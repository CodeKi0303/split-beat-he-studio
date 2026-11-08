// Approximate normalized reference shape, NOT a measured C86 ADC-to-mm curve.
// Source: NeonHE public Tab60 HE "OW Ti" table (2026-11-07).
// Original 3.3 mm coordinates are normalized; total switch travel (e.g. user
// supplied Owlab Ti HE 3.4 mm) scales the resulting distance proportionally.
// Source URL: https://neonhe.com/assets/index-C2gKFU8p.js
export const HALL_CURVE_LINEAR = 0;
export const HALL_CURVE_OWLAB_TI = 1;
export const OWLAB_TI_TRAVEL_MM = 3.4;
const signal = Object.freeze([0, 467, 1211, 2244, 3667, 5644, 8500, 10000]);
const reference = Object.freeze([0, 5000, 10000, 15000, 20000, 25000, 30000, 33000]);
export function validateCurveId(id = 0) {
  if (!Number.isInteger(id) || ![HALL_CURVE_LINEAR, HALL_CURVE_OWLAB_TI].includes(id))
    throw Error("지원하지 않는 Hall 거리 곡선입니다.");
  return id;
}
export function rawToTravel(raw, key) {
  const id = validateCurveId(key.curve_id ?? 0);
  const signedSpan = key.pressed - key.released, span = Math.abs(signedSpan);
  if (!Number.isFinite(raw) || !Number.isInteger(key.pressed) ||
      !Number.isInteger(key.released) || span < 128)
    throw Error("유효한 ADC와 캘리브레이션 끝점이 필요합니다.");
  const distance = (raw - key.released) * Math.sign(signedSpan);
  if (distance <= 0) return 0;
  if (distance >= span) return 1000;
  if (id === HALL_CURVE_LINEAR)
    return Math.floor((distance * 1000 + Math.floor(span / 2)) / span);
  const x = Math.floor((distance * 10000 + Math.floor(span / 2)) / span);
  let hi = 1;
  while (hi < signal.length - 1 && x > signal[hi]) hi++;
  const lo = hi - 1, width = signal[hi] - signal[lo];
  const y = reference[lo] + Math.floor(((x - signal[lo]) *
    (reference[hi] - reference[lo]) + Math.floor(width / 2)) / width);
  return Math.floor((y * 1000 + 16500) / 33000);
}
