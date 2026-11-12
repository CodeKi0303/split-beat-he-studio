// Isolated browser only. Serve this worktree on 8888; all HID is protocol mock.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { installStudioTestHid } = require("./studio-browser-hid.cjs");
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, args: ["--mute-audio"],
    ...(process.env.C77_BROWSER_CHANNEL ? { channel: process.env.C77_BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  await context.addInitScript(() => {
    window.__physicalHidAttempts = 0;
    const blocked = () => { window.__physicalHidAttempts++; throw Error("Physical HID forbidden in practice test"); };
    Object.defineProperty(navigator, "hid", { configurable: true, value: { requestDevice: blocked, getDevices: blocked } });
  });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.message));
  // Test-only observation of the actual instance; production files expose no globals.
  await page.route("**/rhythm-ui.mjs*", async (route) => {
    const response = await route.fetch(), source = await response.text();
    assert.ok(source.includes("this.audio = new RhythmAudio();"));
    await route.fulfill({ response, body: source.replace("this.audio = new RhythmAudio();",
      "this.audio = new RhythmAudio(); globalThis.__practiceTestLab = this;") });
  });
  await page.goto(process.env.C77_WEB_URL || "http://127.0.0.1:8888/");
  await installStudioTestHid(page);
  await page.locator("#connect").click();
  await page.waitForFunction(() => document.querySelector("#mode").textContent.startsWith("연결됨"));
  const nav = (name) => page.locator(`.nav[data-tab="${name}"]`).click();
  const exported = async (id) => {
    const pending = page.waitForEvent("download");
    await page.locator(`#${id}`).click();
    return JSON.parse(fs.readFileSync(await (await pending).path(), "utf8"));
  };
  await nav("profiles");
  const initial = await exported("export"), calibrated = structuredClone(initial);
  for (const key of calibrated.device.keys) Object.assign(key, { flags: 7, released: 1000, pressed: 3000,
    actuation: 200, rt_press: 100, rt_release: 100, top_deadzone: 20, bottom_deadzone: 0 });
  calibrated.ui.totalTravelMm.fill(4);
  await page.locator("#profileFile").setInputFiles({ name: "practice-mock-profile.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(calibrated)) });
  await page.waitForFunction(() => document.querySelector("#calProgress").textContent === "보정 14 / 14");
  await page.locator("#key-0").click();
  await nav("rhythm");
  assert.ok(await page.locator("#rhythmLane").evaluate((canvas) => canvas.width > 0 && canvas.height > 0));
  const keyLabel = await page.locator("#rhythmKey").textContent();
  assert.equal(await page.locator("#rhythmLaneKey").textContent(), keyLabel);
  // 120 BPM leaves enough released time between taps for real mock-HID polls,
  // including under simultaneous browser-suite load; no edges are injected.
  await page.locator("#rhythmBpm").fill("120");
  await page.locator("#rhythmBars").selectOption("2");
  await page.locator("#rhythmOffset").fill("0");
  fs.mkdirSync("build", { recursive: true });

  for (const division of [8, 12, 16]) {
    const mode = division === 12 ? "hold" : "tap";
    await page.locator("#rhythmMode").selectOption(mode);
    await page.locator("#rhythmDivision").selectOption(String(division));
    if (mode === "hold") { await page.locator("#rhythmHoldSteps").fill("8"); await page.locator("#rhythmGapSteps").fill("4"); }
    await page.locator("#rhythmStart").click();
    await page.waitForFunction(() => window.__practiceTestLab?.origin !== null && !window.__practiceTestLab?.starting);
    assert.equal(await page.locator("#rhythmPractice").getAttribute("data-phase"), "preparing");
    assert.equal(await page.locator("#rhythmTimingValue").textContent(), "—");
    // These timers change only the simulated physical pose. The production HID
    // polling, RT state and sampled edge analysis must create every judgment.
    await page.evaluate(({ division, mode }) => {
      const lab = window.__practiceTestLab, simulator = window.__studioTestHid.simulator, key = lab.recordContext.key;
      window.__practiceObservations = [];
      window.__practicePoseTimers = [];
      const at = (timeMs, value) => window.__practicePoseTimers.push(setTimeout(() => { simulator.pose[key] = value; },
        Math.max(0, lab.origin + timeMs - performance.now())));
      at(300, 800); at(450, 0); // preparation movement is deliberately captured
      const tapped = new Set(lab.schedule.cues.filter((cue) => cue.type !== "count-in").slice(0, 6).map((cue) => cue.id));
      const onEvent = lab.audio.onEvent;
      lab.audio.onEvent = (event) => {
        // Let production map native audio timestamps into corrected targets
        // before scheduling physical poses. Nominal cue times can differ by
        // an audio-device latency estimate, even in a muted headless browser.
        onEvent(event);
        if (event.type === "count-in") return;
        const target = (type) => lab.schedule.targets.find((entry) => entry.id === `${event.id}-${type}`).targetMs;
        if (division === 8 && event.kind === "on" && tapped.has(event.id)) {
          at(target("press") - 30, 800); at(target("release") + 22, 0);
        } else if (mode === "hold") {
          if (event.kind === "on") { at(target("press") - 25, 900); at(target("press") + 220, 850); }
          else if (event.kind === "off") at(target("release") + 35, 0);
        }
      };
      const observe = setInterval(() => {
        window.__practiceObservations.push({ phase: document.querySelector("#rhythmPractice").dataset.phase,
          state: document.querySelector("#rhythmTimingCard").dataset.timing,
          value: document.querySelector("#rhythmTimingValue").textContent,
          counts: document.querySelector("#rhythmTimingCounts").textContent,
          lane: document.querySelector("#rhythmLaneState").textContent,
          edgeCount: lab.capture.edges.length });
        if (!lab.active) clearInterval(observe);
      }, 20);
    }, { division, mode });
    await page.waitForFunction(() => window.__practiceTestLab.capture.edges.length >= 2);
    assert.equal(await page.locator("#rhythmTimingCounts").textContent(), "대응 0 · 미관측 0 · 목표 밖 0",
      "observed preparation movements do not score");
    if (mode === "hold") {
      await page.waitForFunction(() => document.querySelector("#rhythmLaneState").textContent.includes("유지 중"));
      await page.locator("#rhythmPractice").screenshot({ path: "build/web-rhythm-practice-hold.png" });
      const noteTimes = await page.evaluate(async () => {
        const { laneNotes } = await import("./rhythm-visuals.mjs");
        return laneNotes(window.__practiceTestLab.schedule);
      });
      assert.ok(noteTimes.every((note) => note.type === "hold" && note.releaseMs - note.pressMs > 800));
    }
    await page.waitForFunction(() => document.querySelector("#rhythmStop").disabled);
    const result = await exported("rhythmExport"), observations = await page.evaluate(() => window.__practiceObservations);
    assert.equal(result.completed, true, result.reason);
    assert.equal(result.schedule.cues.filter((cue) => cue.type === "count-in").length, division);
    const clicks = result.audioEvents.filter((event) => event.type === "count-in" && event.kind === "on");
    assert.equal(clicks.length, division, `all ${division} preparation sounds are scheduled`);
    const firstNote = result.audioEvents.find((event) => event.type !== "count-in" && event.kind === "on");
    assert.ok(Math.abs(firstNote.performanceMs - clicks.at(-1).performanceMs - result.schedule.stepMs) < 35,
      "selected subdivision continues across preparation/performance boundary");
    assert.ok(result.edges.some((edge) => edge.timeMs < result.schedule.countInMs / 2));
    assert.ok(observations.filter((item) => item.phase === "preparing").every((item) => item.value === "—"));
    assert.ok(!result.summary.extraEdges.some((edge) => edge.timeMs < result.schedule.countInMs / 2));
    if (division === 8) {
      assert.ok(result.summary.press.count >= 4 && result.summary.release.count >= 4, JSON.stringify({ press: result.summary.press, release: result.summary.release, edges: result.edges, issues: result.summary.issues }));
      assert.ok(observations.some((item) => item.state === "early" && item.edgeCount > 2));
      assert.ok(observations.some((item) => item.state === "late" && item.edgeCount > 2));
      assert.ok(result.summary.unmatchedTargets > 0, "unplayed notes remain unobserved");
      await page.locator("#rhythmPractice").screenshot({ path: "build/web-rhythm-practice-timing.png" });
      const before = result.samples;
      await page.locator("#rhythmOffset").fill("30");
      await page.locator("#rhythmReanalyze").click();
      const retimed = await exported("rhythmExport");
      assert.deepEqual(retimed.samples, before);
      assert.equal(retimed.schedule.settings.delayMs, 30);
      assert.equal(await page.locator("#rhythmTimingCounts").textContent(),
        `대응 ${retimed.summary.matchedTargets} · 미관측 ${retimed.summary.unmatchedTargets} · 목표 밖 ${retimed.summary.extraEdges.length}`);
      await page.locator("#rhythmOffset").fill("0");
    } else if (division === 16) {
      assert.equal(result.summary.matchedTargets, 0, "elapsed notes cannot create success without input");
      assert.equal(await page.locator("#rhythmTimingValue").textContent(), "—");
      assert.match(await page.locator("#rhythmTimingVerdict").textContent(), /미관측/);
    }
  }
  assert.ok(await page.locator("#rhythmChart").evaluate((canvas) => canvas.width > 0 && canvas.height > 0), "sensor graph retained");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: "build/web-rhythm-practice-mobile.png", fullPage: true });
  await page.locator("#rhythmStart").click();
  await page.waitForFunction(() => window.__practiceTestLab.active);
  await page.locator("#disconnect").click();
  assert.equal(await page.locator("#rhythmStop").isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__physicalHidAttempts), 0);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log("Rhythm practice browser: mocked HID prep exclusion, 8/12/16 audio continuity, live EARLY/LATE, held lane, misses, offset reanalysis, retained graph, mobile and disconnect PASS (no hardware)");
})().catch(async (error) => { console.error(error); if (browser) await browser.close().catch(() => {}); process.exit(1); });
