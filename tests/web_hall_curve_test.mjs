import assert from "node:assert/strict";
import { rawToTravel, travelFromSignal, curveAsCustomTable } from "../web/hall-curve.mjs";
import { setCurvePoint } from "../web/curve-editor.mjs";
import { rawToEstimatedMm, summarizeTravel, summarize, InterferenceSession } from "../web/telemetry.mjs";
import { SampledRT } from "../web/rhythm-analysis.mjs";
import { demoRTState, demoRTStep, DemoTransport } from "../web/demo.mjs";
import { keyRecord, encodeKey, decodeKey, CAP_HALL_CURVE, CAP_WISH_CURVE, OP, CUSTOM_CURVE_IDENTITY, encodeCustomCurve, decodeCustomCurve } from "../web/protocol.mjs";
import { KeyboardClient } from "../web/device.mjs";
import { makeUiProfile, parseUiProfile } from "../web/ui-profile.mjs";
import { proposePerformanceSettings, applyPerformanceSettings } from "../web/performance-settings.mjs";

const key = keyRecord({ key: 0, flags: 7, released: 1000, pressed: 3000,
  actuation: 2000, rt_press: 1000, rt_release: 1000, top_deadzone: 200,
  noise_deadband: 0, curve_id: 1 });
assert.equal(rawToTravel(1000, key), 0);
assert.equal(rawToTravel(3000, key), 10000);
assert.equal(rawToTravel(0, key), 0);
assert.equal(rawToTravel(4095, key), 10000);
assert.ok(rawToTravel(1400, key) > 4000, "20% raw span is not 20% travel");
const reversed = { ...key, released: 3000, pressed: 1000 };
let previous = -1;
for (let raw = 1000; raw <= 3000; raw++) {
  const value = rawToTravel(raw, key);
  assert.ok(value >= previous && value <= 10000);
  assert.equal(value, rawToTravel(4000 - raw, reversed));
  previous = value;
}
assert.equal(rawToEstimatedMm(3000, key, 3.4), 3.4);
assert.ok(Math.abs(rawToEstimatedMm(1800, key, 4) /
  rawToEstimatedMm(1800, key, 3.4) - 4 / 3.4) < 1e-12);
assert.equal(rawToTravel(1400, { ...key, curve_id: 0 }), 2000);
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
for (const bad of [-1, 4, null, true, "1"])
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
// Firmware 0.3.46+ custom curve (curve_id 2): one shared table, firmware-identical math.
const custom = { ...key, curve_id: 2 };
for (let raw = 900; raw <= 3100; raw += 7)
  assert.equal(rawToTravel(raw, custom, CUSTOM_CURVE_IDENTITY), rawToTravel(raw, { ...key, curve_id: 0 }));
const drawn = [150, 350, 650, 1050, 1550, 2150, 2850, 3650, 4550, 5500, 6450, 7400, 8300, 9100, 9700];
assert.equal(rawToTravel(1125, custom, drawn), 150); // span 2000: 125 codes -> signal 625
assert.equal(travelFromSignal(312, 2, drawn), Math.floor((312 * 150 + 312) / 625));
assert.equal(travelFromSignal(10000, 2, drawn), 10000);
assert.deepEqual(curveAsCustomTable(0), [...CUSTOM_CURVE_IDENTITY]);
assert.deepEqual(curveAsCustomTable(1).map((v, i) => travelFromSignal((i + 1) * 625, 1)), curveAsCustomTable(1));
for (const bad of [drawn.slice(0, 14), [...drawn.slice(0, 14), 10001], [200, 100, ...drawn.slice(2)], [...drawn.slice(0, 14), 1.5]])
  assert.throws(() => encodeCustomCurve(bad));
assert.deepEqual(decodeCustomCurve(encodeCustomCurve(drawn)), drawn);
// Drawing keeps the table non-decreasing around an edited point.
assert.deepEqual(setCurvePoint(drawn, 3, 5000).slice(0, 9), [150, 350, 650, 5000, 5000, 5000, 5000, 5000, 5000]);
assert.deepEqual(setCurvePoint(drawn, 3, 100).slice(0, 5), [100, 100, 100, 100, 1550]);
const curveDemo = new DemoTransport(), curveClient = new KeyboardClient(curveDemo);
assert.deepEqual(await curveClient.customCurve(), [...CUSTOM_CURVE_IDENTITY]);
assert.deepEqual(await curveClient.setCustomCurve(drawn), drawn);
assert.equal(curveClient.outputEnabled, false);
assert.deepEqual(await curveClient.customCurve(), drawn);
await assert.rejects(() => oldClient.customCurve(), /0.3.46/);
await assert.rejects(() => oldClient.setCustomCurve(drawn), /0.3.46/);
assert.deepEqual(oldTransport.mutations, [], "custom curve capability preflight precedes any mutation");
assert.throws(() => proposePerformanceSettings(base, [0], Array(14).fill(3.4), { curve_id: 2 }, CAP_HALL_CURVE), /0.3.46/);
const wish = { ...key, curve_id: 3, released: 2204, pressed: 2646 };
assert.deepEqual(decodeKey(encodeKey(wish)), wish);
assert.deepEqual([2190, 2204, 2205, 2214, 2240, 2425, 2646, 2700].map(v => rawToTravel(v, wish)),
  [0, 0, 81, 771, 2362, 7511, 10000, 10000]);
// Direct ADC-to-Q15 rounding is significant near rest (via 0..10000 gives 82).
assert.equal(travelFromSignal(23, 3), 82);
const wishReverse = { ...wish, released: 2646, pressed: 2204 };
for (let i = 0; i <= 442; i++)
  assert.equal(rawToTravel(2204 + i, wish), rawToTravel(2646 - i, wishReverse));
assert.equal(rawToEstimatedMm(2425, wish, 3.4), 7511 * 3.4 / 10000);
assert.deepEqual(proposePerformanceSettings(base, [0], Array(14).fill(3.4),
  {curve_id: 3}, CAP_HALL_CURVE | CAP_WISH_CURVE)[0], { ...base.keys[0], curve_id: 3 });
assert.throws(() => proposePerformanceSettings(base, [0], Array(14).fill(3.4),
  {curve_id: 3}, CAP_HALL_CURVE), /0.6.0/);
const oldCurveTransport = new DemoTransport(), oldCurveClient = new KeyboardClient(oldCurveTransport);
const oldProfile = await oldCurveClient.getConfig();
oldProfile.keys[0] = wish;
const prior = structuredClone(oldCurveTransport.profile);
await assert.rejects(oldCurveClient.importProfile(oldProfile), /0.6.0/);
assert.deepEqual(oldCurveTransport.profile, prior);
console.log("Hall curves: monotonicity, polarity, proportional travel, codec/profile compatibility, RT/demo parity, custom curve table/codec/client and old-firmware zero-mutation gates PASS");
