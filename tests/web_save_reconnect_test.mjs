// In-memory WebHID only. Never enumerates or opens a physical device.
import assert from "node:assert/strict";
import { KeyboardClient, WebHIDTransport } from "../web/device.mjs";
import { DemoTransport } from "../web/demo.mjs";
import { VID, PID, USAGE_PAGE, USAGE, OP, packet, unpackPacket } from "../web/protocol.mjs";

class FakeDevice extends EventTarget {
  vendorId = VID; productId = PID; productName = "Split Hall";
  collections = [{ usagePage: USAGE_PAGE, usage: USAGE }];
  opened = true; opens = 0; closes = 0; ops = [];
  constructor(simulator, reply) { super(); this.simulator = simulator; this.reply = reply; }
  async open() { this.opens++; this.opened = true; }
  async close() { this.closes++; this.opened = false; }
  async sendReport(id, data) {
    const request = unpackPacket(data); this.ops.push(request.op);
    const response = this.reply ? await this.reply(request, data) : await this.simulator.exchange(data);
    if (!response) return;
    const encoded = packet(response.op, response.seq, response.payload, response.status);
    this.dispatchEvent(Object.assign(new Event("inputreport"), {
      reportId: 0, data: new DataView(encoded.buffer), device: this,
    }));
  }
}
const clock = () => {
  let now = 0;
  return { clock: () => now, sleep: async (ms) => { now += ms; }, elapsed: () => now };
};
const makeHID = (getDevices) => Object.assign(new EventTarget(), {
  getDevices, requestDevice: () => assert.fail("Recovery must not open a chooser"),
});

// SAVE ACK precedes a delayed reset. First INFO still comes from the old
// opened handle; later enumeration yields a different HIDDevice object.
for (const loseAck of [false, true]) {
  const simulator = new DemoTransport(), oldSimulator = new DemoTransport();
  simulator.profile.keys.forEach((key) => { key.flags |= 4; key.released = 1000; key.pressed = 3000; });
  simulator.enabled = true;
  oldSimulator.profile = structuredClone(simulator.profile);
  oldSimulator.enabled = true;
  let saved = false, enumerations = 0;
  const replacement = new FakeDevice(simulator);
  const old = new FakeDevice(oldSimulator, async (request, data) => {
    if (request.op === OP.SAVE) {
      saved = true;
      const response = await simulator.exchange(data);
      await simulator.reconnect();
      if (loseAck) throw Error("ACK lost after accepted SAVE");
      return response;
    }
    return oldSimulator.exchange(data);
  });
  const hid = makeHID(async () => {
    enumerations++;
    return saved && enumerations >= 3 ? [replacement] : [old];
  });
  const t = new WebHIDTransport(old, () => {}, { hid }), time = clock();
  const client = new KeyboardClient(t, time);
  const result = await client.save();
  assert.equal(result.verified, true);
  assert.equal(result.acknowledged, !loseAck);
  assert.equal(t.device, replacement);
  assert.ok(old.closes >= 1 && old.opens >= 1, "Stale opened handle was closed and reopened");
  assert.ok(old.ops.filter((op) => op === OP.INFO).length >= 2, "Early old INFO was not accepted");
  assert.equal([...old.ops, ...replacement.ops].filter((op) => op === OP.SAVE).length, 1);
  assert.equal([...old.ops, ...replacement.ops].includes(OP.OUTPUT), false);
  assert.ok(replacement.ops.every((op) => [OP.INFO, OP.STATUS, OP.GET_KEY, OP.GET_BINDING].includes(op)));
  assert.equal(client.outputEnabled, true);
  assert.equal(simulator.enabled, true);
  assert.deepEqual(result.config, simulator.profile);
  await t.close();
}

// Transport preserves an exact object even with multiple authorized devices,
// but will not select an arbitrary replacement after that object disappears.
{
  const old = new FakeDevice(new DemoTransport()), other = new FakeDevice(new DemoTransport());
  let devices = [old, other];
  const t = new WebHIDTransport(old, () => {}, { hid: makeHID(async () => devices) });
  await t.prepareSaveReconnect();
  await t.reconnect(100);
  assert.equal(t.device, old); assert.equal(other.opens, 0);
  devices = [other];
  await assert.rejects(t.reconnect(100), /구분할 수 없/);
  assert.equal(other.opens, 0);
  await t.close();
}
for (const mode of ["ambiguous", "different-product"]) {
  const old = new FakeDevice(new DemoTransport()), next = new FakeDevice(new DemoTransport());
  let devices = [old];
  const t = new WebHIDTransport(old, () => {}, { hid: makeHID(async () => devices) });
  await t.prepareSaveReconnect();
  if (mode === "different-product") next.productName = "Another keyboard";
  devices = mode === "ambiguous" ? [next, new FakeDevice(new DemoTransport())] : [next];
  await assert.rejects(t.reconnect(100), /구분할 수 없/);
  assert.equal(next.opens, 0);
  await t.close();
}

// Native open cannot be cancelled by a Promise timeout. A late completion is
// cleaned up before another transport may claim that same HIDDevice object.
{
  const device = new FakeDevice(new DemoTransport()); device.opened = false;
  let finishOpen;
  device.open = async function () {
    this.opens++;
    if (this.opens === 1) await new Promise((resolve) => { finishOpen = resolve; });
    this.opened = true;
  };
  const hid = makeHID(async () => [device]);
  const old = new WebHIDTransport(device, () => {}, { hid });
  await old.prepareSaveReconnect();
  await assert.rejects(old.reconnect(20), /USB 열기가 지연/);
  assert.equal(device.opened, false);
  const oldClose = old.close();
  const next = new WebHIDTransport(device, () => {}, { hid });
  const nextOpen = next.open();
  assert.equal(device.opens, 1, "New owner waits for the pending native open");
  finishOpen();
  await Promise.all([oldClose, nextOpen]);
  assert.equal(device.closes, 1, "Late old open was closed exactly once");
  assert.equal(device.opens, 2);
  assert.equal(device.opened, true, "New owner remains open after old cleanup");
  await old.close();
  assert.equal(device.opened, true, "Old owner's repeated close cannot close new owner");
  await next.close();
  assert.equal(device.closes, 2);
}
{
  const device = new FakeDevice(new DemoTransport()); device.opened = false;
  let finishOpen;
  device.open = async function () {
    this.opens++;
    await new Promise((resolve) => { finishOpen = resolve; });
    this.opened = true;
  };
  const hid = makeHID(async () => [device]);
  const old = new WebHIDTransport(device, () => {}, { hid });
  await assert.rejects(old.open(20), /USB 열기가 지연/);
  const next = new WebHIDTransport(device, () => {}, { hid });
  await assert.rejects(next.open(20), /USB 열기가 지연/, "Manual reconnect is bounded while native open remains pending");
  finishOpen();
  await Promise.all([old.close(), next.close()]);
  assert.equal(device.opened, false);
  assert.equal(device.opens, 1, "Cancelled waiting transport must never open later");
}

class RecoveryScenario extends DemoTransport {
  ops = []; reconnects = 0;
  constructor(fault) { super(); this.fault = fault; }
  async exchange(data) {
    const request = unpackPacket(data); this.ops.push(request.op);
    if (this.reconnects === 1 && request.op === OP.GET_KEY && request.payload[0] === 5 && this.fault === "mid-read-reset")
      throw Error("Reset during profile readback");
    return super.exchange(data);
  }
  async reconnect() {
    this.reconnects++;
    await super.reconnect();
    if (this.fault === "no-save") this.generation = 0;
    if (this.fault === "wrong-profile") this.profile.keys[0].actuation++;
    if (this.fault === "unexpected-output") this.enabled = true;
  }
}
for (const fault of ["mid-read-reset", "no-save", "wrong-profile", "unexpected-output"]) {
  const t = new RecoveryScenario(fault), time = clock();
  const client = new KeyboardClient(t, time);
  if (fault === "mid-read-reset") {
    assert.equal((await client.save()).verified, true);
    assert.equal(t.reconnects, 2);
  } else {
    await assert.rejects(client.save(), /영구 저장 검증 실패/);
    assert.ok(time.elapsed() <= 20000 && t.reconnects <= 80, "Recovery is bounded");
  }
  assert.equal(t.ops.filter((op) => op === OP.SAVE).length, 1);
  assert.equal(t.ops.includes(OP.OUTPUT), false, "Recovery never enables or mutates output");
}
{
  const transport = new RecoveryScenario(null);
  for (const key of transport.profile.keys)
    Object.assign(key, { flags: key.flags | 4, released: 1000, pressed: 3000 });
  const client = new KeyboardClient(transport, clock());
  assert.equal(await client.output(true), true);
  assert.equal((await client.save()).outputEnabled, true);
  assert.equal(client.outputEnabled, true);
  assert.equal(transport.ops.filter((op) => op === OP.OUTPUT).length, 1);
  assert.equal(await client.output(false), false);
  assert.equal((await client.save()).outputEnabled, false);
}
console.log("SAVE recovery: re-enumeration, lost ACK, readback and saved output on/off PASS (fake devices only)");
