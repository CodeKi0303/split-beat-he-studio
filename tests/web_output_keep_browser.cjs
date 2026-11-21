// Isolated browser + fake HID only. Key output is never turned off by Studio
// except through 출력 끄기; firmware-side OFF during settings writes is restored.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
let browser;
(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.C77_BROWSER_CHANNEL ? { channel: process.env.C77_BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.addInitScript(() => {
    const forbidden = () => { throw Error("Physical HID forbidden"); };
    Object.defineProperty(navigator, "hid", { configurable: true, value: { requestDevice: forbidden, getDevices: forbidden } });
  });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (process.env.DEBUG_OUTPUT) page.on("console", (m) => console.log("console:", m.text()));
  await page.goto(process.env.C77_WEB_URL || "http://127.0.0.1:8877/");
  await page.evaluate(async () => {
    const { DemoTransport } = await import("./demo.mjs");
    const { VID, PID, USAGE_PAGE, USAGE, OP, packet, unpackPacket } = await import("./protocol.mjs");
    // One keyboard across reconnects, like the real device.
    const sim = new DemoTransport();
    sim.profile.keys.forEach((key) => Object.assign(key, { flags: 7, released: 1000, pressed: 3000 }));
    sim.stored = structuredClone(sim.profile);
    const state = { ops: [], busyOnEnable: false, sim };
    const device = Object.assign(new EventTarget(), {
      vendorId: VID, productId: PID, productName: "Split Hall test", serialNumber: "TEST-OUTPUT",
      collections: [{ usagePage: USAGE_PAGE, usage: USAGE }], opened: false,
      async open() { this.opened = true; },
      async close() { this.opened = false; },
      async sendReport(id, bytes) {
        const request = unpackPacket(bytes);
        state.ops.push([request.op, request.payload[0] ?? null]);
        // Firmware v0.3.36+: after a satellite drop, OUTPUT ON is refused until a paired ADC write.
        const refuse = request.op === OP.OUTPUT && request.payload[0] === 1 && state.busyOnEnable;
        const response = refuse ? { op: request.op | 0x80, seq: request.seq, status: 5, payload: new Uint8Array() }
          : await sim.exchange(bytes);
        const encoded = packet(response.op, response.seq, response.payload, response.status);
        this.dispatchEvent(Object.assign(new Event("inputreport"), { reportId: 0, device: this, data: new DataView(encoded.buffer) }));
      },
    });
    const hid = new EventTarget();
    hid.requestDevice = async () => [device];
    hid.getDevices = async () => [device];
    Object.defineProperty(navigator, "hid", { configurable: true, value: hid });
    window.__output = state;
  });
  // Messages can follow each other within one poll; count entries in the activity log.
  const count = (text) => page.evaluate((t) => document.querySelector("#log").textContent.split(t).length - 1, text);
  const seen = {};
  const notice = async (text) => {
    const before = seen[text] ?? 0;
    await page.waitForFunction(({ t, n }) => document.querySelector("#log").textContent.split(t).length - 1 > n, { t: text, n: before }, { timeout: 8000 })
      .catch(async (e) => { throw Error(`${e.message} waiting for ${text}; log=${(await page.locator("#log").textContent()).slice(0, 500)}`); });
    seen[text] = await count(text);
  };
  const idle = () => page.waitForFunction(() => !document.querySelector("#refresh").disabled);
  const deviceOutput = () => page.evaluate(() => window.__output.sim.enabled);
  const offsSince = (start) => page.evaluate((n) => window.__output.ops.slice(n).filter(([op, v]) => op === 6 && v === 0).length, start);
  const mark = () => page.evaluate(() => window.__output.ops.length);
  const connect = async () => {
    await page.locator("#connect").click();
    await page.waitForFunction(() => document.querySelector("#mode").textContent.startsWith("연결됨"), null, { timeout: 8000 })
      .catch(async (e) => { throw Error(`${e.message} mode=${await page.locator("#mode").textContent()} notice=${await page.locator("#notice").textContent()} errors=${errors.join("|")}`); });
    await idle();
  };

  await connect();
  await page.locator("#outputOn").click();
  await page.waitForFunction(() => document.querySelector("#outputState").textContent === "출력 켜짐");
  assert.equal(await deviceOutput(), true);

  // Disconnect leaves output on: no OUTPUT 0 is sent.
  let start = await mark();
  await page.locator("#disconnect").click();
  await page.waitForFunction(() => document.querySelector("#mode").textContent === "연결 안 됨");
  assert.equal(await offsSince(start), 0, "disconnect must not send OUTPUT 0");
  assert.equal(await deviceOutput(), true);

  // Reconnect adopts the keyboard's state; a settings write is followed by a restore.
  await connect();
  await page.waitForFunction(() => document.querySelector("#outputState").textContent === "출력 켜짐");
  await page.locator('.nav[data-tab="performance"]').click();
  await page.locator("#key-0").click();
  await page.locator("#actuation").fill("0.801");
  await page.locator("#applyKey").click();
  await notice("Hall 설정 RAM 적용 완료");
  await notice("작업 전 상태대로 키 출력을 다시 켰습니다.");
  assert.equal(await deviceOutput(), true, "output is restored after the firmware-side OFF of SET_KEY");
  assert.equal(await page.evaluate(() => window.__output.sim.profile.keys[0].actuation), Math.round(0.801 / 4 * 10000));

  // 출력 끄기 is respected: later operations keep it off.
  await idle();
  await page.locator("#outputOff").click();
  await notice("키 출력을 껐습니다.");
  await page.locator("#actuation").fill("0.9");
  await page.locator("#applyKey").click();
  await notice("Hall 설정 RAM 적용 완료");
  await page.waitForTimeout(400);
  assert.equal(await deviceOutput(), false, "a user OFF is not undone");
  start = await mark();
  assert.equal(await page.evaluate((n) => window.__output.ops.slice(n).some(([op, v]) => op === 6 && v === 1), start), false);

  // OUTPUT ON refused with BUSY explains the ADC pair recovery.
  await page.evaluate(() => { window.__output.busyOnEnable = true; });
  await page.locator("#outputOn").click();
  await notice("좌우에 적용");
  assert.equal(await deviceOutput(), false);
  assert.deepEqual(errors, []);
  console.log("Output keep: disconnect without OFF, restore after settings writes, user OFF respected, BUSY guidance PASS (fake HID only)");
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
