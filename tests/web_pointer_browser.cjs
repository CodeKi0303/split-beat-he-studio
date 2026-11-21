// Isolated browser + test HID (demo simulator) only. Maps a Hall key and a
// roller direction to pointer movement and checks the RAM bindings, labels and
// speed units. No physical device or OS input is touched.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const { installStudioTestHid } = require("./studio-browser-hid.cjs");
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
  await page.goto(process.env.C77_WEB_URL || "http://127.0.0.1:8877/");
  await installStudioTestHid(page);
  await page.locator("#connect").click();
  await page.waitForFunction(() => document.querySelector("#mode").textContent.startsWith("연결됨"), null, { timeout: 8000 });
  await page.waitForFunction(() => !document.querySelector("#refresh").disabled);
  const notice = (text) => page.waitForFunction((t) => document.querySelector("#notice").textContent.includes(t), text, { timeout: 8000 });
  const target = (kind, code) => page.locator(`#bindingPicker [data-kind="${kind}"][data-code="${code}"]:visible`);

  // Hall key: pointer right at a custom speed.
  await page.locator("#key-4").click();
  await page.locator('[data-binding-mode="5"]').click();
  assert.equal(await page.locator("#pointerSpeedField").isVisible(), false);
  await target(7, 1).click();
  assert.equal(await page.locator("#pointerSpeedField").isVisible(), true);
  assert.equal(await page.locator("#pointerSpeed").inputValue(), "800");
  assert.match(await page.locator("#pointerSpeedUnit").textContent(), /px\/s · 끝까지/);
  await page.locator("#pointerSpeed").fill("1200");
  assert.equal(await page.locator("#bindingPreview").textContent(), "포인터 → 1200");
  assert.equal(await page.locator("#mappingCompatibility").isVisible(), false);
  await page.locator("#applyBinding").click();
  await notice("키 매핑 RAM 적용 완료");
  assert.deepEqual(await page.evaluate(() => window.__studioTestHid.simulator.profile.bindings[4]),
    { input: 4, kind: 7, code: 1200, modifiers: 0 });

  // Roller CW: pointer up, default 20 px per detent.
  await page.locator("#key-20").click();
  await page.locator('[data-binding-mode="5"]').click();
  await target(7, -2).click();
  assert.equal(await page.locator("#pointerSpeed").inputValue(), "20");
  assert.equal(await page.locator("#pointerSpeedUnit").textContent(), "px / 한 칸");
  assert.equal(await page.locator("#pointerAccelField").isVisible(), true, "rollers offer acceleration");
  await page.locator('#pointerAccel [data-accel="4"]').click();
  assert.equal(await page.locator("#bindingPreview").textContent(), "포인터 ↑ 20 · 가속 ×5");
  await page.locator("#applyBinding").click();
  await notice("키 매핑 RAM 적용 완료");
  assert.deepEqual(await page.evaluate(() => window.__studioTestHid.simulator.profile.bindings[20]),
    { input: 20, kind: 7, code: -20, modifiers: 1, accel: 4 });

  // Reading back: reselecting restores direction, speed and acceleration.
  await page.locator("#key-4").click();
  assert.equal(await page.locator("#pointerAccelField").isVisible(), false, "Hall keys have no detents");
  await page.locator("#key-20").click();
  assert.equal(await page.locator('#pointerAccel [data-accel="4"]').getAttribute("aria-pressed"), "true");
  await page.locator("#key-4").click();
  assert.equal(await page.locator("#bindingPreview").textContent(), "포인터 → 1200");
  assert.equal(await target(7, 1).getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#pointerSpeed").inputValue(), "1200");
  assert.deepEqual(errors, []);
  console.log("Pointer mapping: Hall px/s and roller px/detent bindings, labels, units and readback PASS (test HID only)");
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
