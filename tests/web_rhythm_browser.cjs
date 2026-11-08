// Optional isolated browser regression. Serve web/ at 127.0.0.1:8877.
// New context, physical HID blocked, audio muted; no user browser attachment.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { installStudioTestHid, setTestPose } = require("./studio-browser-hid.cjs");
let browser;
(async () => {
  browser = await chromium.launch({
    headless: true,
    args: ["--mute-audio"],
    ...(process.env.C77_BROWSER_CHANNEL ? { channel: process.env.C77_BROWSER_CHANNEL } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  await context.addInitScript(() => {
    window.__physicalHidAttempts = 0;
    const blocked = () => {
      window.__physicalHidAttempts++;
      throw Error("Physical HID forbidden in rhythm browser regression");
    };
    Object.defineProperty(navigator, "hid", { configurable: true,
      value: { requestDevice: blocked, getDevices: blocked } });
  });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  const nav = (name) => page.locator(`.nav[data-tab="${name}"]`).click();
  const pose = (value) => setTestPose(page, value);
  const exported = async (id) => {
    const pending = page.waitForEvent("download");
    await page.locator(`#${id}`).click();
    return JSON.parse(fs.readFileSync(await (await pending).path(), "utf8"));
  };
  const exportProfile = async () => {
    await nav("profiles");
    return exported("export");
  };
  await page.goto(process.env.C77_WEB_URL || "http://127.0.0.1:8877/");
  await installStudioTestHid(page);
  await page.locator("#connect").click();
  await page.waitForFunction(() => document.querySelector("#mode").textContent.startsWith("연결됨"));
  await nav("rhythm");
  assert.equal(await page.locator("#rhythmStart").isDisabled(), true, "uncalibrated sensor cannot start rhythm judgment");
  const initial = await exportProfile();
  const calibrated = structuredClone(initial);
  for (const key of calibrated.device.keys)
    Object.assign(key, { flags: 7, released: 1000, pressed: 3000,
      actuation: 200, rt_press: 100, rt_release: 100, top_deadzone: 20, bottom_deadzone: 0 });
  calibrated.ui.totalTravelMm.fill(4);
  await page.locator("#profileFile").setInputFiles({ name: "rhythm-demo-profile.json",
    mimeType: "application/json", buffer: Buffer.from(JSON.stringify(calibrated)) });
  await page.waitForFunction(() => document.querySelector("#calProgress").textContent === "보정 14 / 14");
  await page.locator("#key-0").click();
  await nav("rhythm");
  await page.locator("#rhythmBpm").fill("240");
  await page.locator("#rhythmDivision").selectOption("8");
  await page.locator("#rhythmBars").selectOption("2");
  await page.locator("#rhythmOffset").fill("15");
  await page.locator("#rhythmMode").selectOption("tap");
  await page.locator("#rhythmStart").click();
  await page.waitForFunction(() => !document.querySelector("#rhythmStop").disabled);
  assert.equal(await page.locator("#key-1").isDisabled(), true, "selected key fixed during capture");
  assert.equal(await page.locator("#outputOn").isDisabled(), true, "capture cannot enable output");
  await page.waitForTimeout(1250); // One 4/4 count-in plus the audio scheduling lead-in.
  for (let i = 0; i < 8; i++) {
    await pose(800);
    await page.waitForTimeout(90);
    await pose(0);
    await page.waitForTimeout(90);
  }
  await page.waitForFunction(() => document.querySelector("#rhythmStop").disabled);
  assert.equal(await page.locator("#outputState").textContent(), "출력 꺼짐");
  assert.ok(await page.locator("#rhythmChart").evaluate((canvas) => canvas.width > 0 && canvas.height > 0));
  assert.ok((await page.locator("#rhythmSampleInfo").textContent()).trim().length > 0);
  assert.ok((await page.locator("#rhythmSummary").textContent()).trim().length > 0);
  const tap = await exported("rhythmExport");
  assert.equal(tap.schema, "split-rhythm-capture-v1");
  assert.equal(tap.completed, true, tap.reason);
  assert.ok(tap.samples.length > 50);
  assert.ok(tap.edges.length >= 4, "observed demo press/release edges recorded");
  assert.ok(JSON.stringify(tap).length > 200, "export contains recorded data, not only a UI label");
  const beforeRetime = JSON.stringify(tap);
  await page.locator("#rhythmOffset").fill("30");
  await page.locator("#rhythmOffset").dispatchEvent("change");
  const proposal = tap.summary.recommendation.personalOffset;
  assert.equal(await page.locator("#rhythmApplyOffset").isDisabled(), !proposal.withinRange,
    "personal offset proposal requires sufficient matched presses");
  if (proposal.withinRange) {
    await page.locator("#rhythmApplyOffset").click();
    assert.equal(Number(await page.locator("#rhythmOffset").inputValue()), Math.round(proposal.offsetMs));
  }
  const retimed = await exported("rhythmExport");
  assert.equal(JSON.stringify(retimed), beforeRetime, "next-session UI settings do not rewrite old evidence");
  await page.locator("#rhythmOffset").fill("30");
  await page.locator("#rhythmReanalyze").click();
  const analyzed = await exported("rhythmExport");
  assert.equal(analyzed.reanalyzed, true);
  assert.equal(analyzed.schedule.settings.delayMs, 30);
  assert.equal(analyzed.acquiredSettings.delayMs, 15);
  assert.deepEqual(analyzed.samples, tap.samples);
  assert.deepEqual(analyzed.edges, tap.edges);
  assert.deepEqual(analyzed.audioEvents, tap.audioEvents);
  for (const target of analyzed.schedule.targets)
    assert.ok(Math.abs(target.targetMs - target.soundMs - 30) < 1e-6);
  fs.mkdirSync("build", { recursive: true });
  await page.screenshot({ path: "build/web-rhythm-tap-desktop.png", fullPage: true });
  assert.deepEqual(await exportProfile(), calibrated, "rhythm and timing selection do not mutate device profile");

  await nav("rhythm");
  await page.locator("#rhythmMode").selectOption("hold");
  await page.locator("#rhythmDivision").selectOption("12");
  await page.locator("#rhythmHoldSteps").fill("8");
  await page.locator("#rhythmGapSteps").fill("4");
  await page.locator("#rhythmStart").click();
  await page.waitForFunction(() => !document.querySelector("#rhythmStop").disabled);
  await page.waitForTimeout(1250);
  await pose(900);
  await page.waitForTimeout(250);
  await pose(850); // Less than release RT: held.
  await page.waitForTimeout(250);
  await pose(650); // Larger return: release observed.
  await page.waitForTimeout(250);
  await pose(900);
  await page.waitForTimeout(250);
  await pose(0);
  await page.waitForFunction(() => document.querySelector("#rhythmStop").disabled);
  assert.ok((await page.locator("#rhythmHoldSummary").textContent()).trim().length > 0);
  const hold = await exported("rhythmExport");
  assert.equal(hold.completed, true, hold.reason);
  assert.ok(hold.summary.holds.length > 0);
  assert.ok(hold.samples.some((sample) => sample.travel >= 840 && sample.travel <= 860 && sample.pressed),
    "small simulated retreat keeps the RT press held");
  assert.ok(hold.samples.some((sample) => sample.travel >= 640 && sample.travel <= 660 && !sample.pressed),
    "larger simulated retreat produces an RT release");
  assert.ok(hold.summary.holds.some((note) => note.earlyReleaseCount >= 1),
    "sustained-note analysis reports the intentionally early release");
  assert.ok(JSON.stringify(hold).length > 200);
  await page.screenshot({ path: "build/web-rhythm-hold-desktop.png", fullPage: true });

  // Hidden tabs invalidate rhythm audio/timing rather than quietly continuing.
  await page.locator("#rhythmStart").click();
  await page.waitForFunction(() => !document.querySelector("#rhythmStop").disabled);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction(() => document.querySelector("#rhythmStop").disabled);
  await page.evaluate(() => {
    delete document.hidden;
    delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  assert.deepEqual(await exportProfile(), calibrated);
  await nav("rhythm");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    "rhythm mobile page does not overflow");
  await page.screenshot({ path: "build/web-rhythm-mobile.png", fullPage: true });
  await page.locator("#rhythmStart").click();
  await page.waitForFunction(() => !document.querySelector("#rhythmStop").disabled);
  await page.locator("#disconnect").click();
  await page.waitForFunction(() => document.querySelector("#mode").textContent === "연결 안 됨");
  assert.equal(await page.locator("#rhythmStop").isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__physicalHidAttempts), 0);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log("Rhythm browser: tap/hold, demo physical-state trace, frozen evidence/next-session delay/reanalysis, no profile/SAVE/output-enable writes, export, hidden-tab/disconnect stop, responsive layout PASS (isolated/muted, no hardware)");
})().catch(async (error) => {
  console.error(error);
  if (browser) await browser.close().catch(() => {});
  process.exit(1);
});
