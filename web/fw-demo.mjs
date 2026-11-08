/* Offline updater simulator: never imports WebHID or accesses a device. */
import { packet, unpackPacket } from "./protocol.mjs";
import { APP_BASE, MAX_IMAGE, FW, crc32 } from "./fw-protocol.mjs";
export async function demoPackage(role = 0) {
  const image = new Uint8Array(0x440).fill(0xff), id = image.subarray(0x400, 0x420), v = new DataView(id.buffer, id.byteOffset, 32);
  id.set(new TextEncoder().encode("C86FW003")); id[8] = 86; id[9] = role;
  v.setUint16(10, 1, true);
  [0x30000, APP_BASE, MAX_IMAGE, 0x33444946, (~0x33444946) >>> 0].forEach((x, i) => v.setUint32(12 + i * 4, x, true));
  return { schema: "c86-firmware-v1", hardware: 86, role: role ? "right" : "left", version: "0.3.0", version_number: 0x30000, image_base: APP_BASE, image_size: image.length, crc32: crc32(image), sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", image)), (b) => b.toString(16).padStart(2, "0")).join(""), image_base64: btoa(String.fromCharCode(...image)) };
}
export class FirmwareDemoTransport {
  demo = true;
  constructor() { this.calls = []; this.boards = [0, 1].map((role) => ({ role, mode: 1, flags: 3, uid: new Uint8Array(12).fill(role + 1), size: 0, crc: 0, version: 0x30000, session: 0, next: 0, image: new Uint8Array() })); }
  async reconnect() {}
  async close() {}
  async exchange(bytes, timeout) {
    const p = unpackPacket(bytes), role = p.op >= 0x50 ? 1 : 0, op = p.op - (role ? 0x20 : 0), b = this.boards[role], v = new DataView(p.payload.buffer, p.payload.byteOffset, p.payload.byteLength);
    this.calls.push({ op, role, payload: p.payload.slice(), timeout });
    let out = new Uint8Array(), status = 0;
    if (op === FW.INFO) {
      out = new Uint8Array(48); const iv = new DataView(out.buffer);
      out.set([1, 86, role, b.mode]); iv.setUint16(4, 1024, true); iv.setUint16(6, b.flags, true);
      [APP_BASE, MAX_IMAGE, b.size, b.crc, b.version, b.session, b.next].forEach((n, i) => iv.setUint32(8 + i * 4, n, true)); out.set(b.uid, 36);
    } else if (op === FW.ENTER) b.mode = 0;
    else if (op === FW.BEGIN) { b.session = v.getUint32(16, true); b.size = v.getUint32(20, true); b.crc = v.getUint32(24, true); b.version = v.getUint32(28, true); b.next = 0; b.flags = 1; b.image = new Uint8Array(b.size).fill(0xff); }
    else if (op === FW.WRITE) { if (v.getUint32(0, true) !== b.session || v.getUint32(4, true) !== b.next) status = 4; else { b.image.set(p.payload.subarray(8), b.next); b.next += 32; } }
    else if (op === FW.COMMIT) { if (b.next !== b.size || crc32(b.image) !== b.crc) status = 8; else b.flags |= 2; }
    else if (op === FW.READ) out = b.image.slice(v.getUint32(0, true), v.getUint32(0, true) + p.payload[4]);
    else if (op === FW.RUN) { if (!(b.flags & 2)) status = 7; else b.mode = 1; }
    else status = 1;
    return packet(p.op | 128, p.seq, out, status);
  }
}
