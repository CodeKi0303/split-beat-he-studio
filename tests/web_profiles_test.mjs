// Firmware 0.4.0 profiles (command 0x4D): codec parity with host/protocol.py and
// the demo simulator through the real KeyboardClient. No device access.
import assert from "node:assert/strict";
import {
  CAP_PROFILES, OP, PROFILE_NAME_BYTES, decodeProfileName, decodeProfileState, encodeProfileName, profileLabel,
} from "../web/protocol.mjs";
import { KeyboardClient } from "../web/device.mjs";
import { DemoTransport } from "../web/demo.mjs";

assert.equal(OP.PROFILE, 0x4d);
assert.equal(CAP_PROFILES, 0x1000000);
assert.deepEqual([...encodeProfileName("")], Array(PROFILE_NAME_BYTES).fill(0));
assert.equal(decodeProfileName(encodeProfileName("리듬")), "리듬");
assert.equal(encodeProfileName("리듬").length, PROFILE_NAME_BYTES);
for (const bad of ["x".repeat(17), "가나다라마바", "a\tb", 3]) assert.throws(() => encodeProfileName(bad));
assert.throws(() => decodeProfileName(Uint8Array.of(65, 0, 66, ...Array(13).fill(0))));
assert.deepEqual(decodeProfileState(Uint8Array.of(4, 1, 3)), { count: 4, active: 1, used: [0, 1] });
for (const bad of [Uint8Array.of(4, 2, 3), Uint8Array.of(3, 0, 1), Uint8Array.of(4, 0, 0x10), Uint8Array.of(4, 0)])
  assert.throws(() => decodeProfileState(bad));
assert.equal(profileLabel(2, ""), "프로필 3");
assert.equal(profileLabel(0, "FPS"), "FPS");

const transport = new DemoTransport();
const client = new KeyboardClient(transport);
assert.deepEqual(await client.profiles(), { count: 4, active: 0, used: [0], names: ["", "", "", ""] });
await client.createProfile(1, 0);
await client.renameProfile(1, "FPS");
assert.equal((await client.selectProfile(1)).active, 1);
const key = (await client.getConfig()).keys[4];
await client.setKey({ ...key, actuation: 800, rt_press: 150 });
await client.setBinding({ input: 4, kind: 1, code: 0x0b, modifiers: 0 });
await client.selectProfile(0);
let config = await client.getConfig();
assert.equal(config.keys[4].actuation, 2000, "profile 1 keeps its actuation");
assert.equal(config.bindings[4].code, 0x09, "profile 1 keeps its binding");
await client.selectProfile(1);
config = await client.getConfig();
assert.deepEqual([config.keys[4].actuation, config.keys[4].rt_press, config.bindings[4].code], [800, 150, 0x0b]);
assert.equal((await client.profiles()).names[1], "FPS");
await assert.rejects(client.deleteProfile(1), /BAD_CONFIG|status/);  // active profile
await assert.rejects(client.selectProfile(3), /BAD_CONFIG|status/);  // empty slot
assert.throws(() => client.selectProfile(4));
// SAVE keeps all profiles and the active one across a reconnect.
await client.save();
await transport.reconnect();
const reconnected = new KeyboardClient(transport);
assert.deepEqual((await reconnected.profiles()).used, [0, 1]);
assert.equal((await reconnected.profiles()).active, 1);
assert.equal((await reconnected.getConfig()).keys[4].actuation, 800);
// Older firmware: refused before any profile request reaches the device.
class OldFirmware extends DemoTransport {
  sent = [];
  command(op, payload) {
    this.sent.push(op);
    const reply = super.command(op, payload);
    if (op === OP.INFO) {
      const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
      view.setUint32(16, view.getUint32(16, true) & ~CAP_PROFILES, true);
    }
    return reply;
  }
}
const old = new OldFirmware();
await assert.rejects(new KeyboardClient(old).profiles(), /0\.4\.0/);
assert.ok(!old.sent.includes(OP.PROFILE), "no profile request on older firmware");
console.log("Profiles: codec, demo simulator switch/create/rename/delete, save+reconnect and capability gate PASS");
