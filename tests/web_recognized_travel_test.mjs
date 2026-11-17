import assert from "node:assert/strict";
import { recognizedTravel, recognizedTravelToMm } from "../web/recognized-travel.mjs";
import { normalizedToMm, rawToEstimatedMm, TelemetryStore } from "../web/telemetry.mjs";
import { RhythmCapture, SampledRT, depthAt } from "../web/rhythm-analysis.mjs";
import { DemoTransport } from "../web/demo.mjs";
import { OP, encodeKey, decodeStatus } from "../web/protocol.mjs";

const key = { key: 0, flags: 7, released: 1000, pressed: 3000, curve_id: 0,
  actuation: 2000, rt_press: 1000, rt_release: 1000, noise_deadband: 0,
  top_deadzone: 880, bottom_deadzone: 880 };
const boundaries = [[-1,0],[0,0],[879,0],[880,0],[881,881],[5000,5000],
  [9119,9119],[9120,10000],[9121,10000],[10000,10000],[10001,10000]];
for (const flags of [0, 4, 5, 7]) {
  for (const [input, output] of boundaries) {
    const config = { ...key, flags };
    assert.equal(recognizedTravel(input, config), output, `flags=${flags}, input=${input}`);
    assert.equal(recognizedTravel(output, config), output, "already-clamped firmware STATUS is idempotent");
    const mm = recognizedTravelToMm(input, config, 3.4);
    assert.ok(mm >= 0 && mm <= 3.4, "recognized mm never exceeds configured stroke");
  }
}
assert.equal(recognizedTravel(9999, { top_deadzone: 0, bottom_deadzone: 0 }), 9999);
assert.equal(recognizedTravel(880.25, key), 880.25, "interpolated middle values are not rounded/rescaled");
assert.equal(recognizedTravel(5000), 5000, "absent legacy zones default to zero");
assert.equal(recognizedTravelToMm(9120, key, 3.4), 3.4);
for (const value of [NaN, Infinity, "10", null]) assert.throws(() => recognizedTravel(value, key));
assert.throws(() => recognizedTravel(50, { top_deadzone: -1 }));

// Settings and raw diagnostic distance must not inherit the display clamp.
assert.ok(Math.abs(normalizedToMm(880, 3.4) - .2992) < 1e-12);
assert.ok(Math.abs(rawToEstimatedMm(1100, key, 3.4) - .17) < 1e-12);
const reverse = { ...key, released: 3000, pressed: 1000 };
assert.ok(Math.abs(rawToEstimatedMm(2900, reverse, 3.4) - .17) < 1e-12);
const telemetry = new TelemetryStore();
const status = { fresh: true, sample_sequence: 1, calibration_state: 0,
  raw: Array(7).fill(1100), travel: Array(7).fill(50) };
assert.equal(telemetry.add(0, status, 0), true);
assert.equal(telemetry.series(0, 0)[0].travel, 50);
assert.equal(telemetry.stats(0, 0).mean, 1100);
assert.deepEqual(status.travel, Array(7).fill(50), "source STATUS remains intact");

// Captured source and analysis stay unchanged; frozen-config display fields are explicit.
const capture = new RhythmCapture({ keyConfig: key, totalTravelMm: 3.4 });
for (const [i, travel] of [500, 9500, 7500].entries()) capture.addSample({
  timeMs: i * 10, sequence: i + 1, fresh: true, raw: 1000 + travel / 5,
  travel, pressed: i > 0, requestMs: i * 10 - 1, responseMs: i * 10 + 1 });
assert.deepEqual(capture.samples.map((s) => s.travel), [500, 9500, 7500]);
assert.deepEqual(capture.samples.map((s) => s.recognizedTravel), [0, 10000, 7500]);
assert.deepEqual(capture.samples.map((s) => s.raw), [1100, 2900, 2500]);
assert.equal(capture.samples[0].mm, .17);
assert.equal(capture.samples[0].recognizedMm, 0);
assert.equal(depthAt(capture.samples, 0, 80, 3.4).normalized, 500, "analysis source is not display-clamped");
assert.equal(capture.edges[0].depthNormalized, 5000);
key.top_deadzone = 1000;
assert.equal(capture.keyConfig.top_deadzone, 880, "recorded display uses capture configuration");
assert.match(capture.snapshot().travelSources.travel, /Unmodified device STATUS/);
assert.match(capture.snapshot().travelSources.raw, /do not consume/);

// The simulated engine must preserve true internal travel and peak/trough history.
const bottomKey = { ...key, bottom_deadzone: 2000, top_deadzone: 200 };
const replay = new SampledRT(bottomKey);
assert.equal(replay.step(2900).travel, 9500);
assert.equal(replay.step(2500).pressed, true);
assert.equal(replay.step(2400).pressed, false);
let now = 0;
const demo = new DemoTransport({ clock: () => now });
demo.command(OP.SET_KEY, encodeKey(bottomKey));
const poll = () => { now += 10; return decodeStatus(demo.command(OP.STATUS, Uint8Array.of(0))); };
demo.pose[0] = 10; // demo depth knob: ADC 1000 + 2 * pose, travel = 10 * pose
assert.equal(poll().travel[0], 0);
assert.ok(demo.rt[0].travel > 0 && demo.rt[0].travel <= 200, "top clamp is export-only");
demo.pose[0] = 950;
assert.equal(poll().travel[0], 10000);
assert.ok(demo.rt[0].travel > 9000 && demo.rt[0].travel < 10000, "bottom clamp is export-only");
demo.pose[0] = 750;
assert.equal(poll().pressed_mask & 1, 1, "leaving lower deadzone preserves original boundary-relative release");
demo.pose[0] = 690;
assert.equal(poll().pressed_mask & 1, 0);
console.log("Recognized travel: inclusive boundaries, RT-off/disabled display, no rescale, stroke bound, untouched ADC/source/analysis, frozen rhythm fields, export-only demo clamp PASS");
