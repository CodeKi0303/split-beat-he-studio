import { BatchCalibration } from "./batch-calibration.mjs?v=studio-owlab1";
import { fetchStudioRelease, firmwareVersionNumber } from "./studio-release.mjs";
import { RhythmLab } from "./rhythm-ui.mjs?v=studio-consumed-notes1";
import { AutoFitWizard } from "./auto-fit-ui.mjs?v=studio-default-layout1";
import { mountRTSettingHelp } from "./rt-setting-help.mjs?v=studio-recognized-travel1";
import { recognizedTravel, recognizedTravelToMm } from "./recognized-travel.mjs?v=studio-recognized-travel1";
import { applyCalibration } from "./apply-calibration.mjs?v=studio-owlab1";
import {
  proposePerformanceSettings,
  applyPerformanceSettings,
} from "./performance-settings.mjs?v=studio-retrigger1";
import {
  compatible,
  WebHIDTransport,
  KeyboardClient,
} from "./device.mjs?v=studio-adc-windows1";
import {
  VID,
  PID,
  USAGE_PAGE,
  USAGE,
  CAP_MOUSE_BUTTON,
  CAP_BOTTOM_DEADZONE,
  CAP_HALL_CURVE,
  CAP_RETRIGGER_BEFORE_RELEASE,
  CAP_KEY_CHORD,
  CAP_ADC_TUNING,
  CAP_ADC_PAIR,
  CAP_ADC_PAIR_READ,
  CAP_FINE_TRAVEL,
  CAP_CUSTOM_CURVE,
  CAP_POINTER,
  CAP_POINTER_ACCEL,
  CAP_PROFILES,
  PROFILE_COUNT,
  encodeProfileName,
  profileLabel,
  CUSTOM_CURVE_IDENTITY,
  keyRecord,
  TRAVEL_MAX,
} from "./protocol.mjs?v=studio-retrigger1";
import { mountBindingPicker } from "./binding-picker.mjs?v=studio-chords1";
import { OWLAB_TI_TRAVEL_MM, HALL_CURVE_LINEAR, HALL_CURVE_OWLAB_TI, HALL_CURVE_CUSTOM, setActiveCustomCurve, curveAsCustomTable, rawToTravel } from "./hall-curve.mjs?v=studio-owlab1";
import { mountCurveEditor } from "./curve-editor.mjs?v=studio-custom-curve1";
import { mountFirmwareTab } from "./firmware-tab.mjs?v=studio-firmware-tab1";
import { HALVES, CONTROLS, INPUTS } from "./layout.mjs?v=studio-owlab1";
import { inputBinding, inputBindingLabel, inputKeycapLabel, inputLabel } from "./input-labels.mjs?v=studio-default-layout1";
import { noiseTargets, proposeNoiseSettings, sensorSeries, relativeSensorSeries } from "./sensor-settings.mjs?v=studio-sensor-lab1";
import {
  TelemetryStore,
  InterferenceSession,
  normalizedToMm,
  summarize,
} from "./telemetry.mjs?v=studio-filtered-diagnostics1";
import { bindingLabel } from "./key-catalog.mjs?v=studio-default-layout1";
import {
  parseUiProfile,
  makeUiProfile,
  validateTravelArray,
} from "./ui-profile.mjs?v=studio-owlab1";
const $ = (id) => document.getElementById(id);
const titles = {
  mapping: "키 매핑",
  performance: "작동점 · RT",
  calibration: "캘리브레이션",
  diagnostics: "센서 진단/설정",
  rhythm: "리듬 · RT 측정",
  firmware: "펌웨어",
  profiles: "프로필",
};
const keyFields = {
  actuation: "actuation",
  rtPress: "rt_press",
  rtRelease: "rt_release",
  topDeadzone: "top_deadzone",
  bottomDeadzone: "bottom_deadzone",
};
let client = null,
  profile = null,
  info = null,
  selected = 0,
  activeTab = "mapping",
  busy = false,
  saving = false,
  connected = false,
  polling = false,
  timer = null,
  lockRelease = null,
  rhythm = null,
  autoFit = null;
let lastPollAt = -Infinity;
const lastStatusPaint = [-Infinity, -Infinity];
let latest = [null, null],
  travelMm = Array(14).fill(4),
  preferenceKey = "split-studio:preview",
  calStage = null;
const telemetry = new TelemetryStore({ windowMs: 60000, maxSamples: 3000 }),
  measure = new InterferenceSession();
const batch = new BatchCalibration();
let adcComparison = [], lastAdcComparison = -Infinity;
let adcApplied = [null, null];
// Key output the user chose (출력 켜기/끄기, saved state, or state found on connect).
// Firmware turns output off on every configuration write, calibration capture and
// ADC change; Studio never turns it off on its own and restores this choice after
// its operations and measurements finish.
let wantOutput = false, restorePending = false, lastOperationEnd = -Infinity;
// Firmware 0.3.46+ shared custom curve: the keyboard's table and whether the
// user has drawn or picked a draft, or chosen a curve kind, since then.
let deviceCurve = null, curveDrawn = false, curveKindTouched = false;
// Latest ADC_COMPARE snapshot for the curve card (raw / moving average /
// post-deadband decision). Right keys need firmware 0.3.47+.
let curveLive = null, compareRightUnsupported = false;
const curveSupported = () => connected && !!(info?.capabilities & CAP_CUSTOM_CURVE);
const curveLiveWanted = () => adcTuningSupported() && curveSupported() && hall() && !$("curveEditor").hidden &&
  !(selected >= 7 && compareRightUnsupported);
const adcTuningSupported = () => connected && !!(info?.capabilities & CAP_ADC_TUNING);
const adcPairSupported = () => adcTuningSupported() && !!(info?.capabilities & CAP_ADC_PAIR);
const comparingAdc = () => adcTuningSupported() && selected < 7 && $("diagnosticAdcCompare").checked;
const selectedHall = new Set([0]), performanceDirty = new Set();
let noiseDirty = false, noiseTargetKey = "";
const impactHidden = new Set();
const diagnosticWindow = () => Number($("diagnosticWindow").value);
const performanceTargets = () =>
  hall() ? [...selectedHall].sort((a, b) => a - b) : [];
let batchOriginal = null,
  batchOutcome = null;
const batchActive = () => ["baseline", "press"].includes(batch.state);
let drawnMeasurement = null;
// On-device profiles (firmware 0.4.0+): { count, active, used, names } or null.
let profileState = null;
const hall = () => selected < 14;
// Hall keys that are enabled but have no stored calibration (flag bit 2).
const uncalibratedHall = () =>
  profile?.keys.filter((k) => k.flags & 1 && !(k.flags & 4)).map((k) => k.key) ?? [];
const mappedInputLabel = (id) => inputLabel(id, profile?.bindings);
const calibrationActive = () =>
  !!calStage || latest.some((s) => s?.calibration_state > 0);
const measuring = () =>
  !!rhythm?.active || !!autoFit?.active || !!autoFit?.applying || ["baseline", "ready", "pressed"].includes(measure.state);
const fmt = (x, n = 2) =>
  x === null || x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(n);
function log(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
  $("log").textContent = (
    `${new Date().toLocaleTimeString()} ${message}\n` + $("log").textContent
  ).slice(0, 12000);
}
function savePreferences() {
  try {
    localStorage.setItem(
      preferenceKey,
      JSON.stringify({ totalTravelMm: travelMm }),
    );
  } catch {
    log(
      "이 브라우저에 이동거리를 보관할 수 없습니다. 프로필을 내보내 보관하세요.",
      true,
    );
  }
}
function loadPreferences() {
  travelMm = Array(14).fill(4);
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey));
    if (saved) travelMm = validateTravelArray(saved.totalTravelMm);
  } catch {
    log(
      "저장된 이동거리 정보를 읽지 못해 4.00 mm로 표시합니다. 스위치 사양을 다시 선택하세요.",
      true,
    );
  }
}
function setTab(name) {
  rtSettingHelp.close();
  if (name !== "rhythm" && rhythm?.active) rhythm.stop("다른 화면으로 이동해 측정을 중단했습니다.");
  if (name !== "rhythm" && autoFit?.active) autoFit.stop("다른 화면으로 이동해 측정을 중단했습니다.");
  activeTab = name;
  document.body.classList.toggle("performance-tab", name === "performance");
  document.body.classList.toggle("firmware-tab", name === "firmware");
  for (const [id, title] of Object.entries(titles)) $(id).hidden = id !== name;
  document.querySelectorAll(".nav").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
    b.setAttribute("aria-selected", String(b.dataset.tab === name));
  });
  $("pageTitle").textContent = titles[name];
  $("performanceSelectionToolbar").hidden = name !== "performance";
  const pending = [...performanceDirty].map((id) => ({ id, value: $(id).value, checked: $(id).checked, indeterminate: $(id).indeterminate }));
  renderSelection();
  for (const draft of pending) {
    Object.assign($(draft.id), { value: draft.value, checked: draft.checked, indeterminate: draft.indeterminate });
    if ($(draft.id + "Range")) $(draft.id + "Range").value = draft.value;
    performanceDirty.add(draft.id);
  }
  if (pending.length) { renderTravel(); controls(); }
  if (name === "diagnostics") renderDiagnostics();
  if (name === "rhythm") { rhythm?.updateContext(); rhythm?.draw(); }
}
document
  .querySelectorAll(".nav")
  .forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
function selectInput(id, event = {}) {
  if (busy || measuring() || calibrationActive()) return;
  if (activeTab === "performance" && id < 14 &&
      ($("multiSelectHall").checked || event.ctrlKey || event.metaKey)) {
    $("multiSelectHall").checked = true;
    if (selectedHall.has(id)) selectedHall.delete(id);
    else selectedHall.add(id);
    selected = selectedHall.has(id) ? id : ([...selectedHall][0] ?? id);
  } else {
    selected = id;
    selectedHall.clear();
    if (id < 14) selectedHall.add(id);
  }
  renderSelection();
  controls();
}
function selectHallGroup(ids) {
  if (busy || measuring() || calibrationActive() || batchActive()) return;
  selectedHall.clear();
  ids.forEach((id) => selectedHall.add(id));
  if (ids.length) selected = ids[0];
  $("multiSelectHall").checked = true;
  renderSelection();
  controls();
}
$("selectAllHall").onclick = () => selectHallGroup(Array.from({ length: 14 }, (_, i) => i));
$("selectLeftHall").onclick = () => selectHallGroup(Array.from({ length: 7 }, (_, i) => i));
$("selectRightHall").onclick = () => selectHallGroup(Array.from({ length: 7 }, (_, i) => i + 7));
$("clearHallSelection").onclick = () => selectHallGroup([]);
$("multiSelectHall").onchange = () => {
  if (!$("multiSelectHall").checked) {
    selectedHall.clear();
    if (hall()) selectedHall.add(selected);
  }
  renderSelection();
  controls();
};
function buildKeyboard() {
  for (const c of CONTROLS) {
    const side = HALVES[c.side];
    const box = document.createElement("div");
    box.className = `control shape-${c.shape}`;
    box.style.left = `${(c.x / side.width) * 100}%`;
    box.style.top = `${(c.y / side.height) * 100}%`;
    box.style.width = `${(c.width / side.width) * 100}%`;
    box.style.height = `${(c.height / side.height) * 100}%`;
    box.style.transform = `translate(-50%,-50%) rotate(${c.angle}deg)`;
    for (const id of c.inputs) {
      const input = INPUTS[id],
        b = document.createElement("button");
      b.id = `key-${id}`;
      b.type = "button";
      const direction = input.direction && input.direction !== "click";
      b.className = `key ${c.type === "hall" ? "hall" : c.type === "digital" ? "digital" : "encoder"}${direction ? " direction" : ""}`;
      b.setAttribute("aria-label", mappedInputLabel(id));
      b.setAttribute("aria-pressed", "false");
      b.innerHTML =
        '<span class="name"></span><span class="raw">—</span><span class="travel"></span><span class="bar"></span>';
      b.querySelector(".name").textContent = inputKeycapLabel(id, profile?.bindings);
      b.querySelector(".travel").textContent =
        c.type === "hall"
          ? "Hall"
          : input.direction === "click"
            ? "클릭"
            : "MX";
      b.onclick = (event) => selectInput(id, event);
      box.append(b);
    }
    $(c.side ? "rightKeys" : "leftKeys").append(box);
  }
}
buildKeyboard();
$("sideView").onchange = () => {
  document
    .querySelectorAll(".half")
    .forEach(
      (el) =>
        (el.hidden =
          $("sideView").value !== "both" &&
          $("sideView").value !== el.dataset.side),
    );
};
const bindingModes = [...$("bindingModes").querySelectorAll("button")];
const emptyBinding = (kind) => ({ kind, codes: [], modifiers: 0 });
const modifierBit = (code) => code >= 0xe0 && code <= 0xe7 ? 1 << (code - 0xe0) : 0;
const mappingBlocked = () => busy || measuring() || batchActive() || calibrationActive();
let bindingDraft = emptyBinding(1), pickerLocked = null;
const picker = mountBindingPicker($("bindingPicker"), { onPick: pickBinding });
const mappingReady = () => bindingDraft.kind === 0 ||
  bindingDraft.codes.length > 0 || bindingDraft.modifiers !== 0;
const mappingMode = (kind) => [2, 3, 5, 7].includes(kind) ? 5 : kind === 6 ? 1 : kind;
// Pointer speed default: px per detent on encoders, px/s on held inputs.
const defaultPointerSpeed = () => selected >= 20 ? 20 : 800;
function mappingValue() {
  const { kind, codes, modifiers } = bindingDraft;
  if (kind === 7) {
    const direction = codes[0] ?? 1, speed = bindingDraft.speed ?? defaultPointerSpeed();
    const accel = selected >= 20 ? bindingDraft.accel ?? 0 : 0;
    return { input: selected, kind, code: Math.sign(direction) * speed, modifiers: Math.abs(direction) === 2 ? 1 : 0,
      ...(accel ? { accel } : {}) };
  }
  if (kind === 1 && codes.length > 1)
    return { input: selected, kind: 6, keys: [...codes].sort((a, b) => a - b), modifiers };
  return { input: selected, kind, code: codes[0] ?? 0, modifiers };
}
function mappingUnsupported() {
  const k = mappingValue().kind;
  if (k === 7 && !(info?.capabilities & CAP_POINTER))
    return "포인터 이동에는 왼쪽 키보드 펌웨어 v0.3.48 이상이 필요합니다.";
  if (k === 7 && mappingValue().accel && !(info?.capabilities & CAP_POINTER_ACCEL))
    return "포인터 가속에는 왼쪽 키보드 펌웨어 v0.3.49 이상이 필요합니다.";
  if (k === 6 && !(info?.capabilities & CAP_KEY_CHORD))
    return "일반 키를 두 개 이상 함께 보내려면 조합키를 지원하는 왼쪽 C86 펌웨어가 필요합니다.";
  if (!(info?.capabilities & CAP_MOUSE_BUTTON) &&
      ((k === 5 && mappingReady()) || ([2, 3].includes(k) && selected < 20)))
    return "이 매핑에는 왼쪽 키보드 펌웨어 v0.2.0 이상이 필요합니다.";
  return "";
}
function setMappingFeedback(message = "") {
  $("mappingFeedback").textContent = message;
  $("mappingFeedback").hidden = !message;
}
function pickBinding({ kind, code, shiftKey }) {
  if (mappingBlocked()) return;
  setMappingFeedback();
  if (kind === 7) {
    bindingDraft = { kind, codes: [code], modifiers: 0,
      speed: bindingDraft.kind === 7 ? bindingDraft.speed : defaultPointerSpeed(),
      accel: bindingDraft.kind === 7 ? bindingDraft.accel ?? 0 : 0 };
  } else if (kind !== 1) {
    bindingDraft = { kind, codes: [code], modifiers: 0 };
  } else {
    const append = shiftKey && bindingDraft.kind === 1;
    const draft = append ? bindingDraft : emptyBinding(1);
    const modifier = modifierBit(code);
    if (modifier) {
      bindingDraft = { ...draft, modifiers: draft.modifiers ^ modifier };
    } else if (draft.codes.includes(code)) {
      bindingDraft = { ...draft, codes: draft.codes.filter((key) => key !== code) };
    } else if (draft.codes.length === 3) {
      setMappingFeedback("일반 키는 최대 3개까지 선택할 수 있습니다. Ctrl·Shift·Alt·Win 키는 따로 추가할 수 있습니다.");
      return;
    } else {
      bindingDraft = { ...draft, codes: [...draft.codes, code] };
    }
  }
  renderMappingPreview();
}
function renderPicker() {
  const mode = mappingMode(bindingDraft.kind);
  pickerLocked = mappingBlocked();
  for (const button of bindingModes) {
    button.disabled = pickerLocked;
    button.setAttribute("aria-pressed", String(Number(button.dataset.bindingMode) === mode));
  }
  picker.render({ ...bindingDraft, disabled: pickerLocked });
}
function renderMappingPreview() {
  const b = mappingValue();
  $("bindingPreview").textContent = mappingReady() ? bindingLabel(b) : "출력 선택";
  $("pointerSpeedField").hidden = b.kind !== 7;
  $("pointerAccelField").hidden = b.kind !== 7 || selected < 20;
  if (b.kind === 7 && selected >= 20)
    for (const button of $("pointerAccel").querySelectorAll("button"))
      button.setAttribute("aria-pressed", String(Number(button.dataset.accel) === (b.accel ?? 0)));
  if (b.kind === 7) {
    if (document.activeElement !== $("pointerSpeed")) $("pointerSpeed").value = String(Math.abs(b.code));
    $("pointerSpeedUnit").textContent = selected >= 20 ? "px / 한 칸" : selected < 14 ? "px/s · 끝까지 눌렀을 때" : "px/s";
  }
  const mode = mappingMode(b.kind);
  const help = mode === 1
    ? "Shift + 클릭으로 키를 추가하거나 뺍니다. Shift를 출력하려면 그림의 Shift도 선택하세요."
    : mode === 5 ? "버튼, 스크롤 또는 포인터 방향을 선택하세요."
    : mode === 4 ? "보낼 미디어 키를 선택하세요." : "";
  $("mappingHelp").textContent = help;
  $("mappingHelp").hidden = !help;
  const unsupported = connected ? mappingUnsupported() : "";
  $("mappingCompatibility").hidden = !unsupported;
  $("mappingCompatibility").textContent = unsupported;
  renderPicker();
  controls();
}
function renderBinding() {
  $("bindingTitle").textContent = `${mappedInputLabel(selected)} → 출력`;
  const b = inputBinding(selected, profile?.bindings) ?? { kind: 0, code: 0, modifiers: 0 };
  const bit = b.kind === 1 ? modifierBit(b.code) : 0;
  bindingDraft = b.kind === 7
    ? { kind: 7, codes: [Math.sign(b.code) * (b.modifiers ? 2 : 1)], modifiers: 0, speed: Math.abs(b.code), accel: b.accel ?? 0 }
    : {
      kind: b.kind === 6 ? 1 : b.kind,
      codes: b.kind === 6 ? [...b.keys] : b.code && !bit ? [b.code] : [],
      modifiers: b.modifiers | bit,
    };
  setMappingFeedback();
  renderMappingPreview();
}
for (const button of $("pointerAccel").querySelectorAll("button")) button.onclick = () => {
  if (bindingDraft.kind !== 7 || mappingBlocked()) return;
  bindingDraft = { ...bindingDraft, accel: Number(button.dataset.accel) };
  renderMappingPreview();
};
$("pointerSpeed").oninput = () => {
  const speed = Number($("pointerSpeed").value);
  if (bindingDraft.kind !== 7 || !Number.isInteger(speed) || speed < 1 || speed > 4000) return;
  bindingDraft = { ...bindingDraft, speed };
  renderMappingPreview();
};
for (const button of bindingModes) button.onclick = () => {
  const kind = Number(button.dataset.bindingMode);
  if (mappingBlocked() || kind === mappingMode(bindingDraft.kind)) return;
  bindingDraft = emptyBinding(kind);
  setMappingFeedback();
  renderMappingPreview();
};
function renderBoard() {
  for (const input of INPUTS) {
    const b = $(`key-${input.id}`);
    const inGroup = activeTab === "performance" && selectedHall.has(input.id);
    const highlighted = activeTab === "performance" ? inGroup : input.id === selected;
    b.classList.toggle("selected", highlighted);
    b.classList.toggle("multi-selected", inGroup && selectedHall.size > 1);
    b.classList.toggle("selection-primary", inGroup && input.id === selected);
    b.setAttribute("aria-pressed", String(highlighted));
    const label = mappedInputLabel(input.id);
    b.title = label;
    b.querySelector(".name").textContent = inputKeycapLabel(input.id, profile?.bindings);
    b.setAttribute("aria-label", label);
  }
  renderMappingSource();
  const calibrated = profile?.keys.filter((k) => k.flags & 4).length ?? 0;
  $("calProgress").textContent = `보정 ${calibrated} / 14`;
  renderCalibrationNeeded();
}
function renderCalibrationNeeded() {
  const missing = connected ? uncalibratedHall() : [];
  $("calBadge").hidden = !missing.length;
  $("calBadge").textContent = missing.length ? String(missing.length) : "";
  $("calBadge").title = missing.length ? `보정 안 된 키 ${missing.length}개` : "";
  $("calibrationNeeded").hidden = !missing.length;
  if (!missing.length) return;
  $("calibrationNeededTitle").textContent = missing.length === 14
    ? "아직 캘리브레이션하지 않은 키보드입니다"
    : `보정되지 않은 키 ${missing.length}개`;
  $("calibrationNeededKeys").textContent = missing.length === 14
    ? "키가 정확히 눌리려면 처음 한 번 보정이 필요합니다. 아래 순서대로 보정한 뒤 ‘키보드에 저장’을 누르세요."
    : `${missing.map((id) => inputKeycapLabel(id, profile?.bindings)).join(" · ")} — 아래 순서대로 보정한 뒤 ‘키보드에 저장’을 누르세요.`;
}
function renderMappingSource() {
  $("mappingSource").textContent = profile
    ? connected ? "현재 키보드 매핑" : "마지막으로 읽은 매핑 · 연결 끊김"
    : "기본 배치 미리보기";
}
function renderSelection() {
  const count = performanceTargets().length;
  $("selectionLabel").textContent = activeTab === "performance" && count !== 1
    ? `${count}개 Hall 키 선택` : mappedInputLabel(selected);
  $("performanceSelectionCount").textContent = `${count}개 선택`;
  $("selectionType").textContent = hall()
    ? "Hall"
    : selected >= 20
      ? "회전 방향"
      : INPUTS[selected].type === "knob"
        ? "노브 클릭"
        : "일반 스위치";
  document.querySelectorAll(".hall-only").forEach((e) => (e.hidden = !hall()));
  document
    .querySelectorAll(".non-hall-message")
    .forEach((e) => (e.hidden = hall()));
  renderBoard();
  renderBinding();
  renderKey();
  renderNoiseSettings();
  renderCalibration();
  renderDiagnostics();
  renderAdcWindows();
  renderMeasurement();
  renderBatch();
  for (let side = 0; side < latest.length; side++) renderPressedKeys(side);
}
function renderKey() {
  performanceDirty.clear();
  const lowerSupported = !!(info?.capabilities & CAP_BOTTOM_DEADZONE);
  $("bottomDeadzoneCompatibility").hidden = !connected || lowerSupported;
  $("bottomDeadzoneCompatibility").textContent = "하단 데드존은 펌웨어 v0.3.4부터 지원합니다.";
  $("curveCompatibility").hidden = !connected || !!(info?.capabilities & CAP_HALL_CURVE);
  $("curveCompatibility").textContent = "현재 기기는 선형 보정입니다. 비선형 곡선은 펌웨어 v0.3.5부터 적용할 수 있습니다.";
  $("retriggerCompatibility").hidden = !connected || !!(info?.capabilities & CAP_RETRIGGER_BEFORE_RELEASE);
  $("retriggerCompatibility").textContent = "미해제 재입력은 C86 펌웨어 v0.3.37 이상에서 지원합니다.";
  if (!hall()) return;
  const total = travelMm[selected];
  const targets = performanceTargets(),
    sameTravel = targets.every((id) => travelMm[id] === total);
  $("totalTravel").value = sameTravel ? total.toFixed(2) : "";
  $("totalTravel").placeholder = sameTravel ? "" : "혼합";
  $("travelPreset").value = String(total);
  if (!sameTravel || $("travelPreset").selectedIndex < 0) $("travelPreset").value = "";
  const k = profile?.keys[selected];
  $("keyTitle").textContent = `${mappedInputLabel(selected)} 캘리브레이션`;
  if (!k) {
    $("endpoints").textContent = "키보드를 연결하세요.";
    return;
  }
  $("enabled").checked = !!(k.flags & 1);
  $("rt").checked = !!(k.flags & 2);
  $("retrigger").checked = !!(k.flags & 8);
  $("enabled").indeterminate = targets.some((id) => !!(profile.keys[id].flags & 1) !== !!(k.flags & 1));
  $("rt").indeterminate = targets.some((id) => !!(profile.keys[id].flags & 2) !== !!(k.flags & 2));
  $("retrigger").indeterminate = targets.some((id) => !!(profile.keys[id].flags & 8) !== !!(k.flags & 8));
  const sameCurve = targets.every((id) => (profile.keys[id].curve_id ?? 0) === (k.curve_id ?? 0));
  $("curveId").value = sameCurve ? String(k.curve_id ?? 0) : "";
  let hasMixed = $("enabled").indeterminate || $("rt").indeterminate || $("retrigger").indeterminate || !sameTravel || !sameCurve;
  for (const [id, field] of Object.entries(keyFields)) {
    const limit = Math.min(...(targets.length ? targets : [selected]).map((key) => travelMm[key]));
    const valueFor = (key) => normalizedToMm(profile.keys[key][field] ?? 0, travelMm[key]).toFixed(3);
    const mixed = targets.some((key) => valueFor(key) !== valueFor(selected));
    hasMixed ||= mixed;
    $(id).max = String(limit);
    $(id).value = mixed ? "" : valueFor(selected);
    $(id).placeholder = mixed ? "혼합" : "";
    $(id).required = !mixed;
    $(id).classList.toggle("mixed-value", mixed);
    if ($(id + "Range")) {
      $(id + "Range").max = String(limit);
      $(id + "Range").value = mixed ? valueFor(selected) : $(id).value;
      $(id + "Range").setAttribute("aria-valuetext", mixed ? "혼합 — 변경하면 선택한 키에 적용" : `${$(id).value} mm`);
    }
  }
  $("performanceSelectionHelp").textContent = hasMixed
    ? "혼합 값 · 변경한 항목만 적용합니다." : "변경한 항목만 선택한 키에 적용합니다.";
  $("performanceSelectionHelp").hidden = !hasMixed;
  const calibrated = !!(k.flags & 4),
    span = Math.abs(k.pressed - k.released);
  $("endpoints").textContent =
    `${calibrated ? "보정됨" : "미보정"} · 놓음 ADC ${k.released} / 누름 ADC ${k.pressed} · 총 이동거리 ${total.toFixed(2)} mm`;
  $("performanceGate").textContent = !targets.length ? "키를 선택하세요."
    : targets.some((id) => !(profile.keys[id].flags & 4)) ? "미보정 키 포함" : "";
  $("applyKey").textContent = targets.length > 1 ? `${targets.length}개 키에 적용` : "선택 키에 적용";
  // 0.3.43+ stores 1/10000 of the stroke; older firmware 1/1000 (input rounds to it).
  const fine = !connected || !!(info?.capabilities & CAP_FINE_TRAVEL);
  const step = fine ? `내부 설정 1단계 ≈ ${fmt(total / TRAVEL_MAX, 5)} mm`
    : `현재 펌웨어 설정 1단계 ≈ ${fmt(total / 1000, 4)} mm (0.001 mm 입력은 펌웨어 v0.3.43부터 그대로 저장, 지금은 이 단위로 반올림)`;
  $("quantization").textContent = calibrated
    ? k.curve_id
      ? `${step} · Owlab Ti HE 근사곡선 · ADC당 이동량은 위치별로 다릅니다.`
      : `${step} · 현재 보정 기준 ADC 1단계 ≈ ${fmt(total / span, 4)} mm (선형 추정, 판정은 이 단위로 움직입니다)`
    : "거리 기반 설정은 캘리브레이션 후 적용할 수 있습니다.";
  renderTravel();
  controls();
}
function renderTravel() {
  if (!hall()) return;
  const s = latest[INPUTS[selected].side],
    idx = selected % 7,
    k = profile?.keys[selected];
  // Apply display endpoints for older STATUS implementations too. Preserve
  // the received samples and the independent raw ADC diagnostics.
  const mm = s?.fresh && (k?.flags & 4)
    ? recognizedTravelToMm(s.travel[idx], k, travelMm[selected])
    : null;
  $("liveTravel").textContent = mm === null ? "— mm" : `${fmt(mm, 3)} mm`;
  $("liveRaw").textContent =
    `ADC ${s?.fresh ? s.raw[idx] : "—"}${k && !(k.flags & 4) ? " · 미보정" : ""}`;
  $("travelFill").style.height =
    `${mm === null ? 0 : (mm / travelMm[selected]) * 100}%`;
  $("actuationLine").style.top =
    `${Math.min(100, (Number($("actuation").value) / travelMm[selected]) * 100)}%`;
  $("actuationLine").hidden = $("actuation").value === "";
  $("deadzoneBand").style.height =
    `${Math.min(100, (Number($("topDeadzone").value) / travelMm[selected]) * 100)}%`;
  $("bottomDeadzoneBand").style.height =
    `${Math.min(100, (Number($("bottomDeadzone").value) / travelMm[selected]) * 100)}%`;
}
function markPerformanceDirty(id) {
  performanceDirty.add(id);
  $(id).classList.remove("mixed-value");
  if ($(id).type === "number") $(id).required = true;
  controls();
}
for (const id of ["actuation", "rtPress", "rtRelease", "topDeadzone", "bottomDeadzone"]) {
  $(id).oninput = () => {
    markPerformanceDirty(id);
    $(id + "Range").value = $(id).value;
    renderTravel();
  };
  $(id + "Range").oninput = () => {
    $(id).value = Number($(id + "Range").value).toFixed(3);
    $(id + "Range").setAttribute("aria-valuetext", `${$(id).value} mm`);
    markPerformanceDirty(id);
    renderTravel();
  };
}
function renderNoiseSettings() {
  const ids = hall() ? noiseTargets($("noiseScope").value, selected) : [];
  const targetKey = ids.join(",");
  if (targetKey !== noiseTargetKey) noiseDirty = false;
  noiseTargetKey = targetKey;
  if (!profile || !ids.length) {
    $("noiseApplied").textContent = "키보드를 연결하고 Hall 키를 선택하세요.";
    return;
  }
  const values = ids.map((id) => profile.keys[id].noise_deadband);
  const same = values.every((value) => value === values[0]);
  if (!noiseDirty) {
    $("noise").value = same ? String(values[0]) : "";
    $("noise").placeholder = same ? "" : "혼합";
  }
  $("noiseApplied").textContent = `${ids.length === 1 ? mappedInputLabel(ids[0]) : `${ids.length}개 Hall 키`} · 현재 ${same ? `${values[0]} ADC` : `${Math.min(...values)}–${Math.max(...values)} ADC (혼합)`}`;
}
$("noise").oninput = () => { noiseDirty = true; controls(); };
$("noiseScope").onchange = () => { noiseDirty = false; renderNoiseSettings(); controls(); };
$("applyNoise").onclick = () => {
  if ($("applyNoise").disabled) return;
  action(async () => {
    const ids = noiseTargets($("noiseScope").value, selected);
    const candidates = proposeNoiseSettings(profile, ids, Number($("noise").value));
    const outcome = await applyPerformanceSettings(client, profile, candidates);
    if (outcome.profile) profile = outcome.profile;
    if (outcome.complete) noiseDirty = false;
    telemetry.clear(); adcComparison = [];
    measure.reset(); renderMeasurement();
    renderNoiseSettings();
    if (!outcome.complete) throw Error(outcome.error || "노이즈 설정의 적용값을 확인하지 못했습니다.");
    log(`${ids.length}개 키 노이즈 설정 RAM 적용 확인 · 영구 저장은 별도입니다.`);
  });
};
$("curveId").onchange = () => markPerformanceDirty("curveId");
function changeTravel(value, all = false) {
  try {
    if (!hall() || measuring() || busy || batchActive()) return;
    const pendingDraft = [...performanceDirty].map((id) => ({
      id, value: $(id).value, checked: $(id).checked,
    }));
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0.1 || n > 10)
      throw Error("전체 스트로크는 0.10–10.00 mm로 입력하세요.");
    const mm = Math.round(n * 100) / 100;
    if (all) travelMm.fill(mm);
    else for (const id of performanceTargets()) travelMm[id] = mm;
    savePreferences();
    measure.reset();
    renderMeasurement();
    renderKey();
    for (const field of pendingDraft) {
      $(field.id).value = field.value;
      if ($(field.id).type === "checkbox") {
        $(field.id).checked = field.checked;
        $(field.id).indeterminate = false;
      }
      if ($(field.id + "Range")) $(field.id + "Range").value = field.value;
      markPerformanceDirty(field.id);
    }
    renderTravel();
    log(
      `${all ? 14 : performanceTargets().length}개 키 이동거리: ${mm.toFixed(2)} mm`,
    );
  } catch (e) {
    log(e.message, true);
    renderKey();
  }
}
$("travelPreset").onchange = () => {
  if ($("travelPreset").value) changeTravel($("travelPreset").value);
};
$("totalTravel").onchange = () => changeTravel($("totalTravel").value);
$("applyTravel").onclick = () => changeTravel($("totalTravel").value);
$("applyTravelAll").onclick = () => changeTravel($("totalTravel").value, true);
$("owlabPreset").onclick = () => {
  if ($("owlabPreset").disabled) return;
  changeTravel(OWLAB_TI_TRAVEL_MM);
  $("curveId").value = "1";
  markPerformanceDirty("curveId");
  log("Owlab Ti HE 3.4 mm 기준을 선택했습니다. ‘선택 키에 적용’으로 곡선을 적용하세요.");
};
function controls() {
  renderMappingSource();
  renderProfiles();
  const mutable =
    connected &&
    !busy &&
    !measuring() &&
    !calibrationActive() &&
    !batchActive();
  const calibrationAllowed =
    connected && !busy && !measuring() && !batchActive();
  $("adcTuning").hidden = !adcTuningSupported();
  $("readRightAdc").hidden = !adcTuningSupported() || !(info?.capabilities & CAP_ADC_PAIR_READ);
  $("readRightAdc").disabled = !mutable || !latest[0] || latest[0].output_enabled || !latest[1]?.fresh;
  $("adcCompareOption").hidden = !adcTuningSupported() || selected >= 7;
  $("adcCompareLegend").hidden = !comparingAdc();
  $("applyAdcTuning").disabled = !mutable || !adcPairSupported() || !latest[0] || !latest[1]?.fresh;
  $("applyAdcTuning").title = !adcPairSupported() ? "좌우 설정을 지원하는 펌웨어가 필요합니다." :
    !latest[1]?.fresh ? "오른쪽 키보드 연결이 필요합니다." : "";
  $("noise").disabled = $("noiseScope").disabled = !mutable || !hall();
  $("curveEditor").hidden = !curveSupported();
  const curveEditable = mutable && hall() && curveSupported() && !!deviceCurve && !!profile;
  curveEditor.setEnabled(curveEditable);
  for (const id of ["curveKind", "curveScope", "curvePresetLinear", "curvePresetOwlab"]) $(id).disabled = !curveEditable;
  $("curvePresetDevice").disabled = !curveEditable || !curveEditor.dirty();
  const pendingCurve = curveEditable ? curveChanges() : null;
  $("applyCurve").disabled = !pendingCurve || (!pendingCurve.writeTable && !pendingCurve.keys.length);
  $("applyNoise").disabled = !mutable || !hall() || !noiseDirty || !$("noise").value.trim() || !$("noise").checkValidity();
  for (const id of ["outputOff", "save", "refresh", "export", "import"])
    $(id).disabled = !mutable;
  $("outputOn").disabled =
    !mutable ||
    !profile ||
    profile.keys.some((k) => k.flags & 1 && !(k.flags & 4));
  $("applyBinding").disabled = !mutable || !mappingReady() || !!mappingUnsupported();
  if (pickerLocked !== mappingBlocked()) renderPicker();
  $("applyKey").disabled =
    !mutable ||
    !hall() ||
    !performanceTargets().length ||
    !performanceDirty.size ||
    performanceTargets().some((id) => !(profile?.keys[id].flags & 4) &&
      (performanceDirty.has("enabled") ? $("enabled").checked : !!(profile?.keys[id].flags & 1)));
  $("rest").disabled = !mutable || !hall();
  $("cancelCal").disabled = !calibrationAllowed || !hall();
  $("disconnect").disabled = !client || busy;
  $("connect").disabled = !!client || busy || firmwareTab.active();
  const cal = latest[INPUTS[selected].side];
  $("pressed").disabled =
    !calibrationAllowed ||
    !hall() ||
    cal?.calibration_key !== selected ||
    cal?.calibration_state !== 2;
  $("commit").disabled =
    !calibrationAllowed ||
    !hall() ||
    cal?.calibration_key !== selected ||
    cal?.calibration_state !== 4;
  for (const id of [
    "enabled",
    "rt",
    "actuation",
    "rtPress",
    "rtRelease",
    "topDeadzone",
    "bottomDeadzone",
    "actuationRange",
    "rtPressRange",
    "rtReleaseRange",
    "topDeadzoneRange",
    "bottomDeadzoneRange",
    "travelPreset",
    "totalTravel",
    "applyTravel",
    "applyTravelAll",
  ])
    $(id).disabled = busy || measuring() || batchActive();
  for (const id of ["multiSelectHall", "selectAllHall", "selectLeftHall", "selectRightHall", "clearHallSelection"])
    $(id).disabled = busy || measuring() || calibrationActive() || batchActive();
  $("bottomDeadzone").disabled = $("bottomDeadzoneRange").disabled =
    busy || measuring() || batchActive() || !(info?.capabilities & CAP_BOTTOM_DEADZONE);
  $("curveId").disabled = $("owlabPreset").disabled =
    !mutable || !hall() || !(info?.capabilities & CAP_HALL_CURVE);
  $("retrigger").disabled = !mutable || !hall() || !(info?.capabilities & CAP_RETRIGGER_BEFORE_RELEASE);
  $("nextKey").disabled = busy || measuring() || calibrationActive();
  document
    .querySelectorAll(".key")
    .forEach((b) => (b.disabled = busy || measuring() || calibrationActive()));
  $("baseline").disabled =
    !mutable ||
    !hall() ||
    !latest.every((s) => s?.fresh) ||
    latest.some((s) => s?.calibration_state);
  $("measurePress").disabled = !connected || busy || measure.state !== "ready";
  $("cancelMeasure").disabled = busy || measure.state === "idle";
  $("rtPress").disabled =
    $("rtPressRange").disabled =
    $("rtRelease").disabled =
    $("rtReleaseRange").disabled =
      busy || measuring() || batchActive() || (!$("rt").checked && !$("rt").indeterminate);
  $("batchStart").disabled =
    !connected ||
    busy ||
    measuring() ||
    calibrationActive() ||
    batchActive() ||
    !latest.every((s) => s?.fresh);
  const canApplyBatch =
    connected && !busy && batch.state === "press" && batch.eligibleCount > 0;
  $("batchApply").disabled = $("batchQuickApply").disabled = !canApplyBatch;
  $("batchCancel").disabled = $("batchQuickCancel").disabled =
    busy || batch.state === "idle";
  document.body.classList.toggle("measuring", measuring());
  rhythm?.updateContext();
  autoFit?.updateContext();
}
$("rt").onchange = () => markPerformanceDirty("rt");
$("retrigger").onchange = () => markPerformanceDirty("retrigger");
$("enabled").onchange = () => markPerformanceDirty("enabled");
function renderCalibration() {
  if (!hall()) return;
  const s = latest[INPUTS[selected].side],
    state = s?.calibration_key === selected ? s.calibration_state : 0;
  const messages = [
    "보정 대기",
    "놓은 위치에서 안정된 256개 샘플 수집 중…",
    "놓은 위치 완료. 키를 끝까지 누른 채 ②를 누르세요.",
    "누른 위치에서 안정된 256개 샘플 수집 중…",
    "수집 완료. ③ 보정 적용을 누르세요.",
  ];
  $("calState").textContent = messages[state] ?? "알 수 없는 보정 상태";
  $("stepRest").classList.toggle("active", state < 2);
  $("stepPressed").classList.toggle("active", state === 2 || state === 3);
  $("stepCommit").classList.toggle("active", state === 4);
  if (
    calStage &&
    calStage.key === selected &&
    state === 0 &&
    performance.now() - calStage.started > 5500
  ) {
    log(
      "보정 수집이 끝나지 않았습니다. 키를 고정한 뒤 놓은 위치부터 다시 수집하세요.",
      true,
    );
    calStage = null;
  }
}
function clearTelemetry() {
  batch.reset();
  batchOriginal = null;
  batchOutcome = null;
  latest = [null, null];
  telemetry.clear();
  adcComparison = [];
  adcApplied = [null, null];
  renderAdcWindows();
  measure.reset();
  drawnMeasurement = null;
  calStage = null;
  for (const i of INPUTS) {
    const b = $(`key-${i.id}`);
    b.classList.remove("pressed");
    b.style.boxShadow = "";
    b.querySelector(".raw").textContent = "—";
    b.querySelector(".bar").style.width = "0%";
    b.querySelector(".travel").textContent =
      i.id < 14
        ? "연결 없음"
        : i.direction === "click"
          ? "클릭"
          : i.type === "digital"
            ? "MX"
            : "";
  }
  $("outputState").textContent = "출력 꺼짐";
  $("outputState").classList.remove("on");
  $("leftFresh").textContent = $("rightFresh").textContent = "연결 대기";
  $("linkStatus").textContent = "센서 데이터 없음";
  $("dirty").textContent = "장치 연결 대기";
  renderTravel();
  renderMeasurement();
  renderDiagnostics();
  renderBatch();
}
function infoView(data) {
  info = data;
  installedFirmware = `${data.major}.${data.minor}.${data.patch}`;
  firmwareTab.render();
  showFirmwareRelease(data);
  $("generation").textContent = data.generation;
  $("deviceName").textContent = `C${data.board_rev} Split Hall`;
  $("mode").textContent = `연결됨 · v${data.major}.${data.minor}.${data.patch}`;
  $("timing").textContent =
    `USB ${data.usb_interval_us} µs · 스캔 목표 ${data.scan_target_hz.toLocaleString()} Hz`;
}
let studioRelease;
async function showFirmwareRelease(data) {
  $("releaseNotice").hidden = true;
  if (data.board_rev !== 86 || !(data.capabilities & 0x40)) return;
  studioRelease ??= fetchStudioRelease().catch(() => { studioRelease = undefined; });
  const release = await studioRelease;
  const installed = firmwareVersionNumber(data.major, data.minor, data.patch);
  if (!client || info !== data || !release || installed === null) return;
  const latest = release.firmware.left;
  $("releaseVersion").textContent = latest.versionNumber > installed
    ? `좌우 펌웨어 업데이트 v${latest.version} 사용 가능`
    : `좌우 정식 펌웨어 v${latest.version}`;
  $("releaseNotice").hidden = false;
}
async function refresh() {
  profile = await client.getConfig();
  infoView(await client.info());
  await loadProfiles();
  if (adcTuningSupported()) showAdcTuning(await client.adcTuning());
  await loadDeviceCurve();
  renderSelection();
}
// Firmware 0.4.0+ on-device profiles: sidebar switcher and the 프로필 tab.
const profilesSupported = () => !!(info?.capabilities & CAP_PROFILES);
async function loadProfiles() {
  profileState = profilesSupported() ? await client.profiles() : null;
  renderProfiles();
}
// Rebuilt only when the profile state changes, so a name being typed survives
// the frequent controls() refreshes; otherwise only enabled states update.
let profileRendered = "", profileControls = [];
function renderProfiles() {
  const state = profileState;
  const mutable = connected && !busy && !measuring() && !calibrationActive() && !batchActive();
  const key = JSON.stringify([state, connected, profilesSupported()]);
  if (key !== profileRendered) {
    profileRendered = key;
    buildProfiles(state);
  }
  for (const update of profileControls) update(mutable);
}
function buildProfiles(state) {
  $("profileSwitch").hidden = !state;
  $("profileUnsupported").hidden = !connected || profilesSupported();
  $("profileSummary").textContent = state ? `${profileLabel(state.active, state.names[state.active])} 사용 중 · ${state.used.length} / ${PROFILE_COUNT}` : "—";
  const buttons = $("profileButtons"), list = $("profileList");
  buttons.replaceChildren();
  list.replaceChildren();
  profileControls = [];
  if (!state) return;
  const control = (el, blocked = () => false) => {
    profileControls.push((mutable) => { el.disabled = !mutable || blocked(); });
    return el;
  };
  for (let i = 0; i < state.count; i++) {
    const used = state.used.includes(i), active = state.active === i, label = profileLabel(i, state.names[i]);
    const b = document.createElement("button");
    b.type = "button";
    b.className = used ? "ghost" : "ghost empty";
    b.dataset.profile = String(i);
    b.textContent = used ? (state.names[i] || String(i + 1)) : "+";
    b.title = used ? (active ? `${label} 사용 중` : `${label}로 전환`) : `프로필 ${i + 1} 만들기 (현재 프로필 복사)`;
    b.setAttribute("aria-label", b.title);
    b.setAttribute("aria-pressed", String(active));
    b.onclick = () => (used ? switchProfile(i) : createProfile(i));
    buttons.append(control(b, () => active));

    const row = document.createElement("div");
    row.className = active ? "profile-row active" : "profile-row";
    row.dataset.profileRow = String(i);
    const badge = document.createElement("b");
    badge.textContent = String(i + 1);
    const actions = document.createElement("div");
    actions.className = "actions";
    const button = (text, cls, handler, blocked) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = cls;
      el.textContent = text;
      el.onclick = handler;
      actions.append(control(el, blocked));
      return el;
    };
    if (used) {
      const input = document.createElement("input");
      input.type = "text";
      input.value = state.names[i];
      input.placeholder = `프로필 ${i + 1}`;
      input.setAttribute("aria-label", `프로필 ${i + 1} 이름`);
      control(input);
      const rename = button("이름 바꾸기", "secondary", () => renameProfile(i, input.value), () => input.value === state.names[i]);
      input.oninput = () => { rename.disabled = busy || !connected || input.value === state.names[i]; };
      input.onkeydown = (e) => { if (e.key === "Enter" && !rename.disabled) rename.click(); };
      button(active ? "사용 중" : "이 프로필 사용", active ? "secondary" : "", () => switchProfile(i), () => active);
      button("삭제", "ghost", () => deleteProfile(i), () => active);
      row.append(badge, input, actions);
    } else {
      const empty = document.createElement("span");
      empty.className = "empty-label";
      empty.textContent = "비어 있음";
      button(`만들기 · ${profileLabel(state.active, state.names[state.active])} 복사`, "secondary", () => createProfile(i), () => false);
      row.append(badge, empty, actions);
    }
    list.append(row);
  }
}
function switchProfile(index) {
  action(async () => {
    profileState = { ...profileState, ...(await client.selectProfile(index)) };
    await refresh();
  }, `${profileLabel(index, profileState?.names[index])}로 전환했습니다. 유지하려면 ‘키보드에 저장’을 누르세요.`);
}
function createProfile(index) {
  const source = profileState.active;
  action(async () => {
    await client.createProfile(index, source);
    await client.selectProfile(index);
    await refresh();
  }, `프로필 ${index + 1}을 ${profileLabel(source, profileState.names[source])} 설정으로 만들고 전환했습니다. 유지하려면 ‘키보드에 저장’을 누르세요.`);
}
function deleteProfile(index) {
  const label = profileLabel(index, profileState.names[index]);
  if (!confirm(`${label}을 삭제할까요? 저장하기 전에는 연결을 다시 하면 되돌릴 수 있습니다.`)) return;
  action(async () => {
    await client.deleteProfile(index);
    await loadProfiles();
  }, `${label}을 삭제했습니다. 유지하려면 ‘키보드에 저장’을 누르세요.`);
}
function renameProfile(index, name) {
  try { encodeProfileName(name.trim()); } catch (e) { log(e.message, true); return; }
  action(async () => {
    await client.renameProfile(index, name.trim());
    await loadProfiles();
  }, `프로필 ${index + 1} 이름을 바꿨습니다. 유지하려면 ‘키보드에 저장’을 누르세요.`);
}
async function loadDeviceCurve() {
  if (!curveSupported()) {
    deviceCurve = null;
    setActiveCustomCurve(CUSTOM_CURVE_IDENTITY);
    curveEditor.setDevice(null);
    return;
  }
  deviceCurve = setActiveCustomCurve(await client.customCurve());
  curveEditor.setDevice(deviceCurve);
  if (!curveDrawn) curveEditor.setDraft(deviceCurve);
}
const curveEditor = mountCurveEditor($("curveCanvas"), {
  onDraw() { curveDrawn = true; $("curveKind").value = String(HALL_CURVE_CUSTOM); curveKindTouched = true; controls(); },
  onHover(point) {
    if (!point) { renderCurveReadout(); return; }
    const codes = point.codes === null ? "" : ` · 쉼 위 ${point.codes} 코드`;
    $("curveReadout").textContent = `신호 ${(point.signal / 100).toFixed(1)}%${codes} → ` +
      point.names.map((name, i) => `${name} ${point.mm[i].toFixed(3)} mm`).join(" · ");
  },
});
function curveTargets() {
  return hall() && profile ? noiseTargets($("curveScope").value, selected) : [];
}
function renderCurveReadout() {
  const key = profile?.keys[selected];
  if (!curveSupported()) { $("curveReadout").textContent = "커스텀 곡선은 펌웨어 0.3.46 이상에서 사용할 수 있습니다."; return; }
  if (!key || !hall()) { $("curveReadout").textContent = "Hall 키를 선택하세요."; return; }
  const names = ["직선", "Owlab Ti 근사", "커스텀"];
  $("curveReadout").textContent = `${mappedInputLabel(selected)} · 현재 곡선 ${names[key.curve_id ?? 0]}` +
    (key.flags & 4 ? ` · 보정 범위 ${Math.abs(key.pressed - key.released)} 코드` : " · 보정 전 (가로축 코드 미표시)") +
    " · 그래프 위에 마우스를 올리면 값을 보여 줍니다.";
}
function renderCurveEditor() {
  if (activeTab !== "diagnostics" || $("curveEditor").hidden) return;
  const key = hall() ? profile?.keys[selected] : null;
  if (key && !curveKindTouched) $("curveKind").value = String(key.curve_id ?? 0);
  const calibrated = !!(key && key.flags & 4);
  const span = calibrated ? Math.abs(key.pressed - key.released) : null;
  const status = hall() ? latest[INPUTS[selected].side] : null;
  const statusRaw = status?.fresh ? status.raw[selected % 7] : null;
  const compare = curveLive && curveLive.key === selected && performance.now() - curveLive.time < 1000 ? curveLive : null;
  const sign = calibrated ? Math.sign(key.pressed - key.released) : 0;
  const signal = (code) => calibrated && Number.isFinite(code) ? ((code - key.released) * sign / span) * 10000 : null;
  const raw = compare && selected < 7 ? compare.before : statusRaw;
  curveEditor.setContext({ travelMm: hall() ? travelMm[selected] : 4, span,
    keyCurveId: key?.curve_id ?? 0, actuation: key ? key.actuation : null,
    live: { raw: signal(raw), average: compare ? signal(compare.after) : null, decision: compare ? signal(compare.decision) : null } });
  renderCurveLive(key, raw, compare);
  if (!$("curveReadout").dataset.hover) renderCurveReadout();
}
function renderCurveLive(key, raw, compare) {
  const out = $("curveLive");
  if (!key || !hall() || !Number.isFinite(raw)) { out.textContent = "센서값을 기다립니다."; return; }
  const right = selected >= 7, names = ["직선", "Owlab Ti 근사", "커스텀"];
  const parts = [`raw ADC ${raw}${right ? " (오른쪽 보드가 평균 후 전송)" : ""}`];
  if (compare) {
    if (!right) parts.push(`이동평균(${compare.window === 1 ? "Raw" : `${compare.window}스캔`}) ${compare.after}`);
    let judged = "";
    if (key.flags & 4) {
      const travel = rawToTravel(compare.decision, key, deviceCurve ?? CUSTOM_CURVE_IDENTITY);
      judged = ` → ${normalizedToMm(travel, travelMm[selected]).toFixed(3)} mm (${names[key.curve_id ?? 0]})`;
    }
    parts.push(`판정값(노이즈 데드밴드 ${key.noise_deadband}) ${compare.decision}${judged}`);
  } else if (!adcTuningSupported()) {
    parts.push("평균·판정값은 ADC 설정을 지원하는 펌웨어에서 표시됩니다.");
  } else if (right && compareRightUnsupported) {
    parts.push("오른쪽 키의 판정값은 펌웨어 0.3.47 이상에서 표시됩니다.");
  } else {
    parts.push("판정값을 읽는 중…");
  }
  out.textContent = parts.join(" · ");
}
$("curveCanvas").addEventListener("pointerenter", () => { $("curveReadout").dataset.hover = "1"; });
$("curveCanvas").addEventListener("pointerleave", () => { delete $("curveReadout").dataset.hover; renderCurveReadout(); });
$("curveKind").onchange = () => { curveKindTouched = true; controls(); };
$("curveScope").onchange = () => controls();
$("curvePresetDevice").onclick = () => { if (deviceCurve) { curveEditor.setDraft(deviceCurve); curveDrawn = false; controls(); } };
$("curvePresetLinear").onclick = () => { curveEditor.setDraft(curveAsCustomTable(HALL_CURVE_LINEAR)); curveDrawn = true; $("curveKind").value = "2"; curveKindTouched = true; controls(); };
$("curvePresetOwlab").onclick = () => { curveEditor.setDraft(curveAsCustomTable(HALL_CURVE_OWLAB_TI)); curveDrawn = true; $("curveKind").value = "2"; curveKindTouched = true; controls(); };
function curveChanges() {
  const kind = Number($("curveKind").value);
  const writeTable = kind === HALL_CURVE_CUSTOM && curveEditor.dirty();
  const keys = curveTargets().filter((id) => (profile.keys[id].curve_id ?? 0) !== kind);
  return { kind, writeTable, keys };
}
$("applyCurve").onclick = () => {
  if ($("applyCurve").disabled) return;
  action(async () => {
    const { kind, writeTable, keys } = curveChanges();
    if (writeTable) {
      if (await client.output(false) !== false) throw Error("키 출력 해제를 확인하지 못했습니다.");
      deviceCurve = setActiveCustomCurve(await client.setCustomCurve(curveEditor.draft()));
      curveEditor.setDevice(deviceCurve);
      curveDrawn = false;
    }
    if (keys.length) {
      const candidates = keys.map((id) => keyRecord({ ...profile.keys[id], curve_id: kind }));
      const outcome = await applyPerformanceSettings(client, profile, candidates);
      if (outcome.profile) profile = outcome.profile;
      if (!outcome.complete) throw Error(outcome.error || "곡선 설정의 적용값을 확인하지 못했습니다.");
    }
    curveKindTouched = false;
    telemetry.clear(); adcComparison = [];
    measure.reset(); renderMeasurement();
    renderSelection();
    const names = ["직선", "Owlab Ti 근사", "커스텀"];
    log(`${writeTable ? "커스텀 곡선 표를 바꾸고 " : ""}${keys.length}개 키를 ${names[kind]} 곡선으로 RAM 적용 확인 · 영구 저장은 별도입니다.`);
  });
};
const adcWindowLabel = (window) => window === 1 ? "Raw" : `${window}프레임`;
function renderAdcWindows() {
  const rows = CONTROLS.filter((control) => control.type === "hall" && control.side === 0).map((control, key) => {
    const row = document.createElement("tr");
    const label = document.createElement("th");
    label.scope = "row";
    label.textContent = `Hall ${key + 1}`;
    row.append(label);
    for (const [side, state] of adcApplied.entries()) {
      const cell = document.createElement("td");
      // Firmware through v0.3.35 reported zero for the mixed boot profile.
      const id = side * 7 + key;
      cell.textContent = `${inputBindingLabel(id, profile?.bindings)} · ${state ? adcWindowLabel(state.window || (key === 4 ? 8 : 1)) : "미확인"}`;
      cell.title = mappedInputLabel(id);
      row.append(cell);
    }
    return row;
  });
  $("adcWindowsByKey").replaceChildren(...rows);
}
function showAdcTuning(state, paired = false) {
  const { rate, window } = state;
  adcApplied[0] = state;
  if (paired) adcApplied[1] = state;
  $("adcScanRate").value = String(rate);
  $("adcWindow").value = String(window || 1);
  $("adcTuningResult").textContent = `${paired ? "좌우 마지막 적용" : "왼쪽"} · ${rate / 1000} kHz${window ? ` · ${adcWindowLabel(window)}` : ""}`;
  renderAdcWindows();
}
$("readRightAdc").onclick = () => action(async () => {
  adcApplied[1] = null;
  renderAdcWindows();
  adcApplied[1] = await client.adcTuning(undefined, undefined, { paired: true });
  renderAdcWindows();
}, "오른쪽 ADC 적용값 확인 완료");
$("applyAdcTuning").onclick = () => action(async () => {
  let applied;
  try {
    if (await client.output(false) !== false) throw Error("키 출력 해제를 확인하지 못했습니다.");
    telemetry.clear(); adcComparison = [];
    measure.reset(); renderMeasurement();
    applied = await client.adcTuning(Number($("adcScanRate").value), Number($("adcWindow").value), { paired: true });
  } catch (error) {
    adcApplied.fill(null);
    renderAdcWindows();
    $("adcTuningResult").textContent = "좌우 적용을 확인하지 못했습니다. 오른쪽 연결을 확인하고 다시 적용하세요.";
    throw error;
  }
  telemetry.clear();
  adcComparison = [];
  showAdcTuning(applied, true);
  infoView(await client.info());
}, "ADC 설정 적용 완료");
function hallTravelLabel(id) {
  const status = latest[INPUTS[id].side];
  if (!status) return "Hall";
  if (!status.fresh) return "신호 대기";
  const index = id % 7;
  if (!(profile?.keys[id]?.flags & 4)) return `ADC ${status.raw[index]}`;
  return `${fmt(recognizedTravelToMm(status.travel[index], profile.keys[id], travelMm[id]))} mm`;
}
function renderPressedKeys(side) {
  const status = latest[side];
  const show = status?.fresh && !batchActive() &&
    !(activeTab === "calibration" && batch.state === "frozen");
  for (const input of INPUTS.filter((i) => i.side === side))
    $(`key-${input.id}`).classList.toggle("pressed", !!show && !!(status.pressed_mask & (1 << input.id)));
}
function renderStatus(side, s) {
  latest[side] = s;
  if (!s.fresh && adcApplied[side] && side === 1) {
    adcApplied[side] = null;
    renderAdcWindows();
  }
  if (
    s.calibration_state > 0 &&
    s.calibration_key < 14 &&
    selected !== s.calibration_key
  ) {
    selected = s.calibration_key;
    selectedHall.clear();
    selectedHall.add(selected);
    renderSelection();
    log(
      "진행 중인 보정 키를 선택했습니다. 보정 적용 또는 취소 후 다른 키를 선택하세요.",
    );
  }
  const now = performance.now();
  telemetry.add(side, s, now);
  measure.add(side, s, now);
  batch.add(side, s, now);
  for (let i = 0; i < 7; i++) {
    const id = side * 7 + i,
      b = $(`key-${id}`);
    b.querySelector(".raw").textContent = s.fresh ? s.raw[i] : "—";
    b.querySelector(".bar").style.width = `${s.fresh ? recognizedTravel(s.travel[i], profile?.keys[id]) * 100 / TRAVEL_MAX : 0}%`;
  }
  renderPressedKeys(side);
  $("outputState").textContent = s.output_enabled ? "출력 켜짐" : "출력 꺼짐";
  $("outputState").classList.toggle("on", s.output_enabled);
  $("dirty").textContent = s.dirty
    ? "RAM 변경 · 저장 필요"
    : s.stored_valid
      ? "저장된 설정"
      : "첫 설정 · 저장 전";
  const freshness = $(side ? "rightFresh" : "leftFresh");
  freshness.textContent = s.fresh ? "● 최신" : "● 신호 지연";
  freshness.className = s.fresh ? "fresh" : "stale";
  $("linkStatus").textContent = latest
    .map((r, i) =>
      r
        ? `${i ? "오른쪽" : "왼쪽"} · 링크 age ${r.link_age_us} µs · 누적 오류 ${r.errors} · sample ${r.sample_sequence}`
        : "",
    )
    .join(" / ");
  renderTravel();
  renderCalibration();
  renderMeasurement();
  renderBatch();
  controls();
}
async function poll() {
  if (!client || !connected || busy || polling) return;
  if (restorePending && !outputHeldOff()) {
    polling = true;
    try { await restoreOutput(); } finally { polling = false; }
    return;
  }
  const capture = autoFit?.active ? autoFit : rhythm;
  const fast = capture?.active && !capture.starting;
  if (!fast && performance.now() - lastPollAt < 48) return;
  lastPollAt = performance.now();
  polling = true;
  try {
    const targetSide = fast ? Math.floor(capture.recordContext.key / 7) : null;
    const sides = fast ? [targetSide] : [0, 1];
    if (fast && performance.now() - lastStatusPaint[1 - targetSide] > 100) sides.push(1 - targetSide);
    for (const side of sides) {
      if (!client || !connected || busy) break;
      const current = client,
        requestTime = performance.now(),
        s = await current.status(side);
      const responseTime = performance.now();
      if (client === current) {
        rhythm?.ingest(side, s, requestTime, responseTime);
        autoFit?.ingest(side, s, requestTime, responseTime);
        latest[side] = s;
        // Outside Studio's own operations, follow the keyboard's real output state
        // (boot restore, other tools, firmware safety stops) instead of fighting it.
        // A reply to a request sent before Studio's last operation ended is stale.
        if (side === 0 && !busy && !restorePending && !outputHeldOff() && requestTime > lastOperationEnd)
          wantOutput = s.output_enabled;
        if (!fast || responseTime - lastStatusPaint[side] >= 50) {
          lastStatusPaint[side] = responseTime;
          renderStatus(side, s);
        }
      }
    }
    if (activeTab === "diagnostics") {
      if (!fast && !batchActive() && !calibrationActive() && (comparingAdc() || curveLiveWanted()) &&
          performance.now() - lastAdcComparison >= 100) {
        const key = selected, time = performance.now();
        lastAdcComparison = time;
        try {
          const sample = await client.adcCompare(key);
          curveLive = { key, time, ...sample };
          if (comparingAdc() && !adcComparison.some((row) => row.key === key && row.sequence === sample.sequence)) {
            adcComparison = adcComparison.filter((row) => row.time >= time - 60000).slice(-1999);
            adcComparison.push({ key, time, ...sample });
          }
        } catch (error) {
          // Firmware before 0.3.47 compares left keys only. A missed diagnostic
          // snapshot never stops ordinary status polling.
          if (key >= 7 && /BAD_INDEX/.test(error?.message ?? "")) compareRightUnsupported = true;
        }
      }
      renderDiagnostics();
    }
  } catch (e) {
    rhythm?.stop(`장치 통신이 중단되었습니다: ${e.message}`);
    autoFit?.stop(`장치 통신이 중단되었습니다. ${e.message}`);
    connected = false;
    clearTelemetry();
    controls();
    log(`${e.message} · 연결 종료 후 다시 연결하세요.`, true);
  } finally {
    polling = false;
  }
}
function outputHeldOff() {
  return !!(rhythm?.active || autoFit?.active || calibrationActive() || batchActive() || measuring());
}
function outputErrorMessage(error) {
  if (error?.message === "BUSY")
    return "오른쪽 보드 연결이 한 번 끊긴 뒤라 펌웨어가 좌우 ADC 설정 확인을 기다리고 있습니다. 센서 진단/설정의 ADC 설정에서 '좌우에 적용'을 한 번 누른 뒤 다시 켜세요.";
  if (error?.message === "NOT_READY")
    return uncalibratedHall().length
      ? `보정하지 않은 Hall 키가 ${uncalibratedHall().length}개 있어 출력을 켤 수 없습니다. 캘리브레이션에서 보정하세요.`
      : "좌우 센서가 아직 준비되지 않아 출력을 켤 수 없습니다. 잠시 뒤 다시 켜세요.";
  return error?.message ?? String(error);
}
async function restoreOutput() {
  restorePending = false;
  if (!client || !connected || !wantOutput) return;
  const current = client;
  try {
    if ((await current.status(0)).output_enabled || current !== client) return;
    // The user may have pressed 출력 끄기 (or started another operation) meanwhile.
    if (!wantOutput || busy || outputHeldOff()) return;
    await current.output(true);
    $("outputState").textContent = "출력 켜짐";
    $("outputState").classList.add("on");
    log("작업 전 상태대로 키 출력을 다시 켰습니다.");
  } catch (e) {
    log(`키 출력을 다시 켜지 못했습니다. ${outputErrorMessage(e)}`, true);
  }
}
async function action(fn, message) {
  if (!client || busy) return;
  if (batch.state === "frozen") {
    batch.reset();
    batchOriginal = null;
    batchOutcome = null;
    renderBatch();
  }
  busy = true;
  controls();
  try {
    await fn();
    if (message) log(message);
  } catch (e) {
    log(e.message, true);
  } finally {
    busy = false;
    lastOperationEnd = performance.now();
    // Firmware may have turned output off during this operation.
    if (connected && wantOutput) restorePending = true;
    controls();
  }
}
async function ownBrowser() {
  if (!navigator.locks)
    throw Error("Chrome / Edge의 Web Locks 지원이 필요합니다.");
  let acquired;
  const ready = new Promise((resolve) => (acquired = resolve));
  navigator.locks
    .request(
      "c77-hid-configuration-owner",
      { ifAvailable: true },
      async (lock) => {
        if (!lock) {
          acquired(false);
          return;
        }
        acquired(true);
        await new Promise((resolve) => (lockRelease = resolve));
      },
    )
    .catch((e) => log(e.message, true));
  if (!(await ready))
    throw Error(
      "다른 설정 탭이 연결 중입니다. 그 탭에서 먼저 연결 종료하세요.",
    );
}
// The 펌웨어 tab borrows Studio's HID device: Studio disconnects first (saved
// settings required) and reconnects only when the user presses 키보드 연결.
let installedFirmware = null;
const firmwareTab = mountFirmwareTab({
  async takeDevice() {
    if (!client) return null;
    if (busy || measuring() || batchActive() || calibrationActive()) throw Error("진행 중인 작업을 먼저 끝내세요.");
    if (latest[0]?.dirty) throw Error("저장하지 않은 설정이 있습니다. ‘키보드에 저장’ 후 다시 확인하세요.");
    const device = client.transport.device;
    await disconnect({ quiet: true });
    log("펌웨어 확인을 위해 Studio 연결을 펌웨어 탭으로 넘겼습니다.");
    return device;
  },
  released: () => controls(),
  installed: () => installedFirmware,
  log: (message) => log(message),
});
$("openFirmware").onclick = () => setTab("firmware");
async function connect() {
  if (client) return;
  if (firmwareTab.active()) {
    log("펌웨어 탭에서 ‘업데이트 모드 종료’를 먼저 누르세요.", true);
    return;
  }
  busy = true;
  controls();
  let transport;
  try {
    if (!navigator.hid || !window.isSecureContext)
      throw Error("Chrome 또는 Edge에서 HTTPS 주소나 localhost로 열어주세요.");
    // Reuse the one keyboard this site may already open (e.g. after a firmware
    // update re-enumerated it); otherwise ask the browser.
    const granted = (await navigator.hid.getDevices()).filter(compatible);
    const devices = granted.length === 1 ? granted : await navigator.hid.requestDevice({
      filters: [{ vendorId: VID, productId: PID, usagePage: USAGE_PAGE, usage: USAGE }],
    });
    if (devices.length !== 1 || !compatible(devices[0]))
      throw Error("키보드 설정용 HID 장치를 선택하세요.");
    await ownBrowser();
    transport = new WebHIDTransport(devices[0], () => {
      connected = false;
      if (client) client.outputEnabled = false;
      clearTelemetry();
      controls();
      if (!saving)
        log("USB 연결이 끊겼습니다. 연결 종료 후 다시 연결하세요.", true);
    });
    await transport.open();
    preferenceKey = `split-studio:${devices[0].serialNumber || "0483-5744"}`;
    loadPreferences();
    client = new KeyboardClient(transport);
    connected = true;
    noiseDirty = false; noiseTargetKey = "";
    clearTelemetry();
    await refresh();
    wantOutput = (await client.status(0)).output_enabled;
    restorePending = false;
    const missing = uncalibratedHall();
    if (missing.length && activeTab !== "firmware") {
      setTab("calibration");
      log(`보정되지 않은 키가 ${missing.length}개 있어 캘리브레이션 화면을 열었습니다.`);
    } else log("연결했습니다. 설정할 키를 선택하세요.");
    renderCalibrationNeeded();
    timer = setInterval(poll, 8);
  } catch (e) {
    if (transport) await transport.close().catch(() => {});
    client = null;
    connected = false;
    if (lockRelease) lockRelease();
    lockRelease = null;
    log(e.message, true);
  } finally {
    busy = false;
    controls();
  }
}
async function disconnect({ quiet = false } = {}) {
  rhythm?.stop("키보드 연결을 종료해 측정을 중단했습니다.");
  autoFit?.stop("키보드 연결을 종료해 측정을 중단했습니다.");
  if (timer) clearInterval(timer);
  timer = null;
  // Disconnecting leaves key output exactly as it is on the keyboard.
  if (client) await client.transport.close().catch(() => {});
  wantOutput = restorePending = false;
  client = null;
  profile = null;
  info = null;
  profileState = null;
  connected = false;
  noiseDirty = false; noiseTargetKey = "";
  deviceCurve = null; curveDrawn = curveKindTouched = false;
  curveLive = null; compareRightUnsupported = false;
  setActiveCustomCurve(CUSTOM_CURVE_IDENTITY);
  curveEditor.setDevice(null);
  clearTelemetry();
  $("mode").textContent = "연결 안 됨";
  $("releaseNotice").hidden = true;
  if (lockRelease) lockRelease();
  lockRelease = null;
  renderSelection();
  controls();
  if (!quiet)
    log("연결을 종료했습니다. 저장하지 않은 RAM 변경은 전원을 끄면 사라집니다.");
}
$("connect").onclick = connect;
$("disconnect").onclick = disconnect;
$("refresh").onclick = () =>
  action(async () => {
    measure.reset();
    telemetry.clear();
    await refresh();
  }, "설정을 다시 읽었습니다.");
$("bindingForm").onsubmit = (e) => {
  e.preventDefault();
  if ($("applyBinding").disabled) return;
  const b = mappingValue();
  action(async () => {
    profile.bindings[b.input] = await client.setBinding(b);
    renderSelection();
  }, "키 매핑 RAM 적용 완료 · 키보드 저장은 별도입니다.");
};
$("keyForm").onsubmit = (e) => {
  e.preventDefault();
  if ($("applyKey").disabled) return;
  const targets = performanceTargets(), draft = {};
  for (const [id, field] of Object.entries(keyFields))
    if (performanceDirty.has(id)) draft[field] = Number($(id).value);
  if (performanceDirty.has("enabled")) draft.enabled = $("enabled").checked;
  if (performanceDirty.has("rt")) draft.rapid_trigger = $("rt").checked;
  if (performanceDirty.has("retrigger")) draft.retrigger_before_release = $("retrigger").checked;
  if (performanceDirty.has("curveId")) draft.curve_id = Number($("curveId").value);
  action(async () => {
    const proposed = proposePerformanceSettings(profile, targets, travelMm, draft, info.capabilities);
    const outcome = await applyPerformanceSettings(client, profile, proposed);
    if (outcome.profile) profile = outcome.profile;
    telemetry.clear();
    renderSelection();
    if (!outcome.complete) {
      log(outcome.error || `${outcome.appliedKeys.length}/${targets.length}개 키 적용 확인. 설정을 다시 확인하세요.`, true);
      return;
    }
    const k = profile.keys[selected];
    log(targets.length > 1
      ? `${targets.length}개 키 설정 적용 완료. 유지하려면 키보드에 저장하세요.`
      : `Hall 설정 RAM 적용 완료 · 작동 ${fmt(normalizedToMm(k.actuation, travelMm[selected]), 3)} mm.`,
    );
  });
};

for (const input of INPUTS.filter((i) => i.id < 14)) {
  const chip = document.createElement("div");
  chip.id = `batch-key-${input.id}`;
  chip.className = "batch-key-state";
  chip.innerHTML = "<span></span><small>대기</small>";
  chip.querySelector("span").textContent = mappedInputLabel(input.id);
  $("batchKeyStates").append(chip);
}
function renderBatch() {
  const now = performance.now();
  batch.tick(now);
  const active = batchActive(),
    calibrationTab = activeTab === "calibration",
    visible = active || (calibrationTab && batch.state !== "idle");
  $("batchBanner").hidden = !visible;
  const count = `감지 ${batch.detectedCount} / 14 · 적용 가능 ${batch.eligibleCount}`;
  $("batchCounts").textContent = $("batchBannerCount").textContent = count;
  $("batchApply").textContent = $("batchQuickApply").textContent =
    batch.eligibleCount ? `${batch.eligibleCount}개 키 적용` : "감지된 키 적용";
  $("batchProgress").value = $("batchBannerProgress").value =
    batch.progress(now);
  let message =
    "시작하면 키 출력이 꺼집니다. 캘리브레이션만 진행하며 자동 저장하지 않습니다.";
  let title = "전체 Hall 보정";
  if (batch.state === "baseline") {
    const remaining = Math.max(0, 3 * (1 - batch.progress(now))).toFixed(1);
    title = `모든 키에서 손을 떼세요 · ${remaining}초`;
    message = `놓은 위치를 3초간 수집 중입니다. 손을 떼고 그대로 유지하세요. 남은 ${remaining}초`;
  } else if (batch.state === "press") {
    title = "각 Hall 키를 끝까지 눌러 주세요";
    message = batch.eligibleCount
      ? `${count}. 이미 초록색인 키도 더 깊게 누르면 최대값을 계속 갱신합니다. 지금 수집된 키부터 적용해도 됩니다.`
      : "기준 수집 완료. 순서에 상관없이 각 Hall 키를 끝까지 누르고 잠깐 유지하세요. 움직임은 노란색, 적용 가능한 범위는 초록색입니다.";
  } else if (batch.state === "error") {
    title = "수집을 다시 시작해 주세요";
    message = batch.error || "최신 센서값을 충분히 수집하지 못했습니다.";
  } else if (batch.state === "frozen") {
    title = batchOutcome?.complete ? "보정 RAM 적용 확인" : "보정 적용 결과";
    message = batchOutcome
      ? batchOutcome.complete
        ? `${batchOutcome.appliedKeys.length}개 키의 보정 RAM 적용과 읽기 검증 완료. 나머지 키는 유지했습니다. 영구 저장은 별도입니다.`
        : `RAM에서 일치가 확인된 키 ${batchOutcome.appliedKeys.length}개. ${batchOutcome.error || "전체 읽기 검증 불일치"} 자동 재시도·저장은 하지 않았습니다.`
      : "수집을 고정했습니다. 적용 결과를 확인하고 있습니다.";
  }
  $("batchState").textContent = message;
  $("batchBannerTitle").textContent = title;
  $("batchRestStep").classList.toggle("active", batch.state === "baseline");
  $("batchPressStep").classList.toggle("active", batch.state === "press");
  $("batchApplyStep").classList.toggle("active", batch.state === "frozen");
  for (let i = 0; i < 14; i++) {
    const row = batch.keys?.[i],
      button = $(`key-${i}`),
      chip = $(`batch-key-${i}`);
    if (!chip) continue;
    chip.querySelector("span").textContent = mappedInputLabel(i);
    const applied = batchOutcome?.appliedKeys.includes(i) ?? false;
    const usable = batch.state === "press" || batch.state === "frozen";
    const detected = usable && !!row?.detected,
      eligible = usable && !!row?.eligible;
    button.classList.toggle("cal-wait", calibrationTab && active && !detected);
    button.classList.toggle("cal-detected", calibrationTab && detected && !eligible && !applied);
    button.classList.toggle("cal-eligible", calibrationTab && eligible && !applied);
    button.classList.toggle("cal-applied", calibrationTab && applied);
    chip.classList.toggle("detected", detected && !eligible && !applied);
    chip.classList.toggle("eligible", eligible && !applied);
    chip.classList.toggle("applied", applied);
    const state = applied
      ? "적용 확인"
      : eligible
        ? "적용 가능"
        : detected
          ? "감지 · 더 눌러 주세요"
          : batch.state === "baseline"
            ? "기준 수집"
            : "아직 안 누름";
    chip.querySelector("small").textContent = state;
    chip.title =
      row?.rest === null || row?.rest === undefined
        ? state
        : `놓음 ${row.rest} / 누름 ${row.pressed} / 범위 ${row.span} ADC`;
    button.querySelector(".travel").textContent = calibrationTab && (detected || applied)
      ? (detected && !eligible && !applied ? "움직임 감지" : state)
      : hallTravelLabel(i);
  }
}
$("batchStart").onclick = () => {
  if ($("batchStart").disabled) return;
  action(async () => {
    await client.output(false);
    await refresh();
    measure.reset();
    renderMeasurement();
    telemetry.clear();
    batchOriginal = structuredClone(profile);
    batchOutcome = null;
    batch.start(batchOriginal.keys, performance.now());
    setTab("calibration");
    renderBatch();
    document
      .querySelector(".keyboard-panel")
      .scrollIntoView({ behavior: "smooth", block: "start" });
  }, "모든 키에서 손을 떼세요. 3초 동안 14개 Hall 기준을 함께 수집합니다.");
};
function cancelBatch() {
  if (busy) return;
  batch.reset();
  batchOriginal = null;
  batchOutcome = null;
  renderBatch();
  controls();
  log(
    "전체 보정 수집과 결과 표시를 종료했습니다. 이미 적용한 RAM 보정은 유지됩니다.",
  );
}
$("batchCancel").onclick = $("batchQuickCancel").onclick = cancelBatch;
function applyBatch() {
  if ($("batchApply").disabled) return;
  action(async () => {
    const candidates = batch.freeze(performance.now());
    renderBatch();
    batchOutcome = await applyCalibration(client, batchOriginal, candidates);
    if (!batchOutcome.profile) {
      const message = batchOutcome.error;
      connected = false;
      clearTelemetry();
      log(`${message} 연결 종료 후 다시 연결해 RAM 상태를 확인하세요.`, true);
      return;
    }
    profile = batchOutcome.profile;
    telemetry.clear();
    renderSelection();
    renderBatch();
    log($("batchState").textContent, !batchOutcome.complete);
  });
}
$("batchApply").onclick = $("batchQuickApply").onclick = applyBatch;

for (const [id, code] of [
  ["rest", 0],
  ["pressed", 1],
  ["commit", 2],
  ["cancelCal", 3],
])
  $(id).onclick = () => {
    if ($(id).disabled) return;
    const target = selected;
    action(async () => {
      const result = await client.calibrate(target, code);
      telemetry.clear();
      measure.reset();
      calStage =
        code === 0 || code === 1
          ? { key: target, state: result.state, started: performance.now() }
          : null;
      if (code === 2) {
        await refresh();
        log(
          `${mappedInputLabel(target)} 보정 RAM 적용 완료. 다음 키를 선택하거나 작동점 · RT를 설정하세요.`,
        );
      } else if (code === 3) log("보정을 취소했습니다.");
      else
        log(
          code === 0
            ? "키를 완전히 놓은 상태로 유지하세요."
            : "키를 끝까지 누른 상태로 유지하세요.",
        );
    });
  };
$("nextKey").onclick = () => {
  if (busy || measuring() || calibrationActive()) return;
  for (let i = 1; i <= 14; i++) {
    const key = (Math.min(selected, 13) + i) % 14;
    if (
      !profile ||
      (profile.keys[key].flags & 1 && !(profile.keys[key].flags & 4))
    ) {
      selectInput(key);
      return;
    }
  }
  selectInput((selected + 1) % 14);
  log("활성 Hall 키의 보정이 모두 완료되었습니다.");
};
$("outputOff").onclick = () =>
  action(async () => {
    wantOutput = restorePending = false;
    await client.output(false);
    $("outputState").textContent = "출력 꺼짐";
  }, "키 출력을 껐습니다.");
$("outputOn").onclick = () =>
  action(async () => {
    try { await client.output(true); }
    catch (e) { throw Error(`키 출력을 켜지 못했습니다. ${outputErrorMessage(e)}`); }
    wantOutput = true;
    $("outputState").textContent = "출력 켜짐";
  }, "키 출력을 켰습니다. NKRO가 기본 적용됩니다.");
$("save").onclick = () =>
  action(async () => {
    saving = true;
    try {
      log("설정 저장 후 USB 재연결과 전체 프로필을 검증합니다…");
      const result = await client.save();
      connected = true;
      clearTelemetry();
      profile = result.config;
      infoView(result.info);
      renderSelection();
      $("outputState").textContent = result.outputEnabled ? "출력 켜짐" : "출력 꺼짐";
      $("outputState").classList.toggle("on", result.outputEnabled);
      wantOutput = result.outputEnabled;
      log(
        `영구 저장 검증 완료 · 세대 ${result.generation} · 출력 ${result.outputEnabled ? "켜짐" : "꺼짐"}.`,
      );
    } catch (e) {
      // A failed readback must not strand the UI with a stale client/lock.
      // No additional OUTPUT or SAVE is sent to an unverified device.
      connected = false;
      await disconnect({ quiet: true });
      throw e;
    } finally {
      saving = false;
    }
  });
function download(value, name) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2) + "\n"], {
      type: "application/json",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
$("export").onclick = () =>
  action(
    async () =>
      download(
        makeUiProfile(await client.getConfig(), travelMm),
        `split-studio-c${info?.board_rev}-profile.json`,
      ),
    "프로필과 총 이동거리를 내보냈습니다.",
  );
$("import").onclick = () => $("profileFile").click();
$("profileFile").onchange = (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  action(async () => {
    if (file.size > 100000)
      throw Error("프로필 파일은 100KB 이하로 선택하세요.");
    const p = parseUiProfile(JSON.parse(await file.text()));
    await client.importProfile(p.device);
    if (p.travelMm) {
      travelMm = p.travelMm;
      savePreferences();
    }
    telemetry.clear();
    measure.reset();
    await refresh();
  }, "프로필 RAM 적용 및 읽기 검증 완료 · 영구 저장은 별도입니다.");
};
function canvasContext(id) {
  const canvas = $(id),
    rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const c = canvas.getContext("2d");
  c.scale(dpr, dpr);
  c.font = "10px Segoe UI";
  c.fillStyle = "#8491a5";
  return { c, w: rect.width, h: rect.height };
}
function drawSignal(series, stats, now, adcView, before = []) {
  const ctx = canvasContext("signalChart");
  if (!ctx) return;
  const { c, w, h } = ctx,
    L = 48,
    R = w - 12,
    T = 18,
    B = h - 28;
  if (!series.length) {
    c.fillText("최신 센서 샘플을 기다립니다.", 20, 50);
    return;
  }
  const low = Math.min(stats.min, ...before.map((s) => s.value)),
    high = Math.max(stats.max, ...before.map((s) => s.value)),
    padding = Math.max(adcView ? 2 : 0.005, (high - low) * 0.12),
    min = adcView ? low - padding : Math.max(0, low - padding),
    max = adcView ? high + padding : Math.min(travelMm[selected], high + padding);
  const y = (v) => B - ((v - min) / (max - min)) * (B - T),
    x = (t) => L + ((t - (now - diagnosticWindow())) / diagnosticWindow()) * (R - L);
  c.strokeStyle = "#293443";
  c.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const value = min + ((max - min) * i) / 4,
      py = y(value);
    c.beginPath();
    c.moveTo(L, py);
    c.lineTo(R, py);
    c.stroke();
    c.fillStyle = "#8491a5";
    c.fillText(value.toFixed(adcView ? 0 : 3), 5, py + 3);
  }
  c.save();
  c.beginPath();
  c.rect(L, T, R - L, B - T);
  c.clip();
  c.fillStyle = "#b4ed7819";
  c.fillRect(
    L,
    y(stats.mean + stats.stddev),
    R - L,
    y(stats.mean - stats.stddev) - y(stats.mean + stats.stddev),
  );
  c.strokeStyle = "#b4ed78";
  c.setLineDash([4, 4]);
  c.beginPath();
  c.moveTo(L, y(stats.mean));
  c.lineTo(R, y(stats.mean));
  c.stroke();
  c.setLineDash([]);
  if (before.length) {
    c.strokeStyle = "#f6a35d";
    c.beginPath();
    before.forEach((s, i) =>
      i ? c.lineTo(x(s.time), y(s.value)) : c.moveTo(x(s.time), y(s.value)),
    );
    c.stroke();
  }
  c.strokeStyle = "#72d4df";
  c.lineWidth = 1.6;
  c.beginPath();
  series.forEach((s, i) =>
    i ? c.lineTo(x(s.time), y(s.value)) : c.moveTo(x(s.time), y(s.value)),
  );
  c.stroke();
  c.restore();
  c.fillStyle = "#8491a5";
  c.fillText(`−${diagnosticWindow() / 1000}초`, L, h - 9);
  c.fillText("현재", R - 22, h - 9);
}
function drawHistogram(series, stats, adcView) {
  const ctx = canvasContext("histogram");
  if (!ctx) return;
  const { c, w, h } = ctx;
  if (!series.length) {
    c.fillText("샘플 대기", 16, 50);
    return;
  }
  const span = stats.max - stats.min;
  const n = span === 0 ? 1 : Math.min(16, adcView ? span + 1 : series.length);
  const bins = Array(n).fill(0);
  const binSpan = adcView ? span + 1 : span;
  series.forEach(
    (s) =>
      bins[binSpan ? Math.min(n - 1, Math.floor(((s.value - stats.min) / binSpan) * n)) : 0]++,
  );
  const max = Math.max(...bins),
    L = 20,
    R = w - 15,
    B = h - 28;
  bins.forEach((count, i) => {
    const width = (R - L) / n,
      height = (count / max) * (h - 55);
    c.fillStyle = "#72d4dfa0";
    c.fillRect(L + i * width + 1, B - height, Math.max(1, width - 2), height);
  });
  c.fillStyle = "#8491a5";
  const low = stats.min.toFixed(adcView ? 0 : 3);
  const high = stats.max.toFixed(adcView ? 0 : 3);
  c.fillText(low, L, h - 9);
  c.fillText(high, Math.max(L, R - c.measureText(high).width), h - 9);
  c.fillText(`최대 빈도 ${max}`, L, 15);
}
const impactColors = ["#b4ed78", "#72d4df", "#f6a35d", "#cfabf5", "#ff9e9c", "#8faeff", "#e8d979", "#81d2ae", "#f6b9dd", "#aab8d1", "#b4b773", "#69c0ec", "#b6957a", "#ffceab"];
function renderLiveImpact(now) {
  const scope = $("impactScope").value, side = Math.floor(selected / 7);
  const rows = relativeSensorSeries(telemetry, selected, now, diagnosticWindow()).filter((row) =>
    scope === "all" || (scope === "same" ? Math.floor(row.key / 7) === side : Math.floor(row.key / 7) !== side));
  const legend = $("impactLegend");
  const signature = rows.map((row) => `${row.key}:${mappedInputLabel(row.key)}`).join("|");
  if (legend.dataset.signature !== signature) {
    legend.dataset.signature = signature;
    legend.replaceChildren(...rows.map((row) => {
      const button = document.createElement("button");
      button.type = "button"; button.id = `impact-key-${row.key}`;
      button.style.setProperty("--series-color", impactColors[row.key]);
      button.onclick = () => {
        if (impactHidden.has(row.key)) impactHidden.delete(row.key); else impactHidden.add(row.key);
        renderDiagnostics();
      };
      return button;
    }));
  }
  for (const row of rows) {
    const button = $(`impact-key-${row.key}`);
    button.setAttribute("aria-pressed", String(!impactHidden.has(row.key)));
    button.textContent = `${mappedInputLabel(row.key)} · ${row.samples.length ? `${fmt(row.latestDelta, 0)} ADC` : "대기"}`;
    button.title = `이 구간 최대 절대 변화 ${fmt(row.peakAbsDelta, 1)} ADC`;
  }
  const shown = rows.filter((row) => !impactHidden.has(row.key));
  const strongest = shown.filter((row) => row.samples.length).sort((a, b) => b.peakAbsDelta - a.peakAbsDelta)[0];
  $("impactLiveSummary").textContent = strongest
    ? `${mappedInputLabel(selected)} 관찰 중 · 다른 키 최대 변화 ${mappedInputLabel(strongest.key)} ${fmt(strongest.peakAbsDelta, 1)} ADC · 원인 확인은 아래 비교 측정으로 진행하세요.`
    : "다른 키의 수신 샘플을 기다립니다.";
  const ctx = canvasContext("impactChart");
  if (!ctx) return;
  const { c, w, h } = ctx, L = 48, R = w - 15, T = 15, B = h - 28;
  if (!strongest) { c.fillText(shown.length ? "센서 샘플 대기" : "아래 키 이름을 눌러 비교할 키를 선택하세요.", 20, 40); return; }
  const extent = Math.max(2, ...shown.map((row) => row.peakAbsDelta ?? 0)) * 1.12;
  const x = (time) => L + (time - now + diagnosticWindow()) / diagnosticWindow() * (R - L);
  const y = (value) => T + (extent - value) / (2 * extent) * (B - T);
  for (let i = -2; i <= 2; i++) {
    const v = extent * i / 2;
    c.strokeStyle = i ? "#293443" : "#566477";
    c.beginPath(); c.moveTo(L, y(v)); c.lineTo(R, y(v)); c.stroke();
    c.fillText(`${v > 0 ? "+" : ""}${fmt(v, 0)}`, 5, y(v) + 3);
  }
  c.save(); c.beginPath(); c.rect(L, T, R - L, B - T); c.clip();
  for (const row of shown) {
    c.strokeStyle = impactColors[row.key]; c.lineWidth = 1.5; c.beginPath();
    row.samples.forEach((sample, i) => {
      if (!i || sample.time - row.samples[i - 1].time > 250) c.moveTo(x(sample.time), y(sample.value));
      else c.lineTo(x(sample.time), y(sample.value));
    });
    c.stroke();
  }
  c.restore(); c.fillText(`−${diagnosticWindow() / 1000}초`, L, h - 9); c.fillText("현재", R - 22, h - 9);
}
function renderDiagnostics() {
  renderCurveEditor();
  if (!hall() || activeTab !== "diagnostics") return;
  const now = performance.now();
  const compare = comparingAdc();
  const adcView = compare || $("diagnosticAdc").checked;
  $("adcCompareLegend").hidden = !compare;
  const calibrated = !!(profile?.keys[selected]?.flags & 4);
  const samples = adcView || calibrated ? sensorSeries(telemetry, selected, now, diagnosticWindow()) : [];
  const pairs = compare ? adcComparison.filter((s) => s.key === selected && s.time >= now - diagnosticWindow()) : [];
  const series = compare ? pairs.map((s) => ({ time: s.time, value: s.after })) : samples.map((sample) => ({
    time: sample.time,
    value: adcView ? sample.raw : recognizedTravelToMm(sample.travel, profile.keys[selected], travelMm[selected]),
  }));
  const s = summarize(series, (sample) => sample.value);
  const unit = adcView ? "ADC" : "mm";
  const source = compare ? "이동평균 전·후 ADC" : adcView ? "ADC 보고값" : "인식 이동량 (데드존 적용)";
  $("diagnosticSignalLabel").textContent = `${source} · 평균 · ±1σ`;
  $("signalChart").setAttribute("aria-label", `최근 ${diagnosticWindow() / 1000}초 ${source}와 평균 및 표준편차`);
  $("histogram").setAttribute("aria-label", `${source} 표본 분포`);
  for (const label of $("diagnostics").querySelectorAll("[data-diagnostic-stat]")) {
    const name = label.dataset.diagnosticStat;
    label.textContent = `${name} (${unit}${name === "분산" ? "²" : ""})`;
  }
  for (const id of ["mean", "variance", "stddev", "peakToPeak"])
    $(id).textContent = fmt(s[id], adcView ? 2 : id === "variance" ? 6 : 4);
  $("sampleInfo").textContent =
    !adcView && !calibrated
      ? "키를 보정하면 이동량을 확인할 수 있습니다."
      : `최근 ${series.length}개 · 관찰 ${fmt(s.observedHz, 1)} Hz · 보정 중·중복·오래된 샘플 제외`;
  drawSignal(series, s, now, adcView, pairs.map((p) => ({ time: p.time, value: p.before })));
  drawHistogram(series, s, adcView);
  renderLiveImpact(now);
}
$("diagnosticAdc").onchange = renderDiagnostics;
$("diagnosticAdcCompare").onchange = renderDiagnostics;
$("diagnosticWindow").onchange = renderDiagnostics;
$("impactScope").onchange = renderDiagnostics;
function renderMeasurement() {
  const now = performance.now();
  measure.tick(now);
  $("measureProgress").value = measure.progress(now);
  const names = {
    idle: "측정 전 · 모든 키에서 손을 떼고 시작하세요.",
    baseline: "기준 수집 중 · 모든 키에서 손을 떼세요.",
    ready: `기준 수집 완료 · ${mappedInputLabel(measure.selectedKey ?? 0)} 하나만 끝까지 누르고 ②를 클릭하세요.`,
    pressed: "비교 수집 중 · 선택 키 하나만 누르고 다른 키는 건드리지 마세요.",
    done: `측정 완료 · ${mappedInputLabel(measure.selectedKey ?? 0)} 누름 기준, 나머지 13키의 변화입니다.`,
    error: measure.error,
  };
  $("measureState").textContent = names[measure.state];
  const r = measure.result();
  const measurementView = r ? `${r.selectedKey}:${measure.ended}:${JSON.stringify(profile?.bindings)}` : null;
  if (r && drawnMeasurement !== measurementView) {
    drawnMeasurement = measurementView;
    const pressed = r.keys[r.selectedKey];
    const moved =
      pressed.peakAbsDeltaRaw > Math.max(5, pressed.baseline.stddev * 3);
    $("interferenceSummary").textContent =
      `다른 키 최대 변화: ${fmt(r.maxOtherDeltaRaw)} ADC${r.maxOtherMm === null ? "" : ` / ${fmt(r.maxOtherMm, 3)} mm (보정된 키만)`}${moved ? "" : " · 선택 키의 변화가 작습니다. 실제로 끝까지 눌렀는지 확인하세요."}`;
    $("interferenceRows").replaceChildren();
    for (const row of r.keys
      .filter((v) => !v.selected)
      .sort((a, b) => b.peakAbsDeltaRaw - a.peakAbsDeltaRaw)) {
      const tr = document.createElement("tr");
      for (const value of [
        mappedInputLabel(row.key),
        fmt(row.meanDeltaRaw),
        fmt(row.peakAbsDeltaRaw),
        row.peakPercent === null ? "미보정" : `${fmt(row.peakPercent)}%`,
        row.peakMm === null ? "미보정" : fmt(row.peakMm, 3),
      ]) {
        const td = document.createElement("td");
        td.textContent = value;
        tr.append(td);
      }
      $("interferenceRows").append(tr);
      const alpha = Math.min(
        0.7,
        (row.peakAbsDeltaRaw / Math.max(1, r.maxOtherDeltaRaw)) * 0.7,
      );
      $(`key-${row.key}`).style.boxShadow =
        `0 0 0 2px rgba(255,158,156,${alpha})`;
    }
  } else if (measure.state === "idle") {
    $("interferenceRows").replaceChildren();
    $("interferenceSummary").textContent = "";
    drawnMeasurement = null;
    document.querySelectorAll(".key").forEach((b) => (b.style.boxShadow = ""));
  }
}
$("baseline").onclick = () =>
  action(async () => {
    await client.output(false);
    measure.reset();
    renderMeasurement();
    drawnMeasurement = null;
    measure.startBaseline(selected, profile.keys, travelMm, performance.now());
    renderMeasurement();
  }, "기준값 수집 시작. 모든 키에서 손을 떼세요.");
$("measurePress").onclick = () => {
  try {
    measure.startPress(performance.now());
    renderMeasurement();
    controls();
  } catch (e) {
    log(e.message, true);
  }
};
$("cancelMeasure").onclick = () => {
  measure.reset();
  renderMeasurement();
  controls();
};
$("clearStats").onclick = () => {
  telemetry.clear();
  adcComparison = [];
  renderDiagnostics();
};
window.addEventListener("resize", () => renderDiagnostics());
window.addEventListener("pagehide", () => {
  rhythm?.stop("페이지가 닫혀 측정을 중단했습니다.");
  autoFit?.stop("페이지가 닫혀 측정을 중단했습니다.");
  if (lockRelease) lockRelease();
  if (client) client.transport.close().catch(() => {});
});
rhythm = new RhythmLab({
  getContext: () => ({ selected, label: mappedInputLabel(selected), profile, travelMm, info,
    available: connected && !busy && !autoFit?.active && !autoFit?.applying && !calibrationActive() && !batchActive() &&
      !["baseline", "ready", "pressed"].includes(measure.state) && !!latest[INPUTS[selected].side]?.fresh }),
  prepare: async () => {
    if (!client || !connected || busy || calibrationActive() || batchActive()) throw Error("장치가 측정 준비 상태가 아닙니다.");
    busy = true;
    controls();
    try {
      const current = client;
      if (await current.output(false) !== false) throw Error("키 출력 해제를 확인하지 못했습니다.");
      restorePending = wantOutput; // Restored once the measurement ends.
      profile = await current.getConfig();
      const status = await current.status(INPUTS[selected].side);
      if (!connected || current !== client || !status.fresh || status.calibration_state) throw Error("최신 센서 상태를 확인할 수 없습니다.");
      if (!(profile.keys[selected]?.flags & 1)) throw Error("활성화된 Hall 키를 선택하세요.");
      renderStatus(INPUTS[selected].side, status);
      return { profile };
    } finally { busy = false; lastOperationEnd = performance.now(); if (connected && wantOutput) restorePending = true; controls(); }
  },
  onChange: () => controls(),
  onLog: log,
});
function autoFitContext() {
  return { selected, label: mappedInputLabel(selected), profile, travelMm, info, connected,
    identity: preferenceKey, adcSetting: adcApplied,
    available: connected && !busy && !rhythm?.active && !calibrationActive() && !batchActive() &&
      !["baseline", "ready", "pressed"].includes(measure.state) && !!latest[INPUTS[selected].side]?.fresh };
}
autoFit = new AutoFitWizard({
  getContext: autoFitContext,
  prepare: async () => {
    if (!client || !connected || busy || rhythm?.active || calibrationActive() || batchActive()) throw Error("장치가 측정 준비 상태가 아닙니다.");
    busy = true; controls();
    try {
      const current = client;
      if (await current.output(false) !== false) throw Error("키 출력 해제를 확인하지 못했습니다.");
      restorePending = wantOutput; // Restored once the measurement ends.
      profile = await current.getConfig();
      const status = await current.status(INPUTS[selected].side);
      if (!connected || current !== client || !status.fresh || status.calibration_state) throw Error("최신 센서 상태를 확인할 수 없습니다.");
      if (selected >= 14 || (profile.keys[selected].flags & 5) !== 5) throw Error("캘리브레이션을 완료한 Hall 키를 선택하세요.");
      renderStatus(INPUTS[selected].side, status);
      return autoFitContext();
    } finally { busy = false; lastOperationEnd = performance.now(); if (connected && wantOutput) restorePending = true; controls(); }
  },
  verify: async (source) => {
    const current = client;
    if (!current || !connected) throw Error("키보드 연결을 확인하세요.");
    const actual = await current.getConfig();
    if (current !== client || !connected || JSON.stringify(actual) !== JSON.stringify(source.profile))
      throw Error("측정 중 설정이 바뀌었습니다. 처음부터 다시 측정하세요.");
  },
  apply: async (source, candidate) => {
    if (!client || !connected || busy || selected !== source.key) throw Error("측정한 키를 선택하고 연결을 확인하세요.");
    busy = true; controls();
    try {
      if (candidate.key !== source.key || candidate.curve_id !== source.keyConfig.curve_id || candidate.noise_deadband !== source.keyConfig.noise_deadband)
        throw Error("추천 설정의 키와 보정 정보를 확인할 수 없습니다.");
      const outcome = await applyPerformanceSettings(client, source.profile, [candidate]);
      if (outcome.profile) profile = outcome.profile;
      telemetry.clear(); renderSelection();
      if (!outcome.complete) throw Error(outcome.error || "추천값 적용을 확인할 수 없습니다.");
    } finally { busy = false; lastOperationEnd = performance.now(); if (connected && wantOutput) restorePending = true; controls(); }
  },
  onChange: controls,
  onLog: log,
});
const rtSettingHelp = mountRTSettingHelp();
renderSelection();
renderBatch();
controls();
if (location.hash === "#firmware") setTab("firmware");
