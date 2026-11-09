export const VID = 0x0483,
  PID = 0x5744,
  USAGE_PAGE = 0xff60,
  USAGE = 0x61;
// Firmware 0.2+: mouse buttons and press-edge scroll on Hall/MX inputs.
export const CAP_MOUSE_BUTTON = 0x20;
// Firmware 0.3.4+: Hall bottom deadzone in key record bytes16..17.
export const CAP_BOTTOM_DEADZONE = 0x100;
// Firmware 0.3.5+: nonlinear normalized Hall distance, key bytes18..19.
export const CAP_HALL_CURVE = 0x200;
export const CAP_ADC_TRACE = 0x400;
export const CAP_CPU_PROFILE = 0x800;
export const CAP_ADC_IRQ_PROFILE = 0x1000;
// C86 v0.3.22+: simultaneous keyboard usages in binding kind 6.
export const CAP_KEY_CHORD = 0x2000;
export const CAP_SAVE_OUTPUT = 0x4000;
export const CAP_ADC_TUNING = 0x8000;
export const CAP_ADC_PAIR = 0x10000;
export const CAP_ADC_PAIR_READ = 0x20000;
export const ADC_SCAN_RATES = [8000, 16000, 32000, 64000, 96000];
export const ADC_WINDOWS = [0, 1, 2, 4, 6, 8];
// Read-only C86 left v0.3.8+ ADC stop snapshot; not simulated by demo mode.
export const ADC_DIAGNOSTICS = 0x42;
export const SCHEDULER_DIAGNOSTICS = 0x43;
export const ADC_TRACE = 0x44;
export const CPU_PROFILE = 0x45;
export const ADC_IRQ_PROFILE = 0x46;
export const ADC_IRQ_PROFILE_FIELDS = [
  "run_id", "elapsed_cycles", "cpu_hz", "target_cycles", "profiled_samples", "discarded_samples",
  "report_publications", "usb_completions", "adc_sequence_delta", "reserved",
];
export const ADC_IRQ_PROFILE_STAGES = [
  "total", "precopy_checks", "dma_copy", "postcopy_validate_staging", "hall_average", "publish_remainder",
];
export function decodeAdcIrqProfileBegin(payload) {
  if (!(payload instanceof Uint8Array) || payload.byteLength !== 4)
    throw new Error("ADC IRQ profile begin response must contain 4 bytes");
  const runId = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
  if (!runId) throw new Error("ADC IRQ profile run_id must be nonzero");
  return runId;
}
export function decodeAdcIrqProfilePage(payload, page) {
  if (!Number.isInteger(page) || page < 0 || page > 2)
    throw new Error("ADC IRQ profile page must be 0..2");
  const size = page === 0 ? 40 : 44;
  if (!(payload instanceof Uint8Array) || payload.byteLength !== size)
    throw new Error(`ADC IRQ profile page ${page} must contain ${size} bytes`);
  const run_id = decodeAdcIrqProfileBegin(payload.subarray(0, 4));
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (page === 0) {
    const result = Object.fromEntries(ADC_IRQ_PROFILE_FIELDS.map((name, i) => [name, view.getUint32(i * 4, true)]));
    if (result.reserved) throw new Error("ADC IRQ profile reserved field must be zero");
    if (![result.elapsed_cycles, result.cpu_hz, result.target_cycles].every(Boolean))
      throw new Error("ADC IRQ profile timing fields must be nonzero");
    if (result.target_cycles * 2 !== result.cpu_hz || result.elapsed_cycles < result.target_cycles)
      throw new Error("ADC IRQ profile must contain a completed 500ms window");
    return result;
  }
  if (payload[4] !== 3) throw new Error("ADC IRQ profile row page must contain exactly three rows");
  const rows = Array.from({length: 3}, (_, index) => {
    const offset = 5 + index * 13, id = view.getUint8(offset);
    if (id !== (page - 1) * 3 + index)
      throw new Error("ADC IRQ profile stage IDs differ from the requested page/order");
    return {id, name: ADC_IRQ_PROFILE_STAGES[id], calls: view.getUint32(offset + 1, true),
      total_cycles: view.getUint32(offset + 5, true), max_cycles: view.getUint32(offset + 9, true)};
  });
  return {run_id, rows};
}
export const CPU_PROFILE_FIELDS = [
  "run_id", "elapsed_cycles", "cpu_hz", "target_cycles", "report_publications",
  "usb_completions", "irq_cycles", "main_loop_count",
];
export const CPU_PROFILE_STAGES = [
  "service", "local_engine_snapshot", "remote", "report_aux", "vendor_housekeeping",
  "adc_irq", "split_irq", "usb_irq", "system_irq", "nonlinear_miss", "linear_miss", "rt_total_calls",
];
export function decodeCpuProfileBegin(payload) {
  if (!(payload instanceof Uint8Array) || payload.byteLength !== 4)
    throw new Error("CPU profile begin response must contain 4 bytes");
  const runId = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
  if (!runId) throw new Error("CPU profile run_id must be nonzero");
  return runId;
}
export function decodeCpuProfilePage(payload, page) {
  if (!Number.isInteger(page) || page < 0 || page > 4)
    throw new Error("CPU profile page must be 0..4");
  const size = page === 0 ? 32 : 44;
  if (!(payload instanceof Uint8Array) || payload.byteLength !== size)
    throw new Error(`CPU profile page ${page} must contain ${size} bytes`);
  const run_id = decodeCpuProfileBegin(payload.subarray(0, 4));
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (page === 0) {
    const result = Object.fromEntries(CPU_PROFILE_FIELDS.map((name, i) => [name, view.getUint32(i * 4, true)]));
    if (![result.elapsed_cycles, result.cpu_hz, result.target_cycles].every(Boolean))
      throw new Error("CPU profile timing fields must be nonzero");
    if (result.target_cycles * 4 !== result.cpu_hz || result.elapsed_cycles < result.target_cycles)
      throw new Error("CPU profile must contain a completed 250ms window");
    return result;
  }
  if (payload[4] !== 3) throw new Error("CPU profile row page must contain exactly three rows");
  const rows = Array.from({length: 3}, (_, index) => {
    const offset = 5 + index * 13, id = view.getUint8(offset);
    if (id !== (page - 1) * 3 + index)
      throw new Error("CPU profile stage IDs differ from the requested page/order");
    const row = {id, name: CPU_PROFILE_STAGES[id], calls: view.getUint32(offset + 1, true),
      total_cycles: view.getUint32(offset + 5, true), max_cycles: view.getUint32(offset + 9, true)};
    if (id === 11 && (row.total_cycles || row.max_cycles))
      throw new Error("CPU profile RT call counter must have zero timing fields");
    return row;
  });
  return {run_id, rows};
}
export function encodeAdcTraceKeys(keys) {
  if (!Array.isArray(keys) || keys.length !== 2 || keys[0] === keys[1] ||
      keys.some(key => !Number.isInteger(key) || key < 0 || key > 6))
    throw new Error("ADC trace requires exactly two distinct local keys (0..6)");
  return Uint8Array.from(keys);
}
export function decodeAdcTrace(payload) {
  if (!(payload instanceof Uint8Array) || payload.byteLength !== 54)
    throw new Error("ADC trace response must contain 54 bytes");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const keys = [view.getUint8(8), view.getUint8(9)];
  encodeAdcTraceKeys(keys);
  const rows = keys.map((key, index) => {
    const values = Array.from({length: 11}, (_, i) => view.getUint16(10 + index * 22 + i * 2, true));
    if (values.slice(0, 10).some(value => value > 4095))
      throw new Error("ADC trace raw, averaged and deadband ADC values must be 12-bit");
    const packed = values[10];
    if ((packed & 0x7c00) || (packed & 0x3ff) > 1000)
      throw new Error("ADC trace travel/reserved bits are invalid");
    return {key, raw_history: values.slice(0, 8), averaged: values[8],
      after_deadband: values[9], travel: packed & 0x3ff, pressed: Boolean(packed & 0x8000)};
  });
  return {sample_sequence: view.getUint32(0, true), timestamp_us: view.getUint32(4, true), keys, rows};
}
export const SCHEDULER_FIELDS = [
  "micros", "main_loops", "main_loop_gap_max_us", "local_updates", "remote_updates",
  "cc_state", "cc_error", "link_flags", "rx_bytes", "uart_irq_max_cycles",
  "poll_irq_max_cycles", "uart_irqs", "poll_irqs",
];
export function decodeSchedulerDiagnostics(payload) {
  if (!(payload instanceof Uint8Array) || payload.byteLength !== 52)
    throw new Error("Scheduler diagnostics must contain 52 bytes");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const result = Object.fromEntries(SCHEDULER_FIELDS.map((name, i) => [name, view.getUint32(i * 4, true)]));
  if (result.link_flags & ~15) throw new Error("Unknown scheduler link flags");
  return result;
}
export const ADC_DIAGNOSTIC_FIELDS = [
  "running", "sample_sequence", "errors", "overruns", "dma_errors", "late_irqs",
  "init_error", "stop_reason", "stop_phase_cycles", "stop_dma_flags", "stop_ndtr1",
  "stop_ndtr2", "scan_target_hz",
];
const ADC_STOP_REASONS = ["NONE", "FLAGS", "EPOCH", "OWNERSHIP", "RAW_RANGE", "FILTER", "ADC_OVR", "DMA"];
export const OP = {
  INFO: 1,
  STATUS: 2,
  GET_KEY: 3,
  SET_KEY: 4,
  CALIBRATE: 5,
  OUTPUT: 6,
  SAVE: 7,
  DEFAULTS: 8,
  GET_BINDING: 9,
  SET_BINDING: 10,
  ADC_TUNING: 0x47,
  ADC_COMPARE: 0x48,
  ADC_PAIR: 0x49,
};
export const KEY_FIELDS = [
  "key",
  "flags",
  "released",
  "pressed",
  "actuation",
  "rt_press",
  "rt_release",
  "top_deadzone",
  "noise_deadband",
  "bottom_deadzone",
  "curve_id",
];
export const BIND_FIELDS = ["input", "kind", "code", "modifiers"];
const CHORD_BIND_FIELDS = ["input", "kind", "keys", "modifiers"];
export const STATUS_NAMES = [
  "OK",
  "BAD_COMMAND",
  "BAD_PACKET",
  "BAD_INDEX",
  "BAD_CONFIG",
  "BUSY",
  "CALIBRATION_INVALID",
  "NOT_READY",
  "STORAGE_ERROR",
];
export function integer(v, min, max, name) {
  if (!Number.isInteger(v) || v < min || v > max)
    throw Error(`${name}: 정수 ${min}..${max} 필요`);
  return v;
}
export function crc16(data) {
  let c = 0xffff;
  for (const b of data) {
    c ^= b << 8;
    for (let i = 0; i < 8; i++)
      c = ((c << 1) ^ (c & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return c;
}
export function packet(op, seq, payload = new Uint8Array(), status = 0) {
  integer(op, 1, 255, "opcode");
  integer(seq, 1, 65535, "sequence");
  integer(status, 0, 255, "status");
  if (payload.length > 54) throw Error("payload>54");
  let a = new Uint8Array(64),
    v = new DataView(a.buffer);
  a.set([67, 55, 1, op]);
  v.setUint16(4, seq, true);
  a[6] = status;
  a[7] = payload.length;
  a.set(payload, 8);
  v.setUint16(62, crc16(a.subarray(0, 62)), true);
  return a;
}
export function unpackPacket(a) {
  a = new Uint8Array(a);
  if (a.length !== 64) throw Error("64-byte report 필요");
  let v = new DataView(a.buffer, a.byteOffset, a.byteLength);
  if (
    a[0] !== 67 ||
    a[1] !== 55 ||
    a[2] !== 1 ||
    v.getUint16(4, true) === 0 ||
    a[7] > 54
  )
    throw Error("잘못된 header");
  if (v.getUint16(62, true) !== crc16(a.subarray(0, 62)))
    throw Error("CRC mismatch");
  if (a.subarray(8 + a[7], 62).some((x) => x)) throw Error("nonzero padding");
  return {
    op: a[3],
    seq: v.getUint16(4, true),
    status: a[6],
    payload: a.slice(8, 8 + a[7]),
  };
}
function fields(o, names) {
  if (
    !o ||
    typeof o !== "object" ||
    Array.isArray(o) ||
    Object.keys(o).sort().join("|") !== [...names].sort().join("|")
  )
    throw Error("프로필 필드 불일치");
}
export function keyRecord(o) {
  // Older profiles omit either extension; retain their exact linear behavior.
  fields(o, KEY_FIELDS.filter((k) => !["bottom_deadzone", "curve_id"].includes(k) || Object.hasOwn(o ?? {}, k)));
  let d = {};
  for (const k of KEY_FIELDS)
    d[k] = integer(["bottom_deadzone", "curve_id"].includes(k) && !Object.hasOwn(o, k) ? 0 : o[k], 0, 65535, k);
  integer(d.key, 0, 13, "key");
  integer(d.flags, 0, 7, "flags");
  for (const k of ["released", "pressed"]) integer(d[k], 0, 4095, k);
  for (const k of ["actuation", "rt_press", "rt_release"])
    integer(d[k], 1, 1000, k);
  integer(d.top_deadzone, 0, d.actuation - 1, "top_deadzone");
  integer(d.bottom_deadzone, 0, 1000 - d.actuation, "bottom_deadzone");
  integer(d.noise_deadband, 0, 100, "noise");
  integer(d.curve_id, 0, 1, "curve_id");
  if (d.flags & 4 && Math.abs(d.released - d.pressed) < 128)
    throw Error("보정 ADC 범위는 128 이상이어야 합니다");
  return d;
}
export function encodeKey(o) {
  let d = keyRecord(o),
    a = new Uint8Array(22),
    v = new DataView(a.buffer);
  a[0] = d.key;
  a[1] = d.flags;
  KEY_FIELDS.slice(2).forEach((k, i) => v.setUint16(2 + i * 2, d[k], true));
  return a;
}
export function decodeKey(a) {
  if (a.length !== 22 || a.slice(20).some((x) => x))
    throw Error("key record length/reserved");
  let v = new DataView(a.buffer, a.byteOffset, a.byteLength),
    o = { key: a[0], flags: a[1] };
  KEY_FIELDS.slice(2).forEach((k, i) => (o[k] = v.getUint16(2 + i * 2, true)));
  return keyRecord(o);
}
export function requireKeyCapability(key, capabilities) {
  if (key.curve_id && !(capabilities & CAP_HALL_CURVE))
    throw Error("비선형 거리 보정은 펌웨어 0.3.5 이상이 필요합니다. 장치 설정은 변경하지 않았습니다.");
  if (key.bottom_deadzone && !(capabilities & CAP_BOTTOM_DEADZONE))
    throw Error("하단 데드존은 펌웨어 0.3.4 이상이 필요합니다. 장치 설정은 변경하지 않았습니다.");
}
export function bindingRecord(o) {
  if (o?.kind === 6) {
    fields(o, CHORD_BIND_FIELDS);
    const input = integer(o.input, 0, 27, "input");
    const modifiers = integer(o.modifiers, 0, 255, "modifiers");
    if (!Array.isArray(o.keys) || o.keys.length < 2 || o.keys.length > 3)
      throw Error("조합키에는 일반 키 2~3개가 필요합니다");
    const keys = Array.from(o.keys, (key) => integer(key, 4, 0xdf, "keyboard usage"));
    if (keys.some((key, i) => i > 0 && keys[i - 1] >= key))
      throw Error("조합키의 일반 키는 중복 없이 HID 코드 순서로 정렬해야 합니다");
    return { input, kind: 6, keys, modifiers };
  }
  fields(o, BIND_FIELDS);
  let d = { ...o };
  integer(d.input, 0, 27, "input");
  integer(d.kind, 0, 5, "kind");
  integer(d.code, -1, 65535, "code");
  integer(d.modifiers, 0, 255, "modifiers");
  if (d.kind === 0 && (d.code || d.modifiers))
    throw Error("비활성 binding code/modifier는 0");
  if (d.kind === 1 && !(d.code === 0 || (d.code >= 4 && d.code <= 0xe7)))
    throw Error("keyboard usage 범위");
  if ([2, 3].includes(d.kind) && ![-1, 1].includes(d.code))
    throw Error("스크롤 code는 ±1");
  if (
    d.kind === 4 &&
    ![0xb5, 0xb6, 0xb7, 0xcd, 0xe2, 0xe9, 0xea].includes(d.code)
  )
    throw Error("consumer usage 범위");
  if (d.kind === 5 && (d.code < 1 || d.code > 5))
    throw Error("마우스 버튼은 1..5 (좌/우/중/뒤/앞)");
  if (d.kind !== 1 && d.modifiers) throw Error("modifier는 keyboard에만 사용");
  return d;
}
export function requireBindingCapability(binding, capabilities) {
  if (binding.kind === 6 && !(capabilities & CAP_KEY_CHORD))
    throw Error("일반 키 여러 개를 함께 보내려면 조합키를 지원하는 C86 펌웨어가 필요합니다.");
  const extended = binding.kind === 5 ||
    ([2, 3].includes(binding.kind) && binding.input < 20);
  if (extended && !(capabilities & CAP_MOUSE_BUTTON))
    throw Error("이 매핑은 펌웨어 0.2 이상이 필요합니다. 현재 펌웨어는 변경하지 않았습니다.");
}
export function encodeBinding(o) {
  const d = bindingRecord(o);
  if (d.kind === 6)
    return Uint8Array.of(d.input, d.kind, d.keys[0], d.keys[1], d.modifiers, d.keys[2] ?? 0);
  let a = new Uint8Array(6),
    v = new DataView(a.buffer);
  a[0] = d.input;
  a[1] = d.kind;
  v.setUint16(2, d.code & 0xffff, true);
  a[4] = d.modifiers;
  return a;
}
export function decodeBinding(a) {
  if (a.length !== 6) throw Error("binding length");
  if (a[1] === 6) {
    const keys = a[5] ? [a[2], a[3], a[5]] : [a[2], a[3]];
    return bindingRecord({ input: a[0], kind: 6, keys, modifiers: a[4] });
  }
  if (a[5]) throw Error("binding reserved");
  let code = new DataView(a.buffer, a.byteOffset, a.byteLength).getUint16(
    2,
    true,
  );
  return bindingRecord({
    input: a[0],
    kind: a[1],
    code: [2, 3].includes(a[1]) && code === 65535 ? -1 : code,
    modifiers: a[4],
  });
}
export function validateProfile(o) {
  fields(o, ["schema", "board", "keys", "bindings"]);
  if (o.schema !== "c77-profile-v1" || o.board !== "C77")
    throw Error("프로필 버전/보드 불일치");
  if (
    !Array.isArray(o.keys) ||
    o.keys.length !== 14 ||
    !Array.isArray(o.bindings) ||
    o.bindings.length !== 28
  )
    throw Error("키 14개와 binding 28개 필요");
  let keys = o.keys.map(keyRecord).sort((a, b) => a.key - b.key),
    bindings = o.bindings.map(bindingRecord).sort((a, b) => a.input - b.input);
  if (
    keys.some((k, i) => k.key !== i) ||
    bindings.some((b, i) => b.input !== i)
  )
    throw Error("중복/누락 index");
  return { schema: "c77-profile-v1", board: "C77", keys, bindings };
}
export function decodeAdcDiagnostics(p) {
  if (p.length !== 52) throw Error("ADC diagnostics response must contain 13 uint32 fields (52 bytes)");
  const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const result = Object.fromEntries(ADC_DIAGNOSTIC_FIELDS.map((name, i) => [name, view.getUint32(i * 4, true)]));
  if (result.running !== 0 && result.running !== 1) throw Error("ADC diagnostics running flag must be 0 or 1");
  result.stop_reason_name = ADC_STOP_REASONS[result.stop_reason] ?? "UNKNOWN";
  // Preserve unsigned stop_phase_cycles, including wrap; it is not absolute latency.
  return result;
}
export function decodeInfo(p) {
  if (p.length < 34 || p.slice(34).some((x) => x))
    throw Error("INFO length/reserved");
  let v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  let d = {};
  [
    "major",
    "minor",
    "patch",
    "role",
    "hall",
    "digital",
    "encoders",
    "inputs",
  ].forEach((k, i) => (d[k] = p[i]));
  [
    "scan_target_hz",
    "usb_interval_us",
    "capabilities",
    "generation",
    "config_crc",
  ].forEach((k, i) => (d[k] = v.getUint32(8 + i * 4, true)));
  d.flash_kib = v.getUint16(28, true);
  d.board_rev = p[30];
  d.protocol = p[31];
  d.usb_speed = p[32];
  d.storage_valid = p[33];
  if (
    d.role !== 0 ||
    d.hall !== 14 ||
    d.digital !== 6 ||
    d.encoders !== 4 ||
    d.inputs !== 28 ||
    ![77, 85, 86].includes(d.board_rev) ||
    d.protocol !== 1
  )
    throw Error("C77/C85/C86 left-master protocol1 전용");
  return d;
}
export function decodeStatus(p) {
  if (p.length !== 54) throw Error("STATUS length");
  let v = new DataView(p.buffer, p.byteOffset, p.byteLength),
    d = {};
  ["uptime_ms", "sample_sequence", "errors", "link_age_us"].forEach(
    (k, i) => (d[k] = v.getUint32(i * 4, true)),
  );
  d.raw = Array.from({ length: 7 }, (_, i) => v.getUint16(16 + i * 2, true));
  d.travel = Array.from({ length: 7 }, (_, i) => v.getUint16(30 + i * 2, true));
  if (
    v.getUint16(52, true) ||
    d.raw.some((x) => x > 4095) ||
    d.travel.some((x) => x > 1000)
  )
    throw Error("invalid telemetry");
  d.digital_mask = p[44];
  d.output_enabled = Boolean(p[45] & 1);
  d.fresh = Boolean(p[45] & 2);
  d.dirty = Boolean(p[45] & 4);
  d.stored_valid = Boolean(p[45] & 8);
  d.calibration_key = p[46];
  d.calibration_state = p[47];
  d.pressed_mask = v.getUint32(48, true);
  return d;
}
