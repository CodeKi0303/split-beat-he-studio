import { VID, PID, USAGE_PAGE, USAGE, unpackPacket } from "./protocol.mjs";
import { FirmwareClient, validateFirmware } from "./fw-protocol.mjs";
import { fetchStudioRelease, fetchReleaseFirmware } from "./studio-release.mjs";
const compatible = (d) => d.vendorId === VID && d.productId === PID && d.collections.some((c) => c.usagePage === USAGE_PAGE && c.usage === USAGE);
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

if (typeof document !== "undefined") {
  const $ = (id) => document.getElementById(id);
  let source, pkg, client, transport, inspected, release, official = false, busy = false, releaseLock;
  const targetRole = () => +$("target").value ? "right" : "left";
  if (new URLSearchParams(location.search).get("target") === "right") $("target").value = "1";
  const currentOrNewer = (entry) => Boolean(inspected?.flags & 2) && inspected.version >= entry.versionNumber;
  const progress = (message, value) => { $("status").textContent = message; $("progress").value = value; };
  function controls() {
    for (const id of ["target", "file", "connect", "agree", "readback"]) $(id).disabled = busy;
    const entry = release?.firmware[targetRole()];
    const upToDate = entry && currentOrNewer(entry);
    $("releaseStatus").textContent = entry
      ? `정식 릴리스 v${entry.version}${inspected ? (upToDate ? " · 최신 버전 사용 중" : " · 업데이트 가능") : ""}`
      : "게시된 정식 릴리스 없음";
    $("releaseFile").disabled = busy || !entry || upToDate;
    $("disconnect").disabled = busy || !client;
    $("leave").disabled = busy || !client;
    $("update").disabled = busy || !pkg || !client || !inspected || pkg.role !== +$("target").value || (official && upToDate) || !$("agree").checked;
    $("inspectHint").textContent = +$("target").value ? "오른쪽을 확인하면 왼쪽이 중계 모드로 전환되어 스캔·키 출력이 중단됩니다. 확인 후 종료 버튼으로 중계를 끝낼 수 있습니다." : "연결은 업데이트 기능과 왼쪽 보드 정보를 읽습니다.";
  }
  async function action(fn) { if (busy) return; busy = true; $("error").textContent = ""; controls(); try { await fn(); } catch (e) { $("error").textContent = e.message; $("status").textContent = "중단됨 · 상태를 확인한 뒤 직접 다시 시도하세요."; inspected = null; } finally { busy = false; controls(); } }
  async function close() { if (transport) await transport.close(); transport = client = inspected = null; releaseLock?.(); releaseLock = null; $("device").textContent = "연결되지 않음"; }
  async function ownBrowser() {
    if (!navigator.locks) throw Error("Chrome / Edge Web Locks 지원이 필요합니다.");
    let acquired; const ready = new Promise((r) => acquired = r);
    navigator.locks.request("c77-hid-configuration-owner", { ifAvailable: true }, async (lock) => { if (!lock) return acquired(false); acquired(true); await new Promise((r) => releaseLock = r); }).catch((e) => { acquired(false); $("error").textContent = e.message; });
    if (!(await ready)) throw Error("Studio 또는 다른 업데이트 탭에서 먼저 연결을 종료하세요.");
  }
  function showInfo(i) { const version = i.flags & 2 ? `v${i.version >>> 24}.${(i.version >>> 16) & 255}.${i.version & 65535}` : "—"; $("device").textContent = `C86 ${i.role ? "오른쪽" : "왼쪽"} / ${i.mode ? "앱" : "부팅부"}\nUID ${i.uidHex}\nFlash ${i.flashKiB} KiB · 유효한 앱 ${i.flags & 2 ? "있음" : "없음"}\n버전 ${version}`; }
  async function load(sourceValue) { source = sourceValue; pkg = await validateFirmware(source); const m = pkg.manifest; $("package").textContent = `${m.role === "left" ? "왼쪽" : "오른쪽"} C86 · v${m.version}\n${m.image_size.toLocaleString()} bytes · 0x${m.image_base.toString(16)}\nCRC32 ${m.crc32.toString(16).padStart(8, "0")}\nSHA256 ${m.sha256}\n패키지 검증 통과`; $("agree").checked = false; }
  $("releaseFile").addEventListener("click", () => action(async () => {
    const role = targetRole();
    if (!release || currentOrNewer(release.firmware[role])) return;
    pkg = source = null;
    official = false;
    $("file").value = "";
    $("package").textContent = "릴리스 파일 검사 중";
    await load(await fetchReleaseFirmware(release, role));
    official = true;
  }));
  $("file").addEventListener("change", () => action(async () => { pkg = source = null; official = false; $("package").textContent = "검사 중"; const file = $("file").files[0]; if (!file) return; if (file.size > 450000) throw Error("패키지 파일이 너무 큽니다."); await load(await file.text()); }));
  $("target").addEventListener("change", () => { inspected = null; $("agree").checked = false; controls(); });
  $("agree").addEventListener("change", controls);
  $("connect").addEventListener("click", () => action(async () => {
    if (!client) {
      if (!navigator.hid || !window.isSecureContext) throw Error("Chrome 또는 Edge에서 HTTPS 주소나 localhost로 열어주세요.");
      await ownBrowser();
      try { const [device] = await navigator.hid.requestDevice({ filters: [{ vendorId: VID, productId: PID, usagePage: USAGE_PAGE, usage: USAGE }] }); if (!device || !compatible(device)) throw Error("장치를 선택하지 않았습니다."); transport = new FirmwareHIDTransport(device, () => { if (!busy) { inspected = null; $("device").textContent = "USB 연결 끊김 · 다시 확인 필요"; controls(); } }); await transport.open(); client = new FirmwareClient(transport, { progress }); }
      catch (e) { await close(); throw e; }
    }
    const local = await client.info(0); client.checkTarget(local, 0);
    const target = +$("target").value, info = target ? await client.info(1) : local; client.checkTarget(info, target); inspected = info; showInfo(info); progress("장치 확인 완료. 파일을 확인하고 기록을 명시적으로 시작하세요.", 0);
  }));
  $("disconnect").addEventListener("click", () => action(close));
  $("update").addEventListener("click", () => action(async () => { if (!inspected || !$("agree").checked) throw Error("대상 확인과 명시적 동의가 필요합니다."); const after = await client.update(source, { target: +$("target").value, confirmed: true, fullReadback: $("readback").checked, expectedUid: inspected.uidHex, onlyNewer: official }); showInfo(after); inspected = after; $("agree").checked = false; }));
  $("leave").addEventListener("click", () => action(async () => { const local = await client.info(0); client.checkTarget(local, 0); if (!(local.flags & 2)) throw Error("왼쪽에 유효한 앱이 없어 종료할 수 없습니다. 올바른 왼쪽 패키지를 기록하세요."); await client.leaveMaintenance(); inspected = null; progress("종료 요청 완료 · 연결을 종료한 뒤 Studio에서 다시 확인하세요. 키 출력은 자동으로 켜지지 않습니다.", 0); }));
  addEventListener("beforeunload", (e) => { if (busy && client?.running) { e.preventDefault(); e.returnValue = ""; } });
  controls();
  fetchStudioRelease().then((data) => { release = data; controls(); }).catch(() => {});
}
