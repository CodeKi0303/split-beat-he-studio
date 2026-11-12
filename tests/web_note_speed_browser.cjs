// Isolated browser, muted native Web Audio, and DemoTransport only. No hardware.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { installStudioTestHid } = require("./studio-browser-hid.cjs");
const STORAGE_KEY = "split-studio-rhythm-note-speed-v1";

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.C77_BROWSER_CHANNEL || "msedge", args: ["--mute-audio"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
    await context.addInitScript(() => {
      window.__physicalHidAttempts = 0;
      const blocked = () => { window.__physicalHidAttempts++; throw Error("Physical HID forbidden in note-speed test"); };
      Object.defineProperty(navigator, "hid", { configurable: true, value: { requestDevice: blocked, getDevices: blocked } });
      window.__audioContextCount = 0;
      const NativeAudio = window.AudioContext;
      window.AudioContext = new Proxy(NativeAudio, { construct(target, args, newTarget) {
        window.__audioContextCount++;
        return Reflect.construct(target, args, newTarget);
      } });
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Expose the real instance only in this isolated test response.
    await page.route("**/rhythm-ui.mjs*", async (route) => {
      const response = await route.fetch(), source = await response.text();
      assert(source.includes("this.audio = new RhythmAudio();"));
      await route.fulfill({ response, body: source.replace("this.audio = new RhythmAudio();",
        "this.audio = new RhythmAudio(); globalThis.__speedTestLab = this;") });
    });
    await page.goto(process.env.C77_WEB_URL || "http://127.0.0.1:8888/");
    const nav = () => page.locator('.nav[data-tab="rhythm"]').click();
    const setSpeed = (value) => page.locator("#rhythmNoteSpeed").evaluate((input, next) => {
      input.value = String(next); input.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
    await nav();
    assert.equal(await page.locator("#rhythmNoteSpeed").inputValue(), "1");
    assert.equal(await page.locator("#rhythmNoteSpeedValue").textContent(), "1.0×");
    assert((await page.locator("#rhythmNoteSpeedDuration").textContent()).includes("1.800초"));
    assert.equal(await page.locator("#rhythmNoteSpeed").getAttribute("min"), "0.5");
    assert.equal(await page.locator("#rhythmNoteSpeed").getAttribute("max"), "4");

    // Observe actual filled note-head coordinates from the production painter,
    // not just the pure geometry helper. A fixed target isolates visual speed.
    for (const [speed, horizon] of [[0.5, 3600], [4, 450]]) {
      await setSpeed(speed);
      assert.equal(await page.locator("#rhythmNoteSpeedValue").textContent(), `${speed.toFixed(1)}×`);
      assert((await page.locator("#rhythmNoteSpeedDuration").textContent()).includes(`${(horizon / 1000).toFixed(3)}초`));
      const geometry = await page.evaluate(({ horizon }) => {
        const lab = window.__speedTestLab, canvas = document.querySelector("#rhythmLane"), ctx = canvas.getContext("2d");
        const schedule = { quarterMs: 500, cues: [{ id: "one", type: "tap", onMs: 5000, offMs: 5100 }],
          targets: [{ id: "one-press", targetMs: 5000 }, { id: "one-release", targetMs: 5100 }] };
        const fillRect = ctx.fillRect, heads = [];
        ctx.fillRect = function (x, y, w, h) {
          if (h === 8 && ["#b4ed78", "#d5f9b0"].includes(this.fillStyle)) heads.push(y + 4);
          return fillRect.call(this, x, y, w, h);
        };
        const at = (elapsedMs) => {
          heads.length = 0;
          lab.practice.drawLane({ schedule, elapsedMs, active: true, preparing: false, countingIn: false,
            starting: false, hasResult: false, pressed: false, label: "Test", noteSpeed: lab.noteSpeed });
          return [...heads];
        };
        try {
          const result = { top: 12, line: canvas.getBoundingClientRect().height - 58,
            beforeAppearance: at(5000 - horizon * 1.1), atAppearance: at(5000 - horizon),
            halfway: at(5000 - horizon / 2), atTarget: at(5000), sameTime: at(5000 - 225) };
          return result;
        } finally { ctx.fillRect = fillRect; lab.drawPractice(); }
      }, { horizon });
      assert.deepEqual(geometry.beforeAppearance, [], "target has not entered before its speed-specific appearance horizon");
      assert(Math.abs(geometry.atAppearance[0] - geometry.top) < 1e-6);
      assert(Math.abs(geometry.halfway[0] - (geometry.top + geometry.line) / 2) < 1e-6);
      assert(Math.abs(geometry.atTarget[0] - geometry.line) < 1e-6, "both speeds meet the same target time");
      assert(Math.abs(geometry.sameTime[0] - (geometry.line - 225 / horizon * (geometry.line - geometry.top))) < 1e-6);
      assert((await page.locator("#rhythmLane").getAttribute("aria-label")).includes(`${speed.toFixed(1)}배`));
    }
    await setSpeed(2.3);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY), "2.3");
    await page.reload(); await nav();
    assert.equal(await page.locator("#rhythmNoteSpeed").inputValue(), "2.3", "speed persists through reload");
    for (const invalid of ["broken", "0", "4.5", ""]) {
      await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: STORAGE_KEY, value: invalid });
      await page.reload(); await nav();
      assert.equal(await page.locator("#rhythmNoteSpeed").inputValue(), "1", `malformed preference ${JSON.stringify(invalid)} falls back`);
      assert.equal(await page.locator("#rhythmNoteSpeedValue").textContent(), "1.0×");
    }

    await installStudioTestHid(page);
    await page.evaluate(() => {
      const request = navigator.hid.requestDevice;
      navigator.hid.requestDevice = async (...args) => {
        const devices = await request(...args), sim = window.__studioTestHid.simulator;
        for (const key of sim.profile.keys) Object.assign(key, { flags: 7, released: 1000, pressed: 3000,
          actuation: 200, rt_press: 100, rt_release: 100, top_deadzone: 20, bottom_deadzone: 0 });
        sim.stored = structuredClone(sim.profile);
        window.__initialSpeedProfile = structuredClone(sim.profile);
        window.__speedCommands = [];
        const command = sim.command.bind(sim);
        sim.command = (op, payload) => { window.__speedCommands.push({ op, payload: Array.from(payload) }); return command(op, payload); };
        return devices;
      };
    });
    await page.locator("#connect").click();
    await page.waitForFunction(() => document.querySelector("#calProgress").textContent === "보정 14 / 14");
    await page.waitForFunction(() => !document.querySelector("#refresh").disabled);
    await page.locator("#rhythmBpm").fill("120");
    await page.locator("#rhythmBars").selectOption("2");
    await page.locator("#rhythmDivision").selectOption("8");
    await page.locator("#rhythmStart").click();
    await page.waitForFunction(() => window.__speedTestLab.active && !window.__speedTestLab.starting && window.__speedTestLab.capture.samples.length >= 4);
    assert(await page.locator("#rhythmNoteSpeed").isEnabled(), "visual speed remains editable while capturing");
    assert(await page.locator("#rhythmBpm").isDisabled(), "timing settings remain locked during capture");
    for (const speed of [0.5, 4, 1.7]) {
      const result = await page.evaluate((speed) => {
        const lab = window.__speedTestLab;
        const before = { context: lab.audio.context, capture: lab.capture, schedule: lab.schedule,
          origin: lab.origin, generation: lab.generation, audioGeneration: lab.audio.generation,
          contexts: window.__audioContextCount, settings: JSON.stringify(lab.settings()),
          targets: JSON.stringify(lab.schedule.targets), samples: JSON.stringify(lab.capture.samples),
          audioEvents: JSON.stringify(lab.events), audioNotes: JSON.stringify(lab.audio.notes),
          commands: JSON.stringify(window.__speedCommands) };
        const slider = document.querySelector("#rhythmNoteSpeed");
        slider.value = speed; slider.dispatchEvent(new Event("input", { bubbles: true }));
        return { active: lab.active, speed: lab.noteSpeed,
          sameContext: lab.audio.context === before.context, sameCapture: lab.capture === before.capture,
          sameSchedule: lab.schedule === before.schedule, sameOrigin: lab.origin === before.origin,
          sameGeneration: lab.generation === before.generation && lab.audio.generation === before.audioGeneration,
          sameContextCount: window.__audioContextCount === before.contexts,
          sameSettings: JSON.stringify(lab.settings()) === before.settings,
          sameTargets: JSON.stringify(lab.schedule.targets) === before.targets,
          sameSamples: JSON.stringify(lab.capture.samples) === before.samples,
          sameAudio: JSON.stringify(lab.events) === before.audioEvents && JSON.stringify(lab.audio.notes) === before.audioNotes,
          sameHid: JSON.stringify(window.__speedCommands) === before.commands };
      }, speed);
      assert.equal(result.speed, speed);
      for (const [name, value] of Object.entries(result)) if (name !== "speed") assert.equal(value, true, `${speed}×: ${name}`);
    }
    assert.equal(await page.locator("#rhythmBpm").inputValue(), "120");
    await page.evaluate(() => { window.__studioTestHid.simulator.pose[0] = 800; });
    await page.waitForFunction(() => window.__speedTestLab.capture.edges.length >= 1);
    await page.evaluate(() => { window.__studioTestHid.simulator.pose[0] = 0; });
    await page.waitForFunction(() => window.__speedTestLab.capture.edges.length >= 2);
    await page.locator("#rhythmStop").click();
    const exported = async () => {
      const event = page.waitForEvent("download"); await page.locator("#rhythmExport").click();
      return JSON.parse(fs.readFileSync(await (await event).path(), "utf8"));
    };
    const beforeExport = await exported();
    assert(beforeExport.samples.length >= 4 && beforeExport.edges.length >= 2);
    await setSpeed(4);
    const afterExport = await exported();
    assert.deepEqual(afterExport, beforeExport, "changing presentation speed cannot alter exported capture, targets or audio metadata");
    const safety = await page.evaluate(() => ({
      commands: window.__speedCommands, profile: window.__studioTestHid.simulator.profile,
      initial: window.__initialSpeedProfile, stored: window.__studioTestHid.simulator.stored,
      enabled: window.__studioTestHid.simulator.enabled, audioContexts: window.__audioContextCount,
      physicalHidAttempts: window.__physicalHidAttempts,
    }));
    assert.deepEqual(safety.profile, safety.initial);
    assert.deepEqual(safety.stored, safety.initial);
    assert.equal(safety.enabled, false);
    assert.equal(safety.audioContexts, 1, "one native AudioContext for the one explicit start");
    assert.equal(safety.physicalHidAttempts, 0);
    assert(!safety.commands.some((call) => [4, 5, 7, 8, 10].includes(call.op)), "no profile/configuration writes or SAVE");
    assert(!safety.commands.some((call) => call.op === 6 && call.payload[0] !== 0), "no automatic output enable");

    // Reload back to normal idle preview; saved 4× still shows a visible note.
    await page.reload(); await nav();
    assert.equal(await page.locator("#rhythmNoteSpeed").inputValue(), "4");
    fs.mkdirSync("build", { recursive: true });
    await page.locator("#rhythmPractice").screenshot({ path: "build/web-note-speed-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "note-speed controls fit mobile viewport");
    assert(await page.locator("#rhythmNoteSpeed").isVisible());
    await page.locator("#rhythmPractice").screenshot({ path: "build/web-note-speed-mobile.png" });
    assert.deepEqual(errors, []);
    await context.close();
    console.log("Note speed browser: default/bounds/real painted geometry, appearance timing, persistence/fallback, live audio/capture/HID invariance, exports and mobile PASS (no hardware)");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
