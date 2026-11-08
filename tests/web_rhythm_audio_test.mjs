import assert from "node:assert/strict";
import { RhythmAudio, audioPerformanceTime, validateAudioSchedule } from "../web/rhythm-audio.mjs";

class Events {
  constructor() { this.listeners = new Map(); this.hidden = false; }
  addEventListener(name, fn) {
    const set = this.listeners.get(name) ?? new Set(); set.add(fn); this.listeners.set(name, set);
  }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  emit(name) { for (const fn of [...(this.listeners.get(name) ?? [])]) fn(); }
}
class Param {
  constructor() { this.calls = []; }
  setValueAtTime(...args) { this.calls.push(["set", ...args]); }
  linearRampToValueAtTime(...args) { this.calls.push(["linear", ...args]); }
  exponentialRampToValueAtTime(...args) { this.calls.push(["exponential", ...args]); }
  cancelScheduledValues(...args) { this.calls.push(["cancel", ...args]); }
}
class Node {
  constructor() { this.gain = new Param(); this.frequency = new Param(); this.starts = []; this.stops = []; }
  connect(to) { this.connected = to; }
  disconnect() { this.disconnected = true; }
  start(time) { this.starts.push(time); }
  stop(time) { this.stops.push(time); }
}
class Context extends Events {
  constructor() {
    super(); this.state = "suspended"; this.currentTime = 10; this.baseLatency = .005;
    this.outputLatency = .01; this.oscillators = []; this.gains = []; this.destination = {};
  }
  getOutputTimestamp() { return { contextTime: this.currentTime - .02, performanceTime: this.currentTime * 1000 - 10 }; }
  async resume() { this.state = "running"; }
  async close() { this.state = "closed"; this.closed = true; }
  createGain() { const n = new Node(); this.gains.push(n); return n; }
  createOscillator() { const n = new Node(); this.oscillators.push(n); return n; }
}
function fixture(extra = {}) {
  const context = new Context(), document = new Events(), page = new Events();
  let callback, created = 0, cleared = false;
  const audio = new RhythmAudio({
    createContext: () => { created++; return context; },
    now: () => context.currentTime * 1000,
    every: (fn) => { callback = fn; return 7; },
    clearEvery: (id) => { assert.equal(id, 7); cleared = true; },
    warmup: async () => {}, document, page, ...extra,
  });
  return { audio, context, document, page, tick(ms = 25) { context.currentTime += ms / 1000; callback?.(); },
    created: () => created, cleared: () => cleared };
}

// Spec-defined timestamp mapping includes hardware output time already. Do not
// add baseLatency/outputLatency again when getOutputTimestamp is available.
{
  const context = new Context();
  const mapped = audioPerformanceTime(context, 10.25, 10000);
  assert.equal(mapped.method, "output-timestamp");
  assert.ok(Math.abs(mapped.performanceMs - 10260) < .00001);
  context.getOutputTimestamp = () => ({ contextTime: 0, performanceTime: 0 });
  const fallback = audioPerformanceTime(context, 10.25, 10000);
  assert.equal(fallback.method, "latency-estimate-fallback");
  assert.equal(fallback.performanceMs, 10265);
  assert.equal(fallback.acousticMeasured, false);
  context.outputLatency = undefined;
  assert.equal(audioPerformanceTime(context, 10.25, 10000).latencyUnknown, true);
}

// Input bounds, duplicates, overlap and aliases are validated before sound.
{
  const notes = validateAudioSchedule({ cues: [{ id: "a", onMs: 0, offMs: 250, type: "count-in" }] });
  assert.equal(notes[0].toneOffMs, 35);
  for (const notes of [[], [{ onMs: -1, offMs: 100 }], [{ onMs: 0, offMs: 120001 }],
    [{ onMs: 0, offMs: 0 }], [{ onMs: true, offMs: 100 }],
    [{ id: 1, onMs: 0, offMs: 10 }, { id: "1", onMs: 20, offMs: 30 }],
    Array.from({ length: 9 }, (_, id) => ({ id, onMs: 0, offMs: 1000, type: "hold" })),
    Array.from({ length: 1025 }, (_, id) => ({ id, onMs: id, offMs: id + .1 })),
  ]) assert.throws(() => validateAudioSchedule(notes));
}

// Timer fills lookahead; sound starts at audio-clock times, not timer callbacks.
{
  const f = fixture(), events = [];
  assert.equal(f.created(), 0);
  let ready = false;
  const meta = await f.audio.start([{ id: 1, onsetMs: 0, offsetMs: 250 }], {
    onReady: () => { ready = true; }, onEvent: e => { assert.ok(ready); events.push(e); },
  });
  assert.equal(f.created(), 1);
  assert.equal(f.context.oscillators.length, 0);
  f.tick(110);
  assert.equal(f.context.oscillators.length, 1);
  assert.equal(f.context.oscillators[0].starts[0], meta.originAudioTime);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "on");
  assert.equal(events[0].scheduled, true);
  assert.equal(events[0].acousticMeasured, false);
  f.tick(100); f.tick(100); f.tick(100);
  assert.ok(f.audio.running, "Tap capture remains alive until the logical release target");
  f.audio.stop();
  assert.ok(f.context.closed);
  assert.ok(f.cleared());
  assert.equal(f.audio.nodes.size, 0);
  assert.ok(f.context.oscillators.every(n => n.disconnected));
}

// Hold uses a bounded additive piano-like tone and preprogrammed release fade.
{
  const f = fixture(), events = [];
  const meta = await f.audio.start({ cues: [{ id: 3, onMs: 0, offMs: 500, type: "hold" }] }, {
    mode: "hold", onEvent: e => events.push(e),
  });
  f.tick(110);
  assert.equal(f.context.oscillators.length, 3);
  assert.ok(f.context.oscillators.every(n => Math.abs(n.stops[0] - (meta.originAudioTime + .512)) < 1e-8));
  for (let i = 0; i < 20; i++) f.tick();
  const off = events.find(e => e.kind === "off");
  assert.equal(off.relativeMs, 500);
  assert.equal(off.tailMs, 12);
  assert.ok(f.context.gains.some(g => g.gain.calls.some(c => c[0] === "linear" && c[1] === 0)));
  f.audio.stop();
}

// Hidden tabs, device suspension, output changes, lateness and errors abort once.
for (const kind of ["hidden", "suspended", "sinkchange", "late", "error", "pagehide"]) {
  const f = fixture(), aborted = [];
  await f.audio.start([{ onMs: 0, offMs: 1000, type: "hold" }], { onAbort: message => aborted.push(message) });
  if (kind === "hidden") { f.document.hidden = true; f.document.emit("visibilitychange"); }
  else if (kind === "suspended") { f.context.state = "suspended"; f.context.emit("statechange"); }
  else if (kind === "pagehide") f.page.emit("pagehide");
  else if (kind === "late") f.tick(400);
  else f.context.emit(kind);
  assert.equal(aborted.length, 1, kind);
  assert.equal(f.audio.running, false, kind);
  assert.ok(f.context.closed, kind);
  f.context.emit("statechange");
  assert.equal(aborted.length, 1);
}

// Completion includes the final release target and closes the audio graph.
{
  const f = fixture(); let completed = 0;
  await f.audio.start([{ onsetMs: 0, offsetMs: 300 }], { onComplete: () => completed++ });
  for (let i = 0; i < 40; i++) f.tick();
  assert.equal(completed, 1);
  assert.equal(f.audio.running, false);
  assert.ok(f.context.closed);
}

// Cancelling while user activation/resume is pending cannot start an old session.
{
  let resolve;
  const f = fixture({ warmup: () => new Promise(r => { resolve = r; }) });
  const pending = f.audio.start([{ onsetMs: 0, offsetMs: 100 }]);
  await Promise.resolve(); await Promise.resolve();
  f.audio.stop(); resolve();
  await assert.rejects(pending, /취소/);
  assert.equal(f.context.oscillators.length, 0);
}

// Device preflight runs after synchronous audio unlock, before any sound/timer.
{
  let resolve, ready = false;
  const f = fixture();
  const pending = f.audio.start([{ onsetMs: 0, offsetMs: 100 }], {
    beforeSchedule: () => new Promise(r => { resolve = r; }),
    onReady: () => { ready = true; },
  });
  assert.equal(f.context.state, "running", "resume executes before the first await");
  await Promise.resolve();
  assert.equal(f.context.oscillators.length, 0);
  assert.equal(ready, false);
  resolve(); await pending;
  assert.equal(ready, true);
  f.audio.stop();
}
{
  const f = fixture();
  await assert.rejects(f.audio.start([{ onsetMs: 0, offsetMs: 100 }], {
    beforeSchedule: async () => { throw Error("Device preflight rejected"); },
  }), /preflight rejected/);
  assert.equal(f.context.oscillators.length, 0);
  assert.ok(f.context.closed);
}
{
  let resolve, ready = false;
  const f = fixture();
  const pending = f.audio.start([{ onsetMs: 0, offsetMs: 100 }], {
    beforeSchedule: () => new Promise(r => { resolve = r; }),
    onReady: () => { ready = true; },
  });
  await Promise.resolve();
  f.audio.stop(); resolve();
  await assert.rejects(pending, /취소/);
  assert.equal(ready, false);
  assert.equal(f.context.oscillators.length, 0);
}

console.log("Rhythm WebAudio: precise scheduling, output timestamp/fallback, count-in/tap/hold, bounds and stop/abort lifecycle PASS");
