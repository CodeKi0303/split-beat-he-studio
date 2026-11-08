// Web Audio owns the sound clock; the JS timer only fills a short lookahead.
// Output timestamps estimate device playout, not microphone-measured acoustics.
const MAX_DURATION_MS = 120000;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const optionalLatency = (value) => finite(value) && value >= 0 && value < 5 ? value : null;

export function audioPerformanceTime(context, audioTime, now = performance.now()) {
  if (!finite(audioTime) || audioTime < 0 || !finite(now)) throw Error("Invalid audio timestamp");
  const base = optionalLatency(context.baseLatency);
  const output = optionalLatency(context.outputLatency);
  let stamp;
  try { stamp = context.getOutputTimestamp?.(); } catch { /* Older/busy audio backend. */ }
  if (stamp && finite(stamp.contextTime) && finite(stamp.performanceTime) &&
      stamp.contextTime >= 0 && stamp.performanceTime > 0 &&
      Math.abs(now - stamp.performanceTime) < 1000 &&
      stamp.contextTime <= context.currentTime + .02) {
    return {
      performanceMs: stamp.performanceTime + (audioTime - stamp.contextTime) * 1000,
      method: "output-timestamp",
      baseLatencyMs: base === null ? null : base * 1000,
      outputLatencyMs: output === null ? null : output * 1000,
      acousticMeasured: false,
    };
  }
  return {
    performanceMs: now + (audioTime - context.currentTime + (base ?? 0) + (output ?? 0)) * 1000,
    method: "latency-estimate-fallback",
    baseLatencyMs: base === null ? null : base * 1000,
    outputLatencyMs: output === null ? null : output * 1000,
    latencyUnknown: base === null || output === null,
    acousticMeasured: false,
  };
}

export function validateAudioSchedule(schedule, mode = "tap") {
  if (!["tap", "hold"].includes(mode)) throw Error("Audio mode must be tap or hold");
  const source = Array.isArray(schedule) ? schedule : schedule?.cues ?? schedule?.events;
  if (!Array.isArray(source) || source.length < 1 || source.length > 1024)
    throw Error("Audio schedule requires 1..1024 notes");
  const ids = new Set();
  const notes = source.map((event, index) => {
    if (!event || typeof event !== "object") throw Error("Invalid audio note");
    const id = event.id ?? index;
    if (!["number", "string"].includes(typeof id) || ids.has(String(id))) throw Error("Duplicate/invalid audio note ID");
    ids.add(String(id));
    const onsetMs = event.onsetMs ?? event.onMs;
    const kind = event.type === "count-in" ? "count-in" : event.type ?? mode;
    if (!["tap", "hold", "count-in"].includes(kind)) throw Error("Invalid note type");
    const suppliedOff = event.offsetMs ?? event.offMs;
    const offsetMs = suppliedOff ?? (kind === "hold" ? NaN : onsetMs + 35);
    if (!finite(onsetMs) || !finite(offsetMs) || onsetMs < 0 || offsetMs <= onsetMs ||
        offsetMs > MAX_DURATION_MS || onsetMs > MAX_DURATION_MS)
      throw Error("Notes need increasing onset/off times within 120 seconds");
    const toneOffMs = kind === "hold" ? offsetMs : Math.min(offsetMs, onsetMs + 35);
    return { id, onsetMs, offsetMs, toneOffMs, type: kind, accent: Boolean(event.accent) };
  }).sort((a, b) => a.onsetMs - b.onsetMs);
  // Protect audio resource use even if a caller supplies overlapping long notes.
  const changes = notes.flatMap((note) => [[note.onsetMs, 1], [note.toneOffMs, -1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  for (const [, delta] of changes) {
    active += delta;
    if (active > 8) throw Error("No more than 8 simultaneous audio notes");
  }
  return notes;
}

export class RhythmAudio {
  constructor({
    createContext = () => {
      const Audio = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!Audio) throw Error("이 브라우저에서 Web Audio를 사용할 수 없습니다.");
      return new Audio({ latencyHint: "interactive" });
    },
    now = () => performance.now(),
    every = (fn, ms) => setInterval(fn, ms),
    clearEvery = (id) => clearInterval(id),
    warmup = () => new Promise((resolve) => setTimeout(resolve, 30)),
    document = globalThis.document,
    page = globalThis,
  } = {}) {
    Object.assign(this, { createContext, now, every, clearEvery, warmup, document, page });
    this.nodes = new Set();
    this.running = false;
    this.generation = 0;
    this.timer = null;
  }

  async start(schedule, {
    mode = "tap", volume = .25, onReady = () => {}, onEvent = () => {},
    onAbort = () => {}, onComplete = () => {}, beforeSchedule = async () => {},
  } = {}) {
    const notes = validateAudioSchedule(schedule, mode);
    if (!finite(volume) || volume < 0 || volume > 1) throw Error("Volume must be 0..1");
    if (this.document?.hidden) throw Error("측정 탭을 화면에 표시한 뒤 시작하세요.");
    this.stop();
    const generation = this.generation;
    const context = this.createContext();
    this.context = context;
    this.onAbort = onAbort;
    this.onComplete = onComplete;
    this.onEvent = onEvent;
    try {
      // Called synchronously from a click, before the first await, to preserve
      // the browser user-activation requirement for starting audio.
      await context.resume();
      if (generation !== this.generation) throw Error("오디오 시작이 취소되었습니다.");
      // Device preparation may await USB. Unlock audio while user activation
      // exists, but schedule no sound until the explicit preflight succeeds.
      await beforeSchedule();
      if (generation !== this.generation) throw Error("오디오 시작이 취소되었습니다.");
      await this.warmup();
      if (generation !== this.generation) throw Error("오디오 시작이 취소되었습니다.");
      if (context.state !== "running") throw Error("오디오 재생이 허용되지 않았습니다. 시작 버튼을 다시 눌러 주세요.");
      this.master = context.createGain();
      this.master.gain.setValueAtTime(volume * .32, context.currentTime);
      this.master.connect(context.destination);
      this.notes = notes;
      this.noteIndex = this.edgeIndex = 0;
      this.originAudioTime = context.currentTime + .25;
      const origin = audioPerformanceTime(context, this.originAudioTime, this.now());
      this.metadata = {
        originAudioTime: this.originAudioTime, originPerformanceMs: origin.performanceMs,
        durationMs: Math.max(...notes.map((n) => n.offsetMs)),
        timing: { ...origin, note: "오디오 출력 장치 시점의 브라우저 추정값입니다. 실제 들리는 순간을 마이크로 측정한 값은 아닙니다." },
      };
      this.edges = notes.flatMap((note) => {
        const onset = { id: note.id, kind: "on", relativeMs: note.onsetMs, type: note.type, tailMs: 0 };
        // Tap release is a logical rhythm target, not the end of the 35ms click.
        return note.type === "hold" ? [onset,
          { id: note.id, kind: "off", relativeMs: note.offsetMs, type: note.type, tailMs: 12 },
        ] : [onset];
      }).sort((a, b) => a.relativeMs - b.relativeMs);
      this.endAudioTime = this.originAudioTime + this.metadata.durationMs / 1000 + .012;
      this.lastTickMs = this.now();
      this.running = true;
      this.visibility = () => {
        if (this.document?.hidden) this._abort("탭이 숨겨져 리듬 측정을 중단했습니다.");
      };
      this.pageHide = () => this._abort("페이지 이동으로 리듬 측정을 중단했습니다.");
      this.stateChange = () => {
        if (this.running && context.state !== "running") this._abort("오디오 장치가 일시 정지되거나 연결이 끊겼습니다.");
      };
      this.sinkChange = () => this._abort("오디오 출력 장치가 변경되어 측정을 중단했습니다.");
      this.audioError = () => this._abort("오디오 출력 오류로 측정을 중단했습니다.");
      this.document?.addEventListener?.("visibilitychange", this.visibility);
      this.page?.addEventListener?.("pagehide", this.pageHide);
      context.addEventListener?.("statechange", this.stateChange);
      context.addEventListener?.("sinkchange", this.sinkChange);
      context.addEventListener?.("error", this.audioError);
      onReady(this.metadata);
      this._pump();
      if (this.running) this.timer = this.every(() => this._pump(), 25);
      return this.metadata;
    } catch (error) {
      if (generation === this.generation) this.stop();
      else { try { await context.close(); } catch { /* Already closed. */ } }
      throw error;
    }
  }

  _pump() {
    if (!this.running) return;
    try {
      const context = this.context;
      const now = this.now();
      if (now - this.lastTickMs > 250) throw Error("브라우저 처리 지연으로 오디오 예약을 유지하지 못했습니다.");
      this.lastTickMs = now;
      if (context.state !== "running") throw Error("오디오가 정지되어 측정을 중단했습니다.");
      const horizon = context.currentTime + .15;
      while (this.noteIndex < this.notes.length) {
        const note = this.notes[this.noteIndex];
        const onset = this.originAudioTime + note.onsetMs / 1000;
        if (onset > horizon) break;
        if (onset < context.currentTime + .005) throw Error("소리 예약 시점을 놓쳤습니다. 측정을 다시 시작하세요.");
        this._voice(note, onset, this.originAudioTime + note.toneOffMs / 1000);
        this.noteIndex++;
      }
      while (this.edgeIndex < this.edges.length) {
        const edge = this.edges[this.edgeIndex];
        const audioTime = this.originAudioTime + edge.relativeMs / 1000;
        if (audioTime > horizon) break;
        const mapped = audioPerformanceTime(context, audioTime, now);
        this.onEvent({ ...edge, audioTime, performanceMs: mapped.performanceMs,
                       timingMethod: mapped.method, scheduled: true, acousticMeasured: false });
        this.edgeIndex++;
      }
      const extra = (optionalLatency(context.baseLatency) ?? .1) + (optionalLatency(context.outputLatency) ?? .1);
      if (this.noteIndex === this.notes.length && context.currentTime > this.endAudioTime + extra + .1) {
        const complete = this.onComplete;
        this.stop();
        complete();
      }
    } catch (error) {
      this._abort(error.message);
    }
  }

  _voice(note, onset, off) {
    const context = this.context;
    const gain = context.createGain();
    gain.connect(this.master);
    const duration = off - onset;
    const sustained = note.type === "hold";
    const attack = Math.min(.006, duration / 4);
    gain.gain.setValueAtTime(0, onset);
    gain.gain.linearRampToValueAtTime(sustained ? .7 : 1, onset + attack);
    if (sustained) {
      gain.gain.exponentialRampToValueAtTime(.22, onset + Math.min(.2, duration * .6));
      gain.gain.setValueAtTime(.22, off);
      gain.gain.linearRampToValueAtTime(0, off + .012);
    } else {
      gain.gain.exponentialRampToValueAtTime(.001, off);
    }
    const partials = sustained ? [[1, .7], [2, .2], [3, .08]] : [[1, 1]];
    const base = sustained ? 261.625565 : note.accent ? 1320 : 880;
    let remaining = partials.length;
    for (const [harmonic, amplitude] of partials) {
      const oscillator = context.createOscillator();
      const partial = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(base * harmonic, onset);
      partial.gain.setValueAtTime(amplitude, onset);
      oscillator.connect(partial);
      partial.connect(gain);
      const record = { oscillator, partial, gain };
      this.nodes.add(record);
      oscillator.onended = () => {
        oscillator.disconnect();
        partial.disconnect();
        this.nodes.delete(record);
        if (--remaining === 0) gain.disconnect();
      };
      oscillator.start(onset);
      oscillator.stop(off + (sustained ? .012 : .002));
    }
  }

  _abort(reason) {
    if (!this.running) return;
    const abort = this.onAbort;
    this.stop();
    abort(reason);
  }

  stop() {
    this.generation++;
    this.running = false;
    if (this.timer !== null) this.clearEvery(this.timer);
    this.timer = null;
    this.document?.removeEventListener?.("visibilitychange", this.visibility);
    this.page?.removeEventListener?.("pagehide", this.pageHide);
    const context = this.context;
    if (!context) return;
    context.removeEventListener?.("statechange", this.stateChange);
    context.removeEventListener?.("sinkchange", this.sinkChange);
    context.removeEventListener?.("error", this.audioError);
    try {
      this.master?.gain.cancelScheduledValues(context.currentTime);
      this.master?.gain.setValueAtTime(0, context.currentTime);
    } catch { /* A disconnected device may already have closed the context. */ }
    for (const record of this.nodes) {
      try { record.oscillator.stop(); } catch { /* Already ended. */ }
      try { record.oscillator.disconnect(); record.partial.disconnect(); record.gain.disconnect(); } catch { /* Closed. */ }
    }
    this.nodes.clear();
    try { this.master?.disconnect(); } catch { /* Already disconnected. */ }
    this.context = this.master = null;
    try { context.close()?.catch?.(() => {}); } catch { /* Already closed. */ }
  }
}
