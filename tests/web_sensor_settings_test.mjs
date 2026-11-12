import assert from "node:assert/strict";
import {
  noiseTargets, proposeNoiseSettings, sensorSeries, summarizeSensorSeries, relativeSensorSeries,
} from "../web/sensor-settings.mjs";
import { validateProfile } from "../web/protocol.mjs";
import { TelemetryStore } from "../web/telemetry.mjs";

assert.deepEqual(noiseTargets("selected", 9), [9]);
assert.deepEqual(noiseTargets("left"), [0, 1, 2, 3, 4, 5, 6]);
assert.deepEqual(noiseTargets("right"), [7, 8, 9, 10, 11, 12, 13]);
assert.deepEqual(noiseTargets("all"), Array.from({ length: 14 }, (_, key) => key));
for (const value of [-1, 14, 0.5, "0", null, undefined])
  assert.throws(() => noiseTargets("selected", value));
assert.throws(() => noiseTargets("unexpected", 0));

const profile = validateProfile({
  schema: "c77-profile-v1", board: "C77",
  keys: Array.from({ length: 14 }, (_, key) => ({
    key, flags: key === 7 ? 0 : 7, released: key < 7 ? 1000 + key : 3100 + key,
    pressed: key < 7 ? 3000 + key : 1100 + key,
    actuation: 200 + key, rt_press: 100 + key, rt_release: 80 + key,
    top_deadzone: 20 + key, bottom_deadzone: key, noise_deadband: key,
    curve_id: key % 2,
  })),
  bindings: Array.from({ length: 28 }, (_, input) => ({ input, kind: 1, code: 4 + input, modifiers: 0 })),
});
const original = structuredClone(profile);
for (const noise of [0, 100]) {
  const candidates = proposeNoiseSettings(profile, noiseTargets("all"), noise);
  for (const candidate of candidates) {
    assert.equal(candidate.noise_deadband, noise);
    const { noise_deadband, ...rest } = candidate;
    const { noise_deadband: originalNoise, ...expected } = profile.keys[candidate.key];
    assert.deepEqual(rest, expected, "noise candidates preserve every other protocol field");
  }
  assert.deepEqual(profile, original, "proposal does not mutate the profile");
  candidates[0].released = 0;
  assert.equal(profile.keys[0].released, original.keys[0].released);
}
assert.deepEqual(proposeNoiseSettings(profile, new Set([7, 2]), 5).map((key) => key.key), [7, 2]);
assert.equal(proposeNoiseSettings(profile, [7], 5)[0].flags, 0, "disabled uncalibrated key remains disabled");
for (const noise of [-1, 101, 0.5, "5", "", null, NaN, Infinity])
  assert.throws(() => proposeNoiseSettings(profile, [0], noise));
for (const selection of [[], [14], [-1], [0.1], [0, 0], ["0"], null, "all"])
  assert.throws(() => proposeNoiseSettings(profile, selection, 5));
const legacy = structuredClone(profile);
legacy.keys.forEach((key) => { delete key.bottom_deadzone; delete key.curve_id; });
assert.equal(proposeNoiseSettings(legacy, [0], 5)[0].bottom_deadzone, 0);
assert.equal(proposeNoiseSettings(legacy, [0], 5)[0].curve_id, 0);

const store = new TelemetryStore({ windowMs: 60000, maxSamples: 4000 });
const status = (sequence, raws) => ({
  fresh: true, sample_sequence: sequence, calibration_state: 0,
  raw: raws, travel: Array(7).fill(0),
});
store.add(0, status(1, [900, 1200, 2200, 2200, 2200, 2200, 2200]), 0);
store.add(0, status(2, [1000, 1000, 2000, 2000, 2000, 2000, 2000]), 20000);
store.add(1, status(1, [3000, 3000, 3000, 3000, 3000, 3000, 3000]), 21000);
store.add(0, status(3, [1100, 1004, 1996, 2000, 2000, 2000, 2000]), 30000);
store.add(1, status(2, [2994, 3000, 3000, 3000, 3000, 3000, 3000]), 30010);
assert.equal(sensorSeries(store, 1, 30010, 10000).length, 1);
assert.equal(sensorSeries(store, 1, 30010, 30000).length, 2);
assert.equal(sensorSeries(store, 1, 30010, 60000).length, 3);
assert.deepEqual(summarizeSensorSeries(sensorSeries(store, 1, 30010, 30000)), {
  count: 2, mean: 1002, variance: 4, stddev: 2, min: 1000, max: 1004, peakToPeak: 4, observedHz: 0.1,
});
const rows = relativeSensorSeries(store, 0, 30010, 30000);
assert.equal(rows.length, 13);
assert.ok(rows.every((row) => row.key !== 0));
assert.equal(rows.find((row) => row.key === 1).baselineRaw, 1000, "ignore observations outside the chosen window");
assert.equal(rows.find((row) => row.key === 1).latestDelta, 4);
assert.equal(rows.find((row) => row.key === 2).latestDelta, -4);
assert.equal(rows.find((row) => row.key === 7).baselineTime, 21000, "each key uses its own observed baseline time");
assert.equal(rows.find((row) => row.key === 7).latestDelta, -6);
assert.equal(rows.find((row) => row.key === 7).peakAbsDelta, 6);
const empty = relativeSensorSeries(store, 0, 90000, 10000)[0];
assert.deepEqual(empty.samples, []);
assert.equal(empty.baselineRaw, null);
assert.equal(empty.latestDelta, null);
assert.equal(empty.peakAbsDelta, null);
assert.equal(empty.stats.count, 0);
const futureStore = { series: () => [{ time: 90, raw: 10 }, { time: 100, raw: 20 }, { time: 101, raw: 30 }] };
assert.deepEqual(sensorSeries(futureStore, 0, 100, 10).map((sample) => sample.raw), [10, 20], "window endpoints included; future data excluded");
for (const [now, window] of [[NaN, 10000], [0, 0], [0, -1], [0, Infinity]])
  assert.throws(() => sensorSeries(store, 0, now, window));
console.log("Sensor settings: isolated noise proposals, scope validation, observation windows and independent relative ADC baselines passed");
