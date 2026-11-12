// Isolated Edge, muted Web Audio, and DemoTransport only. No physical keyboard.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { installStudioTestHid } = require("./studio-browser-hid.cjs");

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.C77_BROWSER_CHANNEL || "msedge", args: ["--mute-audio"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
    await context.addInitScript(() => {
      window.__physicalHidAttempts = 0;
      const blocked = () => { window.__physicalHidAttempts++; throw Error("Physical HID forbidden in consumed-note test"); };
      Object.defineProperty(navigator, "hid", { configurable: true, value: { requestDevice: blocked, getDevices: blocked } });
    });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error) => errors.push(error.message));
    // Test-only observation of the real instance; production exposes no globals.
    await page.route("**/rhythm-ui.mjs*", async (route) => {
      const response = await route.fetch(), source = await response.text();
      assert(source.includes("this.audio = new RhythmAudio();"));
      await route.fulfill({ response, body: source.replace("this.audio = new RhythmAudio();",
        "this.audio = new RhythmAudio(); globalThis.__consumedLab = this;") });
    });
    await page.goto(process.env.C77_WEB_URL || "http://127.0.0.1:8888/");
    await page.locator('.nav[data-tab="rhythm"]').click();
    await page.evaluate(async () => {
      const { matchTimingEdges } = await import("./rhythm-analysis.mjs");
      const { laneNotes } = await import("./rhythm-visuals.mjs");
      const canvas = document.querySelector("#rhythmLane"), ctx = canvas.getContext("2d"), lab = window.__consumedLab;
      const nativeFill = ctx.fillRect, nativeStroke = ctx.strokeRect;
      let draws = [];
      ctx.fillRect = function (x, y, w, h) {
        draws.push({ kind: "fill", style: this.fillStyle, x, y, w, h });
        return nativeFill.call(this, x, y, w, h);
      };
      ctx.strokeRect = function (x, y, w, h) {
        draws.push({ kind: "stroke", style: this.strokeStyle, x, y, w, h });
        return nativeStroke.call(this, x, y, w, h);
      };
      const frame = (paint) => {
        draws = [];
        paint();
        const { width: w, height: h } = canvas.getBoundingClientRect(), nw = w * .56 - 24;
        const close = (a, b) => Math.abs(a - b) < 1e-5;
        return { line: h - 58, top: 12,
          heads: draws.filter((d) => d.kind === "fill" && d.h === 8 && close(d.w, nw)),
          caps: draws.filter((d) => d.kind === "stroke" && d.h === 5 && d.style === "#e8ad72"),
          bodies: draws.filter((d) => d.kind === "fill" && close(d.w, nw * .6)),
          // Below-line strip avoids the center label and includes the hold body.
          below: Array.from(ctx.getImageData(Math.ceil(w * .22 + 12 + nw * .2 + 3), h - 58 + 5, 5, 8).data),
        };
      };
      const schedule = (type = "tap", pressMs = 9000, releaseMs = type === "hold" ? 17000 : 9125, next = false) => {
        const cues = [{ id: "one", type, onMs: pressMs, offMs: releaseMs, accent: true }];
        if (next) cues.push({ id: "two", type: "tap", onMs: pressMs + 300, offMs: pressMs + 425 });
        return { quarterMs: 500, stepMs: 250, countInMs: 2000, cues,
          targets: cues.flatMap((cue) => [
            { id: `${cue.id}-press`, type: "press", targetMs: cue.onMs, soundMs: cue.onMs },
            { id: `${cue.id}-release`, type: "release", targetMs: cue.offMs, soundMs: cue.offMs },
          ]) };
      };
      const match = (chart, edges) => matchTimingEdges(chart.targets, edges.map(([type, timeMs], i) => ({
        id: `edge-${i}`, type, timeMs, earliestMs: timeMs - 3, latestMs: timeMs + 3,
      })), 120);
      const render = ({ chart, edges = [], elapsedMs, noteSpeed = 1, pressed = false, active = true, hasResult = false }) => {
        const matched = match(chart, edges);
        const result = frame(() => lab.practice.render({ schedule: chart, ...matched,
          samples: [{ timeMs: elapsedMs, pressed }], elapsedMs, noteSpeed, active, hasResult, label: "검증용 데모" }));
        return { ...result, notes: laneNotes(chart, matched.matches, elapsedMs),
          counts: document.querySelector("#rhythmTimingCounts").textContent };
      };
      window.__consumedTools = { frame, schedule, match, render };
    });

    // Every fixture passes through the production render(), matcher and painter.
    for (const speed of [0.5, 1, 4]) {
      const result = await page.evaluate((noteSpeed) => {
        const { render, schedule } = window.__consumedTools, tap = schedule("tap", 9000, 9125, true);
        const at = (edges, elapsedMs, options = {}) => render({ chart: tap, edges, elapsedMs, noteSpeed, ...options });
        const hold = schedule("hold"), holdAt = (edges, elapsedMs, options = {}) => render({ chart: hold, edges, elapsedMs, noteSpeed, ...options });
        const beforeHold = holdAt([], 16900, { pressed: true });
        const consumedHold = holdAt([["press", 8970]], 16900, { pressed: true });
        const releasedHold = holdAt([["press", 8970], ["release", 16980]], 16980);
        const blankHold = render({ chart: { ...hold, cues: [], targets: [] }, elapsedMs: 16900, noteSpeed, pressed: true });
        return {
          earlyBefore: at([["press", 8970]], 8969), earlyAt: at([["press", 8970]], 8970),
          earlyAfter: at([["press", 8970]], 9000),
          lateBefore: at([["press", 9040]], 9039), lateAt: at([["press", 9040]], 9040),
          sameFrame: at([["press", 9000]], 9000),
          missed: at([], 9130), extra: at([["press", 8800]], 9000),
          pressedOnly: at([], 9000, { pressed: true }),
          futureHeld: at([["press", 9000]], 9300, { pressed: true }),
          replayBefore: at([["press", 9000], ["release", 9125]], 8999, { active: false, hasResult: true }),
          replayHit: at([["press", 9000], ["release", 9125]], 9000, { active: false, hasResult: true }),
          replayRelease: at([["press", 9000], ["release", 9125]], 9125, { active: false, hasResult: true }),
          preview: at([["press", 9000], ["release", 9125]], 9999, { active: false }),
          beforeHold, consumedHold, releasedHold, blankHold,
          // Late release keeps its unmatched tail below the line, but body stays clipped.
          lateReleaseBefore: holdAt([["press", 9000], ["release", 17040]], 17039),
          lateReleaseAt: holdAt([["press", 9000], ["release", 17040]], 17040),
          releaseOnly: holdAt([["release", 17000]], 17000),
        };
      }, speed);
      const check = (condition, message) => assert(condition, `${speed}×: ${message}`);
      for (const name of ["earlyBefore", "lateBefore", "missed", "extra", "pressedOnly", "replayBefore"]) {
        check(result[name].heads.length === 2, `${name} retains both real/unplayed note heads`);
      }
      for (const name of ["earlyAt", "earlyAfter", "lateAt", "sameFrame", "futureHeld", "replayHit", "replayRelease"]) {
        check(result[name].heads.length === 1, `${name} hides only the judged head`);
      }
      check(result.lateBefore.heads[0].y > result.lateBefore.line - 4, "pending late head still travels below the line");
      check(result.earlyAt.caps.length === 2, "press judgment preserves both release caps");
      check(result.replayRelease.caps.length === 1, "release judgment removes only its own cap");
      check(result.preview.heads.length >= 1, "idle preview ignores recorded consumption");
      check(result.beforeHold.bodies[0].y + result.beforeHold.bodies[0].h > result.beforeHold.line + 20,
        "unmatched long hold retains its original below-line motion");
      check(result.consumedHold.heads.length === 0, "matched long-hold head disappears after leaving view");
      check(result.consumedHold.caps.length === 1 && result.consumedHold.caps[0].y < result.consumedHold.line,
        "long-hold future release cap stays visible");
      check(result.consumedHold.bodies.length === 1, "long-hold approaching body stays visible");
      assert.deepEqual(result.consumedHold.below, result.blankHold.below, `${speed}×: actual pixels show no consumed hold body below the line`);
      check(result.releasedHold.bodies.length === 0 && result.releasedHold.caps.length === 0 && result.releasedHold.heads.length === 0,
        "matched release removes the remaining body and cap on that frame");
      check(result.lateReleaseBefore.caps.length === 1 && result.lateReleaseBefore.caps[0].y > result.lateReleaseBefore.line,
        "late release cap remains until its own observed edge");
      check(result.lateReleaseAt.caps.length === 0 && result.lateReleaseAt.bodies.length === 0,
        "late release consumes the rest exactly at its edge");
      check(result.releaseOnly.caps.length === 0 && result.releaseOnly.bodies.length === 0 && result.releaseOnly.heads.length === 1,
        "release-only match hides the body/cap while leaving the missed press unconsumed");
    }

    // Exercise the actual replay slider with a captured-result-shaped fixture.
    const replay = await page.evaluate(() => {
      const lab = window.__consumedLab, t = window.__consumedTools;
      const chart = t.schedule("hold", 9000, 9700), matching = t.match(chart, [["press", 8980], ["release", 9710]]);
      const previous = { result: lab.result, viewEnd: lab.viewEnd, recordContext: lab.recordContext };
      lab.result = { schedule: chart, samples: [{ timeMs: 12000, pressed: false }], summary: matching, edges: [] };
      lab.recordContext = { label: "기록 검증", demo: true, totalTravelMm: 4 };
      const slider = document.querySelector("#rhythmScrub");
      slider.min = 8000; slider.max = 12000;
      const at = (time) => t.frame(() => { slider.value = time; slider.dispatchEvent(new Event("input", { bubbles: true })); });
      try { return { before: at(8970), hit: at(8980), after: at(9710), rewind: at(8970) }; }
      finally { Object.assign(lab, previous); lab.draw(); }
    });
    assert.equal(replay.before.heads.length, 1);
    assert.equal(replay.hit.heads.length, 0);
    assert.equal(replay.hit.caps.length, 1);
    assert.equal(replay.after.caps.length, 0);
    assert.equal(replay.after.bodies.length, 0);
    assert.equal(replay.rewind.heads.length, 1, "scrubbing backwards restores a not-yet-hit note");

    // Real protocol-mock polling supplies the live edges; no capture edge injection.
    await installStudioTestHid(page);
    await page.evaluate(() => {
      const request = navigator.hid.requestDevice;
      navigator.hid.requestDevice = async (...args) => {
        const devices = await request(...args), sim = window.__studioTestHid.simulator;
        for (const key of sim.profile.keys) Object.assign(key, { flags: 7, released: 1000, pressed: 3000,
          actuation: 200, rt_press: 100, rt_release: 100, top_deadzone: 20, bottom_deadzone: 0 });
        sim.stored = structuredClone(sim.profile);
        window.__consumedInitialProfile = structuredClone(sim.profile);
        window.__consumedCommands = [];
        const command = sim.command.bind(sim);
        sim.command = (op, payload) => { window.__consumedCommands.push({ op, payload: Array.from(payload) }); return command(op, payload); };
        return devices;
      };
    });
    await page.locator("#connect").click();
    await page.waitForFunction(() => document.querySelector("#calProgress").textContent === "보정 14 / 14");
    await page.waitForFunction(() => !document.querySelector("#refresh").disabled);
    await page.locator("#rhythmBpm").fill("120");
    await page.locator("#rhythmBars").selectOption("4");
    await page.locator("#rhythmDivision").selectOption("8");
    await page.locator("#rhythmMode").selectOption("hold");
    await page.locator("#rhythmHoldSteps").fill("8");
    await page.locator("#rhythmGapSteps").fill("4");
    await page.locator("#rhythmStart").click();
    await page.waitForFunction(() => window.__consumedLab.active && !window.__consumedLab.starting && window.__consumedLab.capture.samples.length >= 4);
    await page.evaluate(() => {
      const lab = window.__consumedLab, sim = window.__studioTestHid.simulator, cue = lab.schedule.cues.find((c) => c.type === "hold");
      const at = (timeMs, pose) => setTimeout(() => { sim.pose[lab.recordContext.key] = pose; }, Math.max(0, lab.origin + timeMs - performance.now()));
      const onEvent = lab.audio.onEvent;
      lab.audio.onEvent = (event) => {
        // Production applies native audio timing first; only the simulator's
        // physical pose is scheduled here. HID polling still creates the edges.
        onEvent(event);
        if (event.id !== cue.id) return;
        const type = event.kind === "on" ? "press" : "release";
        const target = lab.schedule.targets.find((entry) => entry.id === `${cue.id}-${type}`).targetMs;
        at(target + (type === "press" ? -25 : 30), type === "press" ? 900 : 0);
      };
    });
    await page.waitForFunction(() => window.__consumedLab.capture.edges.some((e) => e.type === "press"));
    const liveHold = await page.evaluate(() => {
      const lab = window.__consumedLab, t = window.__consumedTools;
      const painted = t.frame(() => lab.drawPractice());
      return { ...painted, firstMatch: lab.visualMatches.matches[0], samples: lab.capture.samples.length,
        edges: lab.capture.edges.length, observedEdges: lab.capture.edges, settings: lab.schedule.settings };
    });
    assert(liveHold.samples >= 4 && liveHold.edges >= 1);
    assert(liveHold.firstMatch.edge, `actual polled mock-HID press is matched by the production path: ${JSON.stringify({ match: liveHold.firstMatch, edges: liveHold.observedEdges, settings: liveHold.settings })}`);
    assert.equal(liveHold.heads.length, 0, "real live draw consumes the matched first head");
    fs.mkdirSync("build", { recursive: true });
    await page.locator("#rhythmPractice").screenshot({ path: "build/web-consumed-notes-live-hold.png" });
    await page.waitForFunction(() => window.__consumedLab.capture.edges.some((e) => e.type === "release"));
    const liveRelease = await page.evaluate(() => {
      const lab = window.__consumedLab, t = window.__consumedTools;
      const painted = t.frame(() => lab.drawPractice());
      const firstId = lab.schedule.cues.find((cue) => cue.type === "hold").id;
      return { ...painted, first: lab.visualMatches.matches.filter((m) => m.id.startsWith(firstId + "-")),
        elapsed: performance.now() - lab.origin };
    });
    assert(liveRelease.first.every((m) => m.edge), "actual polled release matches the same hold");
    assert(!liveRelease.caps.some((c) => c.y >= liveRelease.line - 15), "released live hold has no residual cap near/below the line");
    await page.locator("#rhythmStop").click();
    const pending = page.waitForEvent("download");
    await page.locator("#rhythmExport").click();
    const exported = JSON.parse(fs.readFileSync(await (await pending).path(), "utf8"));
    assert(exported.summary.matchedTargets >= 2 && exported.edges.length >= 2);
    assert(exported.summary.matches.some((match) => !match.edge && match.pending),
      "later unplayed targets stay pending and are not falsely consumed or scored");
    const safety = await page.evaluate(() => ({ commands: window.__consumedCommands,
      current: window.__studioTestHid.simulator.profile, stored: window.__studioTestHid.simulator.stored,
      initial: window.__consumedInitialProfile, physical: window.__physicalHidAttempts }));
    assert.deepEqual(safety.current, safety.initial);
    assert.deepEqual(safety.stored, safety.initial);
    assert.equal(safety.physical, 0);
    assert(!safety.commands.some((c) => [4, 5, 7, 8, 10].includes(c.op)), "no configuration writes or SAVE");
    assert(!safety.commands.some((c) => c.op === 6 && c.payload[0] !== 0), "no output enable");

    // Deterministic desktop/mobile screenshots show the clipped hold and next note.
    const showHold = () => page.evaluate(() => {
      const t = window.__consumedTools, lab = window.__consumedLab;
      // Device polling may refresh the context between evaluate and screenshot.
      // Keep only this isolated screenshot phase pinned to its fixture.
      lab.drawPractice = () => t.render({ chart: t.schedule("hold", 9000, 9800, true), edges: [["press", 8980]],
        elapsedMs: 9250, noteSpeed: 1, pressed: true });
      lab.drawPractice();
    });
    await showHold();
    await page.locator("#rhythmPractice").screenshot({ path: "build/web-consumed-notes-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await showHold();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator("#rhythmPractice").screenshot({ path: "build/web-consumed-notes-mobile.png" });
    assert.deepEqual(errors, []);
    await context.close();
    console.log("Consumed notes browser: early/late/same-frame matched heads, future/unmatched/misses, 0.5/1/4× long holds and actual below-line pixels, replay scrub/rewind, live protocol-mock capture, unchanged exports/HID and mobile PASS (no hardware)");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
