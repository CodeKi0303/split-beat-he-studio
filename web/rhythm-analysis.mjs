/** Rhythm schedules and bounded host-snapshot analysis. Never writes a device.
 * All times are milliseconds relative to the audible playback origin.
 * Observed edges are brackets between polls, not hardware event timestamps.
 */
import { recognizedTravel, recognizedTravelToMm } from "./recognized-travel.mjs?v=studio-recognized-travel1";
const finite = (v, lo, hi, label) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi)
    throw Error(`${label}: ${lo}–${hi} 범위의 수치가 필요합니다.`);
  return v;
};
const int = (v, lo, hi, label) => {
  finite(v, lo, hi, label);
  if (!Number.isInteger(v)) throw Error(`${label}: 정수가 필요합니다.`);
  return v;
};
const copy = (v) => JSON.parse(JSON.stringify(v));
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const median = (a) => {
  if (!a.length) return null;
  const sorted = [...a].sort((x, y) => x - y), i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
};

export function validateSettings(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("리듬 설정이 필요합니다.");
  const s = { bpm: 120, division: 8, mode: "tap", bars: 4, holdSteps: 3,
    gapSteps: 1, delayMs: 0, delayMode: "offset", tapDuty: .5, ...value };
  finite(s.bpm, 20, 300, "BPM");
  if (![4, 8, 12, 16, 24, 32].includes(s.division)) throw Error("분할은 한 마디당 4·8·12·16·24·32개 중 선택하세요.");
  if (!["tap", "hold"].includes(s.mode)) throw Error("tap 또는 hold 모드를 선택하세요.");
  int(s.bars, 1, 16, "마디 수");
  int(s.holdSteps, 1, 32, "유지 길이");
  int(s.gapSteps, 1, 32, "쉬는 길이");
  if (!["offset", "input", "after"].includes(s.delayMode)) throw Error("지연 방향은 offset 또는 input입니다.");
  finite(s.delayMs, s.delayMode === "input" ? 0 : -300, 300, "목표 보정(ms)");
  finite(s.tapDuty, .1, .9, "짧은 음 유지 비율");
  const duration = (s.bars + 1) * 240000 / s.bpm + 500;
  if (duration > 120000) throw Error("한 번에 최대 2분입니다. 마디 수를 줄이세요.");
  return s;
}

export function makeSchedule(settings = {}) {
  const s = validateSettings(settings), quarterMs = 60000 / s.bpm;
  const stepsPerBeat = s.division / 4;
  const stepMs = quarterMs * 4 / s.division, countInMs = quarterMs * 4;
  const totalSteps = s.bars * s.division, cues = [], targets = [];
  // Prepare for one complete 4/4 bar at the selected subdivision. Reuse the
  // performance step clock so the last count-in click leads into note-0 with
  // exactly one step, including triplets. Count-in cues never create targets.
  for (let step = 0; step < s.division; step++) cues.push({ id: `count-${step}`, type: "count-in",
    onMs: step * stepMs, offMs: step * stepMs + Math.min(45, stepMs / 3),
    accent: step === 0, beatAccent: step % stepsPerBeat === 0,
    beat: Math.floor(step / stepsPerBeat), step });
  const correction = s.delayMode === "input" ? -s.delayMs : s.delayMs;
  for (let step = 0, index = 0; step < totalSteps; step += s.mode === "hold" ? s.holdSteps + s.gapSteps : 1, index++) {
    const onMs = countInMs + step * stepMs;
    const length = s.mode === "hold" ? Math.min(s.holdSteps, totalSteps - step) : s.tapDuty;
    const offMs = onMs + length * stepMs, id = `note-${index}`;
    cues.push({ id, type: s.mode, onMs, offMs, accent: step % s.division === 0,
      beatAccent: step % stepsPerBeat === 0, beat: Math.floor(step / stepsPerBeat) % 4, index, step });
    targets.push({ id: `${id}-press`, noteId: id, type: "press", soundMs: onMs, targetMs: onMs + correction });
    targets.push({ id: `${id}-release`, noteId: id, type: "release", soundMs: offMs, targetMs: offMs + correction });
  }
  return { settings: s, quarterMs, stepsPerBeat, stepMs, countInMs,
    durationMs: countInMs + totalSteps * stepMs + Math.max(500, s.delayMs), cues, targets };
}

/** Firmware-equivalent RT state on the samples actually supplied. It cannot
 * recreate raw samples missed between host polls. Raw noise filter is included.
 */
export class SampledRT {
  constructor(config) {
    this.config = { bottom_deadzone: 0, noise_deadband: 0, ...config };
    const c = this.config;
    int(c.flags, 0, 15, "키 flags");
    int(c.released, 0, 4095, "해제 ADC"); int(c.pressed, 0, 4095, "눌림 ADC");
    int(c.actuation, 1, 1000, "작동점"); int(c.rt_press, 1, 1000, "눌림 RT");
    int(c.rt_release, 1, 1000, "복귀 RT"); int(c.top_deadzone, 0, c.actuation - 1, "상단 데드존");
    int(c.bottom_deadzone, 0, 1000 - c.actuation, "하단 데드존");
    int(c.noise_deadband, 0, 100, "센서 데드밴드");
    validateCurveId(c.curve_id ?? 0);
    this.valid = Boolean(c.flags & 4) && Math.abs(c.pressed - c.released) >= 128;
    this.reset();
  }
  reset() { this.filtered = null; this.pressed = false; this.extreme = 0; this.rapid = false; this.travel = 0; this.retriggerTrough = null; }
  step(raw) {
    int(raw, 0, 4095, "ADC");
    const c = this.config, before = this.pressed, previousTravel = this.travel;
    let retriggered = false;
    if (this.filtered === null || Math.abs(raw - this.filtered) >= c.noise_deadband) this.filtered = raw;
    if (!this.valid) return { pressed: false, travel: null, changed: false, extreme: 0 };
    const travel = rawToTravel(this.filtered, c);
    this.travel = travel;
    if (!(c.flags & 1) || travel <= c.top_deadzone) {
      this.pressed = false; this.rapid = false; this.extreme = travel;
    } else if (!(c.flags & 2)) {
      this.pressed = travel >= c.actuation; this.rapid = false; this.extreme = travel;
    } else if (c.bottom_deadzone && travel >= 1000 - c.bottom_deadzone) {
      this.pressed = true; this.rapid = true; this.extreme = 1000 - c.bottom_deadzone;
    } else if (!this.rapid) {
      if (travel >= c.actuation) { this.pressed = true; this.rapid = true; this.extreme = travel; }
    } else if (this.pressed) {
      this.extreme = Math.max(this.extreme, travel);
      if (this.extreme - travel >= c.rt_release) { this.pressed = false; this.extreme = travel; }
    } else {
      this.extreme = Math.min(this.extreme, travel);
      if (travel - this.extreme >= c.rt_press) { this.pressed = true; this.extreme = travel; }
    }
    const canRetrigger = (c.flags & 10) === 10 && before && this.pressed && travel > c.top_deadzone &&
      !(c.bottom_deadzone && travel >= 1000 - c.bottom_deadzone);
    if (!canRetrigger) this.retriggerTrough = null;
    else {
      if (travel < previousTravel && this.retriggerTrough === null) this.retriggerTrough = travel;
      if (this.retriggerTrough !== null) {
        this.retriggerTrough = Math.min(this.retriggerTrough, travel);
        if (travel - this.retriggerTrough >= c.rt_press) {
          retriggered = true; this.retriggerTrough = null;
        }
      }
    }
    // A synthetic event is not an observed OFF state. USB ACK scheduling is
    // firmware-owned and cannot be reconstructed from host sensor snapshots.
    return { pressed: this.pressed, travel, changed: before !== this.pressed, extreme: this.extreme, retriggered };
  }
}

/** Interpolation never bridges stale/reset/gap segments. */
export function depthAt(samples, timeMs, maxGapMs = 80, totalTravelMm = 4) {
  const index = samples.findIndex((s) => s.timeMs >= timeMs);
  if (index < 0) return null;
  const b = samples[index];
  if (b.timeMs === timeMs) return { normalized: b.travel, mm: b.travel * totalTravelMm / 1000,
    uncertaintyMs: b.uncertaintyMs, bracketMs: [b.lowerMs, b.upperMs], interpolated: false };
  if (!index) return null;
  const a = samples[index - 1], delta = b.timeMs - a.timeMs;
  if (a.segment !== b.segment || delta > maxGapMs || delta <= 0) return null;
  const normalized = a.travel + (b.travel - a.travel) * (timeMs - a.timeMs) / delta;
  return { normalized, mm: normalized * totalTravelMm / 1000,
    uncertaintyMs: Math.max(timeMs - a.lowerMs, b.upperMs - timeMs),
    bracketMs: [a.lowerMs, b.upperMs], interpolated: true };
}

const edgeFrom = (a, b, source) => ({
  id: `${source}-${b.sequence}-${b.timeMs}`, type: (source === "observed" ? b.pressed : b.simulatedPressed) ? "press" : "release",
  timeMs: (a.timeMs + b.timeMs) / 2, earliestMs: a.lowerMs, latestMs: b.upperMs,
  uncertaintyMs: (b.upperMs - a.lowerMs) / 2,
  depthNormalized: (a.travel + b.travel) / 2, source, segment: b.segment,
});

/** Timing-only matching for both live feedback and final analysis. Raw capture
 * retains preparation edges, but they are not extra performance judgments.
 * Keep the first target's early window, including intentional input offsets.
 */
export function matchTimingEdges(targets, edges, windowMs) {
  const scoringStartMs = targets.length ? Math.min(...targets.map((t) => t.targetMs)) - windowMs : Infinity;
  const scoringEdges = edges.filter((edge) => edge.timeMs >= scoringStartMs);
  const used = new Set();
  const matches = targets.map((target) => {
    const choices = scoringEdges.filter((edge) => edge.type === target.type && !used.has(edge.id)
      && Math.abs(edge.timeMs - target.targetMs) <= windowMs)
      .sort((a, b) => Math.abs(a.timeMs - target.targetMs) - Math.abs(b.timeMs - target.targetMs));
    const edge = choices[0] ?? null;
    if (edge) used.add(edge.id);
    return { ...target, edge, matched: Boolean(edge),
      errorMs: edge ? edge.timeMs - target.targetMs : null,
      correctedErrorMs: edge ? edge.timeMs - target.targetMs : null,
      rawSoundErrorMs: edge ? edge.timeMs - target.soundMs : null,
      errorRangeMs: edge ? [edge.earliestMs - target.targetMs, edge.latestMs - target.targetMs] : null,
      timing: !edge ? "not_observed"
        : edge.earliestMs <= target.targetMs && edge.latestMs >= target.targetMs ? "within_observation_window"
          : edge.timeMs < target.targetMs ? "early" : "late" };
  });
  return { matches, extraEdges: scoringEdges.filter((edge) => !used.has(edge.id)) };
}

function edgeMatches(targets, edges, windowMs, samples, maxGapMs, totalTravelMm) {
  const result = matchTimingEdges(targets, edges, windowMs);
  return { ...result, matches: result.matches.map((match) => {
    const depth = depthAt(samples, match.targetMs, maxGapMs, totalTravelMm);
    const pending = !match.edge && (samples.at(-1)?.timeMs ?? -Infinity) < match.targetMs + windowMs;
    return { ...match, depthAtTarget: depth, pending,
      timing: match.edge ? match.timing : pending ? "pending" : depth ? "no_observed_edge" : "not_observed" };
  }) };
}

function errorStats(matches, type) {
  const values = matches.filter((m) => m.type === type && m.matched).map((m) => m.errorMs);
  return { count: values.length, meanMs: mean(values), medianMs: median(values),
    meanAbsoluteMs: mean(values.map(Math.abs)),
    stdevMs: values.length ? Math.sqrt(mean(values.map((x) => (x - mean(values)) ** 2))) : null };
}

export class RhythmCapture {
  constructor({ settings = {}, keyConfig, totalTravelMm = 4, key = 0, maxGapMs = 80, maxSamples = 24000 } = {}) {
    if ((keyConfig?.flags & 10) === 10)
      throw Error("미해제 재입력을 끈 뒤 리듬 판정을 측정하세요. 짧은 USB 해제·눌림 시점은 센서 스냅샷으로 검증할 수 없습니다.");
    this.schedule = makeSchedule(settings);
    finite(totalTravelMm, .1, 10, "총 이동거리(mm)"); int(key, 0, 13, "Hall 키");
    finite(maxGapMs, 1, 500, "최대 관찰 간격"); int(maxSamples, 10, 50000, "샘플 제한");
    this.keyConfig = copy(keyConfig); this.replay = new SampledRT(keyConfig);
    if (!this.replay.valid) throw Error("먼저 선택 Hall 키를 보정하세요.");
    this.totalTravelMm = totalTravelMm; this.key = key;
    this.maxGapMs = Math.min(maxGapMs, this.schedule.stepMs * .5);
    this.maxSamples = maxSamples; this.samples = []; this.edges = []; this.simulatedEdges = [];
    this.segment = 0; this.last = null; this.sequence = null; this.lastTime = -Infinity;
    this.issues = []; this.counts = { duplicates: 0, invalid: 0, gaps: 0, resets: 0 };
    this.stopped = false;
  }
  breakSegment(reason, timeMs = null) {
    this.segment++; this.last = null; this.replay.reset();
    if (this.issues.length < 100) this.issues.push({ reason, timeMs });
  }
  setSoundEvent({ id, kind, timeMs }) {
    const cue = this.schedule.cues.find((c) => c.id === id);
    if (!cue || !["on", "off"].includes(kind)) throw Error("등록된 음의 on/off 이벤트가 필요합니다.");
    finite(timeMs, -1000, 190000, "오디오 시각");
    const shift = timeMs - cue[kind === "on" ? "onMs" : "offMs"];
    cue[kind === "on" ? "onMs" : "offMs"] = timeMs;
    const correction = this.schedule.settings.delayMode === "input" ? -this.schedule.settings.delayMs : this.schedule.settings.delayMs;
    const target = this.schedule.targets.find((t) => t.noteId === id && t.type === (kind === "on" ? "press" : "release"));
    if (target) { target.soundMs = timeMs; target.targetMs = timeMs + correction; }
    if (cue.type === "tap" && kind === "on") {
      cue.offMs += shift;
      const release = this.schedule.targets.find((t) => t.noteId === id && t.type === "release");
      if (release) { release.soundMs += shift; release.targetMs = release.soundMs + correction; }
    }
  }
  addSample(value) {
    if (this.stopped) return false;
    if (!value || typeof value !== "object") return false;
    const { timeMs, raw, travel, pressed, sequence } = value;
    if (!Number.isFinite(timeMs) || timeMs <= this.lastTime) {
      this.counts.invalid++; this.breakSegment("clock_regression", Number.isFinite(timeMs) ? timeMs : null); return false;
    }
    if (value.fresh !== true || value.calibrationState && value.calibrationState !== 0
      || !Number.isInteger(raw) || raw < 0 || raw > 4095 || !Number.isInteger(travel) || travel < 0 || travel > 1000
      || typeof pressed !== "boolean" || !Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) {
      this.counts.invalid++; this.breakSegment("invalid_or_stale", timeMs); return false;
    }
    if (this.sequence !== null) {
      const delta = (sequence - this.sequence) >>> 0;
      if (!delta) { this.counts.duplicates++; return false; }
      if (delta >= 0x80000000) { this.counts.resets++; this.breakSegment("sequence_reset", timeMs); }
    }
    if (this.last && timeMs - this.last.timeMs > this.maxGapMs) {
      this.counts.gaps++; this.breakSegment("sample_gap", timeMs);
    }
    if (this.samples.length >= this.maxSamples) {
      this.stopped = true; this.breakSegment("sample_limit", timeMs); return false;
    }
    const request = value.requestMs ?? timeMs, response = value.responseMs ?? timeMs;
    if (!Number.isFinite(request) || !Number.isFinite(response) || response < request || response - request > 1500) {
      this.counts.invalid++; this.breakSegment("invalid_request_interval", timeMs); return false;
    }
    if (response - request > this.maxGapMs) {
      this.counts.gaps++; this.breakSegment("slow_transaction", timeMs); return false;
    }
    if (this.last && response - this.last.upperMs > this.maxGapMs) {
      this.counts.gaps++; this.breakSegment("response_gap", timeMs);
    }
    // A status sample can predate the request because of cache age. Expand,
    // never shrink, the interval. timeMs is midpoint-age, so subtracting half
    // the transaction duration includes the earliest request-age estimate.
    const lowerMs = Math.min(timeMs - (response - request) / 2, request), upperMs = Math.max(timeMs, response);
    const simulated = this.replay.step(raw);
    const sample = { timeMs, raw, travel, mm: travel * this.totalTravelMm / 1000,
      recognizedTravel: recognizedTravel(travel, this.keyConfig),
      recognizedMm: recognizedTravelToMm(travel, this.keyConfig, this.totalTravelMm),
      pressed, sequence, segment: this.segment, lowerMs, upperMs,
      uncertaintyMs: Math.max(timeMs - lowerMs, upperMs - timeMs),
      simulatedPressed: simulated.pressed, simulatedTravel: simulated.travel, replayExtreme: simulated.extreme };
    if (this.last) {
      if (sample.pressed !== this.last.pressed) this.edges.push(edgeFrom(this.last, sample, "observed"));
      if (sample.simulatedPressed !== this.last.simulatedPressed) this.simulatedEdges.push(edgeFrom(this.last, sample, "simulation"));
    }
    this.samples.push(sample); this.last = sample; this.sequence = sequence; this.lastTime = timeMs;
    return true;
  }
  summary() {
    const schedule = this.schedule, windowMs = Math.min(150, schedule.stepMs * .48);
    const observed = edgeMatches(schedule.targets, this.edges, windowMs, this.samples, this.maxGapMs, this.totalTravelMm);
    const simulated = edgeMatches(schedule.targets, this.simulatedEdges, windowMs, this.samples, this.maxGapMs, this.totalTravelMm);
    const matches = observed.matches;
    const holds = schedule.cues.filter((c) => c.type === "hold").map((cue) => {
      const begin = schedule.targets.find((t) => t.noteId === cue.id && t.type === "press").targetMs;
      const end = schedule.targets.find((t) => t.noteId === cue.id && t.type === "release").targetMs;
      const rows = this.samples.filter((s) => s.timeMs >= begin && s.timeMs <= end);
      const interior = rows.filter((s) => s.timeMs >= begin + windowMs && s.timeMs <= end - windowMs);
      const dropEdges = this.edges.filter((e) => e.type === "release" && e.timeMs > begin + windowMs && e.timeMs < end - windowMs);
      let peak = null, maxDrop = 0;
      const ceiling = this.keyConfig.bottom_deadzone ? 1000 - this.keyConfig.bottom_deadzone : 1000;
      for (const row of interior) {
        peak = Math.max(peak ?? Math.min(row.travel, ceiling), Math.min(row.travel, ceiling));
        maxDrop = Math.max(maxDrop, peak - row.travel);
      }
      const target = depthAt(this.samples, end, this.maxGapMs, this.totalTravelMm);
      const finalPeak = rows.length ? Math.max(...rows.map((s) => Math.min(s.travel, ceiling))) : null;
      return { noteId: cue.id, startMs: begin, endMs: end,
        observedSamples: rows.length, interiorSamples: interior.length,
        unpressedInteriorSamples: interior.filter((s) => !s.pressed).length,
        earlyReleaseCount: dropEdges.length,
        continuousCoverage: Boolean(depthAt(this.samples, begin, this.maxGapMs, this.totalTravelMm) && target
          && rows.length > 1 && rows.every((s, i) => !i || s.segment === rows[i - 1].segment)),
        maxHoldRetreatNormalized: maxDrop,
        targetReleaseDepth: target,
        desiredReleaseRetreatNormalized: target && finalPeak !== null ? Math.max(0, finalPeak - target.normalized) : null };
    });
    const validPressDepths = matches.filter((m) => m.type === "press" && m.matched && m.depthAtTarget
      && m.depthAtTarget.uncertaintyMs <= this.maxGapMs)
      .map((m) => m.depthAtTarget.normalized).filter((v) => v > this.keyConfig.top_deadzone && v <= 1000 - (this.keyConfig.bottom_deadzone ?? 0));
    const depthCandidate = validPressDepths.length >= 3 ? median(validPressDepths) : null;
    const coveredHolds = holds.filter((h) => h.continuousCoverage && h.interiorSamples > 1
      && h.unpressedInteriorSamples < h.interiorSamples && h.targetReleaseDepth.uncertaintyMs <= this.maxGapMs);
    const minHold = coveredHolds.length ? Math.floor(Math.max(...coveredHolds.map((h) => h.maxHoldRetreatNormalized))) + 1 : null;
    const releaseCandidates = coveredHolds.map((h) => h.desiredReleaseRetreatNormalized).filter((x) => x !== null && x >= 1);
    const desiredRelease = median(releaseCandidates);
    const compatible = Boolean(this.keyConfig.flags & 2) && coveredHolds.length >= 3 && minHold !== null && desiredRelease !== null && minHold <= desiredRelease && minHold <= 1000;
    const sampleIntervals = [], allIntervals = [];
    for (let i = 1; i < this.samples.length; i++) {
      const interval = this.samples[i].timeMs - this.samples[i - 1].timeMs;
      allIntervals.push(interval);
      if (this.samples[i].segment === this.samples[i - 1].segment) sampleIntervals.push(interval);
    }
    const rawPressErrors = matches.filter((m) => m.type === "press" && m.matched).map((m) => m.rawSoundErrorMs);
    const offset = rawPressErrors.length >= 8 ? median(rawPressErrors) : null;
    return { settings: copy(schedule.settings), key: this.key, totalTravelMm: this.totalTravelMm,
      sampleCount: this.samples.length, edgeCount: this.edges.length,
      observedSnapshotHz: sampleIntervals.length ? 1000 / mean(sampleIntervals) : null,
      maxObservedGapMs: allIntervals.length ? Math.max(...allIntervals) : null,
      matchWindowMs: windowMs, maxInterpolationGapMs: this.maxGapMs,
      counts: copy(this.counts), issues: copy(this.issues), truncated: this.stopped,
      press: errorStats(matches, "press"), release: errorStats(matches, "release"),
      matchedTargets: matches.filter((m) => m.matched).length,
      unmatchedTargets: matches.filter((m) => !m.matched && !m.pending).length,
      pendingTargets: matches.filter((m) => m.pending).length,
      matches, extraEdges: copy(observed.extraEdges), holds,
      simulated: { press: errorStats(simulated.matches, "press"), release: errorStats(simulated.matches, "release"),
        matchedTargets: simulated.matches.filter((m) => m.matched).length,
        note: "관찰한 샘플만 재생한 RT 모의 판정입니다. 전체 ADC 스캔의 실제 판정과 다를 수 있습니다." },
      recommendation: { applied: false,
        actuation: { sampleCount: validPressDepths.length, normalized: depthCandidate === null ? null : Math.round(depthCandidate),
          mm: depthCandidate === null ? null : depthCandidate * this.totalTravelMm / 1000,
          note: "관찰이 충분한 눌림 3회 이상에서 목표 시점 깊이의 중앙값입니다. RT 재입력에는 최초 작동점만으로 설명되지 않습니다." },
        rtRelease: { minimumToHoldNormalized: minHold, desiredAtReleaseNormalized: desiredRelease,
          compatible, normalized: compatible ? Math.round(desiredRelease) : null,
          mm: compatible ? desiredRelease * this.totalTravelMm / 1000 : null,
          note: !(this.keyConfig.flags & 2) ? "현재 키의 RT가 꺼져 있어 작동점 기준으로 판정합니다. 복귀 RT 후보는 RT를 켠 측정에서 확인하세요."
            : compatible ? "유지 중 가장 큰 복귀량보다 크게, 목표 해제 시점의 복귀량에 맞춘 후보입니다. 자동 적용하지 않습니다."
            : "유효한 유지·해제 관찰 3회가 필요하거나 두 조건을 동시에 만족하는 복귀 RT 범위가 없습니다." },
        personalOffset: { count: rawPressErrors.length, offsetMs: offset,
          withinRange: offset !== null && Math.abs(offset) <= 300,
          note: "소리 대비 눌림 8회 이상의 중앙값입니다. 개인 타이밍·오디오·장치 지연이 합쳐진 관찰값이며 순수 입력 지연이 아닙니다. 다음 측정에 명시적으로 적용하세요." } },
      limits: "호스트가 관찰한 상태 변화의 시간 구간입니다. 샘플 사이의 빠른 눌림·해제는 누락될 수 있고, 오디오 출력 시각과 mm는 추정치입니다." };
  }
  snapshot() { return { schedule: copy(this.schedule), samples: copy(this.samples), edges: copy(this.edges),
    travelSources: { travel: "Unmodified device STATUS travel; firmware may already clamp deadzone endpoints.",
      mm: "STATUS travel scaled by configured switch stroke, without an additional host clamp.",
      recognizedTravel: "Display-only inclusive top/bottom deadzone clamp using this capture's keyConfig; middle unchanged.",
      recognizedMm: "recognizedTravel scaled by configured switch stroke; bounded to that stroke.",
      raw: "Unmodified reported ADC. Timing analysis and raw replay do not consume display-clamped fields." },
    simulatedEdges: copy(this.simulatedEdges), summary: this.summary() }; }
}
import { rawToTravel, validateCurveId } from "./hall-curve.mjs?v=studio-owlab1";
