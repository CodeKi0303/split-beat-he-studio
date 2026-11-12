import { analyzeAutoFit, evaluateAutoFit } from "./auto-fit.mjs?v=studio-retrigger1";

const $ = (id) => document.getElementById(id);
const clone = (value) => structuredClone(value);
const phases = [
  { id: "released", title: "손 떼기", seconds: 3, instruction: "선택한 키에서 손을 떼고 측정을 시작하세요." },
  { id: "resting", title: "손 얹기", seconds: 3, instruction: "평소 대기할 때처럼 손가락을 키에 가볍게 얹으세요." },
  { id: "tapping", title: "반복 입력", seconds: 10, instruction: "시작한 뒤 편한 속도로 6회 이상 눌렀다 떼세요. 마지막에는 손을 떼세요." },
  { id: "holding", title: "길게 유지", seconds: 5, instruction: "선택한 키를 평소 롱노트처럼 누른 채 다른 손으로 시작 버튼을 누르세요. 완료될 때까지 유지하세요." },
];
const settingNames = { actuation: "작동점", rt_press: "눌림 RT", rt_release: "복귀 RT", top_deadzone: "상단 데드존", bottom_deadzone: "하단 데드존" };

function fingerprint(context) {
  return JSON.stringify([context.identity, context.connected, context.info?.major, context.info?.minor, context.info?.patch, context.selected, context.profile,
    context.travelMm[context.selected], context.adcSetting]);
}

/** Explicit, bounded captures. Device writes are provided by the application. */
export class AutoFitWizard {
  constructor({ getContext, prepare, verify, apply, onChange, onLog }) {
    Object.assign(this, { getContext, prepare, verify, apply, onChange, onLog });
    this.active = this.starting = this.applying = false;
    this.generation = 0;
    this.phaseIndex = 0;
    this.phases = {};
    this.source = this.result = this.previous = null;
    this.applied = false;
    this.verification = null; this.retestSummary = "";
    $("autoFitStart").onclick = () => this.start();
    $("autoFitStop").onclick = () => this.stop("측정을 중단했습니다. 자세를 맞춘 뒤 다시 시작하세요.");
    $("autoFitReset").onclick = () => this.reset();
    $("autoFitApply").onclick = () => this.applyRecommendation();
    $("autoFitRetest").onclick = () => this.retest();
    $("autoFitExport").onclick = () => this.export();
    $("autoFitPreference").onchange = () => {
      if (this.active || this.applied) return;
      this.result = null;
      if (phases.every((p) => this.phases[p.id])) this.analyze();
      this.render();
    };
    $("autoFitSteps").replaceChildren(...phases.map((phase, index) => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "secondary";
      button.onclick = () => {
        if (this.active || this.applied) return;
        this.phaseIndex = index;
        this.result = null;
        this.render();
      };
      button.textContent = phase.title;
      return button;
    }));
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.stop("화면이 숨겨져 측정을 중단했습니다.");
    });
    window.addEventListener("pagehide", () => this.stop("페이지가 닫혀 측정을 중단했습니다."));
    this.render();
  }
  input() {
    return { keyConfig: clone(this.source.keyConfig), totalTravelMm: this.source.totalTravelMm,
      preference: $("autoFitPreference").value, phases: clone(this.phases) };
  }
  reset(message = "") {
    this.stop(message);
    this.phaseIndex = 0; this.phases = {};
    this.source = this.result = this.previous = null;
    this.applied = false;
    this.verification = null; this.retestSummary = "";
    $("autoFitState").textContent = message;
    this.render();
  }
  updateContext() {
    const context = this.getContext();
    if (this.source && !this.applying && fingerprint(context) !== this.source.fingerprint) {
      this.generation++;
      this.active = this.starting = false;
      clearInterval(this.timer);
      this.source = this.result = this.previous = null;
      this.phases = {}; this.phaseIndex = 0; this.applied = false;
      this.verification = null; this.retestSummary = "";
      $("autoFitState").textContent = "키 또는 설정이 바뀌었습니다. 새 설정으로 처음부터 측정하세요.";
    }
    if (this.active && !context.connected) this.stop("장치 연결이 끊겨 측정을 중단했습니다.");
    this.render();
  }
  render() {
    const context = this.getContext(), key = context.profile?.keys[context.selected];
    const retriggerEnabled = !!(key?.flags & 8);
    const available = context.available && context.selected < 14 && (key?.flags & 5) === 5 && !retriggerEnabled;
    const phase = phases[this.phaseIndex];
    if (!this.active) $("autoFitProgress").value = this.phases[phase.id] ? 1 : 0;
    $("autoFitKey").textContent = this.source?.label ?? (context.selected < 14 ? context.label : "Hall 키 선택");
    $("autoFitInstruction").textContent = retriggerEnabled ? "미해제 재입력을 끈 뒤 자동 맞춤을 진행하세요. 짧은 USB 해제·눌림은 이 측정으로 검증할 수 없습니다."
      : available || this.active ? phase.instruction : "캘리브레이션을 완료한 Hall 키를 선택하세요.";
    $("autoFitStart").textContent = `${phase.title} · ${phase.seconds}초 측정`;
    $("autoFitStart").disabled = !available || this.active || this.applying || this.applied;
    $("autoFitStop").disabled = !this.active || this.applying;
    $("autoFitReset").disabled = this.active || this.applying;
    $("autoFitPreference").disabled = this.active || this.applying || this.applied;
    $("autoFitApply").disabled = !available || this.active || this.applying || this.applied || !this.result?.ready;
    $("autoFitRetest").disabled = !available || this.active || this.applying || !this.applied;
    $("autoFitExport").disabled = this.active || this.applying || !Object.keys(this.phases).length;
    [...$("autoFitSteps").children].forEach((button, index) => {
      button.disabled = this.active || this.applying || this.applied || (index > 0 && !this.phases[phases[index - 1].id]);
      button.classList.toggle("active", index === this.phaseIndex);
      button.textContent = `${this.phases[phases[index].id] ? "✓ " : ""}${phases[index].title}`;
      button.setAttribute("aria-current", index === this.phaseIndex ? "step" : "false");
    });
    $("autoFitResults").hidden = !this.result;
    if (!this.result) return;
    $("autoFitReasons").textContent = this.result.ready
      ? this.verification ? "적용한 설정으로 다시 측정한 결과입니다." : "기록을 재생해 찾은 후보입니다. 적용 후 같은 동작으로 확인하세요."
      : this.result.reasons.join(" ");
    const candidate = this.result.recommendation;
    const list = $("autoFitValues"); list.replaceChildren();
    if (candidate) {
      const enabled = document.createElement("div");
      enabled.textContent = `래피드 트리거 ${candidate.config.flags & 2 ? "켜짐" : "꺼짐"}`; list.append(enabled);
      for (const [field, label] of Object.entries(settingNames)) {
        const item = document.createElement("div");
        item.textContent = `${label} ${(candidate.config[field] * this.source.totalTravelMm / 1000).toFixed(2)} mm`;
        list.append(item);
      }
    }
    $("autoFitMetrics").textContent = this.result.baseline && candidate
      ? `기록 재생 · 원래 설정 → 추천값\n${this.metricsComparison(this.result.baseline.metrics, candidate.metrics)}` : "";
    $("autoFitRetestSummary").textContent = this.retestSummary ?? "";
  }
  async start() {
    if ($("autoFitStart").disabled) return;
    const generation = ++this.generation;
    this.active = this.starting = true;
    this.rows = []; this.result = null; this.retestSummary = "";
    $("autoFitState").textContent = "키 출력을 끄고 센서를 확인합니다…";
    this.onChange();
    try {
      const context = await this.prepare();
      if (!this.active || generation !== this.generation) return;
      const currentFingerprint = fingerprint(context);
      if (this.source && currentFingerprint !== this.source.fingerprint) throw Error("측정 이후 설정이 바뀌었습니다. 처음부터 다시 측정하세요.");
      if (!this.source) this.source = { key: context.selected, label: context.label,
        keyConfig: clone(context.profile.keys[context.selected]), profile: clone(context.profile),
        totalTravelMm: context.travelMm[context.selected], fingerprint: currentFingerprint,
        demo: !!context.info.demo, hardwareRevision: context.info.board_rev,
        firmware: `${context.info.major}.${context.info.minor}.${context.info.patch}` };
      this.recordContext = { key: this.source.key };
      this.origin = this.lastSample = performance.now();
      this.starting = false;
      this.timer = setInterval(() => this.tick(), 50);
      this.tick(); this.onChange();
    } catch (error) { this.stop(error.message); this.onLog(error.message, true); }
  }
  ingest(side, status, requestTime, responseTime) {
    if (!this.active || this.starting || side !== Math.floor(this.source.key / 7)) return;
    if (!status.fresh || status.calibration_state || status.output_enabled) {
      this.stop("센서 신호나 출력 상태가 바뀌었습니다. 다시 측정하세요."); return;
    }
    const last = this.rows.at(-1), sequence = status.sample_sequence;
    if (last?.sequence === sequence) return;
    const timeMs = (requestTime + responseTime) / 2 - Math.max(0, status.link_age_us) / 1000 - this.origin;
    if (timeMs < 0) return;
    const delta = last ? (sequence - last.sequence) >>> 0 : 1;
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff ||
        (last && (timeMs <= last.timeMs || timeMs - last.timeMs > 100 || delta > 0x7fffffff))) {
      this.stop("수집 간격이 벌어졌습니다. 현재 단계를 다시 측정하세요."); return;
    }
    const key = this.source.key, raw = status.raw[key % 7];
    if (!Number.isInteger(raw) || raw < 0 || raw > 4095) { this.stop("센서 값을 확인할 수 없습니다."); return; }
    this.rows.push({ timeMs, raw, sequence, pressed: !!(status.pressed_mask & (1 << key)) });
    this.lastSample = responseTime;
  }
  tick() {
    if (!this.active || this.starting) return;
    const elapsed = performance.now() - this.origin, duration = phases[this.phaseIndex].seconds * 1000;
    if (performance.now() - this.lastSample > 300) { this.stop("센서 수집이 멈췄습니다. 현재 단계를 다시 측정하세요."); return; }
    $("autoFitProgress").value = Math.min(1, elapsed / duration);
    $("autoFitState").textContent = `${phases[this.phaseIndex].title} · ${Math.max(0, (duration - elapsed) / 1000).toFixed(1)}초 남음`;
    if (elapsed >= duration) this.finish();
  }
  async finish() {
    clearInterval(this.timer);
    this.starting = true;
    const generation = this.generation;
    try {
      await this.verify(this.source);
      if (!this.active || generation !== this.generation) return;
      if (this.rows.length < 40 || this.rows.at(-1).timeMs - this.rows[0].timeMs < 2000) throw Error("측정값이 부족합니다. 현재 단계를 다시 측정하세요.");
      this.phases[phases[this.phaseIndex].id] = this.rows;
      this.active = this.starting = false;
      $("autoFitProgress").value = 1;
      $("autoFitState").textContent = `${phases[this.phaseIndex].title} 완료`;
      if (phases.every((phase) => this.phases[phase.id])) this.analyze();
      else this.phaseIndex = Math.min(phases.length - 1, this.phaseIndex + 1);
      this.onChange(); this.render();
    } catch (error) { this.stop(error.message); this.onLog(error.message, true); }
  }
  analyze() {
    if (this.previous) {
      const checked = evaluateAutoFit(this.source.keyConfig, this.input());
      const original = evaluateAutoFit(this.previous.input.keyConfig, this.input());
      this.retestSummary = checked.ready && checked.observedMetrics && this.previous.result.observedMetrics
        ? `실제 관측 · 첫 측정 → 추천값 재시험\n${this.metricsComparison(this.previous.result.observedMetrics, checked.observedMetrics)}`
        : "재시험 기록을 충분히 확인할 수 없습니다. 안내된 단계를 다시 측정하세요.";
      this.verification = checked;
      this.applied = true;
      this.result = { ready: checked.ready, reasons: checked.reasons,
        baseline: original.ready ? { config: clone(this.previous.input.keyConfig), metrics: original.metrics } : null,
        recommendation: checked.ready ? { ...clone(this.previous.result.recommendation), config: clone(this.source.keyConfig),
          metrics: checked.metrics, changed: false, requiresRetest: false } : null,
        observedMetrics: checked.observedMetrics, limits: checked.limits };
      $("autoFitState").textContent = checked.ready && checked.observedMetrics
        ? "추천값 재시험을 마쳤습니다. 관측 결과와 손의 느낌을 확인하세요."
        : "재시험 기록이 부족합니다. 안내된 단계를 다시 측정하세요.";
    } else this.result = analyzeAutoFit(this.input());
  }
  metricsComparison(before, after) {
    return [
      ["손을 얹을 때 입력", "restActivations"], ["연타 누락", "missedTaps"],
      ["추가 연타", "extraTaps"], ["해제 누락", "missedReleases"], ["유지 중 해제", "holdDrops"],
    ].map(([label, field]) => `${label} ${before[field]} → ${after[field]}회`).join(" · ");
  }
  stop(message) {
    if (!this.active) return;
    this.generation++; this.active = this.starting = false;
    clearInterval(this.timer);
    $("autoFitState").textContent = message;
    this.onChange(); this.render();
  }
  async applyRecommendation() {
    if ($("autoFitApply").disabled) return;
    this.applying = true; this.onChange(); this.render();
    try {
      await this.apply(this.source, clone(this.result.recommendation.config));
      const context = this.getContext();
      this.applied = true;
      this.source.fingerprint = fingerprint(context);
      $("autoFitState").textContent = "선택한 키에 RAM 적용했습니다. 추천값 재시험 후 키보드에 저장하세요.";
    } catch (error) { this.onLog(error.message, true); $("autoFitState").textContent = error.message; }
    finally { this.applying = false; this.onChange(); this.render(); }
  }
  retest() {
    if ($("autoFitRetest").disabled) return;
    this.previous = { input: this.input(), result: clone(this.result) };
    this.source.keyConfig = clone(this.getContext().profile.keys[this.source.key]);
    this.source.profile = clone(this.getContext().profile);
    this.phases = {}; this.phaseIndex = 0; this.result = null; this.applied = false;
    this.retestSummary = ""; this.verification = null;
    $("autoFitState").textContent = "적용한 설정으로 같은 네 단계를 다시 측정합니다.";
    this.render();
  }
  export() {
    if ($("autoFitExport").disabled) return;
    const record = { schema: "split-beat-auto-fit-v1", ...this.input(), key: this.source.key,
      demo: this.source.demo, hardwareRevision: this.source.hardwareRevision, firmware: this.source.firmware,
      result: this.result, applied: this.applied, verification: this.verification ?? null, previous: this.previous };
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url;
    link.download = `split-beat-auto-fit-${this.source.key}-${Date.now()}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
