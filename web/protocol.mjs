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
// C86 v0.3.37+: key.flags bit3 requests a new HID press before full RT release.
export const CAP_RETRIGGER_BEFORE_RELEASE = 0x40000;
// Firmware 0.3.43+: travel thresholds, STATUS and ADC trace use 0..10000.
export const CAP_FINE_TRAVEL = 0x80000;
// Normalized travel used everywhere in Studio. Older firmware speaks 0..1000;
// device.mjs converts at the HID boundary. One unit is 1/10000 of the stroke,
// fine enough for 0.001 mm entry; it is not the sensor's physical resolution.
export const TRAVEL_MAX = 10000;
export const LEGACY_TRAVEL_MAX = 1000;
export const LEGACY_TRAVEL_SCALE = TRAVEL_MAX / LEGACY_TRAVEL_MAX;
export const TRAVEL_FIELDS = ["actuation", "rt_press", "rt_release", "top_deadzone", "bottom_deadzone"];
// C86 left v0.3.44+: opt-in input telemetry (0x4A control, 0x4B read). Studio does not
// use it; the codec is kept in sync with host/telemetry.py and src/telemetry.c.
export const CAP_TELEMETRY = 0x100000;
export const TELEMETRY_CONTROL = 0x4a;
export const TELEMETRY_READ = 0x4b;
const TELEMETRY_KINDS = ["sample", "decision", "usb"];
// Firmware 0.3.46+: curve_id 2 selects one shared user-drawn table. 0x4C reads it
// (empty payload) or replaces it in RAM (15 x u16 outputs at signal 625..9375;
// the endpoints are always 0 and 10000). Mirrors host/protocol.py and src/config.c.
export const CAP_CUSTOM_CURVE = 0x200000;
// Firmware 0.3.48+: binding kind 7 moves the mouse pointer. modifiers = axis
// (0 X, 1 Y); code = signed speed 1..4000 (Hall: px/s at full depth, MX: px/s
// ramping 30%->100% over 350 ms, encoder: px per detent). Mirrors host/protocol.py.
export const CAP_POINTER = 0x400000;
export const BINDING_POINTER = 7;
export const POINTER_MAX = 4000;
// Firmware 0.3.49+: optional accel 1..15 on encoder pointer bindings (inputs
// 20..27), in the last binding byte; omitted when 0. Gain 1 below 5 detents/s,
// rising linearly to (1+accel)x at 40 detents/s.
export const CAP_POINTER_ACCEL = 0x800000;
export const POINTER_ACCEL_MAX = 15;
export const CUSTOM_CURVE_POINTS = 15;
export const CUSTOM_CURVE_STEP = 625;
export const CUSTOM_CURVE_IDENTITY = Object.freeze(Array.from({ length: CUSTOM_CURVE_POINTS }, (_, i) => (i + 1) * CUSTOM_CURVE_STEP));
export function customCurveRecord(points) {
  if (!Array.isArray(points) || points.length !== CUSTOM_CURVE_POINTS)
    throw Error(`커스텀 곡선은 점 ${CUSTOM_CURVE_POINTS}개가 필요합니다.`);
  let previous = 0;
  return points.map((value, index) => {
    if (!Number.isInteger(value) || value < 0 || value > TRAVEL_MAX)
      throw Error(`커스텀 곡선 ${index + 1}번째 점은 0–${TRAVEL_MAX} 정수여야 합니다.`);
    if (value < previous) throw Error("커스텀 곡선은 깊어질수록 줄어들 수 없습니다.");
    previous = value;
    return value;
  });
}
export function encodeCustomCurve(points) {
  const values = customCurveRecord(points), out = new Uint8Array(2 * CUSTOM_CURVE_POINTS);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => view.setUint16(2 * i, value, true));
  return out;
}
export function decodeCustomCurve(payload) {
  if (!(payload instanceof Uint8Array) || payload.byteLength !== 2 * CUSTOM_CURVE_POINTS)
    throw Error("커스텀 곡선 응답 길이가 올바르지 않습니다.");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return customCurveRecord(Array.from({ length: CUSTOM_CURVE_POINTS }, (_, i) => view.getUint16(2 * i, true)));
}
export function encodeTelemetryControl(enable, threshold = 4, intervalUs = 1000) {
  if (enable === undefined || enable === null) return new Uint8Array(0);
  if (typeof enable !== "boolean") throw new Error("Telemetry enable must be boolean");
  if (enable && (!Number.isInteger(threshold) || threshold < 1 || threshold > 255 ||
      !Number.isInteger(intervalUs) || intervalUs < 0 || intervalUs > 10000))
    throw new Error("Telemetry threshold must be 1..255 and interval 0..10000 us");
  const out = new Uint8Array(4);
  if (enable) { out[0] = 1; out[1] = threshold; out[2] = intervalUs & 255; out[3] = intervalUs >> 8; }
  return out;
}
export function decodeTelemetryControl(payload) {
  if (!(payload instanceof Uint8Array) || payload.byteLength !== 20)
    throw new Error("Telemetry control reply must contain 20 bytes");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (payload[0] > 1 || !view.getUint32(4, true)) throw new Error("Invalid telemetry control reply");
  return {armed: payload[0] === 1, threshold: payload[1], interval_us: view.getUint16(2, true),
    capacity: view.getUint32(4, true), device_now_us: view.getUint32(8, true),
    dropped: view.getUint32(12, true), pending: view.getUint32(16, true)};
}
export function decodeTelemetryRead(payload) {
  if (!(payload instanceof Uint8Array) || payload.byteLength < 14)
    throw new Error("Telemetry read reply must contain at least 14 bytes");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const count = payload[12], flags = payload[13];
  if (count > 8 || payload.byteLength !== 14 + count * 5 || (flags & ~3))
    throw new Error("Invalid telemetry read reply");
  let time = view.getUint32(4, true);
  const records = Array.from({length: count}, (_, i) => {
    const offset = 14 + i * 5, delta = view.getInt16(offset, true);
    if (i === 0 && delta) throw new Error("First telemetry record must have zero delta");
    time = (time + delta) >>> 0;
    const kind = payload[offset + 2] >> 6, index = payload[offset + 2] & 63, value = view.getUint16(offset + 3, true);
    if (kind > 2) throw new Error("Unknown telemetry record kind");
    if (kind === 0) {
      if (index >= 14 || value > 4095) throw new Error("Invalid telemetry sample");
      return {device_us: time, kind: "sample", key: index, raw: value};
    }
    if (kind === 1) {
      if (index >= 14 || (value & 0x3fff) > TRAVEL_MAX) throw new Error("Invalid telemetry decision");
      return {device_us: time, kind: "decision", key: index, travel: value & 0x3fff,
        retriggered: Boolean(value & 0x4000), pressed: Boolean(value & 0x8000)};
    }
    if (value & ~0x1ff) throw new Error("Invalid telemetry USB change");
    return {device_us: time, kind: TELEMETRY_KINDS[kind], usage: value & 255, pressed: Boolean(value & 0x100)};
  });
  return {device_now_us: view.getUint32(0, true), base_us: view.getUint32(4, true),
    dropped: view.getUint32(8, true), armed: Boolean(flags & 1), more: Boolean(flags & 2), records};
}
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
export function decodeAdcTrace(payload, legacy = false) {
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
    // 0.3.43+: travel bits0..13, bit14 zero. Older firmware: bits0..9 of0..1000.
    const [reserved, mask, limit] = legacy ? [0x7c00, 0x3ff, LEGACY_TRAVEL_MAX] : [0x4000, 0x3fff, TRAVEL_MAX];
    if ((packed & reserved) || (packed & mask) > limit)
      throw new Error("ADC trace travel/reserved bits are invalid");
    return {key, raw_history: values.slice(0, 8), averaged: values[8],
      after_deadband: values[9], travel: (packed & mask) * (legacy ? LEGACY_TRAVEL_SCALE : 1),
      pressed: Boolean(packed & 0x8000)};
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
  // cc_error stays the raw word; firmware 0.3.45+ packs boot-lifetime fault evidence above it.
  const word = result.cc_error;
  return {...result, cc_current_error: word & 0xff, cc_last_error: (word >>> 8) & 0xff,
    cc_retries: (word >>> 16) & 0xff, link_restarts: word >>> 24};
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
  CUSTOM_CURVE: 0x4c,
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
  integer(d.flags, 0, 15, "flags");
  for (const k of ["released", "pressed"]) integer(d[k], 0, 4095, k);
  for (const k of ["actuation", "rt_press", "rt_release"])
    integer(d[k], 1, TRAVEL_MAX, k);
  integer(d.top_deadzone, 0, d.actuation - 1, "top_deadzone");
  integer(d.bottom_deadzone, 0, TRAVEL_MAX - d.actuation, "bottom_deadzone");
  integer(d.noise_deadband, 0, 100, "noise");
  integer(d.curve_id, 0, 2, "curve_id");
  if (d.flags & 4 && Math.abs(d.released - d.pressed) < 128)
    throw Error("보정 ADC 범위는 128 이상이어야 합니다");
  return d;
}
// legacy=true encodes for firmware without CAP_FINE_TRAVEL (0..1000 units).
export function encodeKey(o, legacy = false) {
  let d = keyRecord(o),
    a = new Uint8Array(22),
    v = new DataView(a.buffer);
  if (legacy) {
    for (const k of TRAVEL_FIELDS) {
      if (d[k] % LEGACY_TRAVEL_SCALE)
        throw Error("현재 펌웨어는 총 이동거리의 1/1000 단위만 저장합니다. 0.001 mm 단위 설정은 펌웨어 0.3.43 이상이 필요합니다. 장치 설정은 변경하지 않았습니다.");
      d[k] /= LEGACY_TRAVEL_SCALE;
    }
  }
  a[0] = d.key;
  a[1] = d.flags;
  KEY_FIELDS.slice(2).forEach((k, i) => v.setUint16(2 + i * 2, d[k], true));
  return a;
}
export function decodeKey(a, legacy = false) {
  if (a.length !== 22 || a.slice(20).some((x) => x))
    throw Error("key record length/reserved");
  let v = new DataView(a.buffer, a.byteOffset, a.byteLength),
    o = { key: a[0], flags: a[1] };
  KEY_FIELDS.slice(2).forEach((k, i) => (o[k] = v.getUint16(2 + i * 2, true)));
  if (legacy) {
    if (TRAVEL_FIELDS.some((k) => o[k] > LEGACY_TRAVEL_MAX)) throw Error("legacy key record outside 0..1000");
    for (const k of TRAVEL_FIELDS) o[k] *= LEGACY_TRAVEL_SCALE;
  }
  return keyRecord(o);
}
export function requireKeyCapability(key, capabilities) {
  if ((key.flags & 8) && !(capabilities & CAP_RETRIGGER_BEFORE_RELEASE))
    throw Error("미해제 재입력은 이를 지원하는 C86 펌웨어 0.3.37 이상이 필요합니다. 장치 설정은 변경하지 않았습니다.");
  if (key.curve_id && !(capabilities & CAP_HALL_CURVE))
    throw Error("비선형 거리 보정은 펌웨어 0.3.5 이상이 필요합니다. 장치 설정은 변경하지 않았습니다.");
  if (key.curve_id === 2 && !(capabilities & CAP_CUSTOM_CURVE))
    throw Error("커스텀 거리 곡선은 펌웨어 0.3.46 이상이 필요합니다. 장치 설정은 변경하지 않았습니다.");
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
  if (o?.kind === BINDING_POINTER && Object.hasOwn(o, "accel")) fields(o, [...BIND_FIELDS, "accel"]);
  else fields(o, BIND_FIELDS);
  let d = { ...o };
  integer(d.input, 0, 27, "input");
  integer(d.kind, 0, 7, "kind");
  if (d.kind === BINDING_POINTER) {
    integer(d.code, -POINTER_MAX, POINTER_MAX, "pointer speed");
    if (!d.code) throw Error("포인터 속도는 0일 수 없습니다");
    integer(d.modifiers, 0, 1, "pointer axis");
    const accel = integer(d.accel ?? 0, 0, POINTER_ACCEL_MAX, "pointer acceleration");
    if (accel && d.input < 20) throw Error("포인터 가속은 노브·롤러 방향 입력에만 쓸 수 있습니다");
    if (accel) d.accel = accel;
    else delete d.accel;
    return d;
  }
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
  if (binding.kind === BINDING_POINTER && !(capabilities & CAP_POINTER))
    throw Error("포인터 이동은 펌웨어 0.3.48 이상이 필요합니다. 장치 설정은 변경하지 않았습니다.");
  if (binding.accel && !(capabilities & CAP_POINTER_ACCEL))
    throw Error("포인터 가속은 펌웨어 0.3.49 이상이 필요합니다. 장치 설정은 변경하지 않았습니다.");
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
  a[5] = d.accel ?? 0;
  return a;
}
export function decodeBinding(a) {
  if (a.length !== 6) throw Error("binding length");
  if (a[1] === 6) {
    const keys = a[5] ? [a[2], a[3], a[5]] : [a[2], a[3]];
    return bindingRecord({ input: a[0], kind: 6, keys, modifiers: a[4] });
  }
  if (a[5] && a[1] !== BINDING_POINTER) throw Error("binding reserved");
  let code = new DataView(a.buffer, a.byteOffset, a.byteLength).getUint16(
    2,
    true,
  );
  return bindingRecord({
    input: a[0],
    kind: a[1],
    code: [2, 3].includes(a[1]) && code === 65535 ? -1 : a[1] === BINDING_POINTER && code >= 0x8000 ? code - 0x10000 : code,
    modifiers: a[4],
    ...(a[1] === BINDING_POINTER && a[5] ? { accel: a[5] } : {}),
  });
}
// Profiles carry travel_max=10000. Older exports without it hold 0..1000
// thresholds and are converted, so each threshold keeps its stroke fraction.
export function validateProfile(o) {
  fields(o, ["schema", "board", "keys", "bindings", ...(Object.hasOwn(o ?? {}, "travel_max") ? ["travel_max"] : [])]);
  if (o.schema !== "c77-profile-v1" || o.board !== "C77")
    throw Error("프로필 버전/보드 불일치");
  if (
    !Array.isArray(o.keys) ||
    o.keys.length !== 14 ||
    !Array.isArray(o.bindings) ||
    o.bindings.length !== 28
  )
    throw Error("키 14개와 binding 28개 필요");
  const scale = Object.hasOwn(o, "travel_max") ? o.travel_max : LEGACY_TRAVEL_MAX;
  if (scale !== TRAVEL_MAX && scale !== LEGACY_TRAVEL_MAX)
    throw Error("travel_max는 10000이어야 합니다 (없으면 0..1000 단위의 이전 프로필)");
  const source = scale === TRAVEL_MAX ? o.keys : o.keys.map((k) => {
    if (!k || typeof k !== "object" || Array.isArray(k)) throw Error("프로필 필드 불일치");
    const copy = { ...k };
    for (const name of TRAVEL_FIELDS)
      if (Object.hasOwn(copy, name)) copy[name] = integer(copy[name], 0, LEGACY_TRAVEL_MAX, name) * LEGACY_TRAVEL_SCALE;
    return copy;
  });
  let keys = source.map(keyRecord).sort((a, b) => a.key - b.key),
    bindings = o.bindings.map(bindingRecord).sort((a, b) => a.input - b.input);
  if (
    keys.some((k, i) => k.key !== i) ||
    bindings.some((b, i) => b.input !== i)
  )
    throw Error("중복/누락 index");
  return { schema: "c77-profile-v1", board: "C77", travel_max: TRAVEL_MAX, keys, bindings };
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
export function decodeStatus(p, legacy = false) {
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
    d.travel.some((x) => x > (legacy ? LEGACY_TRAVEL_MAX : TRAVEL_MAX))
  )
    throw Error("invalid telemetry");
  if (legacy) d.travel = d.travel.map((x) => x * LEGACY_TRAVEL_SCALE);
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
