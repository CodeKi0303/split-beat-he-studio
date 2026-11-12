// Test the real Studio UI/protocol against an isolated in-page simulated HID.
// No physical keyboard request, firmware install, SAVE, or output enable.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const { installStudioTestHid } = require("./studio-browser-hid.cjs");

(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome", args: ["--mute-audio"] });
  const errors = [];
  try {
    async function fixture(modern) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(() => Object.defineProperty(navigator, "hid", { configurable: true, value: {
        requestDevice: () => { throw Error("Physical HID blocked"); },
        getDevices: () => { throw Error("Physical HID blocked"); },
      } }));
      await page.goto(process.env.C77_WEB_URL || "http://127.0.0.1:8882/");
      await installStudioTestHid(page);
      await page.evaluate((supportsRetrigger) => {
        const requestMock = navigator.hid.requestDevice;
        navigator.hid.requestDevice = async (...args) => {
          const devices = await requestMock(...args);
          const sim = window.__studioTestHid.simulator;
          for (const key of sim.profile.keys) Object.assign(key, {
            flags: 7, released: 1000 + key.key, pressed: 3000 + key.key,
            actuation: 200 + key.key, rt_press: 100, rt_release: 100,
            top_deadzone: 20, bottom_deadzone: 0, noise_deadband: 5,
          });
          sim.stored = structuredClone(sim.profile);
          window.__initialProfile = structuredClone(sim.profile);
          window.__operations = [];
          const command = sim.command.bind(sim);
          sim.command = (op, payload) => {
            window.__operations.push(op);
            const result = command(op, payload);
            if (op === 1) {
              const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
              const caps = view.getUint32(16, true);
              view.setUint32(16, supportsRetrigger ? caps | 0x40000 : caps & ~0x40000, true);
              result[2] = supportsRetrigger ? 37 : 36;
            }
            return result;
          };
          return devices;
        };
      }, modern);
      await page.locator("#connect").click();
      await page.waitForFunction(() => document.querySelector("#calProgress").textContent === "보정 14 / 14");
      await page.locator('[data-tab="performance"]').click();
      return { context, page };
    }
    const { context, page } = await fixture(true);
    const initial = await page.evaluate(() => window.__initialProfile);
    assert(await page.locator("#retrigger").isEnabled());
    assert(!await page.locator("#retrigger").isChecked());
    assert(await page.locator("#retriggerCompatibility").isHidden());
    await page.locator("#selectLeftHall").click();
    const applyAndExpect = async (flags) => {
      await page.locator("#applyKey").click();
      await page.waitForFunction((expected) => window.__studioTestHid.simulator.profile.keys.slice(0, 7).every(k => k.flags === expected), flags);
      await page.waitForFunction(() => !document.querySelector("#refresh").disabled);
      const snapshot = await page.evaluate(() => ({
        profile: window.__studioTestHid.simulator.profile,
        stored: window.__studioTestHid.simulator.stored,
        enabled: window.__studioTestHid.simulator.enabled,
        generation: window.__studioTestHid.simulator.generation,
      }));
      const expected = structuredClone(initial);
      for (const key of expected.keys.slice(0, 7)) key.flags = flags;
      assert.deepEqual(snapshot.profile, expected, "Only the seven selected keys' requested flags change");
      assert.deepEqual(snapshot.stored, initial, "RAM editing does not save");
      assert.equal(snapshot.enabled, false);
      assert.equal(snapshot.generation, 0);
    };
    await page.locator("#retrigger").check();
    await applyAndExpect(15);
    await page.locator("#refresh").click();
    await page.waitForFunction(() => !document.querySelector("#refresh").disabled);
    assert(await page.locator("#retrigger").isChecked());
    await page.locator('[data-tab="rhythm"]').click();
    assert(await page.locator("#autoFitStart").isDisabled());
    assert((await page.locator("#autoFitInstruction").innerText()).includes("미해제 재입력을 끈 뒤"));
    assert(await page.locator("#rhythmStart").isDisabled());
    assert((await page.locator("#rhythmStart").getAttribute("title")).includes("USB 재입력 펄스"));

    await page.locator('[data-tab="performance"]').click();
    await page.locator("#rt").uncheck();
    await applyAndExpect(13);
    assert(await page.locator("#retrigger").isChecked(), "RT off preserves the stored retrigger preference");
    await page.locator('[data-tab="rhythm"]').click();
    assert(await page.locator("#autoFitStart").isDisabled(), "Auto fit could enable RT, so it requires an explicitly cleared retrigger option");
    assert(await page.locator("#rhythmStart").isEnabled(), "Ordinary actuation-only timing remains measurable");

    await page.locator('[data-tab="performance"]').click();
    await page.locator("#rt").check();
    await applyAndExpect(15);
    await page.locator("#retrigger").uncheck();
    await applyAndExpect(7);
    await page.locator("#refresh").click();
    await page.waitForFunction(() => !document.querySelector("#refresh").disabled);
    assert(!await page.locator("#retrigger").isChecked());
    await page.locator('[data-tab="rhythm"]').click();
    assert(await page.locator("#autoFitStart").isEnabled());
    assert(await page.locator("#rhythmStart").isEnabled());
    const ops = await page.evaluate(async () => {
      const { OP } = await import("./protocol.mjs");
      return { saved: window.__operations.includes(OP.SAVE), keyWrites: window.__operations.filter(op => op === OP.SET_KEY).length };
    });
    assert.equal(ops.saved, false);
    assert.equal(ops.keyWrites, 28);
    await context.close();

    const legacy = await fixture(false);
    assert(await legacy.page.locator("#retrigger").isDisabled());
    assert(await legacy.page.locator("#retriggerCompatibility").isVisible());
    assert((await legacy.page.locator("#retriggerCompatibility").innerText()).includes("v0.3.37"));
    assert(await legacy.page.locator("#actuation").isEnabled());
    await legacy.page.locator("#actuation").fill("1.30");
    await legacy.page.locator("#applyKey").click();
    await legacy.page.waitForFunction(() => window.__studioTestHid.simulator.profile.keys[0].actuation === 325);
    const oldResult = await legacy.page.evaluate(() => ({ initial: window.__initialProfile, actual: window.__studioTestHid.simulator.profile, stored: window.__studioTestHid.simulator.stored }));
    const oldExpected = structuredClone(oldResult.initial);
    oldExpected.keys[0].actuation = 325;
    assert.deepEqual(oldResult.actual, oldExpected);
    assert.deepEqual(oldResult.stored, oldResult.initial);
    await legacy.context.close();
    assert.deepEqual(errors, []);
    console.log("Retrigger UI: capability gate, default off, seven-key on/off readback, RT-off preference, untouched endpoints/right/bindings, RAM-only, measurement safeguards, legacy edits PASS (simulated HID)");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
