// Isolated browser + test HID (demo simulator) only. An uncalibrated keyboard
// opens the calibration tab on connect with a banner and nav badge; once every
// Hall key is calibrated, connecting stays on the mapping tab. No physical
// device or OS input is touched.
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
  const connect = async () => {
    await page.locator("#connect").click();
    await page.waitForFunction(() => document.querySelector("#mode").textContent.startsWith("연결됨"), null, { timeout: 8000 });
    await page.waitForFunction(() => !document.querySelector("#refresh").disabled);
  };
  const activeTab = () => page.locator(".nav.active").getAttribute("data-tab");

  assert.equal(await page.locator("#calBadge").isVisible(), false, "no badge before connecting");
  await connect();
  assert.equal(await activeTab(), "calibration");
  assert.equal(await page.locator("#calibration").isVisible(), true);
  assert.equal(await page.locator("#calBadge").textContent(), "14");
  assert.equal(await page.locator("#calibrationNeeded").isVisible(), true);
  assert.equal(await page.locator("#calibrationNeededTitle").textContent(), "아직 캘리브레이션하지 않은 키보드입니다");
  assert.match(await page.locator("#notice").textContent(), /보정되지 않은 키가 14개/);

  // Partly calibrated: still opens calibration and names the remaining keys.
  await page.locator("#disconnect").click();
  await page.waitForFunction(() => !document.querySelector("#connect").disabled);
  assert.equal(await page.locator("#calBadge").isVisible(), false, "badge clears on disconnect");
  await page.evaluate(() => window.__studioTestHid.simulator.profile.keys.forEach((k, i) => {
    if (i !== 3 && i !== 10) Object.assign(k, { flags: k.flags | 4, released: 2000, pressed: 3000 });
  }));
  await page.locator('.nav[data-tab="mapping"]').click();
  await connect();
  assert.equal(await activeTab(), "calibration");
  assert.equal(await page.locator("#calBadge").textContent(), "2");
  assert.equal(await page.locator("#calibrationNeededTitle").textContent(), "보정되지 않은 키 2개");

  // Fully calibrated: connecting keeps the current tab, no banner or badge.
  await page.locator("#disconnect").click();
  await page.waitForFunction(() => !document.querySelector("#connect").disabled);
  await page.evaluate(() => window.__studioTestHid.simulator.profile.keys.forEach((k) =>
    Object.assign(k, { flags: k.flags | 4, released: 2000, pressed: 3000 })));
  await page.locator('.nav[data-tab="mapping"]').click();
  await connect();
  assert.equal(await activeTab(), "mapping");
  assert.equal(await page.locator("#calBadge").isVisible(), false);
  assert.equal(await page.locator("#calibrationNeeded").isVisible(), false);
  assert.deepEqual(errors, []);
  console.log("Calibration first: uncalibrated keyboards open calibration with banner and badge; calibrated ones stay put PASS (test HID only)");
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
