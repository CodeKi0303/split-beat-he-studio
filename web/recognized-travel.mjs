// Display-only endpoint clamp. Keep STATUS/raw samples and RT history intact.
import { normalizedToMm } from "./telemetry.mjs?v=studio-filtered-diagnostics1";
import { TRAVEL_MAX } from "./protocol.mjs?v=studio-retrigger1";

export function recognizedTravel(value, keyConfig = {}) {
  if (!Number.isFinite(value)) throw Error("recognized travel: finite number required");
  const top = keyConfig?.top_deadzone ?? 0;
  const bottom = keyConfig?.bottom_deadzone ?? 0;
  if (![top, bottom].every((zone) => Number.isFinite(zone) && zone >= 0 && zone <= TRAVEL_MAX))
    throw Error(`recognized travel: deadzones must be 0..${TRAVEL_MAX}`);
  const bounded = Math.max(0, Math.min(TRAVEL_MAX, value));
  if (bounded <= top) return 0;
  if (bottom > 0 && bounded >= TRAVEL_MAX - bottom) return TRAVEL_MAX;
  return bounded; // Do not stretch or shift the remaining travel range.
}

export function recognizedTravelToMm(value, keyConfig, totalMm) {
  return normalizedToMm(recognizedTravel(value, keyConfig), totalMm);
}
