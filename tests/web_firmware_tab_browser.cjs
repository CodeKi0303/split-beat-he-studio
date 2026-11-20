// Isolated browser + fake HID only. The fake keyboard answers Studio commands
// (demo simulator) and update commands (firmware demo) on one HIDDevice, so the
// 펌웨어 tab's hand-over, update and Studio reconnect run end to end.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
let browser;
(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.C77_BROWSER_CHANNEL ? { channel: process.env.C77_BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.addInitScript(() => {
    const forbidden = () => { throw Error("Physical HID forbidden"); };
    Object.defineProperty(navigator, "hid", { configurable: true, value: { requestDevice: forbidden, getDevices: forbidden } });
  });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const base = process.env.C77_WEB_URL || "http://127.0.0.1:8877/";
  // The old update page now opens the tab.
  await page.goto(`${base}update.html`);
  await page.waitForFunction(() => location.hash === "#firmware" && !document.querySelector("#firmware").hidden);
  assert.equal(await page.locator("#pageTitle").textContent(), "펌웨어");
  assert.equal(await page.locator(".keyboard-panel").isVisible(), false, "the keyboard picture is hidden on this tab");

  const packages = await page.evaluate(async () => {
    const { DemoTransport } = await import("./demo.mjs");
    const { FirmwareDemoTransport, demoPackage } = await import("./fw-demo.mjs");
    const { VID, PID, USAGE_PAGE, USAGE, packet, unpackPacket } = await import("./protocol.mjs");
    const sim = new DemoTransport(), fw = new FirmwareDemoTransport();
    sim.profile.keys.forEach((key) => Object.assign(key, { flags: 7, released: 1000, pressed: 3000 }));
    sim.stored = structuredClone(sim.profile);
    const device = Object.assign(new EventTarget(), {
      vendorId: VID, productId: PID, productName: "Split Hall test", serialNumber: "TEST-FW",
      collections: [{ usagePage: USAGE_PAGE, usage: USAGE }], opened: false,
      async open() { this.opened = true; },
      async close() { this.opened = false; },
      async sendReport(id, bytes) {
        const request = unpackPacket(bytes);
        const update = (request.op >= 0x30 && request.op <= 0x37) || (request.op >= 0x50 && request.op <= 0x57);
        let encoded;
        if (update) encoded = await fw.exchange(bytes);
        else {
          const response = await sim.exchange(bytes);
          encoded = packet(response.op, response.seq, response.payload, response.status);
        }
        this.dispatchEvent(Object.assign(new Event("inputreport"), { reportId: 0, device: this, data: new DataView(encoded.buffer) }));
      },
    });
    const hid = new EventTarget();
    window.__prompts = 0;
    hid.requestDevice = async () => { window.__prompts++; return [device]; };
    hid.getDevices = async () => [device];
    Object.defineProperty(navigator, "hid", { configurable: true, value: hid });
    window.__sim = sim; window.__fw = fw; window.__device = device;
    return [JSON.stringify(await demoPackage(0)), JSON.stringify(await demoPackage(1))];
  });

  // Studio connects; the tab shows the installed version next to the release.
  await page.locator("#connect").click();
  await page.waitForFunction(() => document.querySelector("#mode").textContent.startsWith("연결됨"), null, { timeout: 8000 });
  await page.waitForFunction(() => /키보드 v\d+\.\d+\.\d+/.test(document.querySelector("#fwReleaseStatus").textContent));

  await page.locator("#fwFile").setInputFiles([
    { name: "c86-left-app.fw.json", mimeType: "application/json", buffer: Buffer.from(packages[0]) },
    { name: "c86-right-app.fw.json", mimeType: "application/json", buffer: Buffer.from(packages[1]) },
  ]);
  await page.waitForFunction(() => document.querySelector("#fwPackage").textContent.includes("오른쪽 · v0.3.0"));

  // Unsaved RAM settings block the hand-over.
  await page.evaluate(() => { window.__sim.dirty = true; });
  await page.waitForFunction(() => document.querySelector("#dirty").textContent.length > 0);
  await page.waitForTimeout(300);
  await page.locator("#fwInspect").click();
  await page.waitForFunction(() => document.querySelector("#fwError").textContent.includes("저장하지 않은 설정"), null, { timeout: 8000 });
  assert.ok((await page.locator("#mode").textContent()).startsWith("연결됨"), "Studio stays connected");
  await page.evaluate(() => { window.__sim.dirty = false; });
  await page.waitForTimeout(300);

  // Hand-over: Studio disconnects, the tab inspects both halves on the same device.
  await page.locator("#fwInspect").click();
  await page.waitForFunction(() => document.querySelector("#fwDevice").textContent.includes("오른쪽"), null, { timeout: 8000 })
    .catch(async (e) => { throw Error(`${e.message} error=${await page.locator("#fwError").textContent()}`); });
  assert.equal(await page.locator("#mode").textContent(), "연결 안 됨");
  assert.equal(await page.locator("#connect").isDisabled(), true, "Studio cannot reconnect while the tab holds the keyboard");
  assert.equal(await page.evaluate(() => window.__prompts), 0, "no device chooser for a granted keyboard");
  assert.equal(await page.locator("#fwUpdate").isDisabled(), true, "agreement is required");
  await page.locator("#fwAgree").check();
  await page.locator("#fwUpdate").click();
  await page.waitForFunction(() => document.querySelector("#fwStatus").textContent.startsWith("업데이트 완료"), null, { timeout: 20000 })
    .catch(async (e) => { throw Error(`${e.message} status=${await page.locator("#fwStatus").textContent()} error=${await page.locator("#fwError").textContent()}`); });
  const begins = await page.evaluate(() => window.__fw.calls.filter((c) => c.op === 0x32).map((c) => c.role));
  assert.deepEqual(begins, [1, 0], "right first, then left");
  assert.equal(await page.locator("#fwLeave").isDisabled(), true);

  // Studio reconnects to the granted keyboard without a chooser.
  await page.locator("#connect").click();
  await page.waitForFunction(() => document.querySelector("#mode").textContent.startsWith("연결됨"), null, { timeout: 8000 });
  assert.equal(await page.evaluate(() => window.__prompts), 0);
  assert.deepEqual(errors, []);
  console.log("Firmware tab: update.html redirect, hidden keyboard panel, unsaved-settings guard, Studio hand-over, right-then-left update, chooser-free reconnect PASS (fake HID only)");
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
