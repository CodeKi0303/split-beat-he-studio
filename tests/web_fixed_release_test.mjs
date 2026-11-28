import assert from "node:assert/strict";
import { CAP_FIXED_RELEASE, KEY_FIELDS, OP, TRAVEL_MAX, encodeKey, decodeKey, keyRecord } from "../web/protocol.mjs";
import { KeyboardClient } from "../web/device.mjs";
import { DemoTransport } from "../web/demo.mjs";
import { SampledRT } from "../web/rhythm-analysis.mjs";
import { proposePerformanceSettings, applyPerformanceSettings } from "../web/performance-settings.mjs";
import { makeUiProfile, parseUiProfile } from "../web/ui-profile.mjs";

class ObservedTransport extends DemoTransport {
  operations = [];
  command(op, payload) {
    this.operations.push([op, payload.length]);
    return super.command(op, payload);
  }
}
const transport = new ObservedTransport({ fixedRelease: true });
const client = new KeyboardClient(transport);
const capabilities = (await client.info()).capabilities;
assert.ok(capabilities & CAP_FIXED_RELEASE);
const initial = await client.getConfig();
assert.equal(transport.operations.filter(([op, bytes]) => op === OP.KEY_EXT && bytes === 1).length, 14);
assert.equal(transport.operations.some(([op]) => op === OP.GET_KEY), false);
for (const key of initial.keys) Object.assign(key, { flags: 5, released: 1000, pressed: 3000, noise_deadband: 0 });
await client.importProfile(initial);
const travels = Array(14).fill(4);
travels[7] = 3.2;
const patch = proposePerformanceSettings(initial, [0, 7], travels,
  { actuation: 1, fixed_release: .7 }, capabilities);
assert.deepEqual(patch.map(k => [k.actuation, k.fixed_release]), [[2500, 1750], [3125, 2188]]);
const record = encodeKey(patch[0], false, true);
assert.equal(new DataView(record.buffer).getUint16(20, true), 1750);
assert.deepEqual(decodeKey(record, false, true), patch[0]);
assert.throws(() => decodeKey(record), /reserved/);
assert.throws(() => encodeKey(patch[0]), /확장/);
for (const invalid of [null, .5, -1, 1, patch[0].actuation, TRAVEL_MAX])
  assert.throws(() => keyRecord({ ...patch[0], fixed_release: invalid }));
assert.equal(keyRecord({ ...patch[0], fixed_release: patch[0].top_deadzone }).fixed_release, patch[0].top_deadzone);
assert.deepEqual(Object.keys(keyRecord({ ...patch[0], fixed_release: 0 })).sort(), [...KEY_FIELDS].sort());

const outcome = await applyPerformanceSettings(client, initial, patch);
assert.equal(outcome.complete, true, outcome.error);
const exported = makeUiProfile(outcome.profile, travels);
assert.deepEqual(parseUiProfile(JSON.parse(JSON.stringify(exported))).device, outcome.profile);
await client.createProfile(1, 0);
await client.selectProfile(1);
await client.setKey({ ...patch[0], fixed_release: 0 });
assert.equal((await client.getConfig()).keys[0].fixed_release, undefined);
await client.selectProfile(0);
assert.equal((await client.getConfig()).keys[0].fixed_release, 1750);
// Legacy requests on new firmware leave the extended setting untouched.
await client.request(OP.SET_KEY, encodeKey({ ...patch[0], fixed_release: 0, noise_deadband: 1 }));
assert.equal((await client.getConfig()).keys[0].fixed_release, 1750);
assert.equal(decodeKey(await client.request(OP.GET_KEY, Uint8Array.of(0))).fixed_release, undefined);
const replay = (cfg) => {
  const model = new SampledRT(cfg);
  return [1000, 1499, 1500, 1499, 1351, 1350, 1351, 1500].map(raw => model.step(raw).pressed);
};
assert.deepEqual(replay(patch[0]), [false, false, true, true, true, false, false, true]);
assert.deepEqual(replay({ ...patch[0], fixed_release: 0 }), [false, false, true, false, false, false, false, true]);
assert.deepEqual(replay({ ...patch[0], flags: 7 }), replay({ ...patch[0], flags: 7, fixed_release: 0 }));
await client.importProfile(initial);
assert.deepEqual(await client.getConfig(), initial, "old backups restore linked thresholds on new firmware");

const oldTransport = new ObservedTransport();
const old = new KeyboardClient(oldTransport);
await assert.rejects(old.importProfile(outcome.profile), /0\.5\.0/);
assert.deepEqual(oldTransport.operations, [[OP.INFO, 0]], "incompatible backups rejected before output or writes");
await old.importProfile(initial);
assert.ok(oldTransport.operations.some(([op]) => op === OP.SET_KEY));
assert.ok(oldTransport.operations.every(([op]) => op !== OP.KEY_EXT));
console.log("Fixed release wire format, two-key application, profiles, backup compatibility and replay boundaries PASS");
