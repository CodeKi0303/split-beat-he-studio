// Drawable ADC-to-travel curve for firmware 0.3.46+ curve_id 2. Pure canvas UI:
// no device access. The caller writes the table with KeyboardClient.setCustomCurve.
import { TRAVEL_MAX, CUSTOM_CURVE_POINTS, CUSTOM_CURVE_STEP, CUSTOM_CURVE_IDENTITY, customCurveRecord } from "./protocol.mjs?v=studio-retrigger1";
import { travelFromSignal, HALL_CURVE_LINEAR, HALL_CURVE_OWLAB_TI, HALL_CURVE_CUSTOM } from "./hall-curve.mjs?v=studio-owlab1";

const COLORS = {
  grid: "#293443", axis: "#8491a5", linear: "#969eac", owlab: "#72d4df",
  device: "rgba(180, 237, 120, 0.45)", draft: "#b4ed78", live: "#ff9e9c", actuation: "#f2c46d",
  average: "#c39bff", decision: "#f5f7fa",
};
const CURVE_NAMES = ["직선", "Owlab Ti 근사", "커스텀"];

/** Keep the table non-decreasing around an edited point. */
export function setCurvePoint(points, index, value) {
  const next = [...points], v = Math.max(0, Math.min(TRAVEL_MAX, Math.round(value)));
  next[index] = v;
  for (let j = index + 1; j < next.length; j++) if (next[j] < v) next[j] = v;
  for (let j = index - 1; j >= 0; j--) if (next[j] > v) next[j] = v;
  return next;
}

export function mountCurveEditor(canvas, { onDraw = () => {}, onHover = () => {} } = {}) {
  let draft = [...CUSTOM_CURVE_IDENTITY], device = null, enabled = false;
  // live: ADC signal fractions (0..10000) of the raw code, the moving average and
  // the post-deadband decision code; null when unknown.
  let context = { travelMm: 4, keyCurveId: HALL_CURVE_LINEAR, span: null, actuation: null,
    live: { raw: null, average: null, decision: null } };
  let dragging = false, lastIndex = null, geometry = null;

  function layout() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const c = canvas.getContext("2d");
    c.scale(dpr, dpr);
    geometry = { L: 46, R: rect.width - 14, T: 14, B: rect.height - 32, w: rect.width, h: rect.height };
    return c;
  }
  const px = (signal) => geometry.L + (signal / 10000) * (geometry.R - geometry.L);
  const py = (travel) => geometry.B - (travel / TRAVEL_MAX) * (geometry.B - geometry.T);
  const tableOf = (id) => id === HALL_CURVE_CUSTOM ? draft : undefined;

  function line(c, id, table, style, width, dash = []) {
    c.strokeStyle = style; c.lineWidth = width; c.setLineDash(dash); c.beginPath();
    for (let x = 0; x <= 10000; x += 125) {
      const y = travelFromSignal(x, id, table ?? CUSTOM_CURVE_IDENTITY);
      x ? c.lineTo(px(x), py(y)) : c.moveTo(px(x), py(y));
    }
    c.stroke(); c.setLineDash([]);
  }

  function render() {
    const c = layout();
    if (!c) return;
    const { L, R, T, B } = geometry, mm = context.travelMm;
    c.font = "11px Segoe UI";
    c.fillStyle = COLORS.axis;
    c.strokeStyle = COLORS.grid; c.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const travel = (TRAVEL_MAX * i) / 4, y = py(travel);
      c.beginPath(); c.moveTo(L, y); c.lineTo(R, y); c.stroke();
      c.textAlign = "right"; c.fillText(`${(mm * i / 4).toFixed(1)}`, L - 6, y + 4);
    }
    for (let i = 0; i <= 4; i++) {
      const x = px(2500 * i);
      c.beginPath(); c.moveTo(x, T); c.lineTo(x, B); c.stroke();
      c.textAlign = i === 4 ? "right" : i === 0 ? "left" : "center";
      const codes = context.span ? ` · ${Math.round(context.span * i / 4)}` : "";
      c.fillText(`${25 * i}%${codes}`, x, B + 16);
    }
    c.textAlign = "left";
    c.fillText(context.span ? "ADC 신호 (보정 범위 % · 쉼 위 코드)" : "ADC 신호 (보정 범위 %)", L, B + 29);
    c.save(); c.translate(12, (T + B) / 2); c.rotate(-Math.PI / 2); c.textAlign = "center";
    c.fillText("판정 거리 (mm)", 0, 0); c.restore();

    line(c, HALL_CURVE_LINEAR, null, COLORS.linear, 1.5, [6, 4]);
    line(c, HALL_CURVE_OWLAB_TI, null, COLORS.owlab, 1.5, [2, 3]);
    if (device && device.some((v, i) => v !== draft[i])) line(c, HALL_CURVE_CUSTOM, device, COLORS.device, 1.5);
    line(c, HALL_CURVE_CUSTOM, draft, COLORS.draft, 2.5);
    c.fillStyle = COLORS.draft;
    draft.forEach((value, i) => {
      c.beginPath(); c.arc(px((i + 1) * CUSTOM_CURVE_STEP), py(value), enabled ? 4 : 3, 0, Math.PI * 2); c.fill();
    });
    if (Number.isFinite(context.actuation)) {
      c.strokeStyle = COLORS.actuation; c.lineWidth = 1; c.setLineDash([4, 4]);
      c.beginPath(); c.moveTo(L, py(context.actuation)); c.lineTo(R, py(context.actuation)); c.stroke(); c.setLineDash([]);
      c.fillStyle = COLORS.actuation; c.textAlign = "right";
      c.fillText(`작동점 ${(context.actuation * mm / TRAVEL_MAX).toFixed(3)} mm`, R, py(context.actuation) - 5);
    }
    const clampSignal = (s) => Math.max(0, Math.min(10000, Math.round(s)));
    const { raw, average, decision } = context.live ?? {};
    if (Number.isFinite(raw)) {
      const x = px(clampSignal(raw));
      c.strokeStyle = COLORS.live; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(x, T); c.lineTo(x, B); c.stroke();
    }
    if (Number.isFinite(average)) {
      const x = px(clampSignal(average));
      c.strokeStyle = COLORS.average; c.lineWidth = 1.5; c.setLineDash([3, 3]);
      c.beginPath(); c.moveTo(x, T); c.lineTo(x, B); c.stroke(); c.setLineDash([]);
    }
    if (Number.isFinite(decision)) {
      // The decision code on the curve the key actually uses (the keyboard's table).
      const id = context.keyCurveId ?? HALL_CURVE_LINEAR, s = clampSignal(decision);
      const y = py(travelFromSignal(s, id, id === HALL_CURVE_CUSTOM ? (device ?? draft) : CUSTOM_CURVE_IDENTITY));
      c.strokeStyle = COLORS.decision; c.lineWidth = 1; c.setLineDash([2, 3]);
      c.beginPath(); c.moveTo(L, y); c.lineTo(px(s), y); c.stroke(); c.setLineDash([]);
      c.fillStyle = COLORS.decision; c.strokeStyle = "#101216"; c.lineWidth = 2;
      c.beginPath(); c.arc(px(s), y, 5, 0, Math.PI * 2); c.fill(); c.stroke();
    }
  }

  function signalAt(event) {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const signal = Math.max(0, Math.min(10000, ((x - geometry.L) / (geometry.R - geometry.L)) * 10000));
    const travel = Math.max(0, Math.min(TRAVEL_MAX, ((geometry.B - y) / (geometry.B - geometry.T)) * TRAVEL_MAX));
    return { signal, travel };
  }
  function paint(event) {
    const { signal, travel } = signalAt(event);
    const index = Math.max(1, Math.min(CUSTOM_CURVE_POINTS, Math.round(signal / CUSTOM_CURVE_STEP))) - 1;
    if (lastIndex === null || lastIndex === index) draft = setCurvePoint(draft, index, travel);
    else {
      // Fill the grid points crossed between two pointer events (freehand).
      const from = lastIndex, start = draft[from], step = index > from ? 1 : -1;
      for (let j = from + step; step > 0 ? j <= index : j >= index; j += step)
        draft = setCurvePoint(draft, j, start + ((travel - start) * (j - from)) / (index - from));
    }
    lastIndex = index;
    render();
    onDraw(draft);
  }
  canvas.addEventListener("pointerdown", (event) => {
    if (!enabled || !geometry) return;
    dragging = true; lastIndex = null;
    canvas.setPointerCapture(event.pointerId);
    paint(event);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!geometry) return;
    if (dragging) paint(event);
    const { signal } = signalAt(event), x = Math.round(signal);
    const values = [HALL_CURVE_LINEAR, HALL_CURVE_OWLAB_TI, HALL_CURVE_CUSTOM]
      .map((id) => travelFromSignal(x, id, tableOf(id) ?? CUSTOM_CURVE_IDENTITY) * context.travelMm / TRAVEL_MAX);
    onHover({ signal: x, codes: context.span ? Math.round(context.span * x / 10000) : null, mm: values, names: CURVE_NAMES });
  });
  const stop = () => { dragging = false; lastIndex = null; };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  canvas.addEventListener("pointerleave", () => { if (!dragging) onHover(null); });

  return {
    render,
    draft: () => [...draft],
    setDraft(points) { draft = customCurveRecord([...points]); render(); },
    setDevice(points) { device = points ? customCurveRecord([...points]) : null; render(); },
    setEnabled(value) { enabled = !!value; canvas.classList.toggle("drawable", enabled); },
    setContext(next) { context = { ...context, ...next }; render(); },
    dirty: () => !device || device.some((v, i) => v !== draft[i]),
  };
}
