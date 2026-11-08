import assert from "node:assert/strict";
import { rawToTravel } from "../web/hall-curve.mjs";
import { rawToEstimatedMm, summarizeTravel, summarize, InterferenceSession } from "../web/telemetry.mjs";
import { SampledRT } from "../web/rhythm-analysis.mjs";
import { demoRTState, demoRTStep, DemoTransport } from "../web/demo.mjs";
import { keyRecord, encodeKey, decodeKey, CAP_HALL_CURVE, OP } from "../web/protocol.mjs";
import { KeyboardClient } from "../web/device.mjs";
import { makeUiProfile, parseUiProfile } from "../web/ui-profile.mjs";
import { proposePerformanceSettings, applyPerformanceSettings } from "../web/performance-settings.mjs";

const key = keyRecord({ key: 0, flags: 7, released: 1000, pressed: 3000,
  actuation: 200, rt_press: 100, rt_release: 100, top_deadzone: 20,
  noise_deadband: 0, curve_id: 1 });
assert.equal(rawToTravel(1000, key), 0);
assert.equal(rawToTravel(3000, key), 1000);
assert.equal(rawToTravel(0, key), 0);
assert.equal(rawToTravel(4095, key), 1000);
assert.ok(rawToTravel(1400, key) > 400, "20% raw span is not 20% travel");
const reversed = { ...key, released: 3000, pressed: 1000 };
let previous = -1;
for (let raw = 1000; raw <= 3000; raw++) {
  const value = rawToTravel(raw, key);
  assert.ok(value >= previous && value <= 1000);
  assert.equal(value, rawToTravel(4000 - raw, reversed));
  previous = value;
}
assert.equal(rawToEstimatedMm(3000, key, 3.4), 3.4);
assert.ok(Math.abs(rawToEstimatedMm(1800, key, 4) /
  rawToEstimatedMm(1800, key, 3.4) - 4 / 3.4) < 1e-12);
assert.equal(rawToTravel(1400, { ...key, curve_id: 0 }), 200);
assert.equal(rawToEstimatedMm(1401, { ...key, curve_id: 0 }, 4), .802);
const samples = [1400, 1800, 2200].map((raw, time) => ({raw, time}));
assert.deepEqual(summarizeTravel(samples, key, 3.4),
  summarize(samples.map((sample) => ({time:sample.time, raw:rawToEstimatedMm(sample.raw, key, 3.4)}))));
const interference = new InterferenceSession({durationMs:1000, minSamples:5});
interference.startBaseline(0, Array.from({length:14}, (_, id) => ({...key, key:id})), Array(14).fill(3.4), 0);
const observe = (sequence, raw) => ({fresh:true, sample_sequence:sequence, calibration_state:0, raw:Array(7).fill(raw), travel:Array(7).fill(0)});
for (let i=0;i<10;i++) for (const side of [0,1]) interference.add(side,observe(i,1400),i*100);
assert.equal(interference.tick(1000),"ready"); interference.startPress(1000);
for (let i=0;i<10;i++) for (const side of [0,1]) interference.add(side,observe(i+10,1420),1000+i*100);
assert.equal(interference.tick(2000),"done");
assert.equal(interference.result().keys[1].meanDeltaMm,
  rawToEstimatedMm(1420,key,3.4)-rawToEstimatedMm(1400,key,3.4));
for (const bad of [-1, 2, null, true, "1"])
  assert.throws(() => keyRecord({ ...key, curve_id: bad }));
const legacy = { ...key }; delete legacy.curve_id; delete legacy.bottom_deadzone;
assert.equal(keyRecord(legacy).curve_id, 0);
assert.deepEqual(decodeKey(encodeKey(key)), key);
assert.deepEqual([...encodeKey(key).slice(18)], [1, 0, 0, 0]);

const sampled = new SampledRT(key), demo = demoRTState();
for (const raw of [1000, 1150, 1500, 2700, 2500, 2000, 2100, 2200, 1000]) {
  const a = sampled.step(raw), b = demoRTStep(demo, key, raw);
  assert.equal(a.travel, rawToTravel(raw, key));
  assert.equal(a.travel, b.travel); assert.equal(a.pressed, b.pressed);
}
class OldFirmware extends DemoTransport {
  mutations = [];
  command(op, payload) {
    if ([4,5,6,7,8,10].includes(op)) this.mutations.push(op);
    const reply = super.command(op, payload);
    if (op === OP.INFO) new DataView(reply.buffer).setUint32(16, 0x13f, true);
    return reply;
  }
}
const oldTransport = new OldFirmware(), oldClient = new KeyboardClient(oldTransport);
const profile = await oldClient.getConfig();
profile.keys[0] = key;
await assert.rejects(() => oldClient.setKey(key), /0.3.5/);
await assert.rejects(() => oldClient.importProfile(profile), /0.3.5/);
assert.deepEqual(oldTransport.mutations, [], "capability preflight must precede OUTPUT/SET_KEY");
const base = structuredClone(profile); base.keys[0].curve_id = 0;
assert.throws(() => proposePerformanceSettings(base, [0], Array(14).fill(3.4),
  { curve_id: 1 }, 0), /0.3.5/);
const proposed = proposePerformanceSettings(base, [0], Array(14).fill(3.4),
  { curve_id: 1 }, CAP_HALL_CURVE);
assert.deepEqual(proposed[0], key, "changing curve preserves endpoints and thresholds");
const outcome = await applyPerformanceSettings(oldClient, base, proposed);
assert.equal(outcome.complete, false);
assert.deepEqual(oldTransport.mutations, [], "group capability preflight cannot disable output");
const wrapped = makeUiProfile(profile, Array(14).fill(3.4));
assert.deepEqual(parseUiProfile(wrapped), { device: profile, travelMm: Array(14).fill(3.4) });
console.log("Hall curves: monotonicity, polarity, proportional travel, codec/profile compatibility, RT/demo parity and old-firmware zero-mutation gates PASS");
