// Isolated browser + test HID (demo simulator) only. Creates, renames, switches
// and deletes on-device profiles from the sidebar and the 프로필 tab, and checks
// each profile keeps its own mapping and actuation. No physical device.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const { installStudioTestHid } = require("./studio-browser-hid.cjs");
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
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(process.env.C77_WEB_URL || "http://127.0.0.1:8877/");
  await installStudioTestHid(page);
  assert.equal(await page.locator("#profileSwitch").isVisible(), false, "hidden before connecting");
  await page.locator("#connect").click();
  await page.waitForFunction(() => document.querySelector("#mode").textContent.startsWith("연결됨"), null, { timeout: 8000 });
  await page.waitForFunction(() => !document.querySelector("#refresh").disabled);
  const notice = (text) => page.waitForFunction((t) => document.querySelector("#notice").textContent.includes(t), text, { timeout: 8000 });
  const idle = () => page.waitForFunction(() => !document.querySelector("#refresh").disabled, null, { timeout: 8000 });
  const sim = () => page.evaluate(() => {
    const s = window.__studioTestHid.simulator;
    return { active: s.bank.active, used: s.bank.used, act4: s.profile.keys[4].actuation, code4: s.profile.bindings[4].code };
  });
  const switchButton = (i) => page.locator(`#profileButtons [data-profile="${i}"]`);

  assert.equal(await page.locator("#profileSwitch").isVisible(), true);
  assert.equal(await switchButton(0).getAttribute("aria-pressed"), "true");
  assert.equal(await switchButton(1).textContent(), "+");

  // "+" creates profile 2 as a copy of profile 1 and switches to it.
  await switchButton(1).click();
  await notice("프로필 2을");
  await idle();
  assert.deepEqual(await sim(), { active: 1, used: 3, act4: 2000, code4: 0x09 });
  assert.equal(await switchButton(1).getAttribute("aria-pressed"), "true");

  // Change key 4's mapping inside profile 2.
  await page.locator('.nav[data-tab="mapping"]').click();
  await page.locator("#key-4").click();
  await page.locator('#bindingPicker [data-kind="1"][data-code="11"]:visible').first().click();
  await page.locator("#applyBinding").click();
  await notice("키 매핑 RAM 적용 완료");
  await idle();
  assert.equal((await sim()).code4, 0x0b);

  // Back to profile 1: its mapping is untouched; profile 2 keeps its own.
  await switchButton(0).click();
  await notice("프로필 1로 전환");
  await idle();
  assert.deepEqual(await sim(), { active: 0, used: 3, act4: 2000, code4: 0x09 });
  assert.match(await page.locator("#key-4").getAttribute("aria-label"), /F/);
  await switchButton(1).click();
  await notice("전환했습니다");
  await idle();
  assert.equal((await sim()).code4, 0x0b);

  // 프로필 tab: rename, then delete the inactive profile 1... after switching back.
  await page.locator('.nav[data-tab="profiles"]').click();
  const row = (i) => page.locator(`[data-profile-row="${i}"]`);
  assert.equal(await row(1).locator("button", { hasText: "사용 중" }).isDisabled(), true);
  // Typed slowly with pauses: the status polling must not reset the field.
  await row(1).locator("input").pressSequentially("리듬", { delay: 120 });
  await page.waitForTimeout(400);
  assert.equal(await row(1).locator("input").inputValue(), "리듬");
  await row(1).locator("button", { hasText: "이름 바꾸기" }).click();
  await notice("이름을 바꿨습니다");
  await idle();
  assert.equal(await switchButton(1).textContent(), "리듬");
  assert.match(await page.locator("#profileSummary").textContent(), /리듬 사용 중 · 2 \/ 4/);
  await row(1).locator("input").fill("가나다라마바");
  await row(1).locator("button", { hasText: "이름 바꾸기" }).click();
  await notice("16바이트");
  assert.equal(await switchButton(1).textContent(), "리듬", "too-long name refused");

  // Empty slot 4 offers creation from the active profile.
  assert.match(await row(3).textContent(), /비어 있음/);
  await row(3).locator("button", { hasText: "만들기" }).click();
  await notice("프로필 4을");
  await idle();
  assert.deepEqual(await sim(), { active: 3, used: 11, act4: 2000, code4: 0x0b });
  await row(1).locator("button", { hasText: "삭제" }).click();
  await notice("삭제했습니다");
  await idle();
  assert.equal((await sim()).used, 9);
  assert.equal(await switchButton(1).textContent(), "+");

  // Saving keeps the profiles across a reconnect.
  await page.locator("#save").click();
  await notice("저장");
  await page.waitForFunction(() => document.querySelector("#mode").textContent.startsWith("연결됨") && !document.querySelector("#refresh").disabled, null, { timeout: 15000 });
  const stored = await page.evaluate(() => window.__studioTestHid.simulator.storedBank);
  assert.deepEqual([stored.active, stored.used], [3, 9]);
  assert.deepEqual(errors, []);
  console.log("Profiles: sidebar create/switch, per-profile mapping, rename/length check, create from empty slot, delete and save PASS (test HID only)");
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
