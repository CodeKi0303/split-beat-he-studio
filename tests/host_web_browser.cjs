// OPTIONAL isolated Playwright UI artifact. Serve web at 127.0.0.1:8877 first.
// Creates a new browser/context; never attach to a user's browser. Genuine HID
// is blocked before app code loads. Only DemoTransport and in-memory mocks run.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { installStudioTestHid, setTestPose, releaseTestKeys } = require("./studio-browser-hid.cjs");
let browser;
(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.C77_BROWSER_CHANNEL
      ? { channel: process.env.C77_BROWSER_CHANNEL }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1100 },
    acceptDownloads: true,
  });
  await context.addInitScript(() => {
    window.__physicalHidAttempts = 0;
    const forbidden = () => {
      window.__physicalHidAttempts++;
      throw Error("Physical HID is disabled in browser tests");
    };
    Object.defineProperty(navigator, "hid", {
      configurable: true,
      value: { requestDevice: forbidden, getDevices: forbidden },
    });
  });
  const page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  const nav = (name) => page.locator(`.nav[data-tab="${name}"]`).click();
  const bindingMode = (kind) => page.locator(`[data-binding-mode="${kind}"]`).click();
  const bindingTarget = (kind, code) => page.locator(`#bindingPicker [data-kind="${kind}"][data-code="${code}"]:visible`);
  const notice = (text) =>
    page.waitForFunction(
      (text) => document.querySelector("#notice").textContent.includes(text),
      text,
    );
  const enabled = (id) =>
    page.waitForFunction((id) => !document.getElementById(id).disabled, id);
  const exportProfile = async () => {
    await nav("profiles");
    const pending = page.waitForEvent("download");
    await page.locator("#export").click();
    const download = await pending;
    assert.match(download.suggestedFilename(), /^split-studio-/);
    return JSON.parse(fs.readFileSync(await download.path(), "utf8"));
  };
  const importProfile = async (value) => {
    await nav("profiles");
    await page.locator("#profileFile").setInputFiles({
      name: "test-profile.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(value)),
    });
  };
  await page.goto("http://127.0.0.1:8877/");
  const demoInfo = await page.evaluate(async () => {
    const { DemoTransport } = await import("./demo.mjs");
    const { decodeInfo } = await import("./protocol.mjs");
    return decodeInfo(new DemoTransport().command(1, new Uint8Array()));
  });
  assert.equal(demoInfo.board_rev, 86);
  assert.equal(demoInfo.minor, 3);
  assert.equal(demoInfo.patch, 22);
  assert.ok(demoInfo.capabilities & 0x20, "demo has mouse-button capability");
  assert.ok(demoInfo.capabilities & 0x2000, "demo has multi-key chord capability");
  assert.equal(await page.locator("#demo, #demoControls").count(), 0);
  await installStudioTestHid(page);
  await page.locator("#connect").click();
  await page.waitForFunction(() =>
    document.querySelector("#mode").textContent === "연결됨 · v0.3.22",
  );
  await page.waitForFunction(
    () => document.querySelector("#key-13 .raw").textContent !== "—",
  );
  assert.equal(await page.locator(".key").count(), 28);
  assert.equal(
    await page.locator("#outputOn").isDisabled(),
    true,
    "active uncalibrated Hall keys block output",
  );
  assert.equal(await page.locator("#outputState").textContent(), "출력 꺼짐");

  // All-key host-side calibration uses STATUS and compatible SET_KEY records.
  // Only the pose of this isolated DemoTransport is changed; never real HID.
  const pose = (value) => setTestPose(page, value);
  const waitBatchClass = async (key, name) =>
    page.waitForFunction(
      ({ key, name }) =>
        document.getElementById(`key-${key}`).classList.contains(name),
      { key, name },
    );
  const beforeBatch = await exportProfile();
  await nav("calibration");
  assert.equal(
    await page.locator("#individualCalibration").getAttribute("open"),
    null,
    "one-by-one calibration is optional, collapsed initially",
  );
  await releaseTestKeys(page);
  const baselineStarted = Date.now();
  await page.locator("#batchStart").click();
  assert.equal(await page.locator("#save").isDisabled(), true);
  assert.equal(await page.locator("#rest").isDisabled(), true);
  await page.waitForFunction(() =>
    document
      .querySelector("#batchState")
      .textContent.includes("기준 수집 완료"),
  );
  assert.ok(
    Date.now() - baselineStarted >= 2900,
    "baseline actually waits about 3 seconds",
  );
  assert.equal(await page.locator("#batchApply").isDisabled(), true);
  assert.equal(await page.locator("#outputState").textContent(), "출력 꺼짐");
  await page.locator("#key-0").click();
  await pose(10); // about 20 raw ADC: motion, below firmware's minimum span 128.
  await waitBatchClass(0, "cal-detected");
  assert.equal(
    await page.locator("#batchApply").isDisabled(),
    true,
    "slight motion is visible but cannot fabricate a firmware-valid endpoint",
  );
  await pose(200);
  await waitBatchClass(0, "cal-eligible");
  await enabled("batchApply");
  assert.match(
    await page.locator("#batchCounts").textContent(),
    /적용 가능 1/,
    "one eligible key permits partial application",
  );
  await pose(450); // A deeper repeat must replace the previous 400-ADC endpoint.
  await page.waitForFunction(() => {
    const match = document
      .querySelector("#batch-key-0")
      .title.match(/범위 (\d+)/);
    return match && Number(match[1]) > 800;
  });
  await pose(0);
  await page.locator("#key-7").click();
  await pose(500);
  await waitBatchClass(7, "cal-eligible");
  assert.match(await page.locator("#batchCounts").textContent(), /적용 가능 2/);
  await page.locator("#batchQuickApply").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#batchState")
      .textContent.includes("2개 키의 보정 RAM 적용과 읽기 검증 완료"),
  );
  await waitBatchClass(0, "cal-applied");
  await waitBatchClass(7, "cal-applied");
  assert.equal(
    await page.locator("#generation").textContent(),
    "0",
    "batch never saves Flash automatically",
  );
  assert.equal(await page.locator("#outputState").textContent(), "출력 꺼짐");
  const calibrationOverlay = ".key.cal-wait,.key.cal-detected,.key.cal-eligible,.key.cal-applied";
  await nav("mapping");
  assert.equal(await page.locator(calibrationOverlay).count(), 0);
  assert.equal(await page.locator("#batchBanner").isVisible(), false);
  assert.match(await page.locator("#key-0 .travel").textContent(), /mm$/);
  await page.locator("#key-0").click();
  assert.equal(await page.locator("#key-0").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#key-7").getAttribute("aria-pressed"), "false");
  assert.notEqual(
    await page.locator("#key-0").evaluate((key) => getComputedStyle(key).borderColor),
    await page.locator("#key-7").evaluate((key) => getComputedStyle(key).borderColor),
    "calibrated keys retain visibly different selection borders",
  );
  await pose(450);
  await page.waitForSelector("#key-0.pressed");
  await pose(0);
  await page.waitForSelector("#key-0.pressed", { state: "hidden" });
  assert.equal(await page.locator(calibrationOverlay).count(), 0, "polling does not restore old colors");
  await nav("performance");
  assert.equal(await page.locator(calibrationOverlay).count(), 0);
  await nav("calibration");
  await waitBatchClass(0, "cal-applied");
  await waitBatchClass(7, "cal-applied");
  const afterBatch = await exportProfile();
  for (let key = 0; key < 14; key++) {
    if (key === 0 || key === 7) {
      const before = beforeBatch.device.keys[key],
        after = afterBatch.device.keys[key];
      assert.equal(after.flags, before.flags | 4);
      assert.ok(Math.abs(after.released - 1000) <= 3);
      const span = Math.abs(after.pressed - after.released);
      assert.ok(
        span > (key === 0 ? 800 : 900) && span < (key === 0 ? 950 : 1050),
        "capture observed peak",
      );
      for (const field of [
        "actuation",
        "rt_press",
        "rt_release",
        "top_deadzone",
        "noise_deadband",
      ])
        assert.equal(after[field], before[field], `preserve ${field}`);
    } else
      assert.deepEqual(
        afterBatch.device.keys[key],
        beforeBatch.device.keys[key],
        `untouched key ${key}`,
      );
  }
  assert.deepEqual(afterBatch.device.bindings, beforeBatch.device.bindings);
  assert.deepEqual(afterBatch.ui, beforeBatch.ui);
  await nav("calibration");
  await releaseTestKeys(page);
  await page.locator("#batchStart").click();
  await page.locator("#batchQuickCancel").click();
  assert.equal(await page.locator("#batchBanner").isVisible(), false);
  assert.equal(
    await page.locator(".cal-applied,.cal-detected,.cal-eligible").count(),
    0,
  );
  assert.deepEqual(
    await exportProfile(),
    afterBatch,
    "cancel does not revert already-applied RAM settings",
  );
  await page.locator("#disconnect").click();
  await page.locator("#connect").click();
  await page.waitForFunction(
    () => document.querySelector("#calProgress").textContent === "보정 0 / 14",
  );

  await page.locator("#key-0").click();
  await nav("performance");
  assert.equal(await page.locator("#applyKey").isDisabled(), true);
  await nav("calibration");
  await page.locator("#individualCalibration > summary").click();
  await page.locator("#rest").click();
  await enabled("pressed");
  await page.locator("#pressed").click();
  await enabled("commit");
  await page.locator("#commit").click();
  await notice("보정 RAM 적용 완료");
  assert.match(await page.locator("#endpoints").textContent(), /^보정됨/);
  assert.equal(await page.locator("#calProgress").textContent(), "보정 1 / 14");
  await nav("performance");
  await page.locator("#travelPreset").selectOption("3.5");
  assert.equal(await page.locator("#totalTravel").inputValue(), "3.50");
  await page.locator("#totalTravel").fill("3.8");
  await page.locator("#applyTravel").click();
  assert.equal(await page.locator("#totalTravel").inputValue(), "3.80");
  assert.equal(await page.locator("#actuation").getAttribute("step"), "0.01");
  await page.locator("#topDeadzone").fill("0.00");
  await page.locator("#actuation").fill("0.01");
  await page.locator("#rt").check();
  await page.locator("#rtPress").fill("0.02");
  await page.locator("#rtRelease").fill("0.03");
  await page.locator("#applyKey").click();
  await notice("Hall 설정 RAM 적용 완료");
  assert.match(
    await page.locator("#notice").textContent(),
    /0\.011/,
    "show actual normalized-unit rounding",
  );

  // Ordinary switches and rotary directions must not offer Hall settings.
  await page.locator("#key-14").click();
  assert.equal(
    await page.locator("#performance .hall-only").isVisible(),
    false,
  );
  assert.equal(
    await page.locator("#performance .non-hall-message").isVisible(),
    true,
  );
  await nav("calibration");
  assert.equal(
    await page.locator("#calibration .hall-only").isVisible(),
    false,
  );
  await nav("mapping");
  await bindingMode(5);
  await bindingTarget(5, 1).click();
  assert.equal(await page.locator("#mappingCompatibility").isVisible(), false);
  await page.locator("#applyBinding").click();
  await notice("키 매핑 RAM 적용 완료");
  assert.equal(
    await page.locator("#bindingPreview").textContent(),
    "마우스 왼쪽",
  );
  await page.locator("#key-20").click();
  await nav("performance");
  assert.equal(
    await page.locator("#performance .hall-only").isVisible(),
    false,
  );
  await nav("mapping");
  await bindingMode(5);
  await bindingTarget(3, -1).click();
  await page.locator("#applyBinding").click();
  await notice("키 매핑 RAM 적용 완료");

  await page.locator("#key-2").click();
  assert.equal(await page.locator(".binding-picker-board button").count(), 108);
  assert.equal(await page.locator("#bindingForm select").count(), 0);
  await bindingTarget(1, 4).click();
  await page.keyboard.down("Shift");
  try {
    await bindingTarget(1, 5).click();
    await bindingTarget(1, 58).click();
    await bindingTarget(1, 224).click();
    await bindingTarget(1, 6).click();
    assert.match(await page.locator("#mappingFeedback").textContent(), /최대 3개/);
    await bindingTarget(1, 5).click();
    assert.equal(await bindingTarget(1, 5).getAttribute("aria-pressed"), "false");
    await bindingTarget(1, 5).click();
  } finally {
    await page.keyboard.up("Shift");
  }
  assert.equal(await page.locator("#bindingPreview").textContent(), "L Ctrl + A + B + F1");
  assert.equal(await bindingTarget(1, 225).getAttribute("aria-pressed"), "false", "physical Shift is selection-only");
  await page.locator("#applyBinding").click();
  await notice("키 매핑 RAM 적용 완료");

  // The fake HID device supplies sensor positions.
  await page.locator("#key-0").click();
  await nav("diagnostics");
  await page.waitForFunction(
    () => document.querySelector("#mean").textContent !== "—",
  );
  assert.ok(
    await page
      .locator("#signalChart")
      .evaluate((c) => c.width > 0 && c.height > 0),
  );
  assert.match(await page.locator("#sampleInfo").textContent(), /관찰/);
  await releaseTestKeys(page);
  await page.locator("#baseline").click();
  await enabled("measurePress");
  await pose(1000);
  await page.locator("#measurePress").click();
  await page.waitForFunction(() =>
    document.querySelector("#measureState").textContent.startsWith("측정 완료"),
  );
  assert.equal(await page.locator("#interferenceRows tr").count(), 13);
  assert.doesNotMatch(
    await page.locator("#interferenceSummary").textContent(),
    /선택 키의 변화가 작습니다/,
  );
  await page.locator("#cancelMeasure").click();
  await releaseTestKeys(page);
  assert.equal(await page.locator("#interferenceRows tr").count(), 0);

  await page.locator("#save").click();
  await notice("영구 저장 검증 완료");
  assert.equal(await page.locator("#generation").textContent(), "1");
  assert.equal(await page.locator("#outputState").textContent(), "출력 꺼짐");
  const exported = await exportProfile();
  assert.equal(exported.schema, "split-studio-profile-v1");
  assert.equal(exported.ui.totalTravelMm[0], 3.8);
  assert.equal(
    exported.device.schema,
    "c77-profile-v1",
    "wire profile remains compatible",
  );
  assert.equal(exported.device.keys[0].actuation, 3);
  assert.equal(exported.device.keys[0].rt_press, 5);
  assert.equal(exported.device.keys[0].rt_release, 8);
  assert.equal(exported.device.keys[0].top_deadzone, 0);
  assert.equal(
    exported.device.keys[0].noise_deadband,
    5,
    "noise remains ADC counts",
  );
  assert.equal(exported.device.bindings[14].kind, 5);
  assert.equal(exported.device.bindings[14].code, 1);
  assert.equal(exported.device.bindings[20].kind, 3);
  assert.equal(exported.device.bindings[20].code, -1);
  assert.deepEqual(exported.device.bindings[2], { input: 2, kind: 6, keys: [4, 5, 58], modifiers: 1 });
  const updated = structuredClone(exported);
  updated.ui.totalTravelMm[0] = 3.3;
  updated.device.bindings[14].code = 2;
  await importProfile(updated);
  await notice("프로필 RAM 적용 및 읽기 검증 완료");
  assert.deepEqual(
    await exportProfile(),
    updated,
    "both device settings and UI metadata round-trip",
  );
  await page.locator("#save").click();
  await notice("세대 2");
  assert.equal(await page.locator("#generation").textContent(), "2");
  await importProfile({ schema: "invalid" });
  await page.waitForFunction(() =>
    document.querySelector("#notice").classList.contains("error"),
  );
  assert.equal(await page.locator("#generation").textContent(), "2");
  assert.deepEqual(
    await exportProfile(),
    updated,
    "invalid import does not change device settings",
  );
  await page.locator("#refresh").click();
  await notice("설정을 다시 읽었습니다.");

  fs.mkdirSync("build", { recursive: true });
  await nav("mapping");
  await page.screenshot({ path: "build/web-demo-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const section of [
    "mapping",
    "performance",
    "calibration",
    "diagnostics",
    "profiles",
  ]) {
    await nav(section);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
      `mobile page overflow: ${section}`,
    );
  }
  await nav("diagnostics");
  await page.screenshot({ path: "build/web-demo-mobile.png", fullPage: true });
  await page.locator("#disconnect").click();
  await page.waitForFunction(
    () => document.querySelector("#mode").textContent === "연결 안 됨",
  );
  assert.equal(await page.locator("#key-0 .raw").textContent(), "—");
  assert.equal(await page.locator("#mean").textContent(), "—");
  await page.setViewportSize({ width: 1400, height: 1100 });

  // Memory-only HID mocks exercise the actual transport/parser without hardware.
  for (const revision of [77, 85, 86]) {
    await page.evaluate(async (revision) => {
      const { DemoTransport } = await import("./demo.mjs");
      const { VID, PID, USAGE_PAGE, USAGE, packet, unpackPacket } =
        await import("./protocol.mjs");
      const simulator = new DemoTransport();
      const mock = {
        device: null,
        hid: null,
        simulator,
        stale: false,
        commands: [],
      };
      const device = new EventTarget();
      Object.assign(device, {
        vendorId: VID,
        productId: PID,
        opened: false,
        serialNumber: `TEST-ONLY-C${revision}`,
        collections: [{ usagePage: USAGE_PAGE, usage: USAGE }],
        async open() {
          this.opened = true;
        },
        async close() {
          this.opened = false;
        },
        async sendReport(reportId, data) {
          if (reportId !== 0) throw Error("Unexpected report ID");
          const request = unpackPacket(data);
          mock.commands.push({ op: request.op, payload: [...request.payload] });
          const response = await simulator.exchange(data);
          if (response.op === 0x81 && !response.status) {
            response.payload.set([0, 1, 0], 0);
            response.payload[30] = revision;
            new DataView(
              response.payload.buffer,
              response.payload.byteOffset,
              response.payload.byteLength,
            ).setUint32(16, 0x1f, true);
          }
          if (response.op === 0x82 && !response.status && mock.stale)
            response.payload[45] &= ~2;
          const encoded = packet(
              response.op,
              response.seq,
              response.payload,
              response.status,
            ),
            event = new Event("inputreport");
          Object.assign(event, {
            reportId: 0,
            device: this,
            data: new DataView(
              encoded.buffer,
              encoded.byteOffset,
              encoded.byteLength,
            ),
          });
          this.dispatchEvent(event);
        },
      });
      const fakeHID = new EventTarget();
      fakeHID.requestDevice = async () => [device];
      fakeHID.getDevices = async () => [device];
      Object.defineProperty(navigator, "hid", {
        configurable: true,
        value: fakeHID,
      });
      mock.device = device;
      mock.hid = fakeHID;
      window.__mockHid = mock;
    }, revision);
    await page.locator("#connect").click();
    await page.waitForFunction(
      () => document.querySelector("#mode").textContent === "연결됨 · v0.1.0",
    );
    assert.equal(
      await page.locator("#deviceName").textContent(),
      `C${revision} Split Hall`,
    );
    await page.waitForFunction(
      () => document.querySelector("#key-13 .raw").textContent !== "—",
    );
    assert.ok(
      (
        await page.evaluate(() =>
          window.__mockHid.commands.map((item) => item.op),
        )
      ).every((op) => [1, 2, 3, 9].includes(op)),
      "connect sends reads only",
    );
    assert.equal(
      await page.locator("#demoPose").isVisible(),
      false,
      "sensor simulation controls are absent from the public UI",
    );
    await page.locator("#key-14").click();
    await nav("mapping");
    await bindingMode(5);
    await bindingTarget(5, 1).click();
    assert.equal(await page.locator("#mappingCompatibility").isVisible(), true);
    assert.equal(
      await page.locator("#applyBinding").isDisabled(),
      true,
      "legacy mouse buttons blocked",
    );
    await bindingTarget(2, 1).click();
    assert.equal(
      await page.locator("#applyBinding").isDisabled(),
      true,
      "legacy ordinary-key scroll blocked",
    );
    await page.locator("#key-20").click();
    await bindingMode(5);
    await bindingTarget(2, 1).click();
    assert.equal(
      await page.locator("#applyBinding").isDisabled(),
      false,
      "legacy encoder scroll still supported",
    );
    await bindingMode(1);
    await bindingTarget(1, 224).click();
    await bindingTarget(1, 4).click({ modifiers: ["Shift"] });
    assert.equal(await page.locator("#applyBinding").isDisabled(), false, "legacy modifier + one key still supported");
    await bindingTarget(1, 5).click({ modifiers: ["Shift"] });
    assert.equal(await page.locator("#applyBinding").isDisabled(), true, "legacy multi-key chords blocked");
    if (revision === 86) {
      // Batch calibration remains usable on the deployed v0.1 capability set.
      await nav("calibration");
      await enabled("batchStart");
      await page.locator("#batchStart").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#batchState")
          .textContent.includes("기준 수집 완료"),
      );
      await page.evaluate(() => {
        window.__mockHid.simulator.pose[0] = 300;
      });
      await waitBatchClass(0, "cal-eligible");
      await page.locator("#batchQuickApply").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#batchState")
          .textContent.includes("1개 키의 보정 RAM 적용과 읽기 검증 완료"),
      );
      assert.equal(
        await page.locator("#calProgress").textContent(),
        "보정 1 / 14",
      );
      const batchOps = await page.evaluate(() =>
        window.__mockHid.commands.map((command) => command.op),
      );
      assert.equal(
        batchOps.filter((op) => op === 4).length,
        1,
        "one compatible SET_KEY for one captured key",
      );
      assert.equal(
        batchOps.includes(5),
        false,
        "batch does not enter firmware one-key CALIBRATE",
      );
      assert.equal(batchOps.includes(7), false, "batch never sends SAVE");
      await page.locator("#batchQuickCancel").click();
      await page.locator("#key-0").click();
      await nav("performance");
      assert.equal(await page.locator("#bottomDeadzone").isDisabled(), true);
      assert.equal(await page.locator("#bottomDeadzoneCompatibility").isVisible(), true);
      await page.locator("#actuation").fill("0.80");
      await page.locator("#applyKey").click();
      await notice("Hall 설정 RAM 적용 완료");
      assert.equal(await page.locator("#outputState").textContent(), "출력 꺼짐");
      await nav("diagnostics");
      await page.waitForFunction(
        () => document.querySelector("#mean").textContent !== "—",
      );
      await page.screenshot({
        path: "build/web-c86-mock-desktop.png",
        fullPage: true,
      });
      await page.evaluate(() => {
        window.__mockHid.stale = true;
      });
      await page.waitForFunction(
        () => document.querySelector("#key-0 .raw").textContent === "—",
      );
      await page.evaluate(() => {
        const mock = window.__mockHid;
        mock.device.opened = false;
        const event = new Event("disconnect");
        Object.assign(event, { device: mock.device });
        mock.hid.dispatchEvent(event);
      });
      await notice("USB 연결이 끊겼습니다");
      assert.equal(
        await page.locator("#mean").textContent(),
        "—",
        "disconnect clears old statistics",
      );
      assert.equal(await page.locator("#interferenceRows tr").count(), 0);
      assert.equal(
        await page.locator("#outputState").textContent(),
        "출력 꺼짐",
      );
    }
    await page.locator("#disconnect").click();
    await page.waitForFunction(
      () => document.querySelector("#mode").textContent === "연결 안 됨",
    );
    assert.equal(await page.locator("#key-0 .raw").textContent(), "—");
    if (revision === 86) {
      await page.evaluate(() => {
        window.__mockHid.stale = false;
      });
      await page.locator("#connect").click();
      await page.waitForFunction(
        () => document.querySelector("#key-0 .raw").textContent !== "—",
      );
      assert.equal(
        await page.locator("#interferenceRows tr").count(),
        0,
        "reconnect has no prior measurement",
      );
      await page.locator("#disconnect").click();
      await page.waitForFunction(
        () => document.querySelector("#mode").textContent === "연결 안 됨",
      );
    }
  }
  assert.equal(await page.evaluate(() => window.__physicalHidAttempts), 0);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log(
    "Browser demo batch3s/partial/endpoints/cancel/legacy-SET_KEY + calibration/mm/RT/mouse/wheel/diagnostics/interference/profile/SAVE/mobile + synthetic C77/C85/C86 compatibility/reconnect PASS (no hardware)",
  );
})().catch(async (error) => {
  console.error(error);
  if (browser) await browser.close().catch(() => {});
  process.exit(1);
});
