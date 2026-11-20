// Studio "펌웨어" tab: left/right USB update over the same WebHID device Studio
// uses. Studio hands its device over (closing its own connection first); this
// module owns the HID lock until the user leaves update mode or the update ends.
import { VID, PID, USAGE_PAGE, USAGE } from "./protocol.mjs?v=studio-retrigger1";
import { FirmwareClient, validateFirmwarePair } from "./fw-protocol.mjs";
import { fetchStudioRelease, fetchReleaseFirmware } from "./studio-release.mjs";
import { FirmwareHIDTransport, compatible } from "./updater.mjs";

const versionText = (v) => `v${v >>> 24}.${(v >>> 16) & 255}.${v & 65535}`;

/**
 * takeDevice(): resolves an HIDDevice after Studio has released it (or null to
 * ask the browser). released(): called after this tab closed the device.
 * installed(): the version Studio last read over INFO, or null.
 */
export function mountFirmwareTab({ takeDevice, released = () => {}, installed = () => null, log = () => {} }) {
  const $ = (id) => document.getElementById(id);
  let sources = null, client = null, transport = null, inspected = null, release = null;
  let official = false, busy = false, releaseLock = null;
  const progress = (message, value) => { $("fwStatus").textContent = message; $("fwProgress").value = value; };

  function controls() {
    for (const id of ["fwFile", "fwReadback", "fwAgree"]) $(id).disabled = busy;
    const latest = release?.firmware.left.version, current = installed();
    $("fwReleaseStatus").textContent = [latest ? `정식 릴리스 v${latest}` : "정식 릴리스 없음",
      current ? `키보드 v${current}` : null].filter(Boolean).join(" · ");
    $("fwReleaseFile").disabled = busy || !release;
    $("fwInspect").disabled = busy;
    $("fwLeave").disabled = busy || !client;
    $("fwUpdate").disabled = busy || !sources || !client || !inspected || !$("fwAgree").checked;
  }
  async function action(fn) {
    if (busy) return;
    busy = true;
    $("fwError").textContent = "";
    controls();
    try { await fn(); }
    catch (e) {
      $("fwError").textContent = e.message;
      $("fwStatus").textContent = "중단됨 · 양쪽 상태를 다시 확인하세요.";
      inspected = null;
      $("fwAgree").checked = false;
    } finally { busy = false; controls(); released(); }
  }
  async function close() {
    if (transport) await transport.close().catch(() => {});
    transport = client = inspected = null;
    $("fwAgree").checked = false;
    releaseLock?.();
    releaseLock = null;
    $("fwDevice").textContent = "확인 전";
    released();
  }
  async function ownBrowser() {
    if (!navigator.locks) throw Error("Chrome / Edge Web Locks 지원이 필요합니다.");
    let acquired; const ready = new Promise((r) => acquired = r);
    navigator.locks.request("c77-hid-configuration-owner", { ifAvailable: true }, async (lock) => {
      if (!lock) return acquired(false);
      acquired(true);
      await new Promise((r) => releaseLock = r);
    }).catch((e) => { acquired(false); $("fwError").textContent = e.message; });
    if (!(await ready)) throw Error("다른 탭에서 키보드 연결을 먼저 종료하세요.");
  }
  function showInfo(boards) {
    $("fwDevice").textContent = boards.map((i) =>
      `${i.role ? "오른쪽" : "왼쪽"} · ${i.flags & 2 ? versionText(i.version) : "유효한 앱 없음"} · ${i.mode ? "앱" : "부팅부"}`).join("\n");
  }
  async function load(files, fromRelease) {
    sources = null;
    $("fwAgree").checked = false;
    const packages = await validateFirmwarePair(files);
    $("fwPackage").textContent = packages.map(({ manifest: m }) =>
      `${m.role === "left" ? "왼쪽" : "오른쪽"} · v${m.version} · ${m.image_size.toLocaleString()} bytes`).join("\n");
    official = fromRelease;
    sources = files;
  }

  $("fwReleaseFile").addEventListener("click", () => action(async () => {
    $("fwFile").value = "";
    $("fwPackage").textContent = "릴리스 파일 검사 중";
    await load(await Promise.all(["left", "right"].map((role) => fetchReleaseFirmware(release, role))), true);
  }));
  $("fwFile").addEventListener("change", () => action(async () => {
    sources = null;
    const files = Array.from($("fwFile").files);
    $("fwPackage").textContent = files.length ? "파일 검사 중" : "선택한 파일 없음";
    if (!files.length) return;
    if (files.length !== 2) throw Error("왼쪽과 오른쪽 파일을 함께 선택하세요.");
    if (files.some((file) => file.size > 450000)) throw Error("패키지 파일이 너무 큽니다.");
    await load(await Promise.all(files.map((file) => file.text())), false);
  }));
  $("fwAgree").addEventListener("change", controls);
  $("fwInspect").addEventListener("click", () => action(async () => {
    $("fwAgree").checked = false;
    if (!client) {
      if (!navigator.hid || !window.isSecureContext) throw Error("Chrome 또는 Edge에서 HTTPS 주소나 localhost로 열어주세요.");
      let device = await takeDevice();
      if (!device) {
        [device] = await navigator.hid.requestDevice({ filters: [{ vendorId: VID, productId: PID, usagePage: USAGE_PAGE, usage: USAGE }] });
        if (!device || !compatible(device)) throw Error("키보드를 선택하지 않았습니다.");
      }
      await ownBrowser();
      try {
        transport = new FirmwareHIDTransport(device, () => {
          if (busy) return;
          inspected = null;
          $("fwAgree").checked = false;
          $("fwDevice").textContent = "USB 연결 끊김 · 업데이트 모드를 종료한 뒤 다시 확인하세요.";
          controls();
        });
        await transport.open();
        client = new FirmwareClient(transport, { progress });
      } catch (e) { await close(); throw e; }
    }
    await transport.open();
    inspected = await client.inspectPair();
    showInfo(inspected);
    progress("양쪽 확인 완료 · 왼쪽은 업데이트 모드입니다.", 0);
  }));
  $("fwUpdate").addEventListener("click", () => action(async () => {
    if (!inspected || !$("fwAgree").checked) throw Error("양쪽 확인과 동의가 필요합니다.");
    $("fwAgree").checked = false;
    inspected = await client.updatePair(sources, {
      confirmed: true, fullReadback: $("fwReadback").checked,
      expectedUids: inspected.map((board) => board.uidHex), official,
    });
    showInfo(inspected);
    await close();
    progress("업데이트 완료 · ‘키보드 연결’로 다시 연결하세요.", 1);
    log("좌우 펌웨어 업데이트와 버전·CRC 확인을 마쳤습니다.");
  }));
  $("fwLeave").addEventListener("click", () => action(async () => {
    const local = await client.info(0);
    client.checkTarget(local, 0);
    if (!(local.flags & 2)) throw Error("왼쪽에 유효한 앱이 없습니다. 좌우 펌웨어를 먼저 기록하세요.");
    await client.leaveMaintenance();
    await close();
    progress("업데이트 모드 종료 · ‘키보드 연결’로 다시 연결하세요.", 0);
  }));
  addEventListener("beforeunload", (e) => { if (busy && client?.running) { e.preventDefault(); e.returnValue = ""; } });
  controls();
  fetchStudioRelease().then((data) => { release = data; controls(); }).catch(() => {});
  return {
    /** True while this tab owns the keyboard (update mode or a running write). */
    active: () => !!client || busy,
    render: controls,
  };
}
