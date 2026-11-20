// Update transport shared by Studio's 펌웨어 tab (firmware-tab.mjs).
import { VID, PID, USAGE_PAGE, USAGE, unpackPacket } from "./protocol.mjs";
export const compatible = (d) => d.vendorId === VID && d.productId === PID && d.collections.some((c) => c.usagePage === USAGE_PAGE && c.usage === USAGE);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
/* Dedicated transport: update erase timeout differs from normal configuration.
   No KeyboardClient INFO/SAVE/OUTPUT calls are made in boot mode. */
export class FirmwareHIDTransport {
  constructor(device, disconnected = () => {}) { this.device = device; this.disconnected = disconnected; this.pending = null; this.bind(); this.onDisconnect = (e) => { if (e.device !== this.device) return; this.fail(Error("USB 연결이 끊겼습니다. 기록은 자동 재시도하지 않습니다.")); this.disconnected(); }; navigator.hid.addEventListener("disconnect", this.onDisconnect); }
  bind() { this.onReport = (e) => { if (e.reportId || !this.pending) return; let r; try { r = unpackPacket(new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength)); } catch { return; } if (r.seq !== this.pending.seq || r.op !== this.pending.op) return; const p = this.pending; this.pending = null; clearTimeout(p.timer); p.resolve(r); }; this.device.addEventListener("inputreport", this.onReport); }
  fail(error) { if (this.pending) { const p = this.pending; this.pending = null; clearTimeout(p.timer); p.reject(error); } }
  async open() { if (!this.device.opened) await this.device.open(); }
  async exchange(bytes, timeout) { if (this.pending || !this.device.opened) throw Error("HID 연결 없음 또는 다른 거래 진행 중"); const req = unpackPacket(bytes); return new Promise((resolve, reject) => { const pending = { seq: req.seq, op: req.op | 128, resolve, reject }; this.pending = pending; pending.timer = setTimeout(() => { if (this.pending === pending) this.fail(Error("업데이트 응답 시간 초과. 자동 재시도하지 않습니다.")); }, timeout); this.device.sendReport(0, bytes).catch((e) => { if (this.pending === pending) this.fail(e); }); }); }
  async reconnect(timeout = 15000) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw Error("잘못된 USB 재연결 제한 시간");
    const deadline = Date.now() + timeout;
    // Reopening an old HIDDevice immediately before reset can leave an opened
    // but disconnected handle. Release it before each read-only reconnect.
    try { if (this.device.opened) await this.device.close(); } catch { /* Reset may already have removed it. */ }
    await delay(Math.min(750, Math.max(0, deadline - Date.now())));
    while (Date.now() < deadline) {
      try {
        const devices = (await navigator.hid.getDevices()).filter(compatible);
        let candidate = devices.includes(this.device) ? this.device : devices.length === 1 ? devices[0] : null;
        if (candidate) { if (candidate !== this.device) { this.device.removeEventListener("inputreport", this.onReport); this.device = candidate; this.bind(); } await this.open(); if (Date.now() < deadline) return; }
      } catch { /* Read-only reconnect only; never repeat a write. */ }
      const remaining = deadline - Date.now();
      if (remaining > 0) await delay(Math.min(250, remaining));
    }
    throw Error("USB 재연결 실패. 다시 연결 후 장치 상태를 확인하세요. 자동 재기록하지 않습니다.");
  }
  async close() { this.fail(Error("연결 종료")); this.device.removeEventListener("inputreport", this.onReport); navigator.hid.removeEventListener("disconnect", this.onDisconnect); if (this.device.opened) await this.device.close(); }
}

