import assert from "node:assert/strict";
import { applyCalibration } from "../web/apply-calibration.mjs";
import { KeyboardClient } from "../web/device.mjs";
import { DemoTransport } from "../web/demo.mjs";

const clone = (value) => structuredClone(value);
const base = await new KeyboardClient(new DemoTransport()).getConfig();
// Preserve an already-calibrated, disabled, non-default key alongside new keys.
Object.assign(base.keys[8], {
  flags: 6,
  released: 3200,
  pressed: 1400,
  actuation: 333,
  noise_deadband: 7,
  bottom_deadzone: 125,
});
const candidate = (key, released = 1000, pressed = 3000) => ({
  ...base.keys[key],
  flags: base.keys[key].flags | 4,
  released,
  pressed,
});
const pair = [candidate(0), candidate(8, 3190, 1300)];
class FakeClient {
  constructor(profile = base, options = {}) {
    this.profile = clone(profile);
    this.options = options;
    this.calls = [];
    this.reads = 0;
    this.writes = 0;
  }
  async output(enabled) {
    this.calls.push(["output", enabled]);
    assert.equal(enabled, false);
    if (this.options.outputFail) throw Error("output ACK lost");
    return this.options.outputWrong ? true : false;
  }
  async getConfig() {
    this.calls.push(["read"]);
    this.reads++;
    if (this.options.readFail === this.reads) throw Error("read lost");
    return clone(this.profile);
  }
  async setKey(key) {
    this.calls.push(["write", key.key]);
    this.writes++;
    if (this.options.writeFail === this.writes) throw Error("write rejected");
    this.profile.keys[key.key] = clone(key);
    if (this.options.unexpected) this.profile.bindings[14].code = 40;
    if (this.options.ackLost === this.writes) throw Error("write ACK lost");
    if (this.options.echoMismatch === this.writes)
      return { ...key, released: key.released + 1 };
    return clone(key);
  }
}

const sourceBefore = clone(base),
  proposedBefore = clone(pair);
let client = new FakeClient();
let answer = await applyCalibration(client, base, pair);
assert.equal(answer.complete, true);
assert.equal(answer.error, null);
assert.equal(answer.unexpectedChanges, false);
assert.deepEqual(answer.appliedKeys, [0, 8]);
assert.deepEqual(answer.profile.bindings, base.bindings);
for (let key = 0; key < 14; key++) {
  if (![0, 8].includes(key))
    assert.deepEqual(answer.profile.keys[key], base.keys[key]);
}
assert.equal(answer.profile.keys[8].flags, 6, "disabled flag remains disabled");
assert.equal(answer.profile.keys[8].actuation, 333);
assert.equal(answer.profile.keys[8].noise_deadband, 7);
assert.equal(answer.profile.keys[8].bottom_deadzone, 125);
assert.deepEqual(client.calls, [
  ["output", false],
  ["read"],
  ["write", 0],
  ["write", 8],
  ["read"],
]);
assert.deepEqual(base, sourceBefore);
assert.deepEqual(pair, proposedBefore);

// Missing bottom fields from legacy zero-zone records normalize consistently
// during preflight/readback; an existing modern nonzero zone stays untouched.
const legacyOriginal = clone(base);
for (const key of legacyOriginal.keys)
  if (key.bottom_deadzone === 0) delete key.bottom_deadzone;
const legacyCandidate = clone(pair[0]);delete legacyCandidate.bottom_deadzone;
client = new FakeClient(legacyOriginal);
answer = await applyCalibration(client, legacyOriginal, [legacyCandidate]);
assert.equal(answer.complete, true);
assert.equal(answer.unexpectedChanges, false);
assert.deepEqual(answer.appliedKeys, [0]);
assert.equal(answer.profile.keys[0].bottom_deadzone, 0);
assert.equal(answer.profile.keys[8].bottom_deadzone, 125);
assert.equal(Object.hasOwn(legacyOriginal.keys[0], "bottom_deadzone"), false);

// Record key insertion order is not a configuration change.
const reordered = clone(base);
reordered.bindings = reordered.bindings.map(
  ({ input, kind, code, modifiers }) => ({ modifiers, code, kind, input }),
);
client = new FakeClient();
answer = await applyCalibration(client, reordered, pair);
assert.equal(answer.complete, true);
assert.equal(answer.unexpectedChanges, false);

const changed = clone(base);
changed.keys[3].actuation++;
client = new FakeClient(changed);
answer = await applyCalibration(client, base, pair);
assert.equal(answer.complete, false);
assert.equal(answer.unexpectedChanges, true);
assert.deepEqual(answer.profile, changed);
assert.deepEqual(answer.appliedKeys, []);
assert.equal(client.writes, 0, "preflight must not overwrite changed settings");

client = new FakeClient(base, { writeFail: 2 });
answer = await applyCalibration(client, base, pair);
assert.deepEqual(answer.appliedKeys, [0]);
assert.equal(answer.complete, false);
assert.equal(answer.unexpectedChanges, false);
assert.deepEqual(answer.profile.keys[8], base.keys[8]);
assert.equal(client.writes, 2);
assert.equal(client.reads, 2);
assert.match(answer.error, /1\/2/);

client = new FakeClient(base, { ackLost: 1 });
answer = await applyCalibration(client, base, pair);
assert.deepEqual(
  answer.appliedKeys,
  [0],
  "readback can identify a write despite ACK loss",
);
assert.equal(answer.complete, false);
assert.equal(client.writes, 1, "do not continue after uncertain write");
client = new FakeClient(base, { ackLost: 2 });
answer = await applyCalibration(client, base, pair);
assert.deepEqual(answer.appliedKeys, [0, 8]);
assert.equal(
  answer.complete,
  true,
  "exact full readback resolves final ACK loss",
);
assert.equal(answer.error, null);

client = new FakeClient(base, { echoMismatch: 1 });
answer = await applyCalibration(client, base, pair);
assert.equal(client.writes, 1);
assert.deepEqual(answer.appliedKeys, [0]);
assert.equal(answer.complete, false);
assert.match(answer.error, /응답/);

for (const options of [{ readFail: 2 }, { readFail: 2, ackLost: 1 }]) {
  client = new FakeClient(base, options);
  answer = await applyCalibration(client, base, pair);
  assert.equal(answer.profile, null);
  assert.deepEqual(answer.appliedKeys, [], "ACK alone is not final readback");
  assert.equal(answer.complete, false);
  assert.match(answer.error, /읽기 확인 실패/);
}
client = new FakeClient(base, { readFail: 1 });
answer = await applyCalibration(client, base, pair);
assert.equal(client.writes, 0);
assert.deepEqual(
  answer.profile,
  base,
  "second read may restore actual UI profile, but no SET is retried",
);
assert.equal(answer.complete, false);

for (const options of [{ outputFail: true }, { outputWrong: true }]) {
  client = new FakeClient(base, options);
  answer = await applyCalibration(client, base, pair);
  assert.equal(client.writes, 0);
  assert.equal(answer.complete, false);
  assert.deepEqual(answer.profile, base);
}

client = new FakeClient(base, { unexpected: true });
answer = await applyCalibration(client, base, pair);
assert.equal(answer.complete, false);
assert.equal(answer.unexpectedChanges, true);
assert.deepEqual(answer.appliedKeys, [0, 8]);
assert.notDeepEqual(answer.profile.bindings, base.bindings);

for (const invalid of [
  [],
  null,
  [pair[0], pair[0]],
  [{ ...pair[0], flags: 3 }],
  [{ ...pair[1], flags: 7 }],
  [{ ...pair[0], actuation: 250 }],
  [{ ...pair[0], noise_deadband: 10 }],
  [{ ...pair[1], bottom_deadzone: 126 }],
  [{ ...pair[0], pressed: 1127 }],
  [{ ...pair[0], pressed: 4096 }],
  [{ ...pair[0], released: 0.5 }],
]) {
  client = new FakeClient();
  answer = await applyCalibration(client, base, invalid);
  assert.equal(answer.complete, false);
  assert.equal(answer.profile, null);
  assert.equal(typeof answer.error, "string");
  assert.deepEqual(
    client.calls,
    [],
    "invalid calibration has no hardware side effects",
  );
}
console.log(
  "Batch calibration apply: subset preservation, preflight, partial failure, ACK-loss readback and validation passed",
);
