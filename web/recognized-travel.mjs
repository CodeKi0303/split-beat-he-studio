// Display-only endpoint clamp. Keep STATUS/raw samples and RT history intact.
import { normalizedToMm } from "./telemetry.mjs?v=studio-filtered-diagnostics1";

export function recognizedTravel(value, keyConfig = {}) {
  if (!Number.isFinite(value)) throw Error("recognized travel: finite number required");
  const top = keyConfig?.top_deadzone ?? 0;
  const bottom = keyConfig?.bottom_deadzone ?? 0;
  if (![top, bottom].every((zone) => Number.isFinite(zone) && zone >= 0 && zone <= 1000))
    throw Error("recognized travel: deadzones must be 0..1000");
  const bounded = Math.max(0, Math.min(1000, value));
  if (bounded <= top) return 0;
  if (bottom > 0 && bounded >= 1000 - bottom) return 1000;
  return bounded; // Do not stretch or shift the remaining travel range.
}

export function recognizedTravelToMm(value, keyConfig, totalMm) {
  return normalizedToMm(recognizedTravel(value, keyConfig), totalMm);
}
