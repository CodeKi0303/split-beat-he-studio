import { keyRecord } from "./protocol.mjs?v=studio-owlab1";

// This is host-observed calibration data, not a full-rate ADC stream. The user
// must press each desired switch to its mechanical end stop and briefly hold it.
// Neither a movement threshold nor an eligible span proves physical bottom-out.
export const FIRMWARE_CALIBRATION_MIN_SPAN = 128;
const KEYS = 14,
  PER_SIDE = 7;
const activeStates = new Set(["baseline", "press"]);
const finite = (value, name) => {
  if (!Number.isFinite(value)) throw Error(`${name}: finite number required`);
  return value;
};
const emptyKey = (key) => ({
  key,
  rest: null,
  pressed: null,
  span: 0,
  direction: 0,
  threshold: null,
  detected: false,
  eligible: false,
  count: 0,
  mean: null,
  variance: null,
  stddev: null,
  baselineMin: null,
  baselineMax: null,
  lastRaw: null,
});

export class BatchCalibration {
  constructor({
    baselineMs = 3000,
    minSamples = 30,
    maxGapMs = 500,
    maxBaselinePeakToPeakRaw = 64,
    minMotionRaw = 6,
    confirmSamples = 2,
  } = {}) {
    if (
      !Number.isFinite(baselineMs) ||
      baselineMs < 3000 ||
      !Number.isInteger(minSamples) ||
      minSamples < 30 ||
      !Number.isFinite(maxGapMs) ||
      maxGapMs < 100 ||
      maxGapMs > 1000 ||
      !Number.isFinite(maxBaselinePeakToPeakRaw) ||
      maxBaselinePeakToPeakRaw < 0 ||
      !Number.isFinite(minMotionRaw) ||
      minMotionRaw < 1 ||
      !Number.isInteger(confirmSamples) ||
      confirmSamples < 2 ||
      confirmSamples > 10
    )
      throw Error("Invalid batch calibration options");
    Object.assign(this, {
      baselineMs,
      minSamples,
      maxGapMs,
      maxBaselinePeakToPeakRaw,
      minMotionRaw,
      confirmSamples,
    });
    this.reset();
  }
  reset() {
    this.state = "idle";
    this.error = "";
    this.started = null;
    this.baselineEnds = null;
    this.lastNow = null;
    this.keys = Array.from({ length: KEYS }, (_, key) => emptyKey(key));
    this.original = null;
    this.sequence = [null, null];
    this.lastFresh = [null, null];
    this.samples = Array.from({ length: KEYS }, () => []);
    this.recent = Array.from({ length: KEYS }, () => []);
    this.peaks = Array.from({ length: KEYS }, () => ({
      positive: 0,
      negative: 0,
    }));
    this.lockedDirection = Array(KEYS).fill(0);
    this.frozenCandidates = null;
  }
  cancel() {
    this.reset();
  }
  start(keyConfigs, nowMs) {
    finite(nowMs, "start time");
    if (!Array.isArray(keyConfigs) || keyConfigs.length !== KEYS)
      throw Error("Hall 키 14개의 설정이 필요합니다.");
    for (let i = 0; i < KEYS; i++)
      if (!Object.hasOwn(keyConfigs, i))
        throw Error("Hall 키 설정에 누락이 있습니다.");
    const original = keyConfigs.map(keyRecord).sort((a, b) => a.key - b.key);
    if (original.some((key, index) => key.key !== index))
      throw Error("Hall 키 설정에 중복 또는 누락이 있습니다.");
    this.reset();
    this.original = original;
    this.started = this.lastNow = nowMs;
    this.baselineEnds = nowMs + this.baselineMs;
    this.state = "baseline";
  }
  fail(message) {
    this.error = message;
    this.state = "error";
    return false;
  }
  get detectedCount() {
    return this.keys.filter((key) => key.detected).length;
  }
  get eligibleCount() {
    return this.keys.filter((key) => key.eligible).length;
  }
  progress(nowMs) {
    finite(nowMs, "progress time");
    if (this.state === "baseline")
      return Math.max(0, Math.min(1, (nowMs - this.started) / this.baselineMs));
    return ["press", "frozen"].includes(this.state) ? 1 : 0;
  }
  tick(nowMs) {
    finite(nowMs, "sample time");
    if (!activeStates.has(this.state)) return this.state;
    if (nowMs < this.lastNow) {
      this.fail("측정 시간이 역행했습니다. 일괄 보정을 다시 시작하세요.");
      return this.state;
    }
    this.lastNow = nowMs;
    if (
      this.lastFresh.some(
        (time) => nowMs - (time ?? this.started) > this.maxGapMs,
      )
    ) {
      this.fail(
        "양쪽 센서의 최신 샘플이 끊겼습니다. 연결을 확인하고 일괄 보정을 다시 시작하세요.",
      );
      return this.state;
    }
    if (this.state === "baseline" && nowMs >= this.baselineEnds)
      this.finishBaseline();
    return this.state;
  }
  add(side, status, nowMs) {
    if (side !== 0 && side !== 1) throw Error("side must be 0 or 1");
    finite(nowMs, "sample time");
    this.tick(nowMs);
    if (!activeStates.has(this.state)) return false;
    if (!status || status.fresh !== true)
      return this.fail(
        "오래된 센서 데이터가 도착했습니다. 양쪽 연결을 확인하고 다시 시작하세요.",
      );
    if ((status.calibration_state ?? 0) !== 0)
      return this.fail(
        "장치에서 개별 키 보정이 진행 중입니다. 먼저 완료하거나 취소하세요.",
      );
    if (status.output_enabled === true)
      return this.fail(
        "키 출력이 켜져 있습니다. 출력을 끈 뒤 일괄 보정을 다시 시작하세요.",
      );
    if (
      !Number.isInteger(status.sample_sequence) ||
      status.sample_sequence < 0 ||
      status.sample_sequence > 0xffffffff ||
      !Array.isArray(status.raw) ||
      status.raw.length !== PER_SIDE ||
      Array.from({ length: PER_SIDE }, (_, i) => status.raw[i]).some(
        (raw) => !Number.isInteger(raw) || raw < 0 || raw > 4095,
      )
    )
      return this.fail(
        "센서 응답 형식이 올바르지 않습니다. 보정값은 적용하지 않았습니다.",
      );
    const previous = this.sequence[side];
    if (previous !== null) {
      const advance = (status.sample_sequence - previous) >>> 0;
      // Duplicate and delayed reports are not new evidence and do not extend
      // freshness. A sustained sequence reset is caught by the freshness limit.
      if (!advance || advance >= 0x80000000) return false;
    }
    this.sequence[side] = status.sample_sequence;
    this.lastFresh[side] = nowMs;
    for (let i = 0; i < PER_SIDE; i++) {
      const key = side * PER_SIDE + i;
      const raw = status.raw[i];
      this.keys[key].lastRaw = raw;
      if (this.state === "baseline")
        this.samples[key].push({ time: nowMs, raw });
      else this.capture(key, raw);
    }
    return true;
  }
  finishBaseline() {
    // Three seconds must actually elapse. Require observations near both ends
    // of that interval, sufficient unique samples, and no accepted-sample gaps.
    // At 20Hz the first/last observations can be ~50ms inside the boundary.
    const edgeAllowance = Math.min(250, this.maxGapMs / 2);
    for (let key = 0; key < KEYS; key++) {
      const samples = this.samples[key];
      if (
        samples.length < this.minSamples ||
        samples[0].time - this.started > edgeAllowance ||
        this.baselineEnds - samples.at(-1).time > edgeAllowance ||
        samples.at(-1).time - samples[0].time <
          this.baselineMs - 2 * edgeAllowance
      ) {
        this.fail(
          "3초 동안 양쪽의 기준 샘플을 충분히 수집하지 못했습니다. 다시 시작하세요.",
        );
        return;
      }
      let mean = 0,
        m2 = 0,
        count = 0,
        min = Infinity,
        max = -Infinity;
      for (const sample of samples) {
        const delta = sample.raw - mean;
        mean += delta / ++count;
        m2 += delta * (sample.raw - mean);
        min = Math.min(min, sample.raw);
        max = Math.max(max, sample.raw);
      }
      if (max - min > this.maxBaselinePeakToPeakRaw) {
        this.fail(
          `Hall ${key + 1} 기준값이 크게 움직였습니다. 모든 키에서 손을 떼고 다시 시작하세요.`,
        );
        return;
      }
      const variance = Math.max(0, m2 / count),
        stddev = Math.sqrt(variance);
      const rest = Math.round(mean);
      Object.assign(this.keys[key], {
        rest,
        pressed: rest,
        count,
        mean,
        variance,
        stddev,
        baselineMin: min,
        baselineMax: max,
        threshold: Math.max(this.minMotionRaw, Math.ceil(4 * stddev + 2)),
      });
    }
    this.state = "press";
    // Do not reuse released-position samples to confirm a later movement.
    this.recent = Array.from({ length: KEYS }, () => []);
  }
  capture(key, raw) {
    const entry = this.keys[key],
      delta = raw - entry.rest;
    const recent = this.recent[key];
    recent.push(delta);
    if (recent.length > this.confirmSamples) recent.shift();
    if (recent.length !== this.confirmSamples) return;
    const positive = recent.every((value) => value >= entry.threshold);
    const negative = recent.every((value) => value <= -entry.threshold);
    if (!positive && !negative) return;
    const direction = positive ? 1 : -1;
    // The least-extreme of consecutive same-direction samples rejects a single
    // spike. A real bottom position is retained after a brief steady hold.
    const confirmed = Math.min(...recent.map(Math.abs));
    const peaks = this.peaks[key];
    if (direction > 0) peaks.positive = Math.max(peaks.positive, confirmed);
    else peaks.negative = Math.max(peaks.negative, confirmed);
    entry.detected = true;
    const locked = this.lockedDirection[key];
    if (locked && direction !== locked) return;
    const chosenDirection =
      locked || (peaks.positive >= peaks.negative ? 1 : -1);
    const span = chosenDirection > 0 ? peaks.positive : peaks.negative;
    entry.direction = chosenDirection;
    entry.span = span;
    entry.pressed = entry.rest + chosenDirection * span;
    entry.eligible = span >= FIRMWARE_CALIBRATION_MIN_SPAN;
    if (entry.eligible) this.lockedDirection[key] = chosenDirection;
  }
  candidates() {
    if (this.state === "frozen")
      return this.frozenCandidates.map((key) => ({ ...key }));
    if (this.state !== "press") return [];
    return this.keys
      .filter((key) => key.eligible)
      .map((key) =>
        keyRecord({
          ...this.original[key.key],
          released: key.rest,
          pressed: key.pressed,
          flags: this.original[key.key].flags | 4,
        }),
      );
  }
  freeze(nowMs) {
    this.tick(nowMs);
    if (this.state !== "press")
      throw Error(this.error || "키 누름 수집 단계에서만 적용할 수 있습니다.");
    const candidates = this.candidates();
    if (!candidates.length)
      throw Error(
        "아직 적용 가능한 키가 없습니다. 감지된 키를 조금 더 깊게 누르세요.",
      );
    this.frozenCandidates = candidates;
    this.state = "frozen";
    return candidates.map((key) => ({ ...key }));
  }
}
