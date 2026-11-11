// Isolated simulated device. Never connects to an attached physical keyboard.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { installStudioTestHid, setTestPose } = require("./studio-browser-hid.cjs");

(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome", args: ["--mute-audio"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    page.setDefaultTimeout(16000);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "hid", { configurable: true, value: {
        requestDevice: () => { throw Error("Physical HID blocked"); },
        getDevices: () => { throw Error("Physical HID blocked"); },
      } });
    });
    await page.goto(process.env.C77_WEB_URL || "http://127.0.0.1:8881/");
    await installStudioTestHid(page);
    await page.locator("#connect").click();
    await page.locator('[data-tab="rhythm"]').click();
    assert(await page.locator("#autoFitStart").isDisabled());
    await page.locator('[data-tab="profiles"]').click();
    const download = page.waitForEvent("download");
    await page.locator("#export").click();
    const profile = JSON.parse(fs.readFileSync(await (await download).path(), "utf8"));
    for (const key of profile.device.keys) Object.assign(key, {
      flags: 7, released: 1000, pressed: 3000, actuation: 200, rt_press: 100, rt_release: 100,
      top_deadzone: 20, bottom_deadzone: 0, noise_deadband: 0,
    });
    profile.ui.totalTravelMm.fill(4);
    await page.locator("#profileFile").setInputFiles({ name: "test.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(profile)) });
    await page.waitForFunction(() => document.querySelector("#calProgress").textContent === "보정 14 / 14");
    await page.locator('[data-tab="rhythm"]').click();
    const start = async () => {
      await page.locator("#autoFitStart").click();
      await page.waitForFunction(() => document.querySelector("#autoFitState").textContent.includes("남음"));
      assert(await page.locator("#key-1").isDisabled());
      assert(await page.locator("#rhythmStart").isDisabled());
      assert(await page.locator("#outputOn").isDisabled());
    };
    const done = () => page.waitForFunction(() => document.querySelector("#autoFitStop").disabled);
    const run = async () => {
      await setTestPose(page, 0); await start(); await done();
      await setTestPose(page, 30); await start(); await done();
      await setTestPose(page, 0); await start();
      for (let index = 0; index < 9; index++) {
        await setTestPose(page, 900); await page.waitForTimeout(260);
        await setTestPose(page, 0); await page.waitForTimeout(260);
      }
      await done();
      await setTestPose(page, 900); await start(); await done();
      await setTestPose(page, 0);
    };
    await run();
    assert(await page.locator("#autoFitApply").isEnabled(), await page.locator("#autoFitReasons").innerText());
    assert((await page.locator("#autoFitValues").innerText()).includes("작동점"));
    await page.locator("#autoFitApply").click();
    await page.waitForFunction(() => !document.querySelector("#autoFitRetest").disabled);
    const after = await page.evaluate(() => window.__studioTestHid.simulator.profile);
    assert.deepEqual(after.keys.slice(1), profile.device.keys.slice(1));
    assert.deepEqual(after.bindings, profile.device.bindings);
    for (const field of ["released", "pressed", "curve_id", "noise_deadband"])
      assert.equal(after.keys[0][field], profile.device.keys[0][field]);
    assert.equal(await page.locator("#outputState").textContent(), "출력 꺼짐");
    await page.locator("#autoFitRetest").click();
    await run();
    assert((await page.locator("#autoFitRetestSummary").innerText()).includes("실제 관측"));
    const pending = page.waitForEvent("download");
    await page.locator("#autoFitExport").click();
    const record = JSON.parse(fs.readFileSync(await (await pending).path(), "utf8"));
    assert.equal(record.schema, "split-beat-auto-fit-v1");
    assert.equal(typeof record.demo, "boolean");
    assert(record.verification.observedMetrics);
    for (const rows of Object.values(record.phases)) assert(rows.length >= 40 && rows.every(row => typeof row.pressed === "boolean"));
    fs.mkdirSync("build", { recursive: true });
    await page.screenshot({ path: "build/web-auto-fit-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 420, height: 900 });
    await page.screenshot({ path: "build/web-auto-fit-mobile.png", fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    await page.locator("#autoFitReset").click();
    await start();
    await page.locator('[data-tab="mapping"]').click();
    await page.locator('[data-tab="rhythm"]').click();
    assert(await page.locator("#autoFitStop").isDisabled());
    assert(await page.locator("#autoFitApply").isDisabled());
    assert.deepEqual(errors, []);
    console.log("Auto fit browser: four phases, recommendation, explicit one-key RAM apply, observed retest, export, mobile and capture cancellation PASS (simulated HID)");
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
