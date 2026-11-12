// Optional isolated Playwright regression. Serve web at 127.0.0.1:8877 first.
// No existing browser/context or HID device is used. All settings target DemoTransport.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { installStudioTestHid } = require("./studio-browser-hid.cjs");
let browser;
(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.C77_BROWSER_CHANNEL ? { channel: process.env.C77_BROWSER_CHANNEL } : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1080 }, acceptDownloads: true,
  });
  await context.addInitScript(() => {
    window.__physicalHidAttempts = 0;
    const forbidden = () => {
      window.__physicalHidAttempts++;
      throw Error("Physical HID is disabled in browser tests");
    };
    Object.defineProperty(navigator, "hid", {
      configurable: true, value: { requestDevice: forbidden, getDevices: forbidden },
    });
    window.__demoCommands = [];
  });
  // Instrument the actual demo module regardless of its cache-version URL.
  await context.route("**/demo.mjs*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() + `
const originalTestCommand = DemoTransport.prototype.command;
DemoTransport.prototype.command = function(op, payload) {
  window.__demoCommands.push({op, payload:[...payload]});
  const response = originalTestCommand.call(this, op, payload);
  if (op === OP.INFO && window.__legacyTestFirmware) {
    response.set([0,3,3],0);
    const view = new DataView(response.buffer, response.byteOffset, response.byteLength);
    view.setUint32(16, view.getUint32(16,true) & ~0x300, true);
  }
  if (op === OP.STATUS && window.__statusTravelTest) {
    const view = new DataView(response.buffer, response.byteOffset, response.byteLength);
    for (let i=0; i<7; i++) {
      view.setUint16(16+i*2, window.__statusTravelTest.raw, true);
      view.setUint16(30+i*2, window.__statusTravelTest.travel, true);
    }
  }
  return response;
};
` });
  });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  const nav = (name) => page.locator(`.nav[data-tab="${name}"]`).click();
  const notice = (text) => page.waitForFunction(
    (text) => document.querySelector("#notice").textContent.includes(text), text);
  const idle = () => page.waitForFunction(() => !document.querySelector("#refresh").disabled);
  const exportProfile = async () => {
    await idle();
    await nav("profiles");
    const pending = page.waitForEvent("download");
    await page.locator("#export").click();
    const download = await pending;
    const profile = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
    await idle();
    return profile;
  };
  const importProfile = async (profile) => {
    await idle();
    await nav("profiles");
    await page.locator("#profileFile").setInputFiles({
      name: "performance-test.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(profile)),
    });
    await notice("프로필 RAM 적용 및 읽기 검증 완료");
    await idle();
  };
  const selected = () => page.locator(".key.selected").evaluateAll((keys) =>
    keys.map((key) => Number(key.id.slice(4))).sort((a, b) => a - b));
  const assertSelection = async (ids) => {
    assert.deepEqual(await selected(), ids);
    assert.equal(await page.locator("#performanceSelectionCount").textContent(), `${ids.length}개 선택`);
  };
  const commands = () => page.evaluate(() => window.__demoCommands);
  const clearCommands = () => page.evaluate(() => { window.__demoCommands = []; });
  const assertNoSaveOrEnable = async () => {
    const calls = await commands();
    assert.equal(calls.some((call) => call.op === 7), false, "no implicit Flash SAVE");
    assert.equal(calls.some((call) => call.op === 6 && call.payload[0] !== 0), false, "no implicit output enable");
    assert.equal(await page.locator("#outputState").textContent(), "출력 꺼짐");
    assert.equal(await page.locator("#generation").textContent(), "0");
  };

  await page.goto(process.env.C77_WEB_URL || "http://127.0.0.1:8877/");
  assert.doesNotMatch(await page.locator("body").innerText(), /실제 장치 연결은 한 번에 한 설정창만|센서 데이터는 외부 서버로 보내지 않습니다/);
  await installStudioTestHid(page);
  await page.locator("#connect").click();
  await page.waitForFunction(() => document.querySelector("#mode").textContent.includes("v0.3.22"));
  await idle();
  const fixture = await exportProfile();
  fixture.ui.totalTravelMm = Array(14).fill(4);
  fixture.ui.totalTravelMm[7] = 3.2;
  fixture.device.keys.forEach((key, id) => Object.assign(key, {
    flags: id === 7 ? 4 : 7,
    released: id < 7 ? 1000 + id : 3100 + id,
    pressed: id < 7 ? 3000 + id : 1100 + id,
    actuation: 200 + id * 10, rt_press: 100 + id * 2,
    rt_release: 120 + id, top_deadzone: 20 + id,
    bottom_deadzone: id === 0 ? 20 : id === 7 ? 30 : 0,
    noise_deadband: 5 + id % 4,
  }));
  fixture.device.bindings[0] = { input: 0, kind: 1, code: 4, modifiers: 2 };
  fixture.device.bindings[7] = { input: 7, kind: 5, code: 2, modifiers: 0 };
  await importProfile(fixture);
  assert.equal(await page.locator("#calProgress").textContent(), "보정 14 / 14");
  assert.deepEqual(await exportProfile(), fixture);
  await nav("performance");
  assert.equal(await page.locator("#bottomDeadzone").isDisabled(), false);
  assert.equal(await page.locator("#bottomDeadzoneCompatibility").isVisible(), false);
  await page.locator("#multiSelectHall").check();
  await page.locator("#key-7").click();
  await assertSelection([0, 7]);
  for (const id of ["actuation", "rtPress", "rtRelease", "topDeadzone", "bottomDeadzone", "totalTravel"])
    assert.equal(await page.locator(`#${id}`).getAttribute("placeholder"), "혼합", `${id} exposes mixed values`);
  for (const id of ["enabled", "rt"])
    assert.equal(await page.locator(`#${id}`).evaluate((input) => input.indeterminate), true);
  assert.equal(await page.locator("#applyKey").isDisabled(), true, "selection alone is not an edit");

  await page.locator("#selectLeftHall").click();
  await assertSelection(Array.from({ length: 7 }, (_, i) => i));
  await page.locator("#selectRightHall").click();
  await assertSelection(Array.from({ length: 7 }, (_, i) => i + 7));
  await page.locator("#selectAllHall").click();
  await assertSelection(Array.from({ length: 14 }, (_, i) => i));
  await page.locator("#clearHallSelection").click();
  await assertSelection([]);
  assert.equal(await page.locator("#applyKey").isDisabled(), true);
  await page.locator("#multiSelectHall").uncheck();
  await page.locator("#key-0").click();
  await page.locator("#key-7").click({ modifiers: ["Control"] });
  await assertSelection([0, 7]);
  assert.equal(await page.locator("#multiSelectHall").isChecked(), true);

  await clearCommands();
  await page.locator("#actuation").fill("0.8");
  await page.locator("#rtPress").fill("0.16");
  await page.locator("#bottomDeadzone").fill("0.32");
  await page.locator("#applyKey").click();
  await notice("2개 키 설정 적용 완료");
  await idle();
  const group = await exportProfile();
  for (let id = 0; id < 14; id++) {
    const expected = structuredClone(fixture.device.keys[id]);
    if ([0, 7].includes(id)) Object.assign(expected, {
      actuation: id === 0 ? 200 : 250,
      rt_press: id === 0 ? 40 : 50,
      bottom_deadzone: id === 0 ? 80 : 100,
    });
    assert.deepEqual(group.device.keys[id], expected, `key ${id}: only edited distances change`);
  }
  assert.deepEqual(group.device.bindings, fixture.device.bindings);
  assert.deepEqual(group.ui, fixture.ui);
  assert.deepEqual((await commands()).filter((call) => call.op === 4).map((call) => call.payload[0]), [0, 7]);
  await assertNoSaveOrEnable();
  await importProfile(group);
  assert.deepEqual(await exportProfile(), group, "bottom deadzone survives UI profile round trip");

  // Mixed checkboxes change only flags, without copying distances from a primary key.
  await nav("performance");
  await assertSelection([0, 7]);
  await page.locator("#enabled").check();
  await page.locator("#rt").check();
  await page.locator("#applyKey").click();
  await notice("2개 키 설정 적용 완료");
  await idle();
  const flagsApplied = await exportProfile();
  const flagsExpected = structuredClone(group);
  flagsExpected.device.keys[0].flags = flagsExpected.device.keys[7].flags = 7;
  assert.deepEqual(flagsApplied, flagsExpected);
  await assertNoSaveOrEnable();

  // The explicit Owlab preset stages a curve and 3.4mm metadata. Selected keys
  // alone change after Apply; all endpoints/bindings/thresholds remain exact.
  await nav("performance");
  await page.locator("#actuation").fill("0.40");
  await page.locator("#owlabPreset").click();
  assert.equal(await page.locator("#curveId").inputValue(), "1");
  assert.equal(await page.locator("#totalTravel").inputValue(), "3.40");
  assert.equal(await page.locator("#actuation").inputValue(), "0.40", "preset preserves a pending actuation edit");
  await page.locator("#applyKey").click();
  await notice("2개 키 설정 적용 완료"); await idle();
  const curved = await exportProfile(), expectedCurve = structuredClone(flagsApplied);
  for (const id of [0, 7]) {
    expectedCurve.device.keys[id].curve_id = 1;
    expectedCurve.device.keys[id].actuation = Math.round(.4 / 3.4 * 1000);
    expectedCurve.ui.totalTravelMm[id] = 3.4;
  }
  assert.deepEqual(curved, expectedCurve);
  await importProfile(curved);
  assert.deepEqual(await exportProfile(), curved, "curve and travel survive Studio profile round trip");
  await nav("performance");

  // Filtered STATUS travel deliberately disagrees with the instantaneous ADC.
  // Live distances and default sensor statistics follow firmware RT travel.
  // The optional ADC view still exposes the reported ADC code.
  await page.evaluate(() => { window.__statusTravelTest = {raw: 1234, travel: 750}; });
  await page.waitForFunction(() => document.querySelector("#liveTravel").textContent === "2.55 mm");
  for (const id of [0, 7]) {
    assert.equal(await page.locator(`#key-${id} .travel`).textContent(), "2.55 mm");
    assert.equal(await page.locator(`#key-${id} .bar`).evaluate((bar) => bar.style.width), "75%");
    assert.equal(await page.locator(`#key-${id} .raw`).textContent(), "1234");
  }
  assert.equal(await page.locator("#travelFill").evaluate((bar) => bar.style.height), "75%");
  assert.equal(await page.locator("#liveRaw").textContent(), "ADC 1234");
  await nav("diagnostics");
  await page.locator("#clearStats").click();
  for (const id of [0, 7]) {
    await page.locator(`#key-${id}`).click();
    await page.waitForFunction(() => document.querySelector("#mean").textContent === "2.5500");
    assert.match(await page.locator("#diagnosticSignalLabel").textContent(), /인식 이동량 \(데드존 적용\)/);
  }
  await page.locator("#diagnosticAdc").check();
  await page.waitForFunction(() => document.querySelector("#mean").textContent === "1234.00");
  assert.equal(await page.locator("#variance").textContent(), "0.00");
  await page.locator("#diagnosticAdc").uncheck();
  await page.locator("#key-0").click();
  await page.evaluate(() => { window.__statusTravelTest = null; });
  await nav("performance");
  await page.locator("#key-7").click({ modifiers: ["Control"] });

  await clearCommands();
  await page.locator("#totalTravel").fill("4.00");
  await page.locator("#applyTravel").click();
  const scaled = await exportProfile();
  assert.deepEqual(scaled.device, curved.device, "changing total stroke scales distance only");
  assert.equal(scaled.ui.totalTravelMm[0], 4); assert.equal(scaled.ui.totalTravelMm[7], 4);
  assert.equal((await commands()).some((call) => [4,5,6,7,8,10].includes(call.op)), false);
  await assertNoSaveOrEnable();

  // Screenshot the mixed selection and check every tab at a narrow viewport.
  await nav("performance");
  await page.locator("#selectAllHall").click();
  fs.mkdirSync("build", { recursive: true });
  await page.screenshot({ path: "build/web-performance-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of ["performance", "mapping", "calibration", "diagnostics", "profiles"]) {
    await nav(tab);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `mobile overflow: ${tab}`);
  }
  await nav("performance");
  await page.screenshot({ path: "build/web-performance-mobile.png", fullPage: true });

  // Older firmware advertises no bottom-deadzone capability; the UI must gate it.
  await page.locator("#disconnect").click();
  await page.evaluate(() => { window.__legacyTestFirmware = true; });
  await page.locator("#connect").click();
  await page.waitForFunction(() => document.querySelector("#mode").textContent.includes("v0.3.3"));
  await idle();
  await nav("performance");
  assert.equal(await page.locator("#bottomDeadzone").isDisabled(), true);
  assert.equal(await page.locator("#bottomDeadzoneRange").isDisabled(), true);
  assert.equal(await page.locator("#bottomDeadzoneCompatibility").isVisible(), true);
  assert.equal(await page.locator("#curveId").isDisabled(), true);
  assert.equal(await page.locator("#owlabPreset").isDisabled(), true);
  assert.equal(await page.locator("#curveCompatibility").isVisible(), true);
  await assertNoSaveOrEnable();
  assert.equal(await page.evaluate(() => window.__physicalHidAttempts), 0);
  assert.deepEqual(errors, []);
  await context.close();
  await browser.close();
  browser = null;
  console.log("Performance UI: mixed Hall selection, per-key mm patches, preservation, filtered STATUS travel vs raw diagnostics, bottom capability, round-trip and mobile checks passed; no hardware/SAVE/output-enable");
})().catch(async (error) => {
  console.error(error);
  if (browser) await browser.close();
  process.exitCode = 1;
});
