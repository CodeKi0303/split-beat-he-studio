import assert from "node:assert/strict";
import { proposePerformanceSettings, applyPerformanceSettings } from "../web/performance-settings.mjs";
import { CAP_BOTTOM_DEADZONE, validateProfile } from "../web/protocol.mjs";

const clone = (v) => structuredClone(v);
const base = validateProfile({
  schema: "c77-profile-v1", board: "C77",
  keys: Array.from({ length: 14 }, (_, key) => ({
    key, flags: key === 7 ? 6 : 7, released: key < 7 ? 1000 + key : 3100 + key,
    pressed: key < 7 ? 3000 + key : 1100 + key,
    actuation: 200, rt_press: 100, rt_release: 80 + key,
    top_deadzone: 20, bottom_deadzone: 0, noise_deadband: key,
  })),
  bindings: Array.from({ length: 28 }, (_, input) => ({ input, kind: 1, code: 4 + input, modifiers: 0 })),
});
const travel = Array(14).fill(4); travel[7] = 3.2;
const draft = { actuation: 0.8, rt_press: 0.16, bottom_deadzone: 0.32 };
const original = clone(base), beforeDraft = clone(draft);
const pair = proposePerformanceSettings(base, [0, 7], travel, draft, CAP_BOTTOM_DEADZONE);
assert.equal(pair[0].actuation, 200);
assert.equal(pair[1].actuation, 250, "same mm with different per-key travel");
assert.equal(pair[0].rt_press, 40);
assert.equal(pair[1].rt_press, 50);
assert.equal(pair[0].bottom_deadzone, 80);
assert.equal(pair[1].bottom_deadzone, 100);
for (const key of pair) {
  for (const field of ["released", "pressed", "flags", "rt_release", "top_deadzone", "noise_deadband"])
    assert.equal(key[field], base.keys[key.key][field], `preserve per-key ${field}`);
}
assert.deepEqual(base, original); assert.deepEqual(draft, beforeDraft);
const flags = proposePerformanceSettings(base, new Set([0, 7]), travel,
  { enabled: false, rapid_trigger: false, noise_deadband: 2 }, 0);
assert.ok(flags.every((key) => key.flags === 4 && key.noise_deadband === 2));
for (const key of flags) assert.equal(key.rt_release, base.keys[key.key].rt_release);
assert.equal(proposePerformanceSettings(base, [0], travel, { bottom_deadzone: 0 }, 0)[0].bottom_deadzone, 0);
assert.throws(() => proposePerformanceSettings(base, [0], travel, { bottom_deadzone: 0.1 }, 0), /업데이트/);
const legacy = clone(base); legacy.keys.forEach((key) => delete key.bottom_deadzone);
assert.equal(proposePerformanceSettings(legacy, [0], travel, { rt_press: 0.2 }, 0)[0].bottom_deadzone, 0);
for (const selection of [[], [14], [-1], [0.1], [0, 0], ["0"], null])
  assert.throws(() => proposePerformanceSettings(base, selection, travel, draft, CAP_BOTTOM_DEADZONE));
for (const invalid of [{}, { released: 2 }, { actuation: NaN }, { rt_press: -1 },
  { rt_release: "0.2" }, { enabled: 1 }, { rapid_trigger: null }, { noise_deadband: 2.5 },
  { noise_deadband: 101 }, { actuation: 0 }, { rt_press: 0.0001 },
  { actuation: 3.3 }, { actuation: 0.1, top_deadzone: 0.2 }, { bottom_deadzone: 3.1 },
  { actuation: 0.8, bottom_deadzone: 2.4001 }])
  assert.throws(() => proposePerformanceSettings(base, [0, 7], travel, invalid, CAP_BOTTOM_DEADZONE));
const uncalibrated = clone(base); uncalibrated.keys[7].flags &= ~4;
assert.throws(() => proposePerformanceSettings(uncalibrated, [0, 7], travel, draft, CAP_BOTTOM_DEADZONE), /캘리브레이션/);
assert.equal(proposePerformanceSettings(uncalibrated, [7], travel, { enabled: false }, 0)[0].flags & 4, 0);
assert.throws(() => proposePerformanceSettings(uncalibrated, [7], travel, { enabled: true }, 0), /캘리브레이션/);
const noCalibration = clone(uncalibrated); noCalibration.keys[7].flags |= 1;
assert.throws(() => proposePerformanceSettings(noCalibration, [7], travel, { noise_deadband: 3 }, 0), /캘리브레이션/);
assert.equal(proposePerformanceSettings(noCalibration, [7], travel, { enabled: false }, 0)[0].flags, 2);
const badTravel = [...travel]; badTravel[7] = 0;
assert.throws(() => proposePerformanceSettings(base, [0, 7], badTravel, draft, CAP_BOTTOM_DEADZONE));

class FakeClient {
  constructor(profile = base, options = {}) {
    this.profile = clone(profile); this.options = options; this.calls = []; this.reads = 0; this.writes = 0;
  }
  async output(enabled) {
    this.calls.push(["output", enabled]); assert.equal(enabled, false);
    if (this.options.outputFail) throw Error("OFF ACK lost");
    return this.options.outputWrong ? true : false;
  }
  async getConfig() {
    this.calls.push(["read"]); this.reads++;
    if (this.options.readFail === this.reads) throw Error("read lost");
    return clone(this.profile);
  }
  async setKey(key) {
    this.calls.push(["write", key.key]); this.writes++;
    if (this.options.writeFail === this.writes) throw Error("write rejected");
    this.profile.keys[key.key] = clone(key);
    if (this.options.unexpected) this.profile.bindings[14].code = 40;
    if (this.options.nonTarget) this.profile.keys[13].rt_release++;
    if (this.options.ackLost === this.writes) throw Error("write ACK lost");
    if (this.options.echoMismatch === this.writes) return { ...key, rt_release: key.rt_release + 1 };
    return clone(key);
  }
}
let client = new FakeClient(), answer = await applyPerformanceSettings(client, base, pair);
assert.equal(answer.complete, true); assert.equal(answer.error, null);
assert.equal(answer.unexpectedChanges, false); assert.deepEqual(answer.appliedKeys, [0, 7]);
assert.deepEqual(answer.profile.bindings, base.bindings);
for (let i = 0; i < 14; i++) if (![0, 7].includes(i)) assert.deepEqual(answer.profile.keys[i], base.keys[i]);
assert.deepEqual(client.calls, [["output", false], ["read"], ["write", 0], ["write", 7], ["read"]]);
assert.deepEqual(base, original);
const changed = clone(base); changed.keys[13].noise_deadband++;
client = new FakeClient(changed); answer = await applyPerformanceSettings(client, base, pair);
assert.equal(answer.unexpectedChanges, true); assert.equal(client.writes, 0);
assert.deepEqual(answer.profile, changed);
for (const options of [{ writeFail: 2 }, { ackLost: 1 }, { echoMismatch: 1 }]) {
  client = new FakeClient(base, options); answer = await applyPerformanceSettings(client, base, pair);
  assert.deepEqual(answer.appliedKeys, [0]); assert.equal(answer.complete, false);
  assert.equal(answer.unexpectedChanges, false); assert.match(answer.error, /1\/2/);
  assert.equal(client.writes, options.writeFail ? 2 : 1, "no retry or continuation after uncertain ACK");
}
client = new FakeClient(base, { ackLost: 2 }); answer = await applyPerformanceSettings(client, base, pair);
assert.equal(answer.complete, true); assert.equal(answer.error, null);
for (const options of [{ outputFail: true }, { outputWrong: true }, { readFail: 1 }]) {
  client = new FakeClient(base, options); answer = await applyPerformanceSettings(client, base, pair);
  assert.equal(client.writes, 0); assert.equal(answer.complete, false); assert.deepEqual(answer.appliedKeys, []);
}
client = new FakeClient(base, { readFail: 2 }); answer = await applyPerformanceSettings(client, base, pair);
assert.equal(answer.profile, null); assert.deepEqual(answer.appliedKeys, []);
assert.match(answer.error, /읽기 확인 실패/);
for (const options of [{ unexpected: true }, { nonTarget: true }]) {
  client = new FakeClient(base, options); answer = await applyPerformanceSettings(client, base, pair);
  assert.equal(answer.complete, false); assert.equal(answer.unexpectedChanges, true);
  assert.deepEqual(answer.appliedKeys, [0, 7]);
}
for (const invalid of [[], null, [pair[0], pair[0]], [{ ...pair[0], flags: 3 }],
  [{ ...pair[0], released: 999 }], [{ ...pair[0], pressed: 2999 }], [{ ...pair[0], key: 14 }]]) {
  client = new FakeClient(); answer = await applyPerformanceSettings(client, base, invalid);
  assert.equal(answer.complete, false); assert.equal(typeof answer.error, "string");
  assert.deepEqual(client.calls, [], "invalid proposal cannot touch device");
}
client = new FakeClient(uncalibrated);
answer = await applyPerformanceSettings(client, uncalibrated, [{ ...uncalibrated.keys[7], actuation: 250 }]);
assert.equal(answer.complete, false); assert.deepEqual(client.calls, []);
client = new FakeClient(uncalibrated);
answer = await applyPerformanceSettings(client, uncalibrated, [{ ...uncalibrated.keys[7], flags: 3 }]);
assert.equal(answer.complete, false); assert.deepEqual(client.calls, []);
client = new FakeClient(legacy);
const legacyProposal = proposePerformanceSettings(legacy, [0], travel, { rt_press: 0.2 }, 0);
answer = await applyPerformanceSettings(client, legacy, legacyProposal);
assert.equal(answer.complete, true);
assert.equal(answer.profile.keys[0].bottom_deadzone, 0);
console.log("Hall group settings: per-key mm patch, validation, legacy capability, subset preservation and partial-failure readback passed");
