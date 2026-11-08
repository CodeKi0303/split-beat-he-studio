import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
globalThis.crypto ??= webcrypto;
import { FW, FirmwareClient, FirmwareStatusError, validateFirmware, crc32 } from "../web/fw-protocol.mjs";
import { FirmwareDemoTransport, demoPackage } from "../web/fw-demo.mjs";
import { FirmwareHIDTransport } from "../web/updater.mjs";
import { packet, unpackPacket, VID, PID, USAGE_PAGE, USAGE } from "../web/protocol.mjs";
assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
const left = await demoPackage(), right = await demoPackage(1);
const client = (t) => new FirmwareClient(t, { delay: async () => {} });
for (const role of [0, 1]) {
  const t = new FirmwareDemoTransport(), c = client(t), p = role ? right : left;
  const result = await c.update(p, { target: role, confirmed: true, fullReadback: true, session: 0x12345678 });
  assert.equal(result.mode, 1); assert.equal(result.version, 0x30000);
  const begin = t.calls.find((r) => r.op === FW.BEGIN);
  assert.equal(begin.timeout, 15000); assert.equal(begin.payload.length, 32); assert.equal(begin.role, role);
  assert.deepEqual(begin.payload.slice(0, 12), new Uint8Array(12).fill(role + 1));
  assert.equal(new DataView(begin.payload.buffer).getUint32(16, true), 0x12345678);
  assert.equal(t.calls.filter((r) => r.op === FW.WRITE).length, p.image_size / 32);
  assert.equal(t.calls.filter((r) => r.op === FW.READ).length, Math.ceil(p.image_size / 48));
  assert.equal(t.calls.at(-1).op, role ? FW.RUN : FW.INFO);
  if (role) assert.equal(t.calls.at(-1).role, 0);
  assert(t.calls.every((r) => r.op >= 0x30)); // No implicit SAVE/OUTPUT or normal INFO.
}
for (const scenario of ["unconfirmed", "role", "sha", "crc", "size", "identity", "session"]) {
  const t = new FirmwareDemoTransport(), c = client(t), p = { ...left };
  let options = { target: 0, confirmed: true, session: 1 };
  if (scenario === "unconfirmed") options.confirmed = false;
  if (scenario === "role") options.target = 1;
  if (scenario === "sha") p.sha256 = "0".repeat(64);
  if (scenario === "crc") p.crc32 ^= 1;
  if (scenario === "size") p.image_size -= 1;
  if (scenario === "identity") {
    const image = Uint8Array.from(atob(p.image_base64), (c) => c.charCodeAt(0)); image[0x409] = 1;
    p.crc32 = crc32(image); p.image_base64 = btoa(String.fromCharCode(...image));
    p.sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", image)).toString("hex");
  }
  if (scenario === "session") options.session = 0;
  await assert.rejects(c.update(p, options));
  assert(!t.calls.some((r) => [FW.BEGIN, FW.WRITE, FW.COMMIT].includes(r.op)), scenario);
}
for (const options of [{ onlyNewer: true }, { expectedUid: "ff".repeat(12) }]) {
  const transport = new FirmwareDemoTransport();
  transport.boards[0].version = left.version_number;
  await assert.rejects(client(transport).update(left, { target: 0, confirmed: true, ...options }));
  assert.deepEqual(transport.calls.map((call) => call.op), [FW.INFO]);
}
class FaultTransport extends FirmwareDemoTransport {
  constructor(fault) { super(); this.fault = fault; this.fired = false; }
  async exchange(bytes, timeout) {
    const p = unpackPacket(bytes), op = p.op >= 0x50 ? p.op - 0x20 : p.op;
    if (this.fault === "old") return packet(p.op | 128, p.seq, new Uint8Array(), 1);
    const r = await super.exchange(bytes, timeout);
    if (this.fault === "uncertain-begin" && op === FW.BEGIN) throw Error("lost BEGIN ACK");
    if (this.fault === "failed-write" && op === FW.WRITE) throw Error("lost WRITE ACK");
    if (this.fault === "bad-read" && op === FW.READ) { const q = unpackPacket(r); q.payload[0] ^= 1; return packet(q.op, q.seq, q.payload); }
    if (this.fault === "wrong-uid" && op === FW.ENTER) this.boards[0].uid.fill(9);
    if (this.fault === "wrong-offset" && op === FW.WRITE) this.boards[0].next -= 1;
    return r;
  }
}
for (const fault of ["old", "uncertain-begin", "failed-write", "bad-read", "wrong-uid", "wrong-offset"]) {
  const t = new FaultTransport(fault), c = client(t);
  await assert.rejects(c.update(left, { target: 0, confirmed: true, fullReadback: true, session: 7 }));
  assert(t.calls.filter((r) => r.op === FW.BEGIN).length <= 1, fault);
  assert(!t.calls.some((r) => r.op === FW.RUN), fault);
  if (["old", "wrong-uid"].includes(fault)) assert(!t.calls.some((r) => r.op === FW.BEGIN));
}
const old = client(new FaultTransport("old"));
await assert.rejects(old.info(), (e) => e instanceof FirmwareStatusError && /SWD/.test(e.message));
const boot = new FirmwareDemoTransport(); boot.boards[0].mode = 0; boot.boards[0].flags = 1;
await client(boot).update(left, { target: 0, confirmed: true });
assert(!boot.calls.some((r) => r.op === FW.ENTER));
await assert.rejects(validateFirmware({ ...left, image_base64: "!" }));
const pending = new FirmwareDemoTransport(); pending.boards[0].mode = 0; pending.boards[0].session = 42;
await assert.rejects(client(pending).update(left, { target: 0, confirmed: true }), /전원/);
assert(!pending.calls.some((r) => r.op === FW.BEGIN));

// A reset can happen after reconnect already reopened the old OS handle.
// Exercise both ENTER and final RUN while forbidding replay of mutations.
class ResetRaceTransport extends FirmwareDemoTransport {
  constructor(when, fault, loseAck = false) { super(); this.when = when; this.fault = fault; this.loseAck = loseAck; this.race = null; this.reconnects = []; this.time = 0; this.mismatchReads = 0; }
  async reconnect(timeout) {
    this.reconnects.push(timeout); assert(timeout > 0 && timeout <= 1000);
    this.time += this.fault === "deadline" ? timeout : 100;
    if (this.race) {
      this.race.opens++;
      if (this.fault === "reopen-fails" && this.race.opens === 1) throw Error("not enumerated yet");
    }
  }
  async exchange(bytes, timeout) {
    const request = unpackPacket(bytes), response = await super.exchange(bytes, timeout);
    if (request.op === this.when) {
      this.race = { opens: 0, previousMode: this.when === FW.ENTER ? 1 : 0 };
      if (this.loseAck) throw Error("mode ACK lost during reset");
    } else if (request.op === FW.INFO && this.race) {
      if (["unavailable", "deadline"].includes(this.fault) ||
          (this.race.opens === 1 && ["disconnect", "wrong-uid", "wrong-role"].includes(this.fault))) throw Error("old handle disconnected after reopen");
      const decoded = unpackPacket(response);
      if (this.fault === "old-mode" && this.race.opens === 1) decoded.payload[3] = this.race.previousMode;
      if (this.fault === "wrong-uid") { decoded.payload[36] ^= 0x40; this.mismatchReads++; }
      if (this.fault === "wrong-role") { decoded.payload[2] = 1; this.mismatchReads++; }
      return packet(decoded.op, decoded.seq, decoded.payload);
    }
    return response;
  }
}
const raceClient = (t) => new FirmwareClient(t, { clock: () => t.time, delay: async (ms) => { t.time += ms; } });
for (const when of [FW.ENTER, FW.RUN]) {
  for (const fault of ["disconnect", "old-mode", "reopen-fails"]) {
    const t = new ResetRaceTransport(when, fault, fault === "disconnect"), c = raceClient(t);
    const result = await c.update(left, { target: 0, confirmed: true, session: 9 });
    assert.equal(result.mode, 1);
    for (const op of [FW.ENTER, FW.BEGIN, FW.COMMIT, FW.RUN]) assert.equal(t.calls.filter((r) => r.op === op).length, 1, `${when}/${fault}/${op}`);
    assert.equal(t.calls.filter((r) => r.op === FW.WRITE).length, left.image_size / 32);
    assert(t.reconnects.length >= 3, `${when}/${fault}: reopened after the initial race`);
  }
}
for (const fault of ["wrong-uid", "wrong-role", "unavailable", "deadline"]) {
  const t = new ResetRaceTransport(FW.ENTER, fault), c = raceClient(t);
  await assert.rejects(c.update(left, { target: 0, confirmed: true, session: 9 }));
  assert.equal(t.calls.filter((r) => r.op === FW.ENTER).length, 1);
  assert(!t.calls.some((r) => [FW.BEGIN, FW.WRITE, FW.COMMIT, FW.RUN].includes(r.op)));
  assert(t.reconnects.length <= 40 && t.time <= 20000, fault);
  if (fault.startsWith("wrong")) assert.equal(t.mismatchReads, 1, "Identity mismatch is fatal, never a retry condition");
  if (fault === "unavailable") assert.equal(t.reconnects.length, 40, "Attempt bound also applies with fast failures");
}
class RemoteNoReopen extends FirmwareDemoTransport { async reconnect() { assert.fail("A right mode change must not reopen the left USB transport"); } }
await client(new RemoteNoReopen()).update(right, { target: 1, confirmed: true, session: 5 });

// Test the actual browser reconnect helper with granted fake HID devices.
// Timers are simulated; requestDevice must never be used by recovery.
{
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalNow = Date.now, originalTimeout = globalThis.setTimeout;
  let time = 0, devices = [], manualRequests = 0;
  const fakeDevice = () => ({ vendorId: VID, productId: PID, collections: [{ usagePage: USAGE_PAGE, usage: USAGE }], opened: true,
    closes: 0, opens: 0, addEventListener() {}, removeEventListener() {},
    async close() { this.closes++; this.opened = false; }, async open() { this.opens++; this.opened = true; } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { hid: {
    addEventListener() {}, removeEventListener() {}, async getDevices() { return devices; },
    async requestDevice() { manualRequests++; throw Error("Permission prompts are forbidden during recovery"); },
  } } });
  Date.now = () => time;
  globalThis.setTimeout = (callback, ms) => { time += ms; queueMicrotask(callback); return 0; };
  try {
    const oldDevice = fakeDevice(), newDevice = fakeDevice();
    const t = new FirmwareHIDTransport(oldDevice);
    devices = [oldDevice]; await t.reconnect(1000);
    assert.equal(oldDevice.closes, 1); assert.equal(oldDevice.opens, 1);
    devices = [newDevice]; await t.reconnect(1000);
    assert.equal(t.device, newDevice); assert.equal(oldDevice.closes, 2);
    devices = []; const started = time;
    await assert.rejects(t.reconnect(1000), /재연결/);
    assert.equal(time - started, 1000); assert.equal(manualRequests, 0);
    await assert.rejects(t.reconnect(0), /제한 시간/);
    await t.close();
  } finally {
    Date.now = originalNow; globalThis.setTimeout = originalTimeout;
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor); else delete globalThis.navigator;
  }
}
console.log("Firmware updater JS: package identity/hash, left/right routing, readback, recovery, no automatic destructive retry PASS (mock only)");
