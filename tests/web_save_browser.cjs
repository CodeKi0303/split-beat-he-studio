// Isolated browser + fake HID only. No user's browser or physical USB access.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
let browser;
(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.C77_BROWSER_CHANNEL ? { channel: process.env.C77_BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.addInitScript(() => {
    window.__physicalHidAttempts = 0;
    const forbidden = () => { window.__physicalHidAttempts++; throw Error("Physical HID forbidden"); };
    Object.defineProperty(navigator, "hid", { configurable: true,
      value: { requestDevice: forbidden, getDevices: forbidden } });
  });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const badReadback of [false, true]) {
    await page.goto("http://127.0.0.1:8877/");
    await page.evaluate(async (badReadback) => {
      const { DemoTransport } = await import("./demo.mjs");
      const { VID, PID, USAGE_PAGE, USAGE, packet, unpackPacket } = await import("./protocol.mjs");
      const sim = new DemoTransport();
      sim.profile.keys.forEach((key) => { key.flags |= 4; key.released = 1000; key.pressed = 3000; });
      const state = { commands: [], queries: 0, resetting: false, replaced: false };
      const hid = new EventTarget();
      const makeDevice = () => Object.assign(new EventTarget(), {
        vendorId: VID, productId: PID, productName: "Split Hall test", opened: false,
        collections: [{ usagePage: USAGE_PAGE, usage: USAGE }],
        async open() { this.opened = true; },
        async close() { this.opened = false; },
        async sendReport(id, bytes) {
          const request = unpackPacket(bytes); state.commands.push(request.op);
          const response = await sim.exchange(bytes);
          if (request.op === 7) {
            state.resetting = true;
            const old = this;
            setTimeout(async () => {
              await sim.reconnect();
              if (badReadback) sim.profile.keys[0].actuation++;
              old.opened = false;
              state.device = makeDevice();
              state.replaced = true; state.resetting = false;
              hid.dispatchEvent(Object.assign(new Event("disconnect"), { device: old }));
            }, 600);
          }
          if (request.op === 1 && state.resetting)
            new DataView(response.payload.buffer).setUint32(20, 0, true);
          const encoded = packet(response.op, response.seq, response.payload, response.status);
          this.dispatchEvent(Object.assign(new Event("inputreport"), {
            reportId: 0, device: this, data: new DataView(encoded.buffer),
          }));
        },
      });
      state.device = makeDevice();
      hid.requestDevice = async () => { state.queries++; return [state.device]; };
      hid.getDevices = async () => [state.device];
      Object.defineProperty(navigator, "hid", { configurable: true, value: hid });
      window.__saveMock = state;
    }, badReadback);
    await page.locator("#connect").click();
    await page.waitForFunction(() => document.querySelector("#mode").textContent.startsWith("연결됨"));
    await page.locator("#outputOn").click();
    await page.waitForFunction(() => document.querySelector("#outputState").textContent === "출력 켜짐");
    await page.locator("#save").click();
    if (badReadback) {
      await page.waitForFunction(() => document.querySelector("#notice").textContent.includes("영구 저장 검증 실패"));
      assert.equal(await page.locator("#connect").isEnabled(), true, "Failed readback releases stale client and browser lock");
      assert.equal(await page.locator("#disconnect").isDisabled(), true);
      assert.equal(await page.locator("#save").isDisabled(), true);
      assert.equal(await page.locator("#mode").textContent(), "연결 안 됨");
    } else {
      await page.waitForFunction(() => document.querySelector("#notice").textContent.includes("영구 저장 검증 완료"));
      assert.equal(await page.locator("#generation").textContent(), "1");
      assert.equal(await page.locator("#outputState").textContent(), "출력 켜짐");
      assert.equal(await page.locator("#save").isEnabled(), true);
      assert.equal(await page.locator("#connect").isDisabled(), true);
      await page.waitForFunction(() => document.querySelector("#key-13 .raw").textContent !== "—");
      fs.mkdirSync("build", { recursive: true });
      await page.screenshot({ path: "build/web-save-reconnect.png", fullPage: true });
    }
    const result = await page.evaluate(() => ({ ...window.__saveMock, device: undefined,
      physical: window.__physicalHidAttempts }));
    assert.equal(result.replaced, true);
    assert.equal(result.queries, 1, "No automatic device chooser");
    assert.equal(result.commands.filter((op) => op === 7).length, 1, "SAVE sent exactly once");
    assert.ok(result.commands.slice(result.commands.indexOf(7) + 1).every((op) => [1, 2, 3, 9].includes(op)), "After SAVE only reads are sent");
    assert.equal(result.physical, 0);
    if (badReadback) {
      await page.locator("#connect").click();
      await page.waitForFunction(() => document.querySelector("#mode").textContent.startsWith("연결됨"));
    }
    await page.locator("#disconnect").click();
    await page.waitForFunction(() => document.querySelector("#mode").textContent === "연결 안 됨");
  }
  assert.deepEqual(errors, []);
  await browser.close();
  console.log("Browser SAVE: output ON -> delayed reset/new HID -> verified output ON; readback failure -> manual reconnect unlocked PASS (fake HID only)");
})().catch(async (error) => {
  console.error(error);
  await browser?.close().catch(() => {});
  process.exit(1);
});
