import assert from "node:assert/strict";
import { makeSchedule, matchTimingEdges, RhythmCapture } from "../web/rhythm-analysis.mjs";
import { timingEntries, describeTiming, laneNotes, timingPosition, formatTiming, practiceInputStart } from "../web/rhythm-visuals.mjs";

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
console.log("Rhythm visuals: shared matching, signed center meter, uncertain/extra/unobserved states, prep exclusion, press/release, corrected hold tails and offset reanalysis PASS");
