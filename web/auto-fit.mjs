import { SampledRT } from "./rhythm-analysis.mjs?v=studio-owlab1";
import { rawToTravel } from "./hall-curve.mjs?v=studio-owlab1";

export const AUTO_FIT_PHASES = ["released", "resting", "tapping", "holding"];
const phaseNames = { released: "손 떼기", resting: "손 얹기", tapping: "반복 입력", holding: "길게 누르기" };
const errorFields = ["restActivations", "missedTaps", "extraTaps", "missedReleases", "holdDrops"];
const limits = "관찰한 센서 샘플로 비교한 추천입니다. 짧은 변화가 샘플 사이에서 누락될 수 있습니다. 추천값 적용 후 실제 눌림·해제 판정을 다시 확인하세요.";
const round = (value) => Math.round(value * 1000000) / 1000000;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const unique = (values) => [...new Set(values.map(Math.round))];
function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

// The intended tap count comes from large physical excursions, independently of
// the user's current actuation/RT state. Shallow, ambiguous traces are rejected.
function findCycles(rows, low, high) {
  const cycles = [];
  let start = null, peak = null, active = false;
  for (let index = 0; index < rows.length; index++) {
    const depth = rows[index].depth;
    if (!active) {
      if (depth <= low && (start === null || depth <= rows[start].depth)) start = index;
      else if (start !== null && depth >= high) { active = true; peak = index; }
    } else {
      if (depth > rows[peak].depth) peak = index;
      if (depth <= low) {
        if (rows[index].timeMs - rows[start].timeMs >= 40) cycles.push({ start, peak, end: index });
        active = false; start = index; peak = null;
      }
    }
  }
  for (let index = 0; index < cycles.length; index++)
    cycles[index].until = cycles[index + 1]?.start ?? Math.max(cycles[index].end, start ?? 0);
  return cycles;
}

function prepare(input) {
  if (!input || typeof input !== "object") throw Error("측정 기록이 필요합니다.");
  const { keyConfig, totalTravelMm, phases } = input;
  if (!Number.isInteger(keyConfig?.key) || keyConfig.key < 0 || keyConfig.key > 13 ||
      (input.key !== undefined && input.key !== keyConfig.key))
    throw Error("측정 기록의 Hall 키 번호가 일치하지 않습니다.");
  const preference = input.preference ?? "balanced";
  if (!["balanced", "repeat", "hold"].includes(preference)) throw Error("사용 목적을 다시 선택하세요.");
  if (!Number.isFinite(totalTravelMm) || totalTravelMm < .1 || totalTravelMm > 10)
    throw Error("스위치 총 이동거리를 확인하세요.");
  const rt = new SampledRT(keyConfig);
  if (!rt.valid || (keyConfig.flags & 5) !== 5) throw Error("활성화된 Hall 키를 먼저 캘리브레이션하세요.");
  const config = { bottom_deadzone: 0, noise_deadband: 0, curve_id: 0, ...keyConfig };
  const records = {};
  let maxGapMs = 0;
  for (const phase of AUTO_FIT_PHASES) {
    const rows = phases?.[phase];
    if (!Array.isArray(rows) || rows.length < 40 || rows.length > 4000)
      throw Error(`${phaseNames[phase]} 측정을 완료하세요. 최소 40개 샘플이 필요합니다.`);
    records[phase] = rows.map((row, index) => {
      if (!row || !Number.isFinite(row.timeMs) || !Number.isInteger(row.raw) || row.raw < 0 || row.raw > 4095 ||
          !Number.isInteger(row.sequence) || row.sequence < 0 || row.sequence > 0xffffffff ||
          row.fresh === false || row.calibrationState || (row.pressed !== undefined && typeof row.pressed !== "boolean"))
        throw Error(`${phaseNames[phase]} 기록에 유효하지 않은 센서 값이 있습니다. 다시 측정하세요.`);
      if (index) {
        const gap = row.timeMs - rows[index - 1].timeMs;
        const advance = (row.sequence - rows[index - 1].sequence) >>> 0;
        if (gap <= 0 || gap > 100 || !advance || advance >= 0x80000000)
          throw Error(`${phaseNames[phase]} 측정 중 통신이 끊기거나 중복된 샘플이 있습니다. 다시 측정하세요.`);
        maxGapMs = Math.max(maxGapMs, gap);
      }
      return { ...row, depth: rawToTravel(row.raw, config) };
    });
    if (rows.at(-1).timeMs - rows[0].timeMs < 2000)
      throw Error(`${phaseNames[phase]}를 2초 이상 측정하세요.`);
  }
  const released = records.released.map((row) => row.depth);
  if (quantile(released, .95) > 80) throw Error("손 떼기 기록이 보정된 시작 위치에서 멉니다. 손을 완전히 떼고 다시 측정하세요.");
  const releasedMax = Math.max(...released);
  const restMax = Math.max(releasedMax, ...records.resting.map((row) => row.depth));
  const margin = Math.max(6, Math.ceil((releasedMax - Math.min(...released)) * 1.5));
  const tapDepths = records.tapping.map((row) => row.depth);
  const tapLow = quantile(tapDepths, .1), tapHigh = quantile(tapDepths, .9);
  const amplitude = tapHigh - tapLow;
  if (amplitude < Math.max(100, margin * 4)) throw Error("반복 입력의 움직임을 구분하기 어렵습니다. 키를 충분히 눌렀다 놓으며 다시 측정하세요.");
  const cycles = findCycles(records.tapping, tapLow + amplitude * .25, tapLow + amplitude * .65);
  if (cycles.length < 6) throw Error("완료된 반복 입력이 6회 미만입니다. 편한 속도로 6회 이상 눌렀다 놓아 주세요.");
  const minimumPeak = Math.min(...cycles.map((cycle) => records.tapping[cycle.peak].depth));
  if (restMax + margin >= minimumPeak - margin)
    throw Error("손을 얹은 깊이와 누른 깊이가 너무 가깝습니다. 두 동작을 구분해서 다시 측정하세요.");
  const holdRows = records.holding;
  const holdInterior = holdRows.filter((row) => row.timeMs >= holdRows[0].timeMs + 250 && row.timeMs <= holdRows.at(-1).timeMs - 250);
  const holdDepths = holdInterior.map((row) => row.depth);
  if (quantile(holdDepths, .1) < restMax + Math.max(80, margin * 3))
    throw Error("길게 누르기 기록에서 키가 충분히 눌리지 않았습니다. 누른 상태를 유지하며 다시 측정하세요.");
  let peak = holdDepths[0], holdRetreat = 0;
  for (const depth of holdDepths) { peak = Math.max(peak, depth); holdRetreat = Math.max(holdRetreat, peak - depth); }
  return { config, preference, totalTravelMm, records, cycles, holdInterior,
    evidence: { tapCycles: cycles.length, releasedMax, restMax, noiseMargin: margin,
      minimumTapPeak: minimumPeak, tapAmplitude: amplitude, holdMinimum: Math.min(...holdDepths),
      holdRetreat, maxGapMs: round(maxGapMs) } };
}

function replay(config, records, observed) {
  return Object.fromEntries(AUTO_FIT_PHASES.map((phase) => {
    const model = new SampledRT(config);
    return [phase, records[phase].map((row) => observed ? row.pressed : model.step(row.raw).pressed)];
  }));
}
function rising(states, start = 0, end = states.length - 1) {
  const indices = [];
  for (let index = start; index <= end; index++) if (states[index] && !states[index - 1]) indices.push(index);
  return indices;
}
function metrics(config, data, observed = false) {
  const states = replay(config, data.records, observed);
  const taps = data.records.tapping, pressed = states.tapping;
  let missedTaps = 0, extraTaps = 0, missedReleases = 0;
  const retreats = [];
  for (const cycle of data.cycles) {
    const presses = rising(pressed, cycle.start, cycle.until - 1);
    if (!presses.length || !pressed[cycle.peak]) missedTaps++;
    extraTaps += Math.max(0, presses.length - 1);
    const release = taps.findIndex((row, index) => index > cycle.peak && index <= cycle.until && !pressed[index] && pressed[index - 1]);
    if (release < 0) missedReleases++;
    else retreats.push(Math.max(0, taps[cycle.peak].depth - taps[release].depth));
  }
  const holdRows = data.records.holding;
  const interior = holdRows.map((row, index) => ({ row, pressed: states.holding[index] }))
    .filter(({ row }) => row.timeMs >= holdRows[0].timeMs + 250 && row.timeMs <= holdRows.at(-1).timeMs - 250);
  let holdDrops = 0;
  for (let index = 0; index < interior.length; index++)
    if (!interior[index].pressed && (index === 0 || interior[index - 1].pressed)) holdDrops++;
  return { restActivations: rising(states.released).length + rising(states.resting).length,
    missedTaps, extraTaps, missedReleases, holdDrops,
    holdUnpressedFraction: round(interior.filter((row) => !row.pressed).length / interior.length),
    releaseRetreatNormalized: retreats.length ? round(retreats.reduce((a, b) => a + b, 0) / retreats.length) : null,
    tapCycles: data.cycles.length };
}
function hasObserved(data) {
  return AUTO_FIT_PHASES.every((phase) => data.records[phase].every((row) => typeof row.pressed === "boolean"));
}
function inMillimetres(config, travel) {
  return Object.fromEntries(["actuation", "rt_press", "rt_release", "top_deadzone", "bottom_deadzone"]
    .map((field) => [field, round(config[field] * travel / 1000)]));
}
function describe(config, data) {
  return { config, label: config.flags & 2 ? "래피드 트리거 사용" : "고정 작동점 사용",
    metrics: metrics(config, data), mm: inMillimetres(config, data.totalTravelMm) };
}

export function evaluateAutoFit(config, input) {
  try {
    const data = prepare(input);
    const model = new SampledRT(config);
    if (!model.valid || (config.flags & 5) !== 5) throw Error("보정되고 활성화된 Hall 설정이 필요합니다.");
    return { ready: true, reasons: [], metrics: metrics(config, data),
      observedMetrics: hasObserved(data) ? metrics(config, data, true) : null, evidence: data.evidence, limits };
  } catch (error) { return { ready: false, reasons: [error.message], limits }; }
}

export function analyzeAutoFit(input) {
  try {
    const data = prepare(input), { config, preference, evidence: e } = data;
    const baseline = describe(config, data);
    const top = clamp(e.releasedMax + e.noiseMargin, 0, 998);
    const low = Math.max(top + 1, e.restMax + e.noiseMargin);
    const span = e.minimumTapPeak - low;
    const targetActuation = low + span * ({ balanced: .35, repeat: .2, hold: .4 }[preference]);
    const targetPress = Math.max(e.noiseMargin, e.tapAmplitude * ({ balanced: .08, repeat: .05, hold: .12 }[preference]));
    const targetRelease = Math.max(e.noiseMargin, e.holdRetreat + e.noiseMargin + e.tapAmplitude * ({ balanced: .08, repeat: .03, hold: .15 }[preference]));
    const actuations = unique([low, low + span * .2, low + span * .35, low + span * .5, targetActuation, config.actuation])
      .filter((value) => value > top && value < e.minimumTapPeak);
    const presses = unique([e.noiseMargin, targetPress, e.tapAmplitude * .15, config.rt_press]).map((value) => clamp(value, 1, 1000));
    const releases = unique([e.noiseMargin, targetRelease, e.holdRetreat + e.noiseMargin, e.tapAmplitude * .25, config.rt_release]).map((value) => clamp(value, 1, 1000));
    const bottoms = unique([0, config.bottom_deadzone, e.holdMinimum >= 800 ? Math.min(200, 1000 - e.holdMinimum + e.noiseMargin) : 0]);
    const candidates = [baseline];
    for (const actuation of actuations) {
      candidates.push(describe({ ...config, flags: config.flags & ~2, actuation, top_deadzone: top, bottom_deadzone: 0 }, data));
      for (const rt_press of presses) for (const rt_release of releases) for (const bottom_deadzone of bottoms) {
        if (bottom_deadzone > 1000 - actuation) continue;
        candidates.push(describe({ ...config, flags: config.flags | 2, actuation, rt_press, rt_release, top_deadzone: top, bottom_deadzone }, data));
      }
    }
    const safe = candidates.filter((candidate) => errorFields.every((field) => candidate.metrics[field] <= baseline.metrics[field]) &&
      candidate.metrics.holdUnpressedFraction <= baseline.metrics.holdUnpressedFraction);
    function score(candidate) {
      const c = candidate.config, m = candidate.metrics;
      const errors = m.restActivations * 8 + m.holdDrops * 8 + m.holdUnpressedFraction * 8 +
        m.missedTaps * 4 + m.missedReleases * 4 + m.extraTaps * 6;
      const fit = Math.abs(c.actuation - targetActuation) / 1000 +
        (c.flags & 2 ? (Math.abs(c.rt_press - targetPress) + Math.abs(c.rt_release - targetRelease)) / 3000
          : ({ balanced: .08, repeat: .15, hold: 0 }[preference]));
      return errors * 1000 + fit + c.bottom_deadzone / 100000;
    }
    safe.sort((a, b) => score(a) - score(b));
    const best = safe[0];
    const unresolved = errorFields.some((field) => best.metrics[field] > 0) || best.metrics.holdUnpressedFraction > 0;
    if (unresolved) return { ready: false, reasons: ["측정한 연타와 유지 동작을 모두 만족하는 후보를 찾지 못했습니다. 힘을 편하게 두고 다시 측정하세요."],
      baseline, candidates: safe.slice(0, 3), evidence: e, limits };
    const fields = ["flags", "actuation", "rt_press", "rt_release", "top_deadzone", "bottom_deadzone"];
    return { ready: true, reasons: [], baseline, recommendation: { ...best,
      changed: fields.some((field) => best.config[field] !== config[field]), requiresRetest: true },
      candidates: safe.slice(0, 3), evidence: e,
      observedMetrics: hasObserved(data) ? metrics(config, data, true) : null, limits };
  } catch (error) { return { ready: false, reasons: [error.message], limits }; }
}
