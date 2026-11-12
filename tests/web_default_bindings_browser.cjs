// Fresh browser + mock WebHID only. No existing browser or physical device.
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
    window.__physicalHidAttempts = 0; window.__mappingCommands = [];
    const blocked = () => { window.__physicalHidAttempts++; throw Error("Physical HID forbidden"); };
    Object.defineProperty(navigator, "hid", { configurable: true, value: { requestDevice: blocked, getDevices: blocked } });
  });
  // Emulate a device with an existing non-default profile, before its first read.
  await context.route("**/demo.mjs*", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() + `
const originalMappingCommand = DemoTransport.prototype.command;
DemoTransport.prototype.command = function(op, payload) {
  if (!this.mappingFixtureReady) {
    this.profile.bindings[0] = {input:0,kind:0,code:0,modifiers:0};
    this.profile.bindings[1] = {input:1,kind:1,code:29,modifiers:0};
    Object.assign(this.profile.keys[1], {flags:7,released:1000,pressed:3000,
      actuation:220,rt_press:130,rt_release:160,top_deadzone:35,bottom_deadzone:90,noise_deadband:7});
    this.mappingFixtureReady = true;
  }
  window.__mappingCommands.push({op,payload:[...payload]});
  return originalMappingCommand.call(this,op,payload);
};` });
  });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(12000);
  page.on("pageerror", error => errors.push(error.message));
  const nav = name => page.locator(`.nav[data-tab="${name}"]`).click();
  const idle = () => page.waitForFunction(() => !document.querySelector("#refresh").disabled);
  const exported = async id => {
    const pending = page.waitForEvent("download");
    await page.locator(`#${id}`).click();
    return JSON.parse(fs.readFileSync(await (await pending).path(), "utf8"));
  };
  const exportProfile = async () => { await nav("profiles"); await idle(); return exported("export"); };
  const names = ["Tab","A","S","D","F","L Shift","Space","Enter","; / :","L","K","J","R Shift","R Alt",
    "F1","F5","Esc","→","←","Enter","F1","F2","Pg↑","Pg↓","휠↑","휠↓","↑","↓"];
  await page.goto(process.env.C77_WEB_URL || "http://127.0.0.1:8877/");
  await page.waitForFunction(() => document.querySelectorAll(".key").length === 28 && document.querySelector("#selectionLabel").textContent === "Tab · 왼쪽 Hall 1");
  for (let id = 0; id < 28; id++) assert.equal(await page.locator(`#key-${id} .name`).textContent(), names[id]);
  assert.equal(await page.locator("#mappingSource").textContent(), "기본 배치 미리보기");
  assert.equal(await page.locator("#key-7").getAttribute("aria-label"), "Enter · 오른쪽 Hall 1");
  assert.equal(await page.locator("#key-19").getAttribute("aria-label"), "Enter · 오른쪽 노브 클릭");
  assert.equal(await page.locator("#key-14").getAttribute("aria-label"), "F1 · 왼쪽 MX 1");
  assert.equal(await page.locator("#key-20").getAttribute("aria-label"), "F1 · 왼쪽 롤러 CW");
  fs.mkdirSync("build", { recursive: true });
  await page.screenshot({ path: "build/web-default-mapping-disconnected.png", fullPage: true });
  await installStudioTestHid(page);
  await page.locator("#connect").click();
  await idle();
  await page.waitForFunction(() => document.querySelector("#key-1 .name").textContent === "Z");
  assert.equal(await page.locator("#key-0 .name").textContent(), "미지정");
  assert.equal(await page.locator("#mappingSource").textContent(), "현재 키보드 매핑");
  const before = await exportProfile();
  assert.equal(before.device.bindings[0].kind, 0);
  assert.equal(before.device.bindings[1].code, 29);
  assert.equal(await page.evaluate(() => window.__mappingCommands.some(c => [4,5,6,7,8,10].includes(c.op))), false,
    "reading an existing profile does not apply defaults or mutate settings");
  await nav("mapping");
  await page.locator("#key-1").click();
  assert.equal(await page.locator("#selectionLabel").textContent(), "Z · 왼쪽 Hall 2");
  await page.locator('#bindingPicker [data-kind="1"][data-code="28"]:visible').click();
  await page.locator("#applyBinding").click();
  await page.waitForFunction(() => document.querySelector("#key-1 .name").textContent === "Y");
  assert.equal(await page.locator("#key-1").getAttribute("aria-label"), "Y · 왼쪽 Hall 2");
  assert.equal(await page.locator("#selectionLabel").textContent(), "Y · 왼쪽 Hall 2");
  assert.match(await page.locator("#bindingTitle").textContent(), /^Y · 왼쪽 Hall 2/);
  await nav("calibration");
  assert.equal(await page.locator("#keyTitle").textContent(), "Y · 왼쪽 Hall 2 캘리브레이션");
  assert.equal(await page.locator("#batch-key-1 span").textContent(), "Y · 왼쪽 Hall 2");
  await nav("diagnostics");
  assert.match(await page.locator("#adcWindowsByKey tr").nth(1).textContent(), /Y/);
  await page.locator("#baseline").click();
  await page.waitForFunction(() => !document.querySelector("#measurePress").disabled);
  assert.match(await page.locator("#measureState").textContent(), /Y · 왼쪽 Hall 2 하나만/);
  await page.locator("#cancelMeasure").click();
  await nav("rhythm");
  assert.equal(await page.locator("#rhythmKey").textContent(), "Y · 왼쪽 Hall 2");
  assert.equal(await page.locator("#autoFitKey").textContent(), "Y · 왼쪽 Hall 2");
  assert.match(await page.locator("#autoFitInstruction").textContent(), /^Y · 왼쪽 Hall 2/);
  await page.locator("#rhythmStart").click();
  await page.waitForFunction(() => document.querySelector("#rhythmLive").textContent.includes("mm"));
  await page.waitForTimeout(200);
  await page.locator("#rhythmStop").click();
  const captured = await exported("rhythmExport");
  assert.equal(captured.context.label, "Y · 왼쪽 Hall 2");
  assert.deepEqual(captured.context.binding, { input: 1, kind: 1, code: 28, modifiers: 0 });
  await page.screenshot({ path: "build/web-current-mapping-rhythm.png", fullPage: true });
  await nav("mapping");
  await page.locator('[data-binding-mode="0"]').click();
  await page.locator("#applyBinding").click();
  await page.waitForFunction(() => document.querySelector("#key-1 .name").textContent === "미지정");
  assert.equal(await page.locator("#selectionLabel").textContent(), "미지정 · 왼쪽 Hall 2");
  const after = await exportProfile();
  assert.deepEqual(after.device.keys, before.device.keys, "mapping edits preserve calibration/RT/deadzones exactly");
  assert.deepEqual(after.device.bindings.filter(b => b.input !== 1), before.device.bindings.filter(b => b.input !== 1));
  assert.equal(after.device.bindings[1].kind, 0);
  assert.equal(await page.evaluate(() => window.__mappingCommands.some(c => c.op === 7 || c.op === 6 && c.payload[0] !== 0)), false);
  await page.evaluate(() => navigator.hid.dispatchEvent(Object.assign(new Event("disconnect"), { device: window.__studioTestHid.device })));
  await page.waitForFunction(() => document.querySelector("#mappingSource").textContent === "마지막으로 읽은 매핑 · 연결 끊김");
  assert.equal(await page.locator("#key-1 .name").textContent(), "미지정", "unplug keeps last-read mapping visibly marked stale");
  await page.locator("#disconnect").click();
  await page.waitForFunction(() => document.querySelector("#mappingSource").textContent === "기본 배치 미리보기");
  await nav("mapping");
  for (let id = 0; id < 28; id++) assert.equal(await page.locator(`#key-${id} .name`).textContent(), names[id]);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of ["mapping", "performance", "calibration", "diagnostics", "rhythm"]) {
    await nav(tab);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `mobile overflow: ${tab}`);
  }
  await nav("mapping");
  await page.screenshot({ path: "build/web-default-mapping-mobile.png", fullPage: true });
  assert.equal(await page.evaluate(() => window.__physicalHidAttempts), 0);
  assert.deepEqual(errors, []);
  console.log("Default mapping browser: all28 disconnected labels, duplicate controls, current user-profile priority/no writes, dynamic remap/unbound titles/aria/guides, preserved Hall settings, recorded labels, reconnect preview and mobile PASS (mock HID only)");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
