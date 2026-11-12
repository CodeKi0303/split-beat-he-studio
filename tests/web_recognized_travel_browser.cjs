// Isolated demo only. Native HID is replaced before importing the application.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { installStudioTestHid } = require("./studio-browser-hid.cjs");
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, args: ["--mute-audio"],
    ...(process.env.C77_BROWSER_CHANNEL ? { channel: process.env.C77_BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, acceptDownloads: true });
  await context.addInitScript(() => {
    window.__physicalHidAttempts = 0;
    const forbidden = () => { window.__physicalHidAttempts++; throw Error("Physical HID forbidden"); };
    Object.defineProperty(navigator, "hid", { configurable: true, value: { requestDevice: forbidden, getDevices: forbidden } });
    window.__statusTravelTest = { travel: 50, raw: 1234 };
    window.__demoCommands = [];
  });
  await context.route("**/demo.mjs*", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() + `
const originalCommand = DemoTransport.prototype.command;
DemoTransport.prototype.command = function(op, payload) {
  window.__demoCommands.push({ op, payload: [...payload] });
  const response = originalCommand.call(this, op, payload);
  if (op === OP.STATUS && window.__statusTravelTest) {
    const view = new DataView(response.buffer, response.byteOffset, response.byteLength);
    for (let i = 0; i < 7; i++) {
      view.setUint16(16 + i * 2, window.__statusTravelTest.raw, true);
      view.setUint16(30 + i * 2, window.__statusTravelTest.travel, true);
    }
  }
  return response;
};` });
  });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  const nav = name => page.locator(`.nav[data-tab="${name}"]`).click();
  const idle = () => page.waitForFunction(() => !document.querySelector("#refresh").disabled);
  const exportJson = async id => {
    const event = page.waitForEvent("download");
    await page.locator(`#${id}`).click();
    return JSON.parse(fs.readFileSync(await (await event).path(), "utf8"));
  };
  const setTravel = value => page.evaluate(travel => { window.__statusTravelTest.travel = travel; }, value);
  await page.goto(process.env.C77_WEB_URL || "http://127.0.0.1:8877/");
  await installStudioTestHid(page);
  await page.locator("#connect").click();
  await idle();
  await nav("profiles");
  const fixture = await exportJson("export");
  fixture.ui.totalTravelMm.fill(3.4);
  fixture.device.keys.forEach(key => Object.assign(key, { flags: 7, released: 1000, pressed: 3000,
    actuation: 200, rt_press: 100, rt_release: 100, top_deadzone: 88, bottom_deadzone: 88, noise_deadband: 0 }));
  // Include RT-off compatibility on the right half.
  fixture.device.keys[7].flags = 5;
  await page.locator("#profileFile").setInputFiles({ name: "recognized-travel-demo.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)) });
  await page.waitForFunction(() => document.querySelector("#notice").textContent.includes("프로필 RAM 적용 및 읽기 검증 완료"));
  await idle();
  await nav("performance");
  await page.locator("#key-0").click();
  for (const [input, expected] of [[87,0],[88,0],[89,89],[500,500],[911,911],[912,1000],[913,1000],[1000,1000]]) {
    await setTravel(input);
    const mm = (expected * 3.4 / 1000).toFixed(2) + " mm";
    await page.waitForFunction(({ mm, expected }) => document.querySelector("#liveTravel").textContent === mm
      && Number.parseFloat(document.querySelector("#key-7 .bar").style.width) === expected / 10, { mm, expected });
    for (const id of [0, 7]) {
      assert.equal(await page.locator(`#key-${id} .travel`).textContent(), mm);
      assert.equal(await page.locator(`#key-${id} .bar`).evaluate(bar => Number.parseFloat(bar.style.width)), expected / 10);
      assert.equal(await page.locator(`#key-${id} .raw`).textContent(), "1234");
    }
    assert.ok(Math.abs(await page.locator("#travelFill").evaluate(bar => Number.parseFloat(bar.style.height)) - expected / 10) < 1e-8);
  }
  fs.mkdirSync("build", { recursive: true });
  await page.screenshot({ path: "build/web-recognized-travel-bottom.png", fullPage: true });
  // Default travel statistics are clamped; ADC statistics retain source values.
  await nav("diagnostics");
  await page.locator("#clearStats").click();
  await page.waitForFunction(() => document.querySelector("#mean").textContent === "3.4000");
  await page.locator("#diagnosticAdc").check();
  await page.waitForFunction(() => document.querySelector("#mean").textContent === "1234.00");
  await page.locator("#diagnosticAdc").uncheck();
  await setTravel(50);
  await page.locator("#clearStats").click();
  await page.waitForFunction(() => document.querySelector("#mean").textContent === "0.0000");
  await page.screenshot({ path: "build/web-recognized-travel-zero.png", fullPage: true });
  // A legacy, unclamped STATUS capture preserves source fields and displays separate endpoints.
  await nav("rhythm");
  await page.locator("#rhythmStart").click();
  await page.waitForFunction(() => document.querySelector("#rhythmLive").textContent.startsWith("0.00 mm"));
  await page.waitForTimeout(650); // Retain visible samples after the scheduled audio origin.
  await setTravel(950);
  await page.waitForFunction(() => document.querySelector("#rhythmLive").textContent.startsWith("3.40 mm"));
  await page.waitForTimeout(650);
  await page.locator("#rhythmStop").click();
  const capture = await exportJson("rhythmExport");
  assert.ok(capture.samples.some(s => s.travel === 50 && s.recognizedTravel === 0 && s.recognizedMm === 0));
  assert.ok(capture.samples.some(s => s.travel === 950 && s.recognizedTravel === 1000 && s.recognizedMm === 3.4));
  assert.ok(capture.samples.every(s => s.raw === 1234));
  assert.match(capture.travelSources.travel, /Unmodified device STATUS/);
  await page.screenshot({ path: "build/web-recognized-travel-rhythm.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of ["performance", "diagnostics", "rhythm"]) {
    await nav(tab);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `mobile overflow: ${tab}`);
  }
  await nav("performance");
  await page.screenshot({ path: "build/web-recognized-travel-mobile.png", fullPage: true });
  assert.equal(await page.evaluate(() => window.__physicalHidAttempts), 0);
  assert.equal(await page.evaluate(() => window.__demoCommands.some(c => c.op === 7 || c.op === 6 && c.payload[0] !== 0)), false);
  await page.locator("#disconnect").click();
  await page.waitForFunction(() => document.querySelector("#mode").textContent === "연결 안 됨");
  assert.equal(await page.locator("#liveTravel").textContent(), "— mm", "disconnected display does not fabricate recognized travel");
  assert.deepEqual(errors, []);
  console.log("Recognized travel browser: legacy STATUS boundary displays, both halves/RT-off, unchanged ADC, rhythm source/export/display, disconnected state and mobile layout PASS (mock HID only)");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
