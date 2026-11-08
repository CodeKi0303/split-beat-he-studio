/* C86 update wire codec. No browser or device access on import. */
import { packet, unpackPacket, STATUS_NAMES } from "./protocol.mjs";
export const FW = Object.freeze({ INFO: 0x30, ENTER: 0x31, BEGIN: 0x32, WRITE: 0x33, COMMIT: 0x34, RUN: 0x35, READ: 0x36 });
export const APP_BASE = 0x08020000, MAX_IMAGE = 0x3ffe0;
const token = new TextEncoder().encode("UPD3");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const view = (a) => new DataView(a.buffer, a.byteOffset, a.byteLength);
const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
const u32 = (n, name) => { if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw Error(`잘못된 ${name}`); return n; };
export function crc32(data) {
  let c = 0xffffffff;
  for (const b of data) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}
export async function validateFirmware(source) {
  const m = typeof source === "string" ? JSON.parse(source) : JSON.parse(JSON.stringify(source));
  if (m.schema !== "c86-firmware-v1" || m.hardware !== 86 || !["left", "right"].includes(m.role)) throw Error("C86 좌/우 펌웨어 패키지가 아닙니다.");
  if (m.image_base !== APP_BASE || !Number.isInteger(m.image_size) || m.image_size < 0x420 || m.image_size > MAX_IMAGE || m.image_size % 32) throw Error("앱 주소·크기·32바이트 정렬 오류");
  u32(m.version_number, "version_number"); u32(m.crc32, "crc32");
  if (!m.version_number) throw Error("펌웨어 버전 식별값은 0일 수 없습니다.");
  const parts = typeof m.version === "string" && /^(\d+)\.(\d+)\.(\d+)$/.exec(m.version);
  if (!parts) throw Error("버전 표시가 올바르지 않습니다.");
  if (typeof m.image_base64 !== "string" || m.image_base64.length > Math.ceil(MAX_IMAGE / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(m.image_base64)) throw Error("잘못된 이미지 base64");
  const image = Uint8Array.from(atob(m.image_base64), (c) => c.charCodeAt(0));
  if (image.length !== m.image_size || crc32(image) !== m.crc32) throw Error("이미지 길이 또는 CRC32가 일치하지 않습니다.");
  const sha = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", image)));
  if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(m.sha256) || sha !== m.sha256.toLowerCase()) throw Error("이미지 SHA256이 일치하지 않습니다.");
  const id = image.subarray(0x400, 0x420), v = view(id), role = m.role === "left" ? 0 : 1;
  if (new TextDecoder().decode(id.subarray(0, 8)) !== "C86FW003" || id[8] !== 86 || id[9] !== role || v.getUint16(10, true) !== 1 || v.getUint32(12, true) !== m.version_number || v.getUint32(16, true) !== APP_BASE || v.getUint32(20, true) !== MAX_IMAGE || v.getUint32(24, true) !== 0x33444946 || v.getUint32(28, true) !== ((~0x33444946) >>> 0)) throw Error("앱 내부 하드웨어·좌우·메모리 배치 식별자가 다릅니다.");
  return { manifest: m, image, role };
}
export function decodeFirmwareInfo(data) {
  if (data.length !== 48) throw Error("업데이트 INFO 길이 오류");
  const v = view(data);
  if (data[0] !== 1 || data[1] !== 86 || data[2] > 1 || data[3] > 1 || v.getUint32(8, true) !== APP_BASE || v.getUint32(12, true) !== MAX_IMAGE) throw Error("호환되지 않는 업데이트 프로토콜/보드/메모리 배치");
  return { hardware: data[1], role: data[2], mode: data[3], flashKiB: v.getUint16(4, true), flags: v.getUint16(6, true), base: v.getUint32(8, true), max: v.getUint32(12, true), size: v.getUint32(16, true), crc: v.getUint32(20, true), version: v.getUint32(24, true), session: v.getUint32(28, true), nextOffset: v.getUint32(32, true), uid: data.slice(36, 48), uidHex: hex(data.subarray(36, 48)) };
}
export async function validateFirmwarePair(sources) {
  if (sources.length !== 2) throw Error("왼쪽·오른쪽 펌웨어 파일이 모두 필요합니다.");
  const packages = await Promise.all(sources.map(async (source) => {
    const { manifest, role } = await validateFirmware(source);
    return { manifest, role };
  }));
  packages.sort((a, b) => a.role - b.role);
  const [left, right] = packages;
  if (left.role !== 0 || right.role !== 1) throw Error("왼쪽 파일과 오른쪽 파일을 하나씩 선택하세요.");
  if (left.manifest.version_number !== right.manifest.version_number || left.manifest.version !== right.manifest.version) {
    throw Error("왼쪽과 오른쪽 펌웨어 버전이 다릅니다.");
  }
  return packages;
}

const matchesFirmware = (info, manifest) => info.mode === 1 && Boolean(info.flags & 2) &&
  info.version === manifest.version_number && info.size === manifest.image_size && info.crc === manifest.crc32;

export class FirmwareStatusError extends Error { constructor(status, op) { super(`${STATUS_NAMES[status] || status} (0x${op.toString(16)})${status === 1 ? ": 기존 펌웨어에는 USB 업데이트가 없습니다. 양쪽 새 부팅부를 SWD로 한 번 설치해야 합니다." : ""}`); this.status = status; } }
export class FirmwareClient {
  constructor(transport, { progress = () => {}, delay = sleep, clock = Date.now } = {}) { this.transport = transport; this.seq = 0; this.progress = progress; this.delay = delay; this.clock = clock; this.running = false; }
  async request(op, payload = new Uint8Array(), target = 0, timeout = 3000) {
    const wireOp = op + (target ? 0x20 : 0);
    this.seq = this.seq % 65535 + 1;
    const seq = this.seq, raw = await this.transport.exchange(packet(wireOp, seq, payload), timeout);
    const r = raw instanceof Uint8Array ? unpackPacket(raw) : raw;
    if (r.seq !== seq || r.op !== (wireOp | 128)) throw Error("업데이트 응답의 거래번호·명령 불일치");
    if (r.status) throw new FirmwareStatusError(r.status, wireOp);
    return r.payload;
  }
  async info(target = 0, timeout = 3000) { return decodeFirmwareInfo(await this.request(FW.INFO, new Uint8Array(), target, timeout)); }
  checkTarget(info, role, uid) {
    if (info.role !== role || info.hardware !== 86 || info.flashKiB !== 1024 || !(info.flags & 1) || (uid && info.uidHex !== uid)) throw Error("대상 보드의 좌우·UID·부팅부·Flash 용량이 다릅니다. 기록 중지.");
  }
  async waitMode(target, mode, uid) {
    const deadline = this.clock() + 20000;
    let last, reconnect = !target;
    for (let i = 0; i < 40 && this.clock() < deadline; i++) {
      let info;
      try {
        if (reconnect) { await this.transport.reconnect(Math.min(1000, deadline - this.clock())); reconnect = false; }
        const remaining = deadline - this.clock();
        if (remaining <= 0) break;
        info = await this.info(target, Math.min(target ? 3000 : 1000, remaining));
      } catch (e) {
        if (e instanceof FirmwareStatusError && e.status !== 7 && e.status !== 5) throw e;
        last = e;
        // A reopen can race the reset and return the old handle. Recover only
        // the local connection and INFO; never replay ENTER/RUN or flash writes.
        reconnect = !target && !(e instanceof FirmwareStatusError);
      }
      if (info) {
        // A different device is a fatal mismatch, not a transient reset race.
        this.checkTarget(info, target, uid);
        if (info.mode === mode) return info;
        last = undefined; reconnect = !target;
      }
      const remaining = deadline - this.clock();
      if (remaining > 0) await this.delay(Math.min(250, remaining));
    }
    throw Error(`모드 전환 확인 실패: ${last?.message || "장치가 이전 모드입니다."}`);
  }
  async changeMode(op, target, uid, mode) {
    try { await this.request(op, token, target); }
    catch (e) { if (target || e instanceof FirmwareStatusError) throw e; /* Local reset may disconnect before the host receives its ACK. Never repeat ENTER/RUN. */ }
    return this.waitMode(target, mode, uid);
  }
  async leaveMaintenance() { if (this.running) throw Error("기록 중에는 종료할 수 없습니다."); return this.request(FW.RUN, token); }
  async inspectPair(expectedUids) {
    const left = await this.info(0);
    this.checkTarget(left, 0, expectedUids?.[0]);
    const right = await this.info(1);
    this.checkTarget(right, 1, expectedUids?.[1]);
    return [left, right];
  }
  async updatePair(sources, { confirmed = false, fullReadback = false, expectedUids, official = false } = {}) {
    if (!confirmed || expectedUids?.length !== 2 || !expectedUids.every(Boolean)) throw Error("양쪽 장치 확인과 명시적 업데이트 동의가 필요합니다.");
    const packages = await validateFirmwarePair(sources);
    const before = await this.inspectPair(expectedUids);
    for (const { role, manifest } of packages) {
      if (before[role].session) throw Error("이전 기록 세션이 남아 있습니다. 모든 보드 전원을 분리했다가 다시 연결하세요.");
      if (official && (before[role].flags & 2) && before[role].version > manifest.version_number) {
        throw Error("한쪽에 정식 릴리스보다 새 버전이 설치되어 있습니다. 양쪽 기록을 중지했습니다.");
      }
    }
    for (const { role, manifest } of packages.slice().reverse()) {
      if (matchesFirmware(before[role], manifest)) continue;
      await this.update(manifest, { target: role, confirmed, fullReadback, expectedUid: expectedUids[role], resumeLeft: false });
    }
    const after = await this.inspectPair(expectedUids);
    if (!packages.every(({ role, manifest }) => matchesFirmware(after[role], manifest))) throw Error("양쪽 앱의 최종 버전·CRC 확인 실패");
    await this.leaveMaintenance();
    return after;
  }
  async update(source, { target, confirmed = false, fullReadback = false, session, expectedUid, onlyNewer = false, resumeLeft = true } = {}) {
    if (!confirmed) throw Error("명시적 업데이트 확인이 필요합니다.");
    if (this.running) throw Error("업데이트가 이미 진행 중입니다.");
    this.running = true;
    try {
      const pkg = await validateFirmware(source), m = pkg.manifest;
      if (target !== pkg.role) throw Error("선택한 좌우와 파일이 다릅니다.");
      this.progress("패키지 해시·식별자 검증 완료", 0);
      const local = await this.info(0); this.checkTarget(local, 0);
      let before = target ? await this.info(1) : local;
      this.checkTarget(before, target, expectedUid);
      if (onlyNewer && (before.flags & 2) && m.version_number <= before.version) throw Error("설치된 앱과 같거나 이전 버전입니다.");
      const uid = before.uidHex;
      if (before.mode === 1) before = await this.changeMode(FW.ENTER, target, uid, 0);
      this.checkTarget(before, target, uid);
      if (before.mode !== 0) throw Error("부팅부 모드가 아닙니다.");
      if (before.session) throw Error("이전 기록 세션이 남아 있습니다. 모든 보드 전원을 완전히 분리했다가 다시 연결한 후 새로 기록하세요. 자동 삭제·재개는 하지 않습니다.");
      session ??= crypto.getRandomValues(new Uint32Array(1))[0] || 1;
      u32(session, "session"); if (!session) throw Error("session은 0일 수 없습니다.");
      const begin = new Uint8Array(32), bv = view(begin);
      begin.set(before.uid); begin[12] = 86; begin[13] = target;
      [session, m.image_size, m.crc32, m.version_number].forEach((n, i) => bv.setUint32(16 + 4 * i, n, true));
      this.progress("앱 영역 삭제 중 · 전원을 유지하세요", 0);
      await this.request(FW.BEGIN, begin, target, 15000); // NEVER retry uncertain erases/writes automatically.
      for (let offset = 0; offset < pkg.image.length; offset += 32) {
        const payload = new Uint8Array(40), pv = view(payload);
        pv.setUint32(0, session, true); pv.setUint32(4, offset, true); payload.set(pkg.image.subarray(offset, offset + 32), 8);
        await this.request(FW.WRITE, payload, target);
        this.progress("앱 기록 중 · 전원을 유지하세요", (offset + 32) / pkg.image.length * 0.8);
      }
      const pending = await this.info(target); this.checkTarget(pending, target, uid);
      if (pending.mode !== 0 || pending.session !== session || pending.nextOffset !== m.image_size) throw Error("장치의 기록 오프셋·세션이 다릅니다. COMMIT 하지 않았습니다.");
      const commit = new Uint8Array(4); view(commit).setUint32(0, session, true);
      await this.request(FW.COMMIT, commit, target);
      const written = await this.info(target); this.checkTarget(written, target, uid);
      if (!(written.flags & 2) || written.mode !== 0 || written.size !== m.image_size || written.crc !== m.crc32 || written.version !== m.version_number) throw Error("장치 CRC 검증·커밋 확인 실패. RUN 하지 않았습니다.");
      if (fullReadback) {
        for (let offset = 0; offset < pkg.image.length; offset += 48) {
          const n = Math.min(48, pkg.image.length - offset), p = new Uint8Array(5); view(p).setUint32(0, offset, true); p[4] = n;
          const actual = await this.request(FW.READ, p, target);
          if (actual.length !== n || actual.some((b, i) => b !== pkg.image[offset + i])) throw Error(`Flash 읽기 대조 실패: ${offset}. RUN 하지 않았습니다.`);
          this.progress("Flash 전체 읽기 대조 중", 0.8 + (offset + n) / pkg.image.length * 0.18);
        }
      }
      this.progress("검증 완료 · 새 앱 시작", 0.99);
      const after = await this.changeMode(FW.RUN, target, uid, 1);
      if (!(after.flags & 2) || after.version !== m.version_number || after.size !== m.image_size || after.crc !== m.crc32) throw Error("새 앱 시작 후 버전·CRC 확인 실패");
      if (target && resumeLeft) await this.request(FW.RUN, token); // A paired update may still need the left bootloader.
      this.progress("업데이트와 새 앱 확인 완료 · 키 출력은 꺼진 상태", 1);
      return after;
    } finally { this.running = false; }
  }
}
