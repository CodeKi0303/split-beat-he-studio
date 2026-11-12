import { RhythmAudio } from "./rhythm-audio.mjs?v=studio-owlab1";
import { RhythmCapture, makeSchedule, matchTimingEdges } from "./rhythm-analysis.mjs?v=studio-rhythm-practice2";
import { recognizedTravel, recognizedTravelToMm } from "./recognized-travel.mjs?v=studio-recognized-travel1";
import { RhythmPracticeView, practiceInputStart, normalizeNoteSpeed, readNoteSpeed, saveNoteSpeed,
  noteLookaheadMs } from "./rhythm-visuals.mjs?v=studio-note-speed1";

const $ = (id) => document.getElementById(id);
const fmt = (v, n = 1) => Number.isFinite(v) ? v.toFixed(n) : "—";
const signed = (v) => Number.isFinite(v) ? `${v > 0 ? "+" : ""}${v.toFixed(1)} ms` : "—";
const controlIds = ["rhythmMode", "rhythmBpm", "rhythmDivision", "rhythmBars", "rhythmHoldSteps",
  "rhythmGapSteps", "rhythmOffset", "rhythmVolume"];

export class RhythmLab {
  constructor({ getContext, prepare, onChange, onLog }) {
    Object.assign(this, { getContext, prepare, onChange, onLog });
    this.audio = new RhythmAudio();
    this.practice = new RhythmPracticeView();
    this.active = false;
    this.starting = false;
    this.capture = null;
    this.result = null;
    this.generation = 0;
    this.lastSampleAt = null;
    this.events = [];
    this.frame = null;
    this.viewEnd = 8000;
    this.noteSpeed = readNoteSpeed();
    $("rhythmStart").onclick = () => this.start();
    $("rhythmStop").onclick = () => this.stop("사용자가 측정을 멈췄습니다.");
    $("rhythmExport").onclick = () => this.export();
    $("rhythmReanalyze").onclick = () => {
      if (this.active || !this.result?.samples?.length || !this.capture) return;
      try {
        const offset = Number($("rhythmOffset").value);
        if (!Number.isFinite(offset) || offset < -300 || offset > 300) throw Error("타이밍 보정은 −300~300ms입니다.");
        this.capture.schedule.settings.delayMs = offset;
        this.capture.schedule.settings.delayMode = "offset";
        for (const target of this.capture.schedule.targets) target.targetMs = target.soundMs + offset;
        this.result = { ...this.result, ...this.capture.snapshot(), reanalyzed: true };
        this.renderResult();
        this.updateContext();
        $("rhythmState").textContent = `기록의 보정 목표만 ${signed(offset)}로 다시 비교했습니다. 센서 데이터와 키보드 설정은 그대로입니다.`;
      } catch (error) { this.onLog(error.message, true); }
    };
    $("rhythmApplyOffset").onclick = () => {
      const proposal = this.result?.summary?.recommendation?.personalOffset;
      const value = proposal?.withinRange ? proposal.offsetMs : null;
      if (!this.active && Number.isFinite(value)) {
        $("rhythmOffset").value = Math.round(Math.max(-300, Math.min(300, value)));
        this.settingsChanged();
        $("rhythmOffsetSuggestion").textContent = `다음 측정의 목표를 ${signed(Number($("rhythmOffset").value))} 이동합니다. 키보드 설정은 바꾸지 않았습니다.`;
      }
    };
    for (const id of controlIds) $(id).addEventListener("change", () => this.settingsChanged());
    // This control stays available during capture and never rebuilds timing.
    $("rhythmNoteSpeed").oninput = () => this.noteSpeedChanged($("rhythmNoteSpeed").value);
    this.noteSpeedChanged(this.noteSpeed, false);
    $("rhythmScrub").oninput = () => {
      this.viewEnd = Number($("rhythmScrub").value);
      this.draw();
    };
    window.addEventListener("resize", () => this.draw());
    window.addEventListener("pagehide", () => this.stop("페이지가 닫혀 측정을 중단했습니다."));
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && this.active) this.stop("화면이 숨겨져 측정을 중단했습니다.");
    });
    this.settingsChanged();
  }
  noteSpeedChanged(value, persist = true) {
    this.noteSpeed = normalizeNoteSpeed(value);
    const multiplier = `${this.noteSpeed.toFixed(1)}×`;
    const duration = `${(noteLookaheadMs(this.noteSpeed) / 1000).toFixed(3)}초`;
    $("rhythmNoteSpeed").value = this.noteSpeed;
    $("rhythmNoteSpeed").setAttribute("aria-valuetext", `${multiplier}, 등장부터 기준선까지 ${duration}`);
    $("rhythmNoteSpeedValue").textContent = multiplier;
    $("rhythmNoteSpeedDuration").textContent = `등장 → 기준선 ${duration}`;
    if (persist) saveNoteSpeed(this.noteSpeed);
    this.drawPractice();
  }
  settings() {
    return { bpm: Number($("rhythmBpm").value), division: Number($("rhythmDivision").value),
      bars: Number($("rhythmBars").value), mode: $("rhythmMode").value,
      holdSteps: Number($("rhythmHoldSteps").value), gapSteps: Number($("rhythmGapSteps").value),
      delayMs: Number($("rhythmOffset").value), delayMode: "offset" };
  }
  settingsChanged() {
    $("rhythmHoldSettings").hidden = $("rhythmMode").value !== "hold";
    try {
      const schedule = makeSchedule(this.settings());
      this.previewSchedule = schedule;
      $("rhythmGridInfo").textContent = `4/4 · 한 칸 ${fmt(schedule.stepMs)} ms · 준비 포함 ${fmt(schedule.durationMs / 1000, 0)}초`;
      this.settingsError = null;
    } catch (error) {
      this.previewSchedule = null;
      this.settingsError = error.message;
      $("rhythmGridInfo").textContent = error.message;
    }
    this.updateContext();
  }
  updateContext() {
    const context = this.getContext();
    const retriggerEnabled = (context.profile?.keys[context.selected]?.flags & 10) === 10;
    const valid = !retriggerEnabled && context.available && context.selected < 14 && Boolean(context.profile?.keys[context.selected]?.flags & 4)
      && Boolean(context.profile?.keys[context.selected]?.flags & 1);
    $("rhythmStart").disabled = this.active || !valid || Boolean(this.settingsError);
    $("rhythmStart").title = retriggerEnabled ? "미해제 재입력을 끈 뒤 측정하세요. USB 재입력 펄스는 이 센서 측정으로 검증할 수 없습니다." : "";
    $("rhythmStop").disabled = !this.active;
    for (const id of controlIds) $(id).disabled = this.active;
    $("rhythmExport").disabled = this.active || !this.result?.samples?.length;
    $("rhythmReanalyze").disabled = this.active || !this.result?.samples?.length;
    const proposal = this.result?.summary?.recommendation?.personalOffset;
    $("rhythmApplyOffset").disabled = this.active || !proposal?.withinRange || !Number.isFinite(proposal?.offsetMs);
    $("rhythmKey").textContent = this.active && this.recordContext ? this.recordContext.label
      : context.selected < 14 ? context.label : "Hall 키를 선택하세요";
    this.drawPractice();
  }
  async start() {
    if (this.active || $("rhythmStart").disabled) return;
    let settings, context;
    try {
      settings = this.settings();
      makeSchedule(settings);
      context = this.getContext();
      // Validate before stopping PC output. Audio starts only from this button.
      new RhythmCapture({ settings, keyConfig: context.profile.keys[context.selected],
        totalTravelMm: context.travelMm[context.selected], key: context.selected });
    } catch (error) { this.onLog(error.message, true); return; }
    const generation = ++this.generation;
    this.active = this.starting = true;
    this.capture = this.result = null;
    this.events = [];
    this.visualMatches = null;
    this.audioMeta = null;
    this.origin = null;
    this.lastSampleAt = performance.now();
    this.startedAt = performance.now();
    this.finishReason = null;
    this.outputStopped = false;
    this.recordContext = { key: context.selected, label: context.label,
      binding: structuredClone(context.profile.bindings[context.selected]), demo: context.info.demo,
      hardwareRevision: context.info.board_rev,
      firmware: `${context.info.major}.${context.info.minor}.${context.info.patch}`, totalTravelMm: context.travelMm[context.selected] };
    $("rhythmState").textContent = "키 출력을 끄고 측정을 준비합니다…";
    $("rhythmRows").replaceChildren();
    $("rhythmScrubLabel").hidden = true;
    this.onChange();
    try {
      this.capture = new RhythmCapture({ settings, keyConfig: context.profile.keys[context.selected],
        totalTravelMm: this.recordContext.totalTravelMm, key: context.selected });
      this.schedule = this.capture.schedule;
      await this.audio.start(this.schedule, { mode: settings.mode, volume: Number($("rhythmVolume").value),
        beforeSchedule: async () => {
          const fresh = await this.prepare();
          this.outputStopped = true;
          if (!this.active || generation !== this.generation) throw Error("측정 시작이 취소되었습니다.");
          this.capture = new RhythmCapture({ settings, keyConfig: fresh.profile.keys[context.selected],
            totalTravelMm: this.recordContext.totalTravelMm, key: context.selected });
          this.schedule = this.capture.schedule;
        },
        onReady: (metadata) => {
          if (!this.active || generation !== this.generation) { this.audio.stop(); return; }
          this.audioMeta = metadata;
          this.origin = metadata.originPerformanceMs;
          this.starting = false;
          this.lastSampleAt = performance.now();
          this.lastDraw = this.lastPracticeDraw = 0;
          this.animate();
        },
        onEvent: (event) => {
          if (!this.active || generation !== this.generation || this.origin === null) return;
          this.events.push(event);
          if (event.type !== "count-in" && (event.kind === "on" || settings.mode === "hold"))
            this.capture.setSoundEvent({ id: event.id, kind: event.kind,
              // Release targets use scheduled silence, after the short fade.
              timeMs: event.performanceMs - this.origin + (event.kind === "off" ? event.tailMs ?? 0 : 0) });
        },
        onAbort: (reason) => { if (generation === this.generation) this.stop(`오디오가 중단되었습니다: ${reason}`); },
      });
    } catch (error) {
      if (generation === this.generation) {
        this.stop(`측정을 시작하지 못했습니다: ${error.message}`);
        this.onLog(error.message, true);
      }
    }
  }
  ingest(side, status, requestTime, responseTime) {
    if (!this.active || this.starting || !this.capture || this.origin === null || side !== Math.floor(this.recordContext.key / 7)) return;
    if (!status.fresh || status.calibration_state) { this.stop("센서 신호 또는 보정 상태가 바뀌어 중단했습니다."); return; }
    if (status.output_enabled) { this.stop("다른 설정에서 키 출력이 켜져 측정을 중단했습니다."); return; }
    const offset = this.recordContext.key % 7;
    const timeMs = (requestTime + responseTime) / 2 - Math.max(0, status.link_age_us) / 1000 - this.origin;
    const accepted = this.capture.addSample({ timeMs, raw: status.raw[offset], travel: status.travel[offset],
      pressed: Boolean(status.pressed_mask & (1 << this.recordContext.key)), sequence: status.sample_sequence,
      fresh: status.fresh, calibrationState: status.calibration_state,
      requestMs: requestTime - this.origin, responseMs: responseTime - this.origin });
    if (accepted) this.lastSampleAt = responseTime;
    if (this.capture.stopped) this.stop("샘플 수 제한에 도달했습니다.");
  }
  animate() {
    if (!this.active || this.starting) return;
    const now = performance.now(), elapsed = now - this.origin;
    if (now - this.lastSampleAt > 500) { this.stop("새 센서값이 0.5초 이상 없어 중단했습니다."); return; }
    if (elapsed >= this.schedule.durationMs) { this.stop("측정을 완료했습니다.", true); return; }
    if (!this.lastDraw || now - this.lastDraw > 50) {
      this.lastDraw = now;
      this.viewEnd = Math.max(8000, elapsed + 800);
      const left = this.schedule.countInMs - elapsed;
      $("rhythmState").textContent = elapsed < practiceInputStart(this.schedule) ? `한 마디 준비 · ${Math.min(4, Math.max(1, Math.ceil(left / this.schedule.quarterMs)))}박 남음 · 모든 키에서 손을 떼세요`
        : left > 0 ? "첫 노트를 준비하세요 · 타이밍 보정이 반영된 입력 기준선을 따르세요"
        : `${this.recordContext.demo ? "데모 · " : ""}${this.recordContext.label} · ${this.schedule.settings.mode === "hold" ? "음이 이어지는 동안 유지 → 소리가 끊기면 해제" : "박자에 맞춰 누르고 놓으세요"} · ${fmt(elapsed / 1000, 0)} / ${fmt(this.schedule.durationMs / 1000, 0)}초`;
      const last = this.capture.samples.at(-1);
      $("rhythmLive").textContent = last ? `${fmt(last.recognizedMm, 2)} mm · ${last.pressed ? "눌림" : "해제"}` : "샘플 대기";
      $("rhythmEdges").textContent = `${this.capture.edges.filter((e) => e.type === "press").length} / ${this.capture.edges.filter((e) => e.type === "release").length}`;
      this.drawChart();
    }
    // Keep falling notes smooth without recomputing the sensor graph or the
    // complete statistical analysis on every animation frame.
    if (!this.lastPracticeDraw || now - this.lastPracticeDraw >= 1000 / 60) {
      this.lastPracticeDraw = now;
      this.drawPractice(elapsed);
    }
    this.frame = requestAnimationFrame(() => this.animate());
  }
  stop(reason = "측정을 멈췄습니다.", completed = false) {
    if (!this.active) return;
    this.active = this.starting = false;
    this.generation++;
    this.audio.stop();
    cancelAnimationFrame(this.frame);
    this.frame = null;
    this.finishReason = reason;
    if (this.capture) {
      this.result = { schema: "split-rhythm-capture-v1", createdAt: new Date().toISOString(),
        completed, reason, context: this.recordContext, audio: this.audioMeta, audioEvents: this.events,
        keyConfig: structuredClone(this.capture.keyConfig),
        acquiredSettings: structuredClone(this.capture.schedule.settings),
        releaseAudioReference: "Hold release uses scheduled envelope silence (off event plus tailMs); taps use the half-step logical release target.",
        sampleClock: "Host request/response midpoint minus reported source age; not hardware edge timestamps. Right source age excludes prior RS485 transit.",
        ...this.capture.snapshot() };
      this.renderResult();
    }
    $("rhythmState").textContent = reason + (this.outputStopped ? " 키 출력은 꺼진 상태입니다." : "");
    this.onChange();
  }
  renderResult() {
    const s = this.result.summary;
    $("rhythmPressError").textContent = signed(s.press.medianMs);
    $("rhythmReleaseError").textContent = signed(s.release.medianMs);
    $("rhythmEdges").textContent = `${this.result.edges.filter((e) => e.type === "press").length} / ${this.result.edges.filter((e) => e.type === "release").length}`;
    $("rhythmTargetDepth").textContent = `${fmt(s.recommendation.actuation.mm, 2)} mm`;
    const method = this.audioMeta?.timing?.method === "output-timestamp" ? "오디오 출력 타임스탬프" : "오디오 지연 추정";
    $("rhythmSampleInfo").textContent = `${this.recordContext.demo ? "시뮬레이션 · " : ""}${this.recordContext.label} · ${s.sampleCount}샘플 · 관측 ${fmt(s.observedSnapshotHz, 0)} Hz · 최대 간격 ${fmt(s.maxObservedGapMs)} ms · 누락 구간 ${s.counts.gaps} · ${method}`;
    const candidate = s.recommendation.personalOffset?.withinRange ? s.recommendation.personalOffset.offsetMs : null;
    $("rhythmOffsetSuggestion").textContent = Number.isFinite(candidate)
      ? `개인 타이밍 제안 ${signed(candidate)} · 하드웨어 지연이 아닌 반복 입력의 중앙값입니다. 다음 측정부터 선택 적용할 수 있습니다.`
      : "개인 보정값은 소리에 대응한 눌림이 8회 이상 관측되면 제안합니다. 처음에는 0ms를 유지하세요.";
    if (s.settings.mode === "hold") {
      const covered = s.holds.filter((h) => h.continuousCoverage), drops = covered.reduce((n, h) => n + h.earlyReleaseCount, 0);
      const r = s.recommendation.rtRelease;
      $("rhythmHoldSummary").textContent = `연속 관측 ${covered.length}/${s.holds.length}음 · 유지 중 해제 ${drops}회. ` +
        (r.compatible ? `복귀 RT 참고 범위: 유지하려면 ${fmt(r.minimumToHoldNormalized * this.recordContext.totalTravelMm / 1000, 2)} mm 이상, 목표 해제까지 약 ${fmt(r.mm, 2)} mm. 자동 적용하지 않습니다.` : r.note);
    } else $("rhythmHoldSummary").textContent = `목표 ${s.matchedTargets}회 대응 · 추가 판정 ${s.extraEdges.length}회. 목표 깊이는 최초 작동점의 참고값이며 RT 재입력과 다를 수 있습니다.`;
    const fragment = document.createDocumentFragment();
    for (const match of s.matches) {
      const tr = document.createElement("tr");
      const fields = [`${fmt(match.targetMs / 1000, 2)} s`, match.type === "press" ? "눌림" : "해제",
        signed(match.rawSoundErrorMs), signed(match.errorMs), `${fmt(match.depthAtTarget
          ? recognizedTravelToMm(match.depthAtTarget.normalized, this.result.keyConfig, this.recordContext.totalTravelMm) : null, 2)} mm`,
        match.errorRangeMs ? `${signed(match.errorRangeMs[0])} ~ ${signed(match.errorRangeMs[1])}` : "미관측"];
      for (const value of fields) { const td = document.createElement("td"); td.textContent = value; tr.append(td); }
      if (!match.edge) tr.classList.add("miss");
      fragment.append(tr);
    }
    $("rhythmRows").replaceChildren(fragment);
    const final = this.result.samples.at(-1)?.timeMs ?? 0;
    this.viewEnd = Math.max(8000, final + 100);
    $("rhythmScrub").max = this.viewEnd;
    $("rhythmScrub").min = Math.min(8000, this.viewEnd);
    $("rhythmScrub").value = this.viewEnd;
    $("rhythmScrubLabel").hidden = final <= 8000;
    this.draw();
  }
  draw() {
    this.drawChart();
    this.drawPractice();
  }
  drawPractice(elapsedMs) {
    const source = this.active ? this.capture : this.result;
    const schedule = source?.schedule ?? this.previewSchedule;
    const samples = source?.samples ?? [];
    let matches = this.result?.summary?.matches ?? [], extraEdges = this.result?.summary?.extraEdges ?? [];
    if (this.active && this.capture) {
      const signature = `${this.capture.edges.length}:${this.events.length}`;
      if (!this.visualMatches || signature !== this.visualMatches.signature) {
        this.visualMatches = { signature, ...matchTimingEdges(schedule.targets, this.capture.edges, Math.min(150, schedule.stepMs * .48)) };
      }
      ({ matches, extraEdges } = this.visualMatches);
    }
    const context = this.getContext(), recorded = Boolean(source && this.recordContext);
    this.practice.render({ schedule, matches, extraEdges, samples,
      elapsedMs: elapsedMs ?? (this.active ? this.origin === null ? 0 : performance.now() - this.origin
        : Math.min(samples.at(-1)?.timeMs ?? 0, this.viewEnd)),
      active: this.active, starting: this.starting, hasResult: Boolean(this.result), noteSpeed: this.noteSpeed,
      label: recorded ? this.recordContext.label : context.selected < 14 ? context.label : "Hall 키를 선택하세요",
      demo: recorded ? this.recordContext.demo : Boolean(context.info?.demo) });
  }
  drawChart() {
    const canvas = $("rhythmChart"), rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
    const c = canvas.getContext("2d"), w = rect.width, h = rect.height;
    c.scale(dpr, dpr); c.font = "11px Segoe UI";
    const capture = this.active ? this.capture : this.result, samples = capture?.samples ?? [];
    const schedule = capture?.schedule, total = this.recordContext?.totalTravelMm ?? 4;
    const L = 48, R = w - 12, T = 25, B = h - 54, end = this.viewEnd, begin = end - 8000;
    const x = (t) => L + (t - begin) / 8000 * (R - L), y = (v) => B - v / 1000 * (B - T);
    c.strokeStyle = "#293443"; c.fillStyle = "#8792a4";
    for (let i = 0; i <= 4; i++) {
      const py = y(i * 250); c.beginPath(); c.moveTo(L, py); c.lineTo(R, py); c.stroke();
      c.fillText(`${fmt(total * i / 4, 1)}`, 4, py + 4);
    }
    c.fillText("mm", 3, 12);
    for (let time = Math.ceil(begin / 1000) * 1000; time <= end; time += 1000) c.fillText(`${time / 1000}s`, x(time) - 7, h - 7);
    if (!samples.length && !schedule) { c.fillText("측정하면 센서 깊이와 판정이 여기에 표시됩니다.", L + 15, 85); return; }
    c.save(); c.beginPath(); c.rect(L, T - 16, R - L, h - T - 2); c.clip();
    const config = this.active ? this.capture?.keyConfig : this.result?.keyConfig;
    if (config) {
      c.fillStyle = "#b4ed7812"; c.fillRect(L, y(1000), R - L, y(1000 - (config.bottom_deadzone ?? 0)) - y(1000));
      c.fillStyle = "#8594a912"; c.fillRect(L, y(config.top_deadzone), R - L, y(0) - y(config.top_deadzone));
      c.strokeStyle = "#b4ed7866"; c.setLineDash([5, 5]); c.beginPath(); c.moveTo(L, y(config.actuation)); c.lineTo(R, y(config.actuation)); c.stroke(); c.setLineDash([]);
    }
    for (const cue of schedule?.cues ?? []) {
      if (cue.type === "hold") { c.fillStyle = "#e8ad7210"; c.fillRect(x(cue.onMs), T, x(cue.offMs)-x(cue.onMs), B-T); }
    }
    for (const target of schedule?.targets ?? []) {
      if (target.soundMs >= begin && target.soundMs <= end) {
        c.strokeStyle = "#8594a94d"; c.beginPath(); c.moveTo(x(target.soundMs), T); c.lineTo(x(target.soundMs), B); c.stroke();
      }
      if (target.targetMs >= begin && target.targetMs <= end) {
        c.strokeStyle = target.type === "press" ? "#e8ad72" : "#e8ad7280";
        c.setLineDash([3, 4]); c.beginPath(); c.moveTo(x(target.targetMs), T); c.lineTo(x(target.targetMs), B + 20); c.stroke(); c.setLineDash([]);
        c.fillStyle = "#b7a18c"; c.fillText(target.type === "press" ? "↓" : "↑", x(target.targetMs)-3, T-5);
      }
    }
    c.strokeStyle = "#72d4df"; c.lineWidth = 1.7; c.beginPath();
    let previous = null;
    for (const sample of samples) {
      if (sample.timeMs < begin - 100 || sample.timeMs > end) continue;
      const displayed = sample.recognizedTravel ?? recognizedTravel(sample.travel, config);
      if (!previous || sample.segment !== previous.segment) c.moveTo(x(sample.timeMs), y(displayed));
      else c.lineTo(x(sample.timeMs), y(displayed));
      previous = sample;
    }
    c.stroke();
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i-1], b = samples[i];
      if (a.pressed && a.segment === b.segment && b.timeMs >= begin && a.timeMs <= end) {
        c.fillStyle = "#b4ed78"; c.fillRect(x(a.timeMs), B+11, Math.max(1, x(b.timeMs)-x(a.timeMs)), 7);
      }
    }
    for (const edge of capture?.edges ?? []) {
      if (edge.timeMs < begin || edge.timeMs > end) continue;
      c.fillStyle = edge.type === "press" ? "#b4ed7840" : "#ff9e9c40";
      c.fillRect(x(edge.earliestMs), T, Math.max(1, x(edge.latestMs)-x(edge.earliestMs)), B-T);
      c.fillStyle = edge.type === "press" ? "#b4ed78" : "#ff9e9c";
      c.beginPath(); c.arc(x(edge.timeMs), y(recognizedTravel(edge.depthNormalized, config)), 3, 0, Math.PI*2); c.fill();
    }
    c.restore();
  }
  export() {
    if (!this.result || this.active) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(this.result, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url;
    link.download = `split-rhythm-${this.result.context.demo ? "DEMO-" : ""}${this.result.context.key}-${Date.now()}.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}
