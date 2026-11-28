import assert from "node:assert/strict";
import { c86KeyRelation } from "../web/interference-matrix.mjs";
import {
  TelemetryStore,
  InterferenceSession,
  summarize,
  normalizedToMm,
  mmToNormalized,
  rawToEstimatedMm,
} from "../web/telemetry.mjs";

const status = (sequence, value = 2000, overrides = {}) => ({
  fresh: true,
  sample_sequence: sequence,
  calibration_state: 0,
  raw: Array(7).fill(value),
  travel: Array(7).fill(0),
  ...overrides,
});
const config = { flags: 7, released: 2000, pressed: 3000 };
assert.equal(normalizedToMm(2500, 4), 1);
assert.equal(mmToNormalized(0.01, 4), 25);
assert.equal(mmToNormalized(0.001, 4), 3); // 2.5 units: one 0.001 mm step stays distinct
assert.notEqual(mmToNormalized(0.801, 3.4), mmToNormalized(0.8, 3.4));
for (const mm of [0.001, 0.123, 1.234, 3.399])
  assert.equal(normalizedToMm(mmToNormalized(mm, 3.4), 3.4).toFixed(3), mm.toFixed(3));
assert.ok(
  Math.abs(normalizedToMm(mmToNormalized(1.23, 4), 4) - 1.23) <= 0.0002 + 1e-12,
);
assert.throws(() => mmToNormalized(-0.01, 4));
assert.throws(() => normalizedToMm(100, 0));
assert.throws(() => mmToNormalized(4.01, 4));
assert.equal(rawToEstimatedMm(2500, config, 4), 2);
assert.equal(rawToEstimatedMm(500, config, 4), 0);
assert.equal(rawToEstimatedMm(3500, config, 4), 4);
assert.equal(
  rawToEstimatedMm(2500, { flags: 7, released: 3000, pressed: 2000 }, 4),
  2,
);
assert.equal(rawToEstimatedMm(2500, { ...config, flags: 3 }, 4), null);
assert.equal(rawToEstimatedMm(2500, { ...config, pressed: 9999 }, 4), null);
assert.equal(summarize([]).mean, null);
const known = summarize([1, 2, 3]);
assert.equal(known.mean, 2);
assert.equal(known.variance, 2 / 3);

const store = new TelemetryStore({ windowMs: 1000, maxSamples: 20 });
for (let i = 0; i < 10; i++)
  assert.equal(store.add(0, status(i, 2000 + (i % 2)), i * 50), true);
let stats = store.stats(0, 500);
assert.equal(stats.count, 10);
assert.equal(stats.mean, 2000.5);
assert.equal(stats.variance, 0.25);
assert.equal(stats.stddev, 0.5);
assert.equal(stats.peakToPeak, 1);
assert.equal(stats.observedHz, 20);
assert.equal(store.add(0, status(9, 0), 500), false); // same ADC sample, newer host time
assert.equal(store.add(0, status(8), 550), false); // older sequence
assert.equal(store.add(0, status(10, 2000, { fresh: false }), 550), false);
assert.equal(
  store.add(0, status(10, 2000, { calibration_state: 2 }), 550),
  false,
);
assert.equal(store.add(0, status(10), 550, { calibrating: true }), false);
assert.equal(store.add(0, status(10, 5000), 550), false);
assert.equal(store.add(0, status(10), 300), false); // host clock regression
assert.equal(store.stats(0, 550).count, 10);
assert.equal(store.add(1, status(9, 2100), 550), true); // side sequences independent
const series = store.series(0, 550);
series[0].raw = -1;
assert.equal(store.series(0, 550)[0].raw, 2000);
assert.equal(store.stats(0, 2000).count, 0); // wall-clock expiry with no fresh samples
store.clear();
assert.equal(store.add(0, status(0xfffffffe), 0), true);
assert.equal(store.add(0, status(0xffffffff), 50), true);
assert.equal(store.add(0, status(0), 100), true); // sequence wrap
assert.equal(store.add(0, status(0xffffffff), 150), false);
store.clear(); // reconnect/reset explicitly clears both history and sequence guards
assert.equal(store.add(0, status(0), 0), true);
assert.equal(store.stats(0, 0).count, 1);
const bounded = new TelemetryStore({ windowMs: 10000, maxSamples: 3 });
for (let i = 0; i < 8; i++) bounded.add(0, status(i), i);
assert.equal(bounded.stats(0, 8).count, 3);

const keys = Array.from({ length: 14 }, () => ({ ...config }));
keys[8] = { flags: 7, released: 3000, pressed: 2000 }; // reversed sensor direction
keys[9].flags = 3; // uncalibrated: ADC deltas available, mm/% absent
const measure = new InterferenceSession({ durationMs: 1000, minSamples: 5 });
assert.throws(() => measure.startPress(0));
measure.startBaseline(0, keys, Array(14).fill(4), 0);
for (let i = 0; i < 10; i++) {
  measure.add(0, status(i), i * 100);
  measure.add(1, status(i), i * 100);
}
assert.equal(measure.progress(500), 0.5);
assert.equal(measure.tick(1000), "ready");
measure.startPress(1500);
for (let i = 0; i < 10; i++) {
  const left = status(i + 10);
  left.raw[0] = 3000; // intentionally pressed key must not dominate interference metric
  left.raw[1] += 5;
  measure.add(0, left, 1500 + i * 100);
  const right = status(i + 10);
  right.raw[1] -= 10;
  right.raw[2] += 8;
  measure.add(1, right, 1500 + i * 100);
}
assert.equal(measure.tick(3000), "done"); // delayed finalization preserves fixed window
const result = measure.result();
assert.equal(result.keys[0].selected, true);
assert.equal(result.keys[0].meanDeltaRaw, 1000);
assert.equal(result.keys[1].meanDeltaRaw, 5);
assert.equal(result.keys[8].meanDeltaRaw, -10);
assert.equal(result.keys[8].meanDeltaMm, 0.04); // negative raw is positive travel here
assert.equal(result.keys[9].meanDeltaMm, null);
assert.equal(result.maxOtherDeltaRaw, 10);
assert.equal(result.maxOtherPercent, 1);
assert.equal(result.maxOtherMm, 0.04);
assert.equal(result.keys[8].meanDeltaPercent, 1, "positive percent points in the press direction");
assert.equal(result.keys[9].meanDeltaPercent, null, "raw still available without calibrated span");
assert.equal(measure.rows.get(0), result);
function repeatHeld(key, held) {
  measure.startBaseline(key, keys, Array(14).fill(4), 0);
  for (let step = 0; step < 10; step++)
    for (const side of [0, 1]) measure.add(side, status(step), step * 100);
  assert.equal(measure.tick(1000), "ready");
  measure.startPress(1000);
  for (let step = 0; step < 10; step++)
    for (const side of [0, 1]) {
      const s = status(10 + step);
      if (side === Math.floor(key / 7)) s.raw[key % 7] = held;
      measure.add(side, s, 1000 + step * 100);
    }
  assert.equal(measure.tick(2000), "done");
}
repeatHeld(8, 1200);
assert.equal(measure.rows.get(8).sourceMoved, true, "decreasing-ADC switches can be the source");
repeatHeld(0, 2000);
assert.equal(measure.result().sourceMoved, false);
assert.equal(measure.rows.get(0), result, "unsuccessful repeat preserves last usable row");
repeatHeld(0, 2700);
assert.notEqual(measure.rows.get(0), result);
assert.equal(measure.rows.size, 2);
assert.deepEqual(c86KeyRelation(1, 2), { nearby: true, nextAdc: 1 });
assert.deepEqual(c86KeyRelation(2, 1), { nearby: true, nextAdc: null });
assert.deepEqual(c86KeyRelation(5, 4), { nearby: false, nextAdc: 2 });
assert.deepEqual(c86KeyRelation(12, 11), { nearby: false, nextAdc: null });
assert.deepEqual(c86KeyRelation(11, 12), { nearby: false, nextAdc: 2 });
assert.deepEqual(c86KeyRelation(1, 8), { nearby: false, nextAdc: null });
assert.equal(measure.add(0, status(21), 3100), false);
measure.reset();
assert.equal(measure.result(), null);
assert.equal(measure.rows.size, 0);
measure.startBaseline(0, keys, Array(14).fill(4), 0);
for (let i = 0; i < 10; i++) measure.add(0, status(i), i * 100);
assert.equal(measure.tick(1000), "error"); // missing right side cannot look like zero interference
assert.match(measure.error, /최신 샘플/);
measure.startBaseline(0, keys, Array(14).fill(4), 0);
for (let i = 0; i < 5; i++) {
  measure.add(0, status(i), i * 10);
  measure.add(1, status(i), i * 10);
}
assert.equal(measure.tick(1000), "error"); // enough counts, but only an initial burst
assert.match(measure.error, /끊겼/);
measure.startBaseline(0, keys, Array(14).fill(4), 0);
for (let i = 0; i < 10; i++) {
  measure.add(0, status(i, 2000 + i * 10), i * 100);
  measure.add(1, status(i), i * 100);
}
assert.equal(measure.tick(1000), "error"); // baseline motion must not become a quiet reference
assert.match(measure.error, /크게 움직/);
measure.startBaseline(0, keys, Array(14).fill(4), 0);
for (let i = 0; i < 10; i++) {
  measure.add(0, status(i, 2000 + (i % 2)), i * 100);
  measure.add(1, status(i), i * 100);
}
assert.equal(measure.tick(1000), "ready"); // realistic small noise remains valid
assert.throws(() => measure.startPress(999));
measure.startPress(1000);
for (let i = 0; i < 10; i++) {
  measure.add(0, status(i + 10), 1000 + i * 100);
  measure.add(
    1,
    status(i + 10, 2000, { calibration_state: 1 }),
    1000 + i * 100,
  );
}
assert.equal(measure.tick(2000), "error"); // calibration must not contaminate press observation
assert.match(measure.error, /최신 샘플/);
assert.throws(() => measure.startBaseline(0, keys, Array(14), 0));
console.log(
  "Web telemetry: rolling statistics, distance estimates and two-phase interference tests passed",
);
