// Isolated browser + fake HID (demo simulator) only. Draws a custom ADC-to-travel
// curve with the mouse in 센서 진단/설정, applies it to every Hall key and checks
// the table, the keys' curve_id and that key output is restored afterwards.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
let browser;
(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.C77_BROWSER_CHANNEL ? { channel: process.env.C77_BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  await context.addInitScript(() => {
    const forbidden = () => { throw Error("Physical HID forbidden"); };
    Object.defineProperty(navigator, "hid", { configurable: true, value: { requestDevice: forbidden, getDevices: forbidden } });
  });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.C77_WEB_URL || "http://127.0.0.1:8877/");
  await page.evaluate(async () => {
    const { DemoTransport } = await import("./demo.mjs");
    const { VID, PID, USAGE_PAGE, USAGE, packet, unpackPacket } = await import("./protocol.mjs");
    const sim = new DemoTransport();
    sim.profile.keys.forEach((key) => Object.assign(key, { flags: 7, released: 1000, pressed: 3000 }));
    sim.stored = structuredClone(sim.profile);
    const device = Object.assign(new EventTarget(), {
      vendorId: VID, productId: PID, productName: "Split Hall test", serialNumber: "TEST-CURVE",
      collections: [{ usagePage: USAGE_PAGE, usage: USAGE }], opened: false,
      async open() { this.opened = true; },
      async close() { this.opened = false; },
      async sendReport(id, bytes) {
        const response = await sim.exchange(bytes);
        const encoded = packet(response.op, response.seq, response.payload, response.status);
        this.dispatchEvent(Object.assign(new Event("inputreport"), { reportId: 0, device: this, data: new DataView(encoded.buffer) }));
      },
    });
    const hid = new EventTarget();
    hid.requestDevice = async () => [device];
    hid.getDevices = async () => [device];
    Object.defineProperty(navigator, "hid", { configurable: true, value: hid });
    window.__sim = sim;
  });
  await page.locator("#connect").click();
  await page.waitForFunction(() => document.querySelector("#mode").textContent.startsWith("연결됨"), null, { timeout: 8000 });
  await page.waitForFunction(() => !document.querySelector("#refresh").disabled);
  await page.locator("#outputOn").click();
  await page.waitForFunction(() => window.__sim.enabled === true);

  await page.locator('.nav[data-tab="diagnostics"]').click();
  await page.locator("#key-4").click();
  const editor = page.locator("#curveEditor");
  await editor.waitFor({ state: "visible" });
  assert.equal(await page.locator("#curveKind").inputValue(), "0");
  assert.equal(await page.locator("#applyCurve").isDisabled(), true, "nothing to apply yet");

  assert.equal(await page.locator("#curveCanvas").getAttribute("class"), "drawable");
  // Draw: drag across the left half of the chart at a low height.
  await page.locator("#curveCanvas").scrollIntoViewIfNeeded();
  const box = await page.locator("#curveCanvas").boundingBox();
  const L = 46, R = box.width - 14, T = 14, B = box.height - 32;
  const at = (signal, travel) => [box.x + L + (signal / 10000) * (R - L), box.y + B - (travel / 10000) * (B - T)];
  await page.mouse.move(...at(625, 300));
  await page.mouse.down();
  for (let s = 625; s <= 5000; s += 312) await page.mouse.move(...at(s, 300 + s * 0.5));
  await page.mouse.up();
  assert.equal(await page.locator("#curveKind").inputValue(), "2", "drawing selects the custom curve");
  await page.locator("#curveScope").selectOption("all");
  assert.equal(await page.locator("#applyCurve").isDisabled(), false);
  await page.screenshot({ path: process.env.CURVE_SCREENSHOT || "custom-curve.png", fullPage: false,
    clip: { x: box.x - 30, y: box.y - 220, width: box.width + 60, height: box.height + 470 } });
  await page.locator("#applyCurve").click();
  await page.waitForFunction(() => document.querySelector("#log").textContent.includes("커스텀 곡선 표를 바꾸고 14개 키를 커스텀 곡선"), null, { timeout: 8000 })
    .catch(async (e) => { throw Error(`${e.message} log=${(await page.locator("#log").textContent()).slice(0, 600)}`); });
  const state = await page.evaluate(() => ({ curve: window.__sim.customCurve, curves: window.__sim.profile.keys.map((k) => k.curve_id) }));
  assert.ok(state.curve[0] > 0 && state.curve[0] < 1000 && state.curve[7] < 4000, `drawn low: ${state.curve}`);
  for (let i = 1; i < state.curve.length; i++) assert.ok(state.curve[i] >= state.curve[i - 1], "monotonic table");
  assert.deepEqual(state.curves, Array(14).fill(2));
  await page.waitForFunction(() => window.__sim.enabled === true, null, { timeout: 8000 });
  assert.equal(await page.locator("#applyCurve").isDisabled(), true, "applied state has nothing pending");

  // Switching the selected key back to linear leaves the shared table intact.
  await page.locator("#curveScope").selectOption("selected");
  await page.locator("#curveKind").selectOption("0");
  await page.locator("#applyCurve").click();
  await page.waitForFunction(() => window.__sim.profile.keys[4].curve_id === 0, null, { timeout: 8000 });
  const after = await page.evaluate(() => window.__sim.customCurve);
  assert.deepEqual(after, state.curve);
  assert.deepEqual(errors, []);
  console.log("Custom curve: mouse drawing, monotonic table, apply to all keys, per-key linear, output restore PASS (fake HID only)");
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
