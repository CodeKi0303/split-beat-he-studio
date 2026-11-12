// UI-only help checks. Every physical WebHID path is blocked.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");

(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__physicalHidAttempts = 0;
      Object.defineProperty(navigator, "hid", { configurable: true, value: {
        requestDevice: () => { window.__physicalHidAttempts++; throw Error("Physical HID blocked"); },
        getDevices: () => { window.__physicalHidAttempts++; throw Error("Physical HID blocked"); },
      } });
    });
    const url = process.env.C77_WEB_URL || "http://127.0.0.1:8882/";
    await page.goto(url);
    await page.locator('[data-tab="performance"]').click();
    const help = page.locator("#rtSettingHelp");
    assert.equal(await page.locator(".rt-help-button").count(), 7);
    assert(await page.locator('[data-rt-help="actuation"]').isEnabled(), "Help remains available while disconnected");
    assert(!await page.locator("#retrigger").isChecked(), "Optional retrigger starts off");

    await page.locator('[data-rt-help="actuation"]').focus();
    assert(await help.isVisible());
    assert((await help.innerText()).includes("처음 입력이 켜지는 깊이"));
    assert.equal(await page.locator('[data-rt-help="actuation"]').getAttribute("aria-describedby"), "rtSettingHelp");
    await page.keyboard.press("Escape");
    assert(await help.isHidden());
    assert.equal(await page.locator('[data-rt-help="actuation"]').getAttribute("aria-expanded"), "false");

    await page.locator('[data-rt-help="rtRelease"]').hover();
    assert((await help.innerText()).includes("1.20 mm까지"));
    await page.mouse.move(10, 10);
    await page.waitForTimeout(180);
    assert(await help.isHidden());

    // Help is a sibling button, never part of a checkbox label or form submit.
    await page.evaluate(() => {
      window.__helpMutationEvents = 0;
      for (const id of ["rt", "retrigger"]) {
        const field = document.getElementById(id);
        field.disabled = false;
        field.checked = id === "rt";
        field.addEventListener("change", () => window.__helpMutationEvents++);
      }
      document.getElementById("keyForm").addEventListener("submit", event => {
        window.__helpMutationEvents++;
        event.preventDefault();
      });
    });
    for (const id of ["rt", "retrigger"]) {
      const button = page.locator(`[data-rt-help="${id}"]`);
      await button.click();
      assert(await help.isVisible());
      assert.equal(await button.getAttribute("aria-expanded"), "true");
      assert.equal(await page.locator("#rt").isChecked(), true);
      assert.equal(await page.locator("#retrigger").isChecked(), false);
      if (id === "retrigger") assert((await help.innerText()).includes("롱노트가 끊길 수"));
      await button.click();
      assert(await help.isHidden());
    }
    assert.equal(await page.evaluate(() => window.__helpMutationEvents), 0);
    await page.locator('[data-rt-help="rt"]').click();
    assert((await help.innerText()).includes("2.00 → 1.30 → 1.90"));
    await page.locator("main > header").click({ position: { x: 10, y: 10 } });
    assert(await help.isHidden());

    for (const id of ["rtPress", "topDeadzone", "bottomDeadzone"]) {
      await page.locator(`[data-rt-help="${id}"]`).focus();
      assert(await help.isVisible());
      await page.keyboard.press("Escape");
    }
    fs.mkdirSync("build", { recursive: true });
    await page.locator('[data-rt-help="rtRelease"]').click();
    await page.screenshot({ path: "build/web-rt-help-desktop.png", fullPage: true });
    await page.locator('[data-tab="mapping"]').click();
    assert(await help.isHidden(), "Leaving the settings tab closes its help");
    assert.equal(await page.evaluate(() => window.__physicalHidAttempts), 0);
    assert.deepEqual(errors, []);

    const mobile = await browser.newContext({ viewport: { width: 420, height: 900 }, hasTouch: true, isMobile: true });
    const touch = await mobile.newPage();
    touch.on("pageerror", error => errors.push(error.message));
    await touch.addInitScript(() => Object.defineProperty(navigator, "hid", { configurable: true, value: {
      requestDevice: () => { throw Error("Physical HID blocked"); },
      getDevices: () => { throw Error("Physical HID blocked"); },
    } }));
    await touch.goto(url);
    await touch.locator('[data-tab="performance"]').tap();
    await touch.locator('[data-rt-help="retrigger"]').tap();
    assert(await touch.locator("#rtSettingHelp").isVisible());
    const bounds = await touch.locator("#rtSettingHelp").boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 420);
    assert(bounds.y >= 0 && bounds.y + bounds.height <= 900);
    assert(await touch.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    await touch.screenshot({ path: "build/web-rt-help-mobile.png", fullPage: true });
    await touch.locator('[data-rt-help="retrigger"]').tap();
    assert(await touch.locator("#rtSettingHelp").isHidden());
    assert.deepEqual(errors, []);
    console.log("RT help UI: seven descriptions, keyboard/hover/touch, Escape/outside/tab close, unchanged checkbox/form, viewport fit PASS (no physical HID)");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
