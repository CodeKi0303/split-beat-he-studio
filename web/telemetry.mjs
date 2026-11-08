// Host-observed STATUS samples, not the ADC's full-rate acquisition stream.
// Endpoints plus an optional reference curve estimate distance, not physical
// characterization of the switch/magnet. 0.01 mm is a UI setting increment.
import { rawToTravel, validateCurveId } from "./hall-curve.mjs?v=studio-owlab1";
const HALL_COUNT = 14;
const SIDE_COUNT = 7;
const finite = (value, name) => {
  if (!Number.isFinite(value)) throw Error(`${name}: finite number required`);
  return value;
};
function keyIndex(key) {
  if (!Number.isInteger(key) || key < 0 || key >= HALL_COUNT)
    throw Error("Hall key must be 0..13");
  return key;
}
export function validateTotalTravel(totalMm) {
  finite(totalMm, "total travel");
  if (totalMm <= 0 || totalMm > 20)
    throw Error("전체 이동거리는 0 초과 20 mm 이하여야 합니다");
  return totalMm;
}
export function normalizedToMm(value, totalMm) {
  finite(value, "normalized travel");
  return (value * validateTotalTravel(totalMm)) / 1000;
}
export function mmToNormalized(mm, totalMm) {
  finite(mm, "travel mm");
  validateTotalTravel(totalMm);
  if (mm < 0 || mm > totalMm)
    throw Error("설정 거리가 전체 이동거리를 벗어납니다");
  return Math.round((mm * 1000) / totalMm);
}
function calibratedSpan(keyConfig) {
  if (!keyConfig || !(keyConfig.flags & 4)) return null;
  if (
    ![keyConfig.pressed, keyConfig.released].every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 4095,
    )
  )
    return null;
  const span = keyConfig.pressed - keyConfig.released;
  return Number.isFinite(span) && Math.abs(span) >= 128 ? span : null;
}
export function rawToEstimatedMm(raw, keyConfig, totalMm) {
  finite(raw, "raw ADC");
  validateTotalTravel(totalMm);
  const span = calibratedSpan(keyConfig);
  if (span === null) return null;
  if (validateCurveId(keyConfig.curve_id ?? 0))
    return rawToTravel(raw, keyConfig) * totalMm / 1000;
  // Preserve the legacy continuous linear display (not rounded STATUS units).
  return Math.max(0, Math.min(1, (raw - keyConfig.released) / span)) * totalMm;
}
export function summarize(samples, valueOf = (sample) => typeof sample === "number" ? sample : sample.raw) {
  if (!samples.length)
    return {
      count: 0,
      mean: null,
      variance: null,
      stddev: null,
      min: null,
      max: null,
      peakToPeak: null,
      observedHz: 0,
    };
  // Welford avoids cancellation in a narrow signal around a large ADC offset.
  let count = 0,
    mean = 0,
    m2 = 0,
    min = Infinity,
    max = -Infinity;
  for (const sample of samples) {
    const value = valueOf(sample);
    finite(value, "sample");
    const delta = value - mean;
    mean += delta / ++count;
    m2 += delta * (value - mean);
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const duration = samples.at(-1)?.time - samples[0]?.time;
  const variance = Math.max(0, m2 / count); // population variance of this window
  return {
    count,
    mean,
    variance,
    stddev: Math.sqrt(variance),
    min,
    max,
    peakToPeak: max - min,
    observedHz: duration > 0 ? ((count - 1) * 1000) / duration : 0,
  };
}

// Transform individual samples before statistics: nonlinear f(mean(raw)) and
// stddev(raw)*constant do not represent the distance distribution.
export function summarizeTravel(samples, keyConfig, totalMm) {
  if (calibratedSpan(keyConfig) === null) return null;
  return summarize(samples.map((sample) => ({
    time: sample.time,
    raw: rawToEstimatedMm(typeof sample === "number" ? sample : sample.raw, keyConfig, totalMm),
  })));
}

export class TelemetryStore {
  constructor({ windowMs = 10000, maxSamples = 500 } = {}) {
    if (
      !Number.isFinite(windowMs) ||
      windowMs <= 0 ||
      !Number.isInteger(maxSamples) ||
      maxSamples < 1
    )
      throw Error("Invalid telemetry window");
    this.windowMs = windowMs;
    this.maxSamples = maxSamples;
    this.clear();
  }
  clear() {
    this.samples = Array.from({ length: HALL_COUNT }, () => []);
    this.sequence = [null, null];
    this.sideTime = [null, null];
  }
  add(side, status, nowMs, { calibrating = false } = {}) {
    if (side !== 0 && side !== 1) throw Error("side must be 0 or 1");
    finite(nowMs, "sample time");
    if (
      !status ||
      status.fresh !== true ||
      calibrating ||
      (status.calibration_state ?? 0) !== 0
    )
      return false;
    const sequence = status.sample_sequence;
    if (
      !Number.isInteger(sequence) ||
      sequence < 0 ||
      sequence > 0xffffffff ||
      status.raw?.length !== SIDE_COUNT ||
      status.travel?.length !== SIDE_COUNT
    )
      return false;
    if (this.sideTime[side] !== null && nowMs < this.sideTime[side])
      return false;
    if (this.sequence[side] !== null) {
      // Forward modulo-32-bit comparison accepts wrap but rejects duplicates and
      // old/out-of-order responses. Call clear() after a connection/reset.
      const advance = (sequence - this.sequence[side]) >>> 0;
      if (!advance || advance >= 0x80000000) return false;
    }
    for (let i = 0; i < SIDE_COUNT; i++) {
      if (
        !Number.isInteger(status.raw[i]) ||
        status.raw[i] < 0 ||
        status.raw[i] > 4095 ||
        !Number.isFinite(status.travel[i]) ||
        status.travel[i] < 0 ||
        status.travel[i] > 1000
      )
        return false;
    }
    this.sequence[side] = sequence;
    this.sideTime[side] = nowMs;
    for (let i = 0; i < SIDE_COUNT; i++) {
      const key = side * SIDE_COUNT + i;
      this.samples[key].push({
        time: nowMs,
        raw: status.raw[i],
        travel: status.travel[i],
      });
      this.prune(key, nowMs);
    }
    return true;
  }
  prune(key, nowMs) {
    const values = this.samples[keyIndex(key)];
    while (values.length && values[0].time < nowMs - this.windowMs)
      values.shift();
    if (values.length > this.maxSamples)
      values.splice(0, values.length - this.maxSamples);
    return values;
  }
  series(key, nowMs) {
    finite(nowMs, "window time");
    return this.prune(key, nowMs).map((sample) => ({ ...sample }));
  }
  stats(key, nowMs) {
    return summarize(this.series(key, nowMs));
  }
}

// A user-operated two-phase observation. A complete quiet baseline must finish
// before startPress() is called. It never presses/enables/configures hardware.
// Results show correlated changes only: magnetic, supply and mechanical causes
// cannot be distinguished by this observation alone.
export class InterferenceSession {
  constructor({
    durationMs = 2000,
    minSamples = 10,
    maxBaselinePeakToPeakRaw = 64,
  } = {}) {
    if (
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      !Number.isInteger(minSamples) ||
      minSamples < 2 ||
      !Number.isFinite(maxBaselinePeakToPeakRaw) ||
      maxBaselinePeakToPeakRaw < 0
    )
      throw Error("Invalid interference measurement window");
    this.durationMs = durationMs;
    this.minSamples = minSamples;
    this.maxBaselinePeakToPeakRaw = maxBaselinePeakToPeakRaw;
    this.reset();
  }
  reset() {
    this.state = "idle";
    this.error = "";
    this.baseline = null;
    this.pressed = null;
    this.baselineTravel = null;
    this.pressedTravel = null;
    this.selectedKey = null;
    this.started = null;
    this.ended = null;
    this.store = null;
  }
  startBaseline(selectedKey, keyConfigs, totalTravelsMm, nowMs) {
    keyIndex(selectedKey);
    finite(nowMs, "start time");
    if (
      keyConfigs?.length !== HALL_COUNT ||
      totalTravelsMm?.length !== HALL_COUNT
    )
      throw Error("14 Hall key configurations and travel lengths required");
    for (let key = 0; key < HALL_COUNT; key++)
      validateTotalTravel(totalTravelsMm[key]);
    this.reset();
    this.selectedKey = selectedKey;
    this.keyConfigs = keyConfigs.map((key) => ({ ...key }));
    this.totalTravelsMm = [...totalTravelsMm];
    this.begin("baseline", nowMs);
  }
  begin(state, nowMs) {
    this.state = state;
    this.started = nowMs;
    this.ended = nowMs + this.durationMs;
    // Retain every sample in the fixed phase window, even if a delayed tick
    // finalizes it later; stats are evaluated at the planned phase end.
    this.store = new TelemetryStore({
      windowMs: this.durationMs + 1,
      maxSamples: 10000,
    });
  }
  startPress(nowMs) {
    finite(nowMs, "start time");
    if (this.state !== "ready")
      throw Error("먼저 아무 키도 누르지 않고 기준을 측정하세요");
    if (nowMs < this.ended)
      throw Error("측정 시작 시간이 기준 측정보다 이전입니다");
    this.begin("pressed", nowMs);
  }
  add(side, status, nowMs, options) {
    this.tick(nowMs);
    if (!["baseline", "pressed"].includes(this.state) || nowMs < this.started)
      return false;
    return this.store.add(side, status, nowMs, options);
  }
  tick(nowMs) {
    finite(nowMs, "measurement time");
    if (!["baseline", "pressed"].includes(this.state) || nowMs < this.ended)
      return this.state;
    const samples = Array.from({ length: HALL_COUNT }, (_, key) =>
      this.store.series(key, this.ended),
    );
    const stats = samples.map((series) => summarize(series));
    if (stats.some((stat) => stat.count < this.minSamples)) {
      this.error =
        "양쪽의 최신 샘플이 부족합니다. 연결·보정 상태를 확인하고 다시 측정하세요.";
      this.state = "error";
      return this.state;
    }
    // A burst at the start of a phase is insufficient evidence for a complete
    // window. Each half must span at least half the window and reach its final
    // quarter; otherwise link loss/browser suspension could look like a result.
    if (
      samples.some(
        (values) =>
          values.at(-1).time - values[0].time < this.durationMs * 0.5 ||
          this.ended - values.at(-1).time > this.durationMs * 0.25,
      )
    ) {
      this.error =
        "측정 중 샘플이 끊겼습니다. 양쪽 연결을 확인하고 다시 측정하세요.";
      this.state = "error";
      return this.state;
    }
    if (this.state === "baseline") {
      if (
        stats.some((stat) => stat.peakToPeak > this.maxBaselinePeakToPeakRaw)
      ) {
        this.error =
          "기준 측정 중 센서가 크게 움직였습니다. 모든 키를 놓고 안정된 상태에서 다시 측정하세요.";
        this.state = "error";
        return this.state;
      }
      this.baseline = stats;
      this.baselineTravel = samples.map((values, key) =>
        summarizeTravel(values, this.keyConfigs[key], this.totalTravelsMm[key]));
      this.state = "ready";
    } else {
      this.pressed = stats;
      this.pressedTravel = samples.map((values, key) =>
        summarizeTravel(values, this.keyConfigs[key], this.totalTravelsMm[key]));
      this.state = "done";
    }
    return this.state;
  }
  progress(nowMs) {
    finite(nowMs, "measurement time");
    return ["baseline", "pressed"].includes(this.state)
      ? Math.max(0, Math.min(1, (nowMs - this.started) / this.durationMs))
      : this.state === "ready" || this.state === "done"
        ? 1
        : 0;
  }
  result() {
    if (this.state !== "done") return null;
    const keys = this.baseline.map((baseline, key) => {
      const pressed = this.pressed[key];
      const meanDeltaRaw = pressed.mean - baseline.mean;
      const peakAbsDeltaRaw = Math.max(
        Math.abs(pressed.min - baseline.mean),
        Math.abs(pressed.max - baseline.mean),
      );
      const span = calibratedSpan(this.keyConfigs[key]);
      const curved = !!this.keyConfigs[key].curve_id;
      const baselineMm = this.baselineTravel[key], pressedMm = this.pressedTravel[key];
      return {
        key,
        selected: key === this.selectedKey,
        baseline,
        pressed,
        meanDeltaRaw,
        peakAbsDeltaRaw,
        meanDeltaPercent: span === null ? null : (meanDeltaRaw * 100) / span,
        peakPercent:
          span === null ? null : (peakAbsDeltaRaw * 100) / Math.abs(span),
        meanDeltaMm:
          span === null
            ? null
            : curved ? pressedMm.mean - baselineMm.mean
              : (meanDeltaRaw * this.totalTravelsMm[key]) / span,
        peakMm:
          span === null
            ? null
            : curved ? Math.max(Math.abs(pressedMm.min - baselineMm.mean), Math.abs(pressedMm.max - baselineMm.mean))
              : (peakAbsDeltaRaw * this.totalTravelsMm[key]) / Math.abs(span),
      };
    });
    const others = keys.filter((key) => !key.selected);
    return {
      selectedKey: this.selectedKey,
      durationMs: this.durationMs,
      keys,
      maxOtherDeltaRaw: Math.max(...others.map((key) => key.peakAbsDeltaRaw)),
      maxOtherPercent: others.some((key) => key.peakPercent !== null)
        ? Math.max(
            ...others
              .filter((key) => key.peakPercent !== null)
              .map((key) => key.peakPercent),
          )
        : null,
      maxOtherMm: others.some((key) => key.peakMm !== null)
        ? Math.max(
            ...others
              .filter((key) => key.peakMm !== null)
              .map((key) => key.peakMm),
          )
        : null,
    };
  }
}
