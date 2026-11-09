import assert from "node:assert/strict";
import {
  crc16,
  packet,
  unpackPacket,
  validateProfile,
  encodeKey,
  decodeKey,
  encodeBinding,
  decodeBinding,
  decodeInfo,
  keyRecord,
  CAP_BOTTOM_DEADZONE,
  CAP_KEY_CHORD,
  ADC_DIAGNOSTICS,
  ADC_DIAGNOSTIC_FIELDS,
  decodeAdcDiagnostics,
  SCHEDULER_DIAGNOSTICS,
  SCHEDULER_FIELDS,
  decodeSchedulerDiagnostics,
  CAP_ADC_TRACE,
  ADC_TRACE,
  encodeAdcTraceKeys,
  decodeAdcTrace,
  CAP_CPU_PROFILE,
  CPU_PROFILE,
  CPU_PROFILE_FIELDS,
  CPU_PROFILE_STAGES,
  decodeCpuProfileBegin,
  decodeCpuProfilePage,
  CAP_ADC_IRQ_PROFILE,
  ADC_IRQ_PROFILE,
  ADC_IRQ_PROFILE_FIELDS,
  ADC_IRQ_PROFILE_STAGES,
  decodeAdcIrqProfileBegin,
  decodeAdcIrqProfilePage,
} from "../web/protocol.mjs";
import { KeyboardClient } from "../web/device.mjs";
import { DemoTransport } from "../web/demo.mjs";
// The ordinary configuration client must never bypass updater confirmation,
// including right INFO, which pauses scan/output despite its name.
for (const identified of [false, true]) {
  let calls = 0;
  const guarded = new KeyboardClient({ exchange: async () => { calls++; throw Error("unexpected transport I/O"); } });
  guarded.identified = identified;
  for (const op of [...Array.from({length:7}, (_, i) => 0x30+i), ...Array.from({length:7}, (_, i) => 0x50+i), 0x3f, 0x4a, 0, 11, 255, true, 1.5])
    await assert.rejects(guarded.request(op, new TextEncoder().encode("UPD3")), /전용 업데이터/);
  assert.equal(calls, 0);
  assert.equal(guarded.seq, 0);
}
// Diagnostics use only their requested opcode, without INFO/OUTPUT or mutation.
for (const op of [0x40, 0x41, ADC_DIAGNOSTICS, SCHEDULER_DIAGNOSTICS]) {
  const calls = [];
  const diagnostics = new KeyboardClient({ exchange: async (raw) => {
    const request = unpackPacket(raw); calls.push(request.op);
    assert.equal(request.op, op); assert.equal(request.status, 0);
    assert.equal(request.payload.length, 0);
    return {op: op | 128, seq: request.seq, status: 0, payload: new Uint8Array(52)};
  }});
  diagnostics.outputEnabled = true;
  assert.equal((await diagnostics.request(op)).length, 52);
  assert.deepEqual(calls, [op]);
  assert.equal(diagnostics.identified, false);
  assert.equal(diagnostics.outputEnabled, true);
}
const schedulerBacking = new Uint8Array(60), schedulerPayload = schedulerBacking.subarray(4, 56);
const schedulerView = new DataView(schedulerPayload.buffer, schedulerPayload.byteOffset, 52);
const schedulerValues = [0xfffffffe, 2, 30, 4, 5, 6, 7, 15, 9, 10, 11, 12, 13];
schedulerValues.forEach((value, i) => schedulerView.setUint32(i * 4, value, true));
assert.deepEqual(decodeSchedulerDiagnostics(schedulerPayload),
  Object.fromEntries(SCHEDULER_FIELDS.map((name, i) => [name, schedulerValues[i]])));
for (const length of [0, 4, 48, 51, 53, 56])
  assert.throws(() => decodeSchedulerDiagnostics(new Uint8Array(length)), /52 bytes/);
schedulerView.setUint32(28, 16, true);
assert.throws(() => decodeSchedulerDiagnostics(schedulerPayload), /link flags/);
// Same field order and unsigned stop evidence as the C/Python codecs, including
// a Uint8Array offset within a larger transport buffer.
const adcValues = [0, 0, 1, 0, 0, 1, 0, 3, 0xfffffff0, 0x30, 16, 12, 96000];
const adcBacking = new Uint8Array(60), adcPayload = adcBacking.subarray(4, 56);
const adcView = new DataView(adcPayload.buffer, adcPayload.byteOffset, adcPayload.byteLength);
adcValues.forEach((value, i) => adcView.setUint32(i * 4, value, true));
assert.deepEqual(decodeAdcDiagnostics(adcPayload), {
  ...Object.fromEntries(ADC_DIAGNOSTIC_FIELDS.map((name, i) => [name, adcValues[i]])),
  stop_reason_name: "OWNERSHIP",
});
for (const length of [0, 4, 48, 51, 53, 56])
  assert.throws(() => decodeAdcDiagnostics(new Uint8Array(length)), /52 bytes/);
adcView.setUint32(0, 2, true);
assert.throws(() => decodeAdcDiagnostics(adcPayload), /running flag/);
adcView.setUint32(0, 1, true);
for (const [reason, name] of ["NONE", "FLAGS", "EPOCH", "OWNERSHIP", "RAW_RANGE", "FILTER", "ADC_OVR", "DMA"].entries()) {
  adcView.setUint32(28, reason, true);
  assert.equal(decodeAdcDiagnostics(adcPayload).stop_reason_name, name);
}
adcView.setUint32(28, 99, true);
assert.equal(decodeAdcDiagnostics(adcPayload).stop_reason, 99);
assert.equal(decodeAdcDiagnostics(adcPayload).stop_reason_name, "UNKNOWN");
// Same 54-byte maximum-payload trace fixture as the Python wire tests.
assert.equal(CAP_ADC_TRACE, 0x400);
assert.equal(ADC_TRACE, 0x44);
const traceBacking = new Uint8Array(64), tracePayload = traceBacking.subarray(5, 59);
const traceView = new DataView(tracePayload.buffer, tracePayload.byteOffset, tracePayload.byteLength);
traceView.setUint32(0, 0xfffffffe, true); traceView.setUint32(4, 0x12345678, true);
traceView.setUint8(8, 5); traceView.setUint8(9, 6);
const traceRows = [
  [...Array.from({length: 8}, (_, i) => 1000 + i), 1004, 1005, 0x8000 | 321],
  [...Array(8).fill(4095), 4095, 4094, 1000],
];
traceRows.forEach((values, row) => values.forEach((value, i) => traceView.setUint16(10 + row * 22 + i * 2, value, true)));
assert.deepEqual(decodeAdcTrace(tracePayload), {
  sample_sequence: 0xfffffffe, timestamp_us: 0x12345678, keys: [5, 6],
  rows: [
    {key: 5, raw_history: Array.from({length: 8}, (_, i) => 1000 + i), averaged: 1004,
      after_deadband: 1005, travel: 321, pressed: true},
    {key: 6, raw_history: Array(8).fill(4095), averaged: 4095,
      after_deadband: 4094, travel: 1000, pressed: false},
  ],
});
assert.deepEqual(unpackPacket(packet(ADC_TRACE | 128, 9, tracePayload)).payload, tracePayload);
assert.deepEqual(encodeAdcTraceKeys([6, 0]), Uint8Array.of(6, 0));
for (const keys of [null, {}, [], [5], [5, 6, 2], [5, 5], [-1, 6], [0, 7], [true, 6], [5.1, 6], ["5", 6]])
  assert.throws(() => encodeAdcTraceKeys(keys), /two distinct local keys/);
for (const length of [0, 10, 52, 53, 55, 64])
  assert.throws(() => decodeAdcTrace(new Uint8Array(length)), /54 bytes/);
for (const [offset, value, width] of [[8, 7, 1], [9, 5, 1],
  [10, 4096, 2], [26, 4096, 2], [28, 4096, 2], [32, 4096, 2], [48, 4096, 2], [50, 4096, 2],
  [30, 1001, 2], [52, 1023, 2], ...Array.from({length: 5}, (_, i) => [30, 1 << (10 + i), 2])]) {
  const bad = tracePayload.slice(), view = new DataView(bad.buffer);
  if (width === 1) view.setUint8(offset, value); else view.setUint16(offset, value, true);
  assert.throws(() => decodeAdcTrace(bad));
}
// Do not conceal a filter/history inconsistency behind a decoder exception.
const inconsistentTrace = tracePayload.slice();
new DataView(inconsistentTrace.buffer).setUint16(26, 2000, true);
assert.equal(decodeAdcTrace(inconsistentTrace).rows[0].averaged, 2000);
const traceCalls = [];
const traceClient = new KeyboardClient({exchange: async raw => {
  const q = unpackPacket(raw); traceCalls.push(q.op);
  assert.deepEqual(q.payload, Uint8Array.of(5, 6));
  return {op: q.op | 128, seq: q.seq, status: 0, payload: tracePayload};
}});
traceClient.outputEnabled = true;
assert.equal((await traceClient.request(ADC_TRACE, encodeAdcTraceKeys([5, 6]))).length, 54);
assert.deepEqual(traceCalls, [ADC_TRACE]);
assert.equal(traceClient.outputEnabled, true);
// CPU-profile pages use explicit IDs and one run token; no UI/runtime start.
assert.equal(CAP_CPU_PROFILE, 0x800);
assert.equal(CPU_PROFILE, 0x45);
const profileBegin = Uint8Array.of(0xfe, 0xff, 0xff, 0xff);
assert.equal(decodeCpuProfileBegin(profileBegin), 0xfffffffe);
for (const bytes of [new Uint8Array(), new Uint8Array(3), new Uint8Array(4), new Uint8Array(5), null])
  assert.throws(() => decodeCpuProfileBegin(bytes));
const profileValues = [0xfffffffe, 60000240, 240000000, 60000000, 5000, 2000, 12000000, 5001];
const profileBacking = new Uint8Array(40), profileSummary = profileBacking.subarray(3, 35);
const profileSummaryView = new DataView(profileSummary.buffer, profileSummary.byteOffset, 32);
profileValues.forEach((value, i) => profileSummaryView.setUint32(i * 4, value, true));
assert.deepEqual(decodeCpuProfilePage(profileSummary, 0),
  Object.fromEntries(CPU_PROFILE_FIELDS.map((name, i) => [name, profileValues[i]])));
const profilePages = [profileSummary];
for (let page = 1; page <= 4; page++) {
  const backing = new Uint8Array(54), payload = backing.subarray(4, 48);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  view.setUint32(0, 0xfffffffe, true); view.setUint8(4, 3);
  const rows = Array.from({length: 3}, (_, i) => {
    const id = (page - 1) * 3 + i, offset = 5 + i * 13;
    const total = id === 11 ? 0 : 2400 * (id + 1), maximum = id === 11 ? 0 : 240 * (id + 1);
    view.setUint8(offset, id); view.setUint32(offset + 1, 10 + id, true);
    view.setUint32(offset + 5, total, true); view.setUint32(offset + 9, maximum, true);
    return {id, name: CPU_PROFILE_STAGES[id], calls: 10 + id, total_cycles: total, max_cycles: maximum};
  });
  assert.deepEqual(decodeCpuProfilePage(payload, page), {run_id: 0xfffffffe, rows});
  assert.deepEqual(unpackPacket(packet(CPU_PROFILE | 128, page, payload)).payload, payload);
  profilePages.push(payload);
}
for (const page of [true, -1, 5, .5, "1"])
  assert.throws(() => decodeCpuProfilePage(profileSummary, page), /page must/);
for (let page = 0; page <= 4; page++) {
  const payload = profilePages[page];
  for (const size of [0, payload.length - 1, payload.length + 1])
    assert.throws(() => decodeCpuProfilePage(new Uint8Array(size), page));
  const bad = payload.slice(); bad.fill(0, 0, 4);
  assert.throws(() => decodeCpuProfilePage(bad, page), /run_id/);
}
for (const [offset, value] of [[4, 0], [8, 0], [12, 0], [4, 59999999], [12, 59999999]]) {
  const bad = profileSummary.slice(); new DataView(bad.buffer).setUint32(offset, value, true);
  assert.throws(() => decodeCpuProfilePage(bad, 0));
}
for (const [offset, value] of [[4, 0], [4, 2], [4, 4], [5, 1], [18, 0], [31, 12]]) {
  const bad = profilePages[1].slice(); bad[offset] = value;
  assert.throws(() => decodeCpuProfilePage(bad, 1));
}
for (const offset of [36, 40]) {
  const bad = profilePages[4].slice(); new DataView(bad.buffer).setUint32(offset, 1, true);
  assert.throws(() => decodeCpuProfilePage(bad, 4), /zero timing/);
}
const profileRequests = [];
const profileClient = new KeyboardClient({exchange: async raw => {
  const q = unpackPacket(raw); profileRequests.push([...q.payload]);
  assert.equal(q.op, CPU_PROFILE);
  return {op: q.op | 128, seq: q.seq, status: 0,
    payload: q.payload[0] === 0 ? profileBegin : profilePages[q.payload[1]]};
}});
profileClient.outputEnabled = true;
assert.equal(decodeCpuProfileBegin(await profileClient.request(CPU_PROFILE, Uint8Array.of(0))), 0xfffffffe);
for (let page = 0; page <= 4; page++)
  assert.equal(decodeCpuProfilePage(await profileClient.request(CPU_PROFILE, Uint8Array.of(1, page)), page).run_id, 0xfffffffe);
assert.deepEqual(profileRequests, [[0], [1, 0], [1, 1], [1, 2], [1, 3], [1, 4]]);
assert.equal(profileClient.outputEnabled, true);
// Narrow ADC IRQ profiling: 500ms summary plus two pages of partition rows.
assert.equal(CAP_ADC_IRQ_PROFILE, 0x1000);
assert.equal(ADC_IRQ_PROFILE, 0x46);
const irqBegin = Uint8Array.of(0xf0, 0xff, 0xff, 0xff);
assert.equal(decodeAdcIrqProfileBegin(irqBegin), 0xfffffff0);
for (const bytes of [new Uint8Array(), new Uint8Array(3), new Uint8Array(4), new Uint8Array(5), null])
  assert.throws(() => decodeAdcIrqProfileBegin(bytes));
const irqValues = [0xfffffff0, 120000240, 240000000, 120000000, 500, 2, 10000, 4000, 32000, 0];
const irqBacking = new Uint8Array(48), irqSummary = irqBacking.subarray(3, 43);
const irqView = new DataView(irqSummary.buffer, irqSummary.byteOffset, 40);
irqValues.forEach((value, i) => irqView.setUint32(i * 4, value, true));
assert.deepEqual(decodeAdcIrqProfilePage(irqSummary, 0),
  Object.fromEntries(ADC_IRQ_PROFILE_FIELDS.map((name, i) => [name, irqValues[i]])));
const irqPages = [irqSummary], irqTotals = [1800000, 120000, 240000, 360000, 480000, 600000];
const irqMaxima = [9000, 1000, 2000, 3000, 4000, 5000];
for (let page = 1; page <= 2; page++) {
  const backing = new Uint8Array(54), payload = backing.subarray(4, 48);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  view.setUint32(0, 0xfffffff0, true); view.setUint8(4, 3);
  const rows = Array.from({length: 3}, (_, i) => {
    const id = (page - 1) * 3 + i, offset = 5 + i * 13;
    view.setUint8(offset, id); view.setUint32(offset + 1, 500, true);
    view.setUint32(offset + 5, irqTotals[id], true); view.setUint32(offset + 9, irqMaxima[id], true);
    return {id, name: ADC_IRQ_PROFILE_STAGES[id], calls: 500, total_cycles: irqTotals[id], max_cycles: irqMaxima[id]};
  });
  assert.deepEqual(decodeAdcIrqProfilePage(payload, page), {run_id: 0xfffffff0, rows});
  assert.deepEqual(unpackPacket(packet(ADC_IRQ_PROFILE | 128, page, payload)).payload, payload);
  irqPages.push(payload);
}
for (const page of [true, -1, 3, .5, "1"])
  assert.throws(() => decodeAdcIrqProfilePage(irqSummary, page), /page must/);
for (let page = 0; page <= 2; page++) {
  const payload = irqPages[page];
  for (const size of [0, payload.length - 1, payload.length + 1])
    assert.throws(() => decodeAdcIrqProfilePage(new Uint8Array(size), page));
  const bad = payload.slice(); bad.fill(0, 0, 4);
  assert.throws(() => decodeAdcIrqProfilePage(bad, page), /run_id/);
}
for (const [offset, value] of [[4, 0], [8, 0], [12, 0], [4, 119999999], [12, 119999999], [36, 1]]) {
  const bad = irqSummary.slice(); new DataView(bad.buffer).setUint32(offset, value, true);
  assert.throws(() => decodeAdcIrqProfilePage(bad, 0));
}
for (const [offset, value] of [[4, 2], [4, 4], [5, 1], [18, 0], [31, 6]]) {
  const bad = irqPages[1].slice(); bad[offset] = value;
  assert.throws(() => decodeAdcIrqProfilePage(bad, 1));
}
// Wire-valid partition discrepancies remain available to diagnostic callers.
const irqMismatch = irqPages[1].slice(); new DataView(irqMismatch.buffer).setUint32(23, 120240, true);
assert.equal(decodeAdcIrqProfilePage(irqMismatch, 1).rows[1].total_cycles, 120240);
const irqRequests = [];
const irqClient = new KeyboardClient({exchange: async raw => {
  const q = unpackPacket(raw); irqRequests.push([...q.payload]);
  assert.equal(q.op, ADC_IRQ_PROFILE);
  return {op: q.op | 128, seq: q.seq, status: 0,
    payload: q.payload[0] === 0 ? irqBegin : irqPages[q.payload[1]]};
}});
irqClient.outputEnabled = true;
assert.equal(decodeAdcIrqProfileBegin(await irqClient.request(ADC_IRQ_PROFILE, Uint8Array.of(0))), 0xfffffff0);
for (let page = 0; page <= 2; page++)
  assert.equal(decodeAdcIrqProfilePage(await irqClient.request(ADC_IRQ_PROFILE, Uint8Array.of(1, page)), page).run_id, 0xfffffff0);
assert.deepEqual(irqRequests, [[0], [1, 0], [1, 1], [1, 2]]);
assert.equal(irqClient.outputEnabled, true);
assert.equal(crc16(new TextEncoder().encode("123456789")), 0x29b1);
const p = packet(1, 123);
assert.equal(unpackPacket(p).seq, 123);
for (const i of [0, 2, 8, 63]) {
  let b = p.slice();
  b[i] ^= 1;
  assert.throws(() => unpackPacket(b));
}
const t = new DemoTransport(),
  c = new KeyboardClient(t);
assert.equal((await c.info()).board_rev, 86);
assert.equal((await c.info()).scan_target_hz,64000);
const infoPayload = t.command(1, new Uint8Array());
for (const revision of [77, 85, 86]) {
  infoPayload[30] = revision;
  assert.equal(decodeInfo(infoPayload).board_rev, revision);
}
for (const [offset, value] of [[30,0],[30,84],[30,87],[30,255],[3,1],[4,13],[5,5],[6,3],[7,27],[31,2]]) {
  const badInfo = infoPayload.slice();
  badInfo[offset] = value;
  assert.throws(() => decodeInfo(badInfo));
}
assert.equal((await c.status(1)).raw.length, 7);
let profile = await c.getConfig();
for (const k of profile.keys) assert.deepEqual(decodeKey(encodeKey(k)), k);
const oldKey = structuredClone(profile.keys[0]); delete oldKey.bottom_deadzone;
assert.equal(keyRecord(oldKey).bottom_deadzone, 0);
assert.deepEqual([...encodeKey(oldKey).slice(16)], [0,0,0,0,0,0]);
const newKey = {...oldKey, bottom_deadzone:125};
assert.deepEqual(decodeKey(encodeKey(newKey)), newKey);
assert.deepEqual([...encodeKey(newKey).slice(16,18)], [125,0]);
for (const bottom_deadzone of [-1,801,false,null])
  assert.throws(() => keyRecord({...oldKey,bottom_deadzone}));
assert.equal(keyRecord({...oldKey,bottom_deadzone:800}).bottom_deadzone,800);
const reservedKey=encodeKey(newKey);reservedKey[20]=1;
assert.throws(() => decodeKey(reservedKey), /reserved/);
for (const b of profile.bindings)
  assert.deepEqual(decodeBinding(encodeBinding(b)), b);
const chord = { input: 21, kind: 6, keys: [4, 5, 0xdf], modifiers: 0x81 };
for (const [binding, wire] of [
  [chord, [21, 6, 4, 5, 0x81, 0xdf]],
  [{ ...chord, keys: [4, 0xdf] }, [21, 6, 4, 0xdf, 0x81, 0]],
]) {
  assert.deepEqual([...encodeBinding(binding)], wire);
  assert.deepEqual(decodeBinding(Uint8Array.from(wire)), binding);
}
for (const keys of [[4], [4, 5, 6, 7], [4, 4], [5, 4], [0, 4], [4, 0xe0], Array(2)])
  assert.throws(() => encodeBinding({ ...chord, keys }));
assert.throws(() => decodeBinding(Uint8Array.of(21, 6, 4, 5, 0, 4)));
assert.throws(() => decodeBinding(Uint8Array.of(21, 1, 4, 0, 0, 5)), /reserved/);
let bad = structuredClone(profile);
bad.keys[0].key = 1;
assert.throws(() => validateProfile(bad));
bad = structuredClone(profile);
bad.keys[0].actuation = false;
assert.throws(() => validateProfile(bad));
await assert.rejects(() => c.output(true), /NOT_READY/);
await c.calibrate(0, 0);
await new Promise((r) => setTimeout(r, 55));
assert.equal((await c.status(0)).calibration_state, 2);
await c.calibrate(0, 1);
await new Promise((r) => setTimeout(r, 55));
assert.equal((await c.status(0)).calibration_state, 4);
await c.calibrate(0, 2);
profile = await c.getConfig();
assert.ok(profile.keys[0].flags & 4);
profile.bindings[20] = { input: 20, kind: 3, code: -1, modifiers: 0 };
profile.bindings[21] = chord;
assert.equal((await c.info()).capabilities & CAP_KEY_CHORD, CAP_KEY_CHORD);
assert.equal((await c.importProfile(profile)).persisted, false);
assert.equal((await c.save()).verified, true);
assert.deepEqual(await c.getConfig(), profile);
for (const input of [0, 14, 20]) for (let code = 1; code <= 5; code++) {
  const b = {input, kind:5, code, modifiers:0};
  assert.deepEqual(await c.setBinding(b), b);
}
class Legacy extends DemoTransport {
  mutations = 0;
  command(op, p) {
    if ([4,5,6,7,8,10].includes(op)) this.mutations++;
    const reply = super.command(op, p);
    if (op === 1) { reply[1] = 1; new DataView(reply.buffer).setUint32(16, 31, true); }
    return reply;
  }
}
const legacyTransport = new Legacy(), legacy = new KeyboardClient(legacyTransport);
for (const binding of [{input:0,kind:5,code:1,modifiers:0},{input:0,kind:2,code:-1,modifiers:0}]) {
  await assert.rejects(() => legacy.setBinding(binding), /0.2/);
  const unsupported = structuredClone(profile);
  unsupported.bindings[21] = { input: 21, kind: 2, code: -1, modifiers: 0 };
  unsupported.bindings[0] = binding;
  await assert.rejects(() => legacy.importProfile(unsupported), /0.2/);
}
await assert.rejects(() => legacy.setBinding(chord), /조합키/);
await assert.rejects(() => legacy.importProfile(profile), /조합키/);
assert.equal(legacyTransport.mutations, 0);
class Legacy033 extends DemoTransport {
  mutations = [];
  command(op, p) {
    if ([4,5,6,7,8,10].includes(op)) this.mutations.push(op);
    const reply = super.command(op, p);
    if (op === 1) { reply[2]=3;new DataView(reply.buffer).setUint32(16,0xff,true); }
    return reply;
  }
}
const oldTransport=new Legacy033(), oldClient=new KeyboardClient(oldTransport);
await assert.rejects(() => oldClient.setKey(newKey), /0.3.4/);
const bottomProfile=structuredClone(profile);bottomProfile.keys[13].bottom_deadzone=100;
await assert.rejects(() => oldClient.importProfile(bottomProfile), /0.3.4/);
assert.deepEqual(oldTransport.mutations, []);
assert.equal((await oldClient.setKey(oldKey)).bottom_deadzone,0);
assert.deepEqual(oldTransport.mutations,[4]);
assert.equal((await c.info()).capabilities&CAP_BOTTOM_DEADZONE,CAP_BOTTOM_DEADZONE);
await c.importProfile(bottomProfile);
assert.equal((await c.save()).verified,true);
assert.deepEqual(await c.getConfig(),bottomProfile);
class WrongSeq extends DemoTransport {
  async exchange(data) {
    let p = await super.exchange(data);
    p.seq++;
    return p;
  }
}
await assert.rejects(
  () => new KeyboardClient(new WrongSeq()).info(),
  /거래번호/,
);
class FailedSave extends DemoTransport {
  async reconnect() {
    this.generation = 0;
  }
}
let failedSaveTime = 0;
await assert.rejects(
  () => new KeyboardClient(new FailedSave(), {
    clock: () => failedSaveTime,
    sleep: async (ms) => { failedSaveTime += ms; },
  }).save(),
  /검증 실패/,
);
console.log(
  "Web codec + simulation/calibration/import/SAVE/wrong-sequence tests PASS",
);
