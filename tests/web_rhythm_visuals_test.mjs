import assert from "node:assert/strict";
import { makeSchedule, matchTimingEdges, RhythmCapture } from "../web/rhythm-analysis.mjs";
import { timingEntries, describeTiming, laneNotes, timingPosition, formatTiming, practiceInputStart,
  normalizeNoteSpeed, readNoteSpeed, saveNoteSpeed, NOTE_SPEED_STORAGE_KEY, noteLookaheadMs,
  laneGeometry, RhythmPracticeView } from "../web/rhythm-visuals.mjs";
import { RhythmLab } from "../web/rhythm-ui.mjs";

assert.equal(noteLookaheadMs(), 1800, "first-use 1× retains the original 1800 ms approach");
assert.equal(noteLookaheadMs(.5), 3600);
assert.equal(noteLookaheadMs(4), 450);
assert.equal(noteLookaheadMs(2), noteLookaheadMs(1) / 2, "double speed halves time on the approach lane");
for (const invalid of [undefined, null, "", " ", "broken", NaN, Infinity, -1, 0, .4, 4.1, true, [], {}]) {
  assert.equal(normalizeNoteSpeed(invalid), 1, `invalid speed ${String(invalid)} uses 1×`);
  assert.equal(readNoteSpeed({ getItem: () => invalid }), 1);
}
assert.equal(normalizeNoteSpeed("2.3"), 2.3);
assert.equal(normalizeNoteSpeed(1.26), 1.3, "stored numeric preferences normalize to the slider step");
assert.equal(readNoteSpeed({ getItem() { throw Error("storage denied"); } }), 1);
assert.doesNotThrow(() => saveNoteSpeed(2, { setItem() { throw Error("storage full"); } }));
const stored = new Map(), storage = { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) };
saveNoteSpeed(2.5, storage);
assert.equal(stored.get(NOTE_SPEED_STORAGE_KEY), "2.5");
assert.equal(readNoteSpeed(storage), 2.5, "the presentation preference survives a fresh read");
for (const noteSpeed of [.5, 1, 2, 4]) {
  const geometry = laneGeometry({ noteSpeed, top: 12, line: 222, elapsedMs: 2000 });
  assert.equal(geometry.y(2000), 222, "every speed crosses the same line at the same target time");
  assert.equal(geometry.y(2000 + geometry.lookaheadMs), 12, "approach duration matches the lane height");
  assert.ok(geometry.y(1990) > 222, "past press heads continue below the line without clamping");
  assert.ok(geometry.y(2010) < 222, "future release tails stay above the line");
  assert.ok(geometry.y(2001) < geometry.y(2000), "future notes preserve temporal order");
  const preview = laneGeometry({ noteSpeed, top: 12, line: 222, previewTargetMs: 2000 });
  assert.equal(preview.y(2000), 117, "first preview head stays visible at every speed");
}

const key = { flags: 7, released: 1000, pressed: 3000, actuation: 200,
  rt_press: 100, rt_release: 100, top_deadzone: 20, bottom_deadzone: 0, noise_deadband: 5 };
const schedule = makeSchedule({ bpm: 120, division: 8, bars: 1 });
const edges = [
  { id: "prep", type: "press", timeMs: 500, earliestMs: 490, latestMs: 510 },
  { id: "early", type: "press", timeMs: 1970, earliestMs: 1960, latestMs: 1980 },
  { id: "late", type: "release", timeMs: 2155, earliestMs: 2140, latestMs: 2170 },
  { id: "overlap", type: "press", timeMs: 2255, earliestMs: 2245, latestMs: 2265 },
  { id: "outside", type: "release", timeMs: 2300, earliestMs: 2290, latestMs: 2310 },
];
const matching = matchTimingEdges(schedule.targets, edges, 120);
const view = (options = {}) => timingEntries({ schedule, ...matching, lastSampleMs: 2310, elapsedMs: 2310, active: true, ...options });
assert.deepEqual(view({ elapsedMs: 1500, lastSampleMs: 1500 }), [], "preparation movements have no scored visualization");
assert.equal(view({ elapsedMs: 1990, lastSampleMs: 1990 })[0].state, "early", "legitimate early input for the first note is visible before its sound");
assert.equal(practiceInputStart(makeSchedule({ delayMs: -300 })), 1580,
  "negative offset ends the hands-off instruction before the first accepted target window");
const history = view();
assert.equal(history[0].state, "early");
assert.equal(history[0].errorMs, -30);
assert.equal(history[1].state, "late");
assert.equal(history[1].type, "release");
assert.equal(history[2].state, "overlap", "a bracket crossing zero must not claim EARLY/LATE precision");
assert.match(describeTiming(history[2]).detail, /0 ms 포함/);
assert.ok(!history.some((entry) => entry.id === "prep"), "preparation extra edges are not displayed as practice judgments");
assert.equal(timingPosition(-150), 0);
assert.equal(timingPosition(0), 50);
assert.equal(timingPosition(150), 100);
assert.equal(timingPosition(-500), 0);
assert.equal(formatTiming(null), "—");
assert.equal(formatTiming(-15), "−15.0 ms");
assert.equal(formatTiming(15), "+15.0 ms");

const emptyMatching = matchTimingEdges(schedule.targets, [], 120);
assert.equal(timingEntries({ schedule, ...emptyMatching, lastSampleMs: 2100, elapsedMs: 2600, active: true }).length, 0,
  "animation alone cannot turn a pending target into a miss when sensor coverage stops");
const missing = timingEntries({ schedule, ...emptyMatching, lastSampleMs: 2120, elapsedMs: 2120, active: true });
assert.equal(missing.length, 1);
assert.equal(missing[0].state, "unobserved");
assert.equal(describeTiming(missing[0]).value, "—", "missing input never becomes a zero-ms success");
assert.match(describeTiming(missing[0]).verdict, /미관측/);
const extra = timingEntries({ schedule, matches: [], extraEdges: [edges.at(-1)], lastSampleMs: 2300, elapsedMs: 2300, active: true });
assert.equal(extra[0].state, "extra");
assert.equal(describeTiming(extra[0]).value, "—");
assert.match(describeTiming(extra[0]).verdict, /목표 밖/);

const held = new RhythmCapture({ settings: { mode: "hold", bars: 1, delayMs: 30 }, keyConfig: key });
let notes = laneNotes(held.schedule);
assert.equal(notes.length, 2, "count-in clicks are not practice notes");
assert.equal(notes[0].pressMs, 2030);
assert.equal(notes[0].releaseMs, 2780);
held.setSoundEvent({ id: "note-0", kind: "off", timeMs: 2758 });
notes = laneNotes(held.schedule);
assert.equal(notes[0].releaseMs, 2788, "hold tail follows scheduled silence plus personal offset");
held.schedule.settings.delayMs = -40;
for (const target of held.schedule.targets) target.targetMs = target.soundMs - 40;
notes = laneNotes(held.schedule);
assert.equal(notes[0].pressMs, 1960);
assert.equal(notes[0].releaseMs, 2718, "reanalyzed offsets also move the visual release cap");

// The visual match values use the same exported matcher as the final report.
for (let t = 0, sequence = 0; t < 4500; t += 10, sequence++) {
  const down = notes.some((note) => t >= note.pressMs && t < note.releaseMs);
  held.addSample({ timeMs: t, raw: down ? 2000 : 1000, travel: down ? 500 : 0, pressed: down,
    sequence, fresh: true, requestMs: t - 1, responseMs: t + 1 });
}
const final = held.summary(), live = matchTimingEdges(held.schedule.targets, held.edges, final.matchWindowMs);
assert.deepEqual(live.matches.map((match) => [match.id, match.errorMs, match.errorRangeMs]),
  final.matches.map((match) => [match.id, match.errorMs, match.errorRangeMs]));
assert.equal(timingEntries({ schedule: held.schedule, ...live, lastSampleMs: 4490, elapsedMs: 4490 }).filter((entry) => Number.isFinite(entry.errorMs)).length, final.matchedTargets);

// Exercise actual drawing with a long hold whose head has already left the
// canvas. The release cap and connected body must remain visible at all rates.
const draws = [], attributes = new Map();
const context = new Proxy({ createLinearGradient: () => ({ addColorStop() {} }) }, {
  get: (target, name) => name in target ? target[name] : (...args) => draws.push([name, ...args]),
});
const canvas = { getBoundingClientRect: () => ({ width: 300, height: 280 }), getContext: () => context,
  setAttribute: (key, value) => attributes.set(key, value) };
const laneView = new RhythmPracticeView({ getElementById: () => canvas });
const longHold = makeSchedule({ mode: "hold", bpm: 60, division: 4, bars: 4, holdSteps: 8, gapSteps: 1 });
const beforeDraw = structuredClone(longHold);
for (const noteSpeed of [.5, 1, 2, 4]) {
  draws.length = 0;
  const elapsedMs = longHold.targets[1].targetMs - 100;
  laneView.drawLane({ schedule: longHold, elapsedMs, active: true, pressed: true, label: "test", noteSpeed });
  const tail = laneGeometry({ noteSpeed, top: 12, line: 222, elapsedMs }).y(longHold.targets[1].targetMs);
  assert.ok(draws.some(([kind, , y, , height]) => kind === "strokeRect" && y === tail - 2 && height === 5),
    "the approaching release cap survives after the press head leaves view");
  assert.ok(draws.some(([kind, , y, , height]) => kind === "fillRect" && y === tail && height > 100),
    "long hold bodies continue to connect to their release tail");
}
assert.deepEqual(longHold, beforeDraw, "changing render speed never changes corrected targets, cues or BPM");

// Test the real UI update path while a capture is active. A presentation edit
// must not restart audio, rebuild the schedule, or ask for a device operation.
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) elements.set(id, { disabled: false, value: "", textContent: "", setAttribute() {} });
  return elements.get(id);
};
try {
  Object.defineProperty(globalThis, "document", { configurable: true, value: { getElementById: element } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw Error("storage unavailable"); } });
  assert.equal(readNoteSpeed(), 1, "unavailable localStorage itself also falls back");
  assert.doesNotThrow(() => saveNoteSpeed(2));
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  const lab = Object.create(RhythmLab.prototype);
  let renderCount = 0;
  Object.assign(lab, { active: true, starting: false, schedule: held.schedule, capture: held, result: null,
    events: [{ kind: "on", performanceMs: 1234 }], generation: 7, origin: 1234,
    visualMatches: { signature: "keep" }, recordContext: { label: "test" },
    getContext: () => ({ available: true, selected: 0, profile: { keys: [key] }, label: "test" }),
    drawPractice: () => renderCount++,
    settingsChanged: () => assert.fail("speed must not rebuild practice settings"),
    prepare: () => assert.fail("speed must not touch the keyboard"),
    onChange: () => assert.fail("speed must not apply keyboard settings"),
    audio: { start: () => assert.fail("speed must not restart audio"), stop: () => assert.fail("speed must not stop audio") },
  });
  const before = { schedule: structuredClone(lab.schedule), capture: held.snapshot(), events: structuredClone(lab.events),
    visualMatches: lab.visualMatches };
  lab.updateContext();
  assert.equal(element("rhythmBpm").disabled, true, "tempo is locked during capture");
  assert.equal(element("rhythmNoteSpeed").disabled, false, "visual speed remains editable during capture");
  lab.noteSpeedChanged(4);
  assert.equal(lab.noteSpeed, 4);
  assert.equal(element("rhythmNoteSpeedValue").textContent, "4.0×");
  assert.equal(element("rhythmNoteSpeedDuration").textContent, "등장 → 기준선 0.450초");
  assert.equal(readNoteSpeed(storage), 4);
  assert.equal(renderCount, 2, "an active speed change redraws immediately");
  assert.equal(lab.active, true);
  assert.equal(lab.generation, 7);
  assert.equal(lab.origin, 1234);
  assert.equal(lab.visualMatches, before.visualMatches);
  assert.deepEqual(lab.schedule, before.schedule);
  assert.deepEqual(lab.capture.snapshot(), before.capture, "measured samples and judgments are unchanged");
  assert.deepEqual(lab.events, before.events, "audio event times are unchanged");
} finally {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else delete globalThis.document;
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else delete globalThis.localStorage;
}
console.log("Rhythm visuals: matching, signed timing, hold tails, inverse note speed, preview, browser preference fallback and active presentation-only changes PASS");
