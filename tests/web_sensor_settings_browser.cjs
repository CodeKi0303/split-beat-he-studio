// Production Studio against isolated DemoTransport HID; physical HID is blocked.
// ADC tuning/comparison replies and old observation windows are synthetic here.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { installStudioTestHid } = require("./studio-browser-hid.cjs");

(async () => {
  const browser = await chromium.launch({
    headless: true, channel: process.env.C77_BROWSER_CHANNEL || "msedge", args: ["--mute-audio"],
  });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => Object.defineProperty(navigator, "hid", { configurable: true, value: {
      requestDevice: () => { throw Error("Physical HID blocked"); },
      getDevices: () => { throw Error("Physical HID blocked"); },
    } }));
    await page.goto(process.env.C77_WEB_URL || "http://127.0.0.1:8888/");
    await installStudioTestHid(page);
    await page.evaluate(async () => {
      const { OP, CAP_ADC_TUNING, CAP_ADC_PAIR, CAP_ADC_PAIR_READ } = await import("./protocol.mjs");
      const requestMock = navigator.hid.requestDevice;
      navigator.hid.requestDevice = async (...args) => {
        const devices = await requestMock(...args);
        const sim = window.__studioTestHid.simulator;
        for (const key of sim.profile.keys) Object.assign(key, {
          flags: 7, released: 1000 + key.key, pressed: 3000 + key.key,
          actuation: 200 + key.key, rt_press: 100 + key.key, rt_release: 90 + key.key,
          top_deadzone: 20 + key.key, bottom_deadzone: key.key,
          noise_deadband: 3 + key.key, curve_id: key.key % 2,
        });
        sim.stored = structuredClone(sim.profile);
        window.__initialSensorProfile = structuredClone(sim.profile);
        window.__sensorCommands = [];
        window.__adcState = { rate: 64000, window: 8 };
        window.__adcSequence = 0;
        const command = sim.command.bind(sim);
        sim.command = (op, payload) => {
          window.__sensorCommands.push({ op, payload: Array.from(payload), enabled: sim.enabled });
          if (op === OP.ADC_TUNING || op === OP.ADC_PAIR) {
            if (payload.length) {
              if (op !== OP.ADC_PAIR || sim.enabled) throw Error("ADC write must be paired with output OFF");
              window.__adcState = {
                rate: new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true),
                window: payload[4],
              };
            }
            const result = new Uint8Array(5);
            new DataView(result.buffer).setUint32(0, window.__adcState.rate, true);
            result[4] = window.__adcState.window;
            return result;
          }
          if (op === OP.ADC_COMPARE) {
            if (payload.length !== 1 || payload[0] > 6) throw Error("ADC comparison is left-only");
            const result = new Uint8Array(12), view = new DataView(result.buffer);
            result[0] = payload[0]; result[1] = window.__adcState.window;
            view.setUint32(2, ++window.__adcSequence, true);
            view.setUint16(6, 2228, true); view.setUint16(8, 2222, true); view.setUint16(10, 2220, true);
            return result;
          }
          const result = command(op, payload);
          if (op === OP.INFO) {
            const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
            view.setUint32(16, view.getUint32(16, true) | CAP_ADC_TUNING | CAP_ADC_PAIR | CAP_ADC_PAIR_READ, true);
            result[2] = 37;
          }
          return result;
        };
        return devices;
      };
    });
    await page.locator("#connect").click();
    await page.waitForFunction(() => document.querySelector("#calProgress").textContent === "보정 14 / 14");
    const idle = () => page.waitForFunction(() => !document.querySelector("#refresh").disabled);
    const nav = (name) => page.locator(`[data-tab="${name}"]`).click();
    const clearCommands = () => page.evaluate(() => { window.__sensorCommands = []; });
    const snapshot = () => page.evaluate(() => ({
      profile: window.__studioTestHid.simulator.profile,
      stored: window.__studioTestHid.simulator.stored,
      enabled: window.__studioTestHid.simulator.enabled,
      generation: window.__studioTestHid.simulator.generation,
      commands: window.__sensorCommands,
    }));
    await idle();
    const initial = await page.evaluate(() => window.__initialSensorProfile);
    let expected = structuredClone(initial);
    const assertSafe = (state) => {
      assert.deepEqual(state.stored, initial, "sensor edits do not save Flash");
      assert.equal(state.generation, 0);
      assert.equal(state.enabled, false);
      assert(!state.commands.some((call) => call.op === 7), "no automatic SAVE");
      assert(!state.commands.some((call) => call.op === 6 && call.payload[0] !== 0), "no automatic output ON");
    };

    // Keep pending performance edits through navigation and a separate noise write.
    await nav("performance");
    assert.equal(await page.locator("#performance #noise").count(), 0);
    await page.locator("#actuation").fill("1.35");
    await page.locator("#rtPress").fill("0.17");
    await nav("diagnostics");
    assert.equal(await page.locator("#pageTitle").textContent(), "센서 진단/설정");
    assert(await page.locator("#noiseSettings").isVisible());
    assert(await page.locator("#adcTuning").isVisible());
    assert.equal(await page.locator("#diagnostics #noise").count(), 1);
    assert.equal(await page.locator("#noise").inputValue(), "3");
    await page.locator("#noise").fill("23");
    await nav("performance");
    assert.equal(await page.locator("#actuation").inputValue(), "1.35");
    assert.equal(await page.locator("#rtPress").inputValue(), "0.17");
    assert(await page.locator("#applyKey").isEnabled());
    await nav("diagnostics");
    assert.equal(await page.locator("#noise").inputValue(), "23", "noise draft survives tab changes");
    for (const [scope, value, ids] of [
      ["selected", 23, [0]],
      ["left", 24, [0, 1, 2, 3, 4, 5, 6]],
      ["right", 25, [7, 8, 9, 10, 11, 12, 13]],
      ["all", 26, Array.from({ length: 14 }, (_, key) => key)],
    ]) {
      await page.locator("#noiseScope").selectOption(scope);
      await page.locator("#noise").fill(String(value));
      await clearCommands();
      await page.locator("#applyNoise").click();
      await page.waitForFunction(() => document.querySelector("#notice").textContent.includes("노이즈 설정 RAM 적용 확인"));
      await idle();
      for (const key of ids) expected.keys[key].noise_deadband = value;
      const state = await snapshot();
      assert.deepEqual(state.profile, expected, `${scope}: only noise on explicitly scoped keys changes`);
      assert.deepEqual(state.commands.filter((call) => call.op === 4).map((call) => call.payload[0]), ids);
      assertSafe(state);
      assert(await page.locator("#applyNoise").isDisabled());
    }
    for (const invalid of ["", "-1", "101", "1.5"]) {
      await page.locator("#noise").fill(invalid);
      assert(await page.locator("#applyNoise").isDisabled(), `reject invalid noise ${invalid}`);
    }
    await page.locator("#noise").fill("26");
    await nav("performance");
    assert.equal(await page.locator("#actuation").inputValue(), "1.35", "noise writes preserve pending performance draft");
    assert.equal(await page.locator("#rtPress").inputValue(), "0.17");
    await clearCommands();
    await page.locator("#applyKey").click();
    await page.waitForFunction(() => document.querySelector("#notice").textContent.includes("Hall 설정 RAM 적용 완료"));
    await idle();
    expected.keys[0].actuation = Math.round(1.35 / 4 * 1000);
    expected.keys[0].rt_press = Math.round(0.17 / 4 * 1000);
    assert.deepEqual((await snapshot()).profile, expected, "performance apply retains newly applied sensor noise");
    assertSafe(await snapshot());

    // Completed controlled measurements must not survive a change in ADC
    // acquisition settings, since those results describe the previous setup.
    await nav("diagnostics");
    await page.locator("#baseline").click();
    await page.waitForFunction(() => !document.querySelector("#measurePress").disabled);
    await page.evaluate(() => { window.__studioTestHid.simulator.pose[0] = 1000; });
    await page.locator("#measurePress").click();
    await page.waitForFunction(() => document.querySelector("#measureState").textContent.startsWith("측정 완료"));
    assert.equal(await page.locator("#interferenceRows tr").count(), 13);
    await page.evaluate(() => { window.__studioTestHid.simulator.pose.fill(0); });

    // ADC application turns simulated output OFF before the paired write.
    await page.evaluate(() => { window.__studioTestHid.simulator.enabled = true; });
    await page.waitForFunction(() => document.querySelector("#outputState").textContent === "출력 켜짐");
    await page.locator("#adcScanRate").selectOption("32000");
    await page.locator("#adcWindow").selectOption("4");
    await clearCommands();
    await page.locator("#applyAdcTuning").click();
    await page.waitForFunction(() => document.querySelector("#notice").textContent.includes("ADC 설정 적용 완료"));
    await idle();
    const adcState = await snapshot();
    assert.deepEqual(adcState.profile, expected, "global ADC tuning preserves per-key profile");
    assertSafe(adcState);
    const offIndex = adcState.commands.findIndex((call) => call.op === 6 && call.payload[0] === 0);
    const writeIndex = adcState.commands.findIndex((call) => call.op === 0x49 && call.payload.length === 5);
    assert(offIndex >= 0 && writeIndex > offIndex, "verified output OFF precedes paired ADC write");
    assert.equal(adcState.commands[writeIndex].enabled, false);
    assert.equal(await page.locator("#interferenceRows tr").count(), 0, "changing ADC settings clears measurements made with old settings");
    assert((await page.locator("#measureState").textContent()).startsWith("측정 전"));

    // Deterministic old observations avoid waiting 60 seconds. The production
    // window/summarize/relative-baseline code still selects and draws the data.
    await page.evaluate(async () => {
      const { TelemetryStore } = await import("./telemetry.mjs?v=studio-filtered-diagnostics1");
      window.__originalSensorSeries = TelemetryStore.prototype.series;
      TelemetryStore.prototype.series = function (key, now) {
        return [-45000, -20000, -5000, -1000].map((offset, i) => ({
          time: now + offset, raw: 1000 + key * 10 + [100, 20, 5, 9][i] * (key + 1), travel: 100 + i,
        }));
      };
    });
    await page.locator("#diagnosticAdc").check();
    for (const [window, count, delta] of [["10000", 2, 8], ["30000", 3, -22], ["60000", 4, -182]]) {
      await page.locator("#diagnosticWindow").selectOption(window);
      await page.waitForFunction((n) => document.querySelector("#sampleInfo").textContent.startsWith(`최근 ${n}개`), count);
      assert((await page.locator("#signalChart").getAttribute("aria-label")).includes(`최근 ${Number(window) / 1000}초`));
      assert((await page.locator("#impact-key-1").textContent()).includes(`${delta} ADC`));
    }
    assert.equal(await page.locator("#impactLegend button").count(), 6);
    await page.locator("#impactScope").selectOption("other");
    assert.equal(await page.locator("#impactLegend button").count(), 7);
    await page.locator("#impactScope").selectOption("all");
    assert.equal(await page.locator("#impactLegend button").count(), 13);
    assert.equal(await page.locator("#impact-key-0").count(), 0);
    await page.locator("#impact-key-1").click();
    assert.equal(await page.locator("#impact-key-1").getAttribute("aria-pressed"), "false");
    await page.locator("#diagnosticWindow").selectOption("10000");
    assert.equal(await page.locator("#impact-key-1").getAttribute("aria-pressed"), "false", "legend visibility survives window changes");
    await page.locator("#impact-key-1").click();
    assert.equal(await page.locator("#impact-key-1").getAttribute("aria-pressed"), "true");
    assert(await page.locator("#impactChart").evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      return canvas.width > 100 && canvas.height > 100 && pixels.some((value, index) => index % 4 === 3 && value > 0);
    }), "relative chart renders nonempty pixels");

    // Comparison is deliberately left-only and Clear removes its separate buffer.
    assert(await page.locator("#adcCompareOption").isVisible());
    await page.locator("#diagnosticAdcCompare").check();
    await page.waitForFunction(() => document.querySelector("#mean").textContent === "2222.00");
    assert(await page.locator("#adcCompareLegend").isVisible());
    const cleared = await page.evaluate(() => {
      document.querySelector("#clearStats").click();
      return { mean: document.querySelector("#mean").textContent, samples: document.querySelector("#sampleInfo").textContent };
    });
    assert.equal(cleared.mean, "—");
    assert(cleared.samples.startsWith("최근 0개"), "clearStats clears ADC comparison observations immediately");
    await page.locator("#key-7").click();
    assert(await page.locator("#adcCompareOption").isHidden());
    assert(await page.locator("#adcCompareLegend").isHidden());
    assert((await page.locator("#diagnosticSignalLabel").textContent()).includes("ADC 보고값"));
    assert(!(await snapshot()).commands.some((call) => call.op === 0x48 && call.payload[0] > 6));
    await page.locator("#key-0").click();
    assert(await page.locator("#adcCompareOption").isVisible());
    await page.locator("#diagnosticAdcCompare").uncheck();
    // Dense observations produce visible traces (the sparse fixture above
    // correctly breaks lines across gaps greater than 250ms).
    await page.evaluate(async () => {
      const { TelemetryStore } = await import("./telemetry.mjs?v=studio-filtered-diagnostics1");
      TelemetryStore.prototype.series = function (key, now) {
        return Array.from({ length: 101 }, (_, i) => ({
          time: now - 10000 + i * 100,
          raw: 1000 + key * 10 + Math.round((Math.sin(i / 18 + key) - Math.sin(key)) * (key + 2) * 3),
          travel: 100 + i,
        }));
      };
    });
    await page.locator("#diagnosticWindow").selectOption("10000");
    assert(await page.locator("#impactChart").evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i] === 114 && pixels[i + 1] === 212 && pixels[i + 2] === 223 && pixels[i + 3] > 0) return true;
      return false;
    }), "other-key chart draws an actual colored signal trace, not just axes");
    fs.mkdirSync("build", { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: "build/web-sensor-diagnostics-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "sensor page fits narrow viewport");
    await page.screenshot({ path: "build/web-sensor-diagnostics-mobile.png", fullPage: true });
    await page.evaluate(async () => {
      const { TelemetryStore } = await import("./telemetry.mjs?v=studio-filtered-diagnostics1");
      TelemetryStore.prototype.series = window.__originalSensorSeries;
    });

    assertSafe(await snapshot());
    assert.deepEqual(errors, []);
    await context.close();
    console.log("Sensor settings browser: noise scope/preservation, draft retention, safe paired ADC writes, windows/relative graph, legend, comparison reset and left-only UI passed");
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
