import { keyRecord, validateProfile } from "./protocol.mjs?v=studio-retrigger1";
import { summarize } from "./telemetry.mjs?v=studio-filtered-diagnostics1";

const HALL_COUNT = 14;
const SIDE_COUNT = 7;

function hallKey(key) {
  if (!Number.isInteger(key) || key < 0 || key >= HALL_COUNT)
    throw Error("Hall 키 0–13을 선택하세요.");
  return key;
}

/** Explicit sensor scope, independent of the performance page's selection. */
export function noiseTargets(scope, selected) {
  if (scope === "selected") return [hallKey(selected)];
  if (scope === "left") return Array.from({ length: SIDE_COUNT }, (_, key) => key);
  if (scope === "right") return Array.from({ length: SIDE_COUNT }, (_, key) => key + SIDE_COUNT);
  if (scope === "all") return Array.from({ length: HALL_COUNT }, (_, key) => key);
  throw Error("노이즈 설정을 적용할 범위를 선택하세요.");
}

/** Build noise-only RAM candidates. The caller uses applyPerformanceSettings
 * for output OFF, stale-profile protection and full-profile readback. No device
 * access or changes to endpoints, flags, curves, RT or bindings occur here.
 */
export function proposeNoiseSettings(profile, selectedIds, noiseDeadband) {
  if (!Number.isInteger(noiseDeadband) || noiseDeadband < 0 || noiseDeadband > 100)
    throw Error("센서 데드밴드는 ADC 0–100 정수로 입력하세요.");
  if (!(Array.isArray(selectedIds) || selectedIds instanceof Set))
    throw Error("설정할 Hall 키를 선택하세요.");
  const ids = [...selectedIds];
  if (!ids.length || ids.length > HALL_COUNT || new Set(ids).size !== ids.length)
    throw Error("중복 없이 Hall 키 0–13을 선택하세요.");
  ids.forEach(hallKey);
  const original = validateProfile(profile);
  return ids.map((key) => keyRecord({ ...original.keys[key], noise_deadband: noiseDeadband }));
}

/** Select the requested host-observation interval from an existing store.
 * Store capacity must cover the largest UI window; this cannot recover pruned
 * samples or turn STATUS observations into full-rate ADC acquisition.
 */
export function sensorSeries(telemetry, key, nowMs, windowMs) {
  hallKey(key);
  if (!Number.isFinite(nowMs) || !Number.isFinite(windowMs) || windowMs <= 0)
    throw Error("센서 관찰 시간 범위를 확인하세요.");
  return telemetry.series(key, nowMs)
    .filter((sample) => sample.time >= nowMs - windowMs && sample.time <= nowMs)
    .map((sample) => ({ ...sample }));
}

export function summarizeSensorSeries(series, valueOf = (sample) => sample.raw) {
  return summarize(series, valueOf);
}

/** Each other key is relative to its own first sample in this window. Halves
 * are observed at different host times; these traces do not establish causal
 * interference or share the controlled two-phase measurement's baseline.
 */
export function relativeSensorSeries(telemetry, selected, nowMs, windowMs) {
  hallKey(selected);
  return noiseTargets("all").filter((key) => key !== selected).map((key) => {
    const observed = sensorSeries(telemetry, key, nowMs, windowMs);
    const baselineRaw = observed[0]?.raw ?? null;
    const samples = observed.map((sample) => ({ time: sample.time, value: sample.raw - baselineRaw }));
    const stats = summarizeSensorSeries(samples, (sample) => sample.value);
    return {
      key,
      baselineRaw,
      baselineTime: observed[0]?.time ?? null,
      samples,
      stats,
      latestDelta: samples.at(-1)?.value ?? null,
      peakAbsDelta: samples.length ? Math.max(Math.abs(stats.min), Math.abs(stats.max)) : null,
    };
  });
}
