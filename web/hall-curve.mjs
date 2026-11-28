// Approximate normalized reference shape, NOT a measured C86 ADC-to-mm curve.
// Source: NeonHE public Tab60 HE "OW Ti" table (2026-11-07).
// Original 3.3 mm coordinates are normalized; total switch travel (e.g. user
// supplied Owlab Ti HE 3.4 mm) scales the resulting distance proportionally.
// Source URL: https://neonhe.com/assets/index-C2gKFU8p.js
// Curve 2 (firmware 0.3.46+) is the keyboard's shared user-drawn table.
import { TRAVEL_MAX, CUSTOM_CURVE_POINTS, CUSTOM_CURVE_STEP, CUSTOM_CURVE_IDENTITY, customCurveRecord } from "./protocol.mjs?v=studio-retrigger1";
export const HALL_CURVE_LINEAR = 0;
export const HALL_CURVE_OWLAB_TI = 1;
export const HALL_CURVE_CUSTOM = 2;
export const HALL_CURVE_WISH = 3;
export const CURVE_NAMES = Object.freeze(["직선", "Owlab Ti 근사", "커스텀", "WISH 방식 · Owlab Ti HE"]);
export const OWLAB_TI_TRAVEL_MM = 3.4;
const signal = Object.freeze([0, 467, 1211, 2244, 3667, 5644, 8500, 10000]);
const reference = Object.freeze([0, 5000, 10000, 15000, 20000, 25000, 30000, 33000]);
// Firmware v0.6.0: Q15 signals at 33 equally spaced travel depths. This
// modeled Owlab Ti HE curve uses a 3.4 mm stroke and 120/750 Gs endpoints.
const wishSignalQ15 = Object.freeze([
  0, 287, 591, 913, 1256, 1621, 2009, 2423, 2864, 3334, 3836,
  4373, 4948, 5563, 6222, 6930, 7690, 8507, 9386, 10333, 11355,
  12457, 13648, 14936, 16330, 17841, 19479, 21258, 23189, 25289,
  27574, 30060, 32767,
]);

function wishTravel(distance, span) {
  const q15 = Math.floor((distance * 32767 + Math.floor(span / 2)) / span);
  let lo = 0, hi = 32;
  while (hi - lo > 1) {
    const mid = (hi + lo) >> 1;
    if (wishSignalQ15[mid] <= q15) lo = mid;
    else hi = mid;
  }
  const width = wishSignalQ15[hi] - wishSignalQ15[lo];
  const numerator = (lo * width + q15 - wishSignalQ15[lo]) * TRAVEL_MAX;
  return Math.floor((numerator + 16 * width) / (32 * width));
}
// The table last read from (or written to) the connected keyboard. Keys with
// curve_id 2 use it unless a caller passes a table explicitly.
let activeCustomCurve = CUSTOM_CURVE_IDENTITY;
export function setActiveCustomCurve(points) {
  activeCustomCurve = Object.freeze(customCurveRecord([...points]));
  return activeCustomCurve;
}
export const getActiveCustomCurve = () => activeCustomCurve;
export function validateCurveId(id = 0) {
  if (!Number.isInteger(id) || id < HALL_CURVE_LINEAR || id > HALL_CURVE_WISH)
    throw Error("지원하지 않는 Hall 거리 곡선입니다.");
  return id;
}
/** Travel (0..10000) from the rounded 0..10000 ADC signal fraction, exactly as
 * firmware does after rounding. Linear returns the signal itself. */
export function travelFromSignal(x, id, customCurve = activeCustomCurve) {
  validateCurveId(id);
  if (!Number.isInteger(x) || x < 0 || x > 10000) throw Error("signal 0..10000");
  if (id === HALL_CURVE_LINEAR) return x;
  if (id === HALL_CURVE_WISH) return wishTravel(x, 10000);
  if (id === HALL_CURVE_CUSTOM) {
    const table = customCurveRecord([...customCurve]);
    const segment = Math.min(Math.floor(x / CUSTOM_CURVE_STEP), CUSTOM_CURVE_POINTS);
    const low = segment ? table[segment - 1] : 0;
    const high = segment < CUSTOM_CURVE_POINTS ? table[segment] : TRAVEL_MAX;
    const offset = x - segment * CUSTOM_CURVE_STEP;
    return low + Math.floor((offset * (high - low) + Math.floor(CUSTOM_CURVE_STEP / 2)) / CUSTOM_CURVE_STEP);
  }
  let hi = 1;
  while (hi < signal.length - 1 && x > signal[hi]) hi++;
  const lo = hi - 1, width = signal[hi] - signal[lo];
  const y = reference[lo] + Math.floor(((x - signal[lo]) *
    (reference[hi] - reference[lo]) + Math.floor(width / 2)) / width);
  return Math.floor((y * TRAVEL_MAX + 16500) / 33000);
}
export function rawToTravel(raw, key, customCurve = activeCustomCurve) {
  const id = validateCurveId(key.curve_id ?? 0);
  const signedSpan = key.pressed - key.released, span = Math.abs(signedSpan);
  if (!Number.isFinite(raw) || !Number.isInteger(key.pressed) ||
      !Number.isInteger(key.released) || span < 128)
    throw Error("유효한 ADC와 캘리브레이션 끝점이 필요합니다.");
  const distance = (raw - key.released) * Math.sign(signedSpan);
  if (distance <= 0) return 0;
  if (distance >= span) return TRAVEL_MAX;
  if (id === HALL_CURVE_LINEAR)
    return Math.floor((distance * TRAVEL_MAX + Math.floor(span / 2)) / span);
  if (id === HALL_CURVE_WISH) return wishTravel(distance, span);
  const x = Math.floor((distance * 10000 + Math.floor(span / 2)) / span);
  return travelFromSignal(x, id, customCurve);
}
/** The 15 grid outputs that reproduce a built-in curve as a custom table. */
export function curveAsCustomTable(id) {
  return Array.from({ length: CUSTOM_CURVE_POINTS }, (_, i) => travelFromSignal((i + 1) * CUSTOM_CURVE_STEP, id));
}
