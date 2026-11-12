/** Practice visuals use the same observed-edge matches as the exported analysis.
 * No keyboard events, game grades, or hardware timestamps are synthesized here.
 */
export const TIMING_RANGE_MS = 150;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export const formatTiming = (value) => Number.isFinite(value)
  ? `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)} ms` : "—";
export const timingPosition = (value) => 50 + clamp(value, -TIMING_RANGE_MS, TIMING_RANGE_MS) / TIMING_RANGE_MS * 50;
export const practiceInputStart = (schedule) => schedule ? Math.min(schedule.countInMs,
  Math.min(...schedule.targets.map((target) => target.targetMs)) - Math.min(150, schedule.stepMs * .48)) : 0;

/** Pending targets and preparation movements never become successful judgments.
 * A target without an edge becomes 'unobserved' only after its matching window
 * is covered by samples, not merely because the animation clock passed it.
 */
export function timingEntries({ schedule, matches = [], extraEdges = [], lastSampleMs = -Infinity, elapsedMs = 0, active = false }) {
  if (!schedule || active && elapsedMs < practiceInputStart(schedule)) return [];
  const windowMs = Math.min(150, schedule.stepMs * .48);
  const entries = [];
  for (const match of matches) {
    if (match.edge && match.edge.timeMs <= elapsedMs) {
      const range = match.errorRangeMs;
      const uncertain = range && range[0] <= 0 && range[1] >= 0;
      entries.push({ ...match, id: match.id, atMs: match.edge.timeMs,
        state: uncertain ? "overlap" : match.errorMs < 0 ? "early" : match.errorMs > 0 ? "late" : "overlap" });
    } else if (!match.edge && match.targetMs + windowMs <= Math.min(lastSampleMs, elapsedMs)) {
      entries.push({ ...match, id: match.id, atMs: match.targetMs + windowMs, state: "unobserved" });
    }
  }
  // 'Extra' means outside a target association, not a successful extra note.
  const firstWindow = Math.min(...schedule.targets.map((target) => target.targetMs)) - windowMs;
  for (const edge of extraEdges) {
    if (edge.timeMs < firstWindow || edge.timeMs > elapsedMs) continue;
    entries.push({ id: edge.id, type: edge.type, edge, atMs: edge.timeMs, state: "extra", errorMs: null });
  }
  return entries.sort((a, b) => a.atMs - b.atMs);
}

/** Notes follow corrected targets, including the hold release envelope tail. */
export function laneNotes(schedule) {
  if (!schedule) return [];
  const targets = new Map(schedule.targets.map((target) => [target.id, target]));
  return schedule.cues.filter((cue) => cue.type !== "count-in").map((cue) => ({
    id: cue.id, type: cue.type, accent: cue.accent,
    pressMs: targets.get(`${cue.id}-press`)?.targetMs ?? cue.onMs,
    releaseMs: targets.get(`${cue.id}-release`)?.targetMs ?? cue.offMs,
  }));
}

export function describeTiming(entry) {
  if (!entry) return { verdict: "입력 대기", detail: "관측한 눌림과 해제의 타이밍이 여기에 표시됩니다.", value: "—" };
  const type = entry.type === "press" ? "눌림 ↓" : "해제 ↑";
  if (entry.state === "unobserved") return { verdict: `${type} · 입력 미관측`, detail: "대응 구간에서 상태 전환을 관측하지 못했습니다.", value: "—" };
  if (entry.state === "extra") return { verdict: `${type} · 목표 밖 입력`, detail: "관측한 전환에 대응하는 목표가 없습니다.", value: "—" };
  const direction = entry.state === "early" ? "EARLY" : entry.state === "late" ? "LATE" : "관측 범위 내";
  const range = entry.errorRangeMs;
  return { verdict: `${type} · ${direction}`, value: formatTiming(entry.errorMs),
    detail: range ? `관측 구간 ${formatTiming(range[0])} ~ ${formatTiming(range[1])}${entry.state === "overlap" ? " · 0 ms 포함" : ""}` : "관측 구간 정보 없음" };
}

function canvasContext(canvas) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * dpr), height = Math.round(rect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  return { c: context, w: rect.width, h: rect.height };
}

export class RhythmPracticeView {
  constructor(root = document) {
    this.root = root;
    this.get = (id) => this.root.getElementById(id);
  }
  render({ schedule, matches = [], extraEdges = [], samples = [], elapsedMs = 0,
    active = false, starting = false, hasResult = false, label = "Hall 키 선택", demo = false }) {
    if (!this.get("rhythmPractice")) return;
    const last = samples.at(-1), preparing = active && (starting || elapsedMs < practiceInputStart(schedule));
    const countingIn = active && (starting || elapsedMs < (schedule?.countInMs ?? 0));
    const entries = timingEntries({ schedule, matches, extraEdges, lastSampleMs: last?.timeMs ?? -Infinity, elapsedMs, active });
    const latest = entries.at(-1), description = describeTiming(latest);
    this.get("rhythmLaneKey").textContent = label;
    this.get("rhythmLaneKey").title = label;
    this.get("rhythmLaneKey").previousElementSibling.textContent = hasResult && !active ? "기록한 키" : "선택한 키";
    this.get("rhythmPractice").dataset.phase = preparing ? "preparing" : active ? "playing" : hasResult ? "result" : "idle";
    const phase = preparing ? "준비 · 입력 제외" : countingIn ? "첫 노트 준비" : active ? "연습 중" : hasResult ? "기록" : "미리 보기";
    this.get("rhythmPracticePhase").textContent = `${demo ? "데모 · " : ""}${phase}`;
    this.get("rhythmLaneState").textContent = preparing ? "손을 떼고 준비 박자를 들으세요" : active
      ? last ? last.pressed ? "현재 눌림 · 유지 중" : "현재 해제" : "센서 대기" : hasResult ? "측정 기록을 표시합니다" : "노트가 기준선에 닿을 때 누르세요";
    const verdict = preparing ? "준비 박자" : description.verdict;
    // Avoid repetitive live-region announcements during every animation frame.
    const verdictElement = this.get("rhythmTimingVerdict");
    if (verdictElement.textContent !== verdict) verdictElement.textContent = verdict;
    this.get("rhythmTimingValue").textContent = preparing ? "—" : description.value;
    this.get("rhythmTimingDetail").textContent = preparing ? "준비 음에는 입력 목표가 없습니다. 첫 노트부터 비교합니다." : description.detail;
    this.get("rhythmTimingCard").dataset.timing = latest?.state ?? "waiting";
    const hasTiming = !preparing && Boolean(latest?.edge) && Number.isFinite(latest?.errorMs);
    const marker = this.get("rhythmTimingMarker"), range = this.get("rhythmTimingRange");
    marker.hidden = !hasTiming; range.hidden = !hasTiming || !latest?.errorRangeMs;
    if (hasTiming) {
      marker.style.left = `${timingPosition(latest.errorMs)}%`;
      const bounds = latest.errorRangeMs;
      if (bounds) { const left = timingPosition(bounds[0]); range.style.left = `${left}%`; range.style.width = `${Math.max(.3, timingPosition(bounds[1]) - left)}%`; }
    }
    this.get("rhythmTimingMeter").setAttribute("aria-label", preparing ? "준비 박자, 입력 판정 대기" : `${description.verdict}, ${description.value}, ${description.detail}`);
    this.get("rhythmTimingCounts").textContent = `대응 ${entries.filter((entry) => entry.edge && Number.isFinite(entry.errorMs)).length} · 미관측 ${entries.filter((entry) => entry.state === "unobserved").length} · 목표 밖 ${entries.filter((entry) => entry.state === "extra").length}`;
    this.drawHistory(entries.filter((entry) => Number.isFinite(entry.errorMs)).slice(-24));
    this.drawLane({ schedule, elapsedMs, active, starting, hasResult, preparing, countingIn, pressed: Boolean(last?.pressed), label });
  }
  drawLane({ schedule, elapsedMs, active, starting, hasResult, preparing, countingIn, pressed, label }) {
    const surface = canvasContext(this.get("rhythmLane"));
    if (!surface) return;
    const { c, w, h } = surface, L = w * .22, R = w * .78, top = 12, line = h - 58;
    const lookahead = 1800, scale = (line - top) / lookahead;
    // A stationary preview shows the first note approaching the same line.
    const now = !active && !hasResult ? (schedule?.targets[0]?.targetMs ?? 2000) - 1000 : elapsedMs;
    const y = (time) => line - (time - now) * scale;
    c.fillStyle = "#0c1018"; c.fillRect(L, top, R - L, h - top - 12);
    const gradient = c.createLinearGradient(0, top, 0, line);
    gradient.addColorStop(0, "#72d4df03"); gradient.addColorStop(1, pressed && active && !preparing ? "#b4ed7826" : "#72d4df10");
    c.fillStyle = gradient; c.fillRect(L, top, R - L, line - top);
    c.strokeStyle = "#34404f"; c.lineWidth = 1;
    c.beginPath(); c.moveTo(L, top); c.lineTo(L, h - 12); c.moveTo(R, top); c.lineTo(R, h - 12); c.stroke();
    c.save(); c.beginPath(); c.rect(L + 1, top, R - L - 2, h - top - 12); c.clip();
    if (schedule) {
      for (let beat = Math.floor(now / schedule.quarterMs) - 1; beat * schedule.quarterMs < now + lookahead; beat++) {
        const py = y(beat * schedule.quarterMs);
        c.strokeStyle = beat % 4 === 0 ? "#6e7b8d45" : "#35425260";
        c.beginPath(); c.moveTo(L, py); c.lineTo(R, py); c.stroke();
      }
      for (const note of laneNotes(schedule)) {
        const head = y(note.pressMs), tail = y(note.releaseMs), nx = L + 12, nw = R - L - 24;
        if (head < top - 10 || tail > h + 12) continue;
        if (note.type === "hold") {
          const held = active && !preparing && pressed && now >= note.pressMs && now <= note.releaseMs;
          c.fillStyle = held ? "#b4ed785c" : "#72d4df35";
          c.fillRect(nx + nw * .2, tail, nw * .6, Math.max(2, head - tail));
          c.strokeStyle = held ? "#b4ed78" : "#72d4df85";
          c.strokeRect(nx + nw * .2, tail, nw * .6, Math.max(2, head - tail));
        }
        // Open release cap is distinct from the filled press head.
        c.strokeStyle = "#e8ad72"; c.lineWidth = 2; c.strokeRect(nx + 3, tail - 2, nw - 6, 5);
        c.fillStyle = note.accent ? "#d5f9b0" : "#b4ed78";
        c.fillRect(nx, head - 4, nw, 8);
        c.fillStyle = "#182311"; c.fillRect(nx + nw / 2 - 1, head - 2, 2, 4);
      }
    }
    c.restore();
    c.strokeStyle = pressed && active && !preparing ? "#d5f9b0" : "#e6e9ed"; c.lineWidth = 2;
    c.beginPath(); c.moveTo(L - 10, line); c.lineTo(R + 10, line); c.stroke();
    c.fillStyle = "#969eac"; c.font = "10px Segoe UI"; c.textAlign = "center"; c.fillText("입력 기준선", w / 2, line + 19);
    c.fillStyle = "#dce6ed"; c.font = "600 12px Segoe UI";
    c.fillText(active && pressed && !preparing ? "눌림 ↓" : "해제 ↑", w / 2, h - 13);
    if (preparing) {
      c.fillStyle = "#0c1018df"; c.fillRect(L + 2, top + 25, R - L - 4, 88);
      c.fillStyle = "#b4ed78"; c.font = "700 38px Segoe UI";
      c.fillText(starting || elapsedMs < 0 ? "준비" : `${Math.max(1, Math.ceil((schedule.countInMs - elapsedMs) / schedule.quarterMs))}`, w / 2, top + 75);
      c.fillStyle = "#aab6c5"; c.font = "11px Segoe UI"; c.fillText("COUNT IN", w / 2, top + 98);
    } else if (countingIn) {
      c.fillStyle = "#aab6c5"; c.font = "10px Segoe UI"; c.fillText("첫 노트 · 보정 목표", w / 2, top + 18);
    }
    this.get("rhythmLane").setAttribute("aria-label", `${label} 단일 노트 레인. 초록 실선은 눌림, 주황 빈 선은 해제, 연결된 꼬리는 유지 구간. ${preparing ? "준비 중" : active ? pressed ? "현재 눌림" : "현재 해제" : hasResult ? "측정 기록" : "정지 미리 보기"}.`);
  }
  drawHistory(entries) {
    const surface = canvasContext(this.get("rhythmTimingHistory"));
    if (!surface) return;
    const { c, w, h } = surface, L = 30, R = w - 30, T = 17, B = h - 20;
    const x = (error) => L + timingPosition(error) / 100 * (R - L);
    c.font = "10px Segoe UI"; c.textAlign = "center"; c.fillStyle = "#8291a5";
    for (const error of [-150, -75, 0, 75, 150]) {
      c.strokeStyle = error === 0 ? "#b4ed786b" : "#293443";
      c.beginPath(); c.moveTo(x(error), T); c.lineTo(x(error), B); c.stroke();
    }
    c.fillText("EARLY", x(-150) + 4, 9); c.fillText("0 ms", x(0), 9); c.fillText("LATE", x(150) - 3, 9);
    if (!entries.length) { c.fillStyle = "#969eac"; c.font = "12px Segoe UI"; c.fillText("최근 24개 관측이 쌓입니다", w / 2, (T + B) / 2); }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i], py = T + (i + .5) / Math.max(entries.length, 8) * (B - T);
      const color = entry.type === "press" ? "#b4ed78" : "#e8ad72";
      if (!Number.isFinite(entry.errorMs)) {
        c.fillStyle = "#969eac"; c.textAlign = "left"; c.fillText(entry.state === "extra" ? "목표 밖" : "미관측", L + 5, py + 3); c.textAlign = "center";
        continue;
      }
      if (entry.errorRangeMs) {
        c.strokeStyle = `${color}66`; c.lineWidth = 2; c.beginPath();
        c.moveTo(x(entry.errorRangeMs[0]), py); c.lineTo(x(entry.errorRangeMs[1]), py); c.stroke();
      }
      c.strokeStyle = color; c.fillStyle = color; c.lineWidth = 1.5;
      if (entry.type === "press") {
        c.beginPath(); c.moveTo(x(entry.errorMs), py + 3); c.lineTo(x(entry.errorMs) - 3, py - 2); c.lineTo(x(entry.errorMs) + 3, py - 2); c.closePath(); c.fill();
      } else { c.beginPath(); c.arc(x(entry.errorMs), py, 2.5, 0, Math.PI * 2); c.stroke(); }
    }
    c.fillStyle = "#8291a5"; c.textAlign = "left"; c.fillText("이전 ↑", 0, T + 7); c.fillText("최근 ↓", 0, h - 3);
    this.get("rhythmTimingHistory").setAttribute("aria-label", `최근 ${entries.length}개 타이밍 기록. ${entries.slice(-6).map((entry) => { const description = describeTiming(entry); return `${description.verdict} ${description.value}`; }).join("; ")}`);
  }
}
