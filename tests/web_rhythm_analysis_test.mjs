import assert from "node:assert/strict";
import { validateSettings, makeSchedule, SampledRT, RhythmCapture, depthAt } from "../web/rhythm-analysis.mjs";

const key = { key: 0, flags: 7, released: 1000, pressed: 3000, actuation: 200,
  rt_press: 100, rt_release: 100, top_deadzone: 20, bottom_deadzone: 0, noise_deadband: 5 };
const make = (settings = {}, options = {}) => new RhythmCapture({ settings, keyConfig: key, ...options });
const sample = (timeMs, sequence, travel = 0, pressed = false, extra = {}) => ({
  timeMs, raw: 1000 + travel * 2, travel, pressed, sequence, fresh: true,
  requestMs: timeMs - 1, responseMs: timeMs + 1, ...extra,
});

// Eighth notes/triplet twelfths/sixteenths are divisions of a 4/4 bar.
assert.equal(makeSchedule({ bpm: 120, division: 8 }).stepMs, 250);
assert.equal(makeSchedule({ bpm: 120, division: 12 }).stepMs, 1000 / 6);
assert.equal(makeSchedule({ bpm: 120, division: 16 }).stepMs, 125);
assert.equal(makeSchedule({ bars: 1 }).targets.length, 16);
assert.equal(makeSchedule({ mode: "hold", bars: 1 }).targets.length, 4);
assert.equal(makeSchedule({ delayMs: 30 }).targets[0].targetMs, 2030);
assert.equal(makeSchedule({ delayMs: -30 }).targets[0].targetMs, 1970);
assert.equal(makeSchedule({ delayMs: 30, delayMode: "input" }).targets[0].targetMs, 1970);
assert.throws(() => validateSettings({ division: 7 }));
assert.throws(() => validateSettings({ bpm: NaN }));
assert.throws(() => validateSettings({ bpm: 20, bars: 16 }));
assert.throws(() => validateSettings({ delayMs: -1, delayMode: "input" }));
assert.throws(() => make({}, { keyConfig: { ...key, flags: 3 } }));

// Firmware parity: direction, ADC deadband, release/repress and lower zone.
const rt = new SampledRT(key);
assert.equal(rt.step(1000).pressed, false);
assert.equal(rt.step(1400).pressed, true);
assert.equal(rt.step(2000).travel, 500);
assert.equal(rt.step(1998).travel, 500); // 2ADC jitter stays filtered.
assert.equal(rt.step(1800).pressed, false);
assert.equal(rt.step(2000).pressed, true);
assert.equal(rt.step(1000).pressed, false);
const reverse = new SampledRT({ ...key, released: 3000, pressed: 1000 });
assert.equal(reverse.step(2600).pressed, true);
assert.equal(reverse.step(3000).travel, 0);
const bottom = new SampledRT({ ...key, bottom_deadzone: 200 });
assert.equal(bottom.step(3000).extreme, 800);
assert.equal(bottom.step(2620).pressed, true);
assert.equal(bottom.step(2500).pressed, true); // retreat only50 from lower-zone boundary.
assert.equal(bottom.step(2400).pressed, false);
const normal = new SampledRT({ ...key, flags: 5 });
normal.step(2200);
assert.equal(normal.step(1500).pressed, true);
assert.equal(normal.step(1380).pressed, false);

// A sampled edge has an interval, not a manufactured microsecond timestamp.
const c = make({ bars: 1 });
c.addSample(sample(1990, 1, 100, false));
c.addSample(sample(2010, 2, 300, true));
assert.equal(c.edges.length, 1);
assert.equal(c.edges[0].timeMs, 2000);
assert.deepEqual([c.edges[0].earliestMs, c.edges[0].latestMs], [1989, 2011]);
assert.equal(depthAt(c.samples, 2000).normalized, 200);
assert.equal(c.summary().matches[0].timing, "within_observation_window");
assert.equal(c.summary().pendingTargets, 15);
c.setSoundEvent({ id: "note-0", kind: "on", timeMs: 2015 });
assert.equal(c.summary().matches[0].rawSoundErrorMs, -15);
assert.equal(c.schedule.targets.find((x) => x.id === "note-0-release").soundMs, 2140);
assert.equal(c.schedule.cues.find((x) => x.id === "note-0").onMs, 2015);
assert.throws(() => c.setSoundEvent({ id: "unknown", kind: "on", timeMs: 0 }));
const captured = c.snapshot();
captured.samples[0].travel = 999;
assert.equal(c.samples[0].travel, 100);

// Age-adjusted midpoint still includes the earliest request-age bound.
const aged = make();
aged.addSample(sample(101, 1, 0, false, { requestMs: 100, responseMs: 110 })); // midpoint105-age4
aged.addSample(sample(121, 2, 500, true, { requestMs: 120, responseMs: 130 }));
assert.equal(aged.samples[0].lowerMs, 96);
assert.equal(aged.samples[0].upperMs, 110);
assert.equal(aged.edges[0].earliestMs, 96);
assert.equal(aged.edges[0].latestMs, 130);
const slow = make();
slow.addSample(sample(0, 1));
assert.equal(slow.addSample(sample(55, 2, 500, true, { requestMs: 10, responseMs: 100 })), false);
slow.addSample(sample(110, 3, 500, true));
assert.equal(slow.edges.length, 0);
assert.equal(slow.simulatedEdges.length, 0);
assert.equal(depthAt(slow.samples, 55), null);
assert.equal(slow.counts.gaps, 1);
assert.equal(slow.issues[0].reason, "slow_transaction");
const delayedResponse = make();
delayedResponse.addSample(sample(0, 1));
delayedResponse.addSample(sample(60, 2, 500, true, { requestMs: 20, responseMs: 100 }));
assert.equal(delayedResponse.edges.length, 0); // RTT80, but response gap99ms is too wide.
assert.equal(depthAt(delayedResponse.samples, 30), null);
assert.equal(delayedResponse.issues[0].reason, "response_gap");

// Duplicates, stale data, long gaps and reset boundaries must not invent edges.
const broken = make();
broken.addSample(sample(0, 0xfffffffe));
assert.equal(broken.addSample(sample(10, 0xfffffffe)), false);
assert.equal(broken.addSample(sample(20, 0xffffffff)), true);
assert.equal(broken.addSample(sample(30, 0)), true); // wrap is forward.
assert.equal(broken.addSample(sample(40, 1, 500, true, { fresh: false })), false);
broken.addSample(sample(50, 2, 500, true));
assert.equal(broken.edges.length, 0);
assert.equal(depthAt(broken.samples, 40), null);
broken.addSample(sample(200, 3, 0, false));
assert.equal(broken.edges.length, 0);
assert.equal(depthAt(broken.samples, 150), null);
broken.addSample(sample(210, 2, 500, true)); // backwards sequence starts segment.
assert.equal(broken.edges.length, 0);
assert.equal(broken.counts.resets, 1);
assert.equal(broken.counts.gaps, 1);
assert.equal(broken.summary().maxObservedGapMs, 150);
assert.equal(broken.addSample(sample(205, 4)), false);
broken.addSample(sample(220, 5, 0, false));
assert.equal(broken.edges.length, 0);
assert.equal(make({ bpm: 300, division: 32 }).maxGapMs, 12.5);
const limited = make({}, { maxSamples: 10 });
for (let i = 0; i < 15; i++) limited.addSample(sample(i * 10, i));
assert.equal(limited.samples.length, 10);
assert.equal(limited.summary().truncated, true);

// Match each edge once, report sound-relative and corrected offsets separately.
const timed = make({ bars: 1, delayMs: 20 });
const notes = timed.schedule.cues.filter((x) => x.type === "tap");
for (let t = 0, seq = 0; t <= 4500; t += 10, seq++) {
  const down = notes.some((note) => t >= note.onMs + 20 && t < note.offMs + 20);
  timed.addSample(sample(t, seq, down ? 500 : 0, down));
}
const summary = timed.summary();
assert.equal(summary.press.count, 8);
assert.equal(summary.release.count, 8);
assert.equal(summary.matchedTargets, 16);
assert.equal(summary.unmatchedTargets, 0);
assert.equal(new Set(summary.matches.map((m) => m.edge.id)).size, 16);
assert.equal(summary.press.medianMs, -5);
assert.equal(summary.recommendation.personalOffset.offsetMs, 15);
assert.equal(summary.matches[0].rawSoundErrorMs, 15);
assert.equal(summary.matches[0].correctedErrorMs, -5);
assert.equal(summary.recommendation.applied, false);
assert.equal(make().summary().recommendation.personalOffset.offsetMs, null);

// Hold dropouts are interior releases, distinct from the intended final release.
const held = make({ mode: "hold", bars: 2 });
const sustained = held.schedule.cues.filter((x) => x.type === "hold");
for (let t = 0, seq = 0; t <= held.schedule.durationMs; t += 10, seq++) {
  const note = sustained.find((n) => t >= n.onMs && t <= n.offMs + 50);
  let travel = 0, down = false;
  if (note) {
    if (t < note.onMs + 100) travel = Math.min(800, (t - note.onMs) * 8);
    else if (t < note.offMs - 50) travel = 800 - (seq % 2) * 20;
    else travel = Math.max(0, 400 - (t - note.offMs) * 8);
    down = t >= note.onMs + 30 && t < note.offMs;
    if (note.id === "note-0" && t >= note.onMs + 300 && t < note.onMs + 330) down = false;
  }
  held.addSample(sample(t, seq, travel, down));
}
const hs = held.summary();
assert.equal(hs.holds.length, 4);
assert.equal(hs.holds[0].earlyReleaseCount, 1);
assert.equal(hs.holds[0].unpressedInteriorSamples, 3);
assert.equal(hs.holds[1].earlyReleaseCount, 0);
assert.equal(hs.holds[1].continuousCoverage, true);
assert.equal(hs.recommendation.rtRelease.minimumToHoldNormalized, 21);
assert.equal(hs.recommendation.rtRelease.desiredAtReleaseNormalized, 400);
assert.equal(hs.recommendation.rtRelease.compatible, true);
assert.equal(hs.recommendation.rtRelease.mm, 1.6);
assert.ok(hs.simulated.note.includes("모의"));
const nonRtHeld = make({ mode: "hold", bars: 2 }, { keyConfig: { ...key, flags: 5 } });
for (const row of held.samples) nonRtHeld.addSample(sample(row.timeMs, row.sequence, row.travel, row.pressed));
assert.equal(nonRtHeld.summary().recommendation.rtRelease.compatible, false);
assert.ok(nonRtHeld.summary().recommendation.rtRelease.note.includes("RT가 꺼져"));
const lowerHeld = make({ mode: "hold", bars: 2 }, { keyConfig: { ...key, bottom_deadzone: 200 } });
for (const source of held.samples) {
  // Plateaus stay inside the lower deadzone; they must not become retreat.
  const travel = source.travel >= 780 ? source.travel + 100 : source.travel;
  lowerHeld.addSample(sample(source.timeMs, source.sequence, travel, source.pressed));
}
assert.equal(lowerHeld.summary().recommendation.rtRelease.minimumToHoldNormalized, 1);
console.log("Rhythm analysis: subdivisions/offsets, firmware RT replay, sampled edge bounds, sequence/gap guards, unique matching, personal offset and hold/dropout candidates PASS");
