import assert from "node:assert/strict";
import {
  BatchCalibration,
  FIRMWARE_CALIBRATION_MIN_SPAN,
} from "../web/batch-calibration.mjs";

const configs = () =>
  Array.from({ length: 14 }, (_, key) => ({
    key,
    flags: 3,
    released: 0,
    pressed: 0,
    actuation: 230,
    rt_press: 40,
    rt_release: 50,
    top_deadzone: 10,
    noise_deadband: 5,
  }));
const status = (sequence, raw = Array(7).fill(2000), extra = {}) => ({
  sample_sequence: sequence >>> 0,
  raw,
  fresh: true,
  calibration_state: 0,
  output_enabled: false,
  ...extra,
});
function feedBaseline(
  batch,
  { noise = true, end = 3000, step = 50, sequenceBase = 0 } = {},
) {
  let seq = sequenceBase;
  for (let now = 0; now <= end; now += step) {
    const offset = noise ? (Math.floor(now / step) % 3) - 1 : 0;
    for (let side = 0; side < 2; side++)
      batch.add(side, status(seq, Array(7).fill(2000 + offset)), now);
    seq = (seq + 1) >>> 0;
  }
  return { now: end, seq };
}
function prepared(options) {
  const batch = new BatchCalibration(options);
  batch.start(configs(), 0);
  const cursor = feedBaseline(batch);
  assert.equal(batch.state, "press");
  return { batch, cursor };
}
function pressFrame(batch, cursor, changes = {}, extra = {}) {
  cursor.now += 50;
  cursor.seq = (cursor.seq + 1) >>> 0;
  const values = Array(14).fill(2000);
  for (const [key, value] of Object.entries(changes))
    values[Number(key)] = value;
  for (let side = 0; side < 2; side++)
    batch.add(
      side,
      status(cursor.seq, values.slice(side * 7, side * 7 + 7), extra),
      cursor.now,
    );
}

assert.equal(FIRMWARE_CALIBRATION_MIN_SPAN, 128);
assert.throws(() => new BatchCalibration({ baselineMs: 2999 }));
assert.throws(() => new BatchCalibration({ confirmSamples: 1 }));
assert.throws(() => new BatchCalibration({ minSamples: 29 }));
assert.throws(() => new BatchCalibration({ maxGapMs: 2000 }));
assert.throws(() => new BatchCalibration().start(Array(14), 0));
assert.throws(() =>
  new BatchCalibration().start(
    configs().map((k) => ({ ...k, key: 0 })),
    0,
  ),
);

// All released endpoints are observed together over the full three seconds.
{
  const original = configs();
  const batch = new BatchCalibration();
  batch.start(original, 0);
  feedBaseline(batch, { end: 2950 });
  assert.equal(batch.state, "baseline");
  assert.equal(batch.progress(1500), 0.5);
  assert.deepEqual(batch.candidates(), []);
  batch.tick(3000);
  assert.equal(batch.state, "press");
  assert.equal(batch.keys.length, 14);
  for (const key of batch.keys) {
    assert.equal(key.rest, 2000);
    assert.equal(key.count, 60);
    assert.equal(key.threshold, 6);
    assert.equal(key.detected, false);
  }
  assert.deepEqual(original, configs());
}
// A full window does not mean a burst, one missing side, or duplicate reports.
for (const mode of ["missing-side", "duplicate", "burst", "slow"]) {
  const batch = new BatchCalibration();
  batch.start(configs(), 0);
  for (
    let now = 0;
    now <= 3000 && batch.state === "baseline";
    now += mode === "slow" ? 150 : 50
  ) {
    if (mode === "burst" && now > 200) {
      batch.tick(now);
      continue;
    }
    batch.add(0, status(mode === "duplicate" ? 1 : now + 1), now);
    if (mode !== "missing-side")
      batch.add(1, status(mode === "duplicate" ? 1 : now + 1), now);
  }
  assert.equal(batch.state, "error", mode);
  assert.equal(batch.candidates().length, 0, mode);
}
// Baseline movement cannot become a released endpoint.
{
  const batch = new BatchCalibration();
  batch.start(configs(), 0);
  for (let now = 0; now <= 3000; now += 50) {
    const values = Array(7).fill(2000);
    if (now === 1500) values[3] = 2100;
    batch.add(0, status(now + 1, values), now);
    batch.add(1, status(now + 1), now);
  }
  assert.equal(batch.state, "error");
  assert.match(batch.error, /기준값/);
}
// Stale/status conflicts, invalid raw ranges and sparse arrays abort instead of
// silently calibrating from missing or foreign data.
for (const bad of [
  { fresh: false },
  { calibration_state: 2 },
  { output_enabled: true },
  { raw: [2000, 2000, 5000, 2000, 2000, 2000, 2000] },
  { raw: Array(7) },
]) {
  const { batch, cursor } = prepared();
  pressFrame(batch, cursor, {}, bad);
  assert.equal(batch.state, "error");
  assert.throws(() => batch.freeze(cursor.now));
}
// A single outlier and ordinary measured baseline noise do not count as presses.
{
  const { batch, cursor } = prepared();
  pressFrame(batch, cursor, { 0: 3500 });
  assert.equal(batch.detectedCount, 0);
  pressFrame(batch, cursor, { 0: 2000 });
  pressFrame(batch, cursor, { 0: 2002 });
  pressFrame(batch, cursor, { 0: 1999 });
  assert.equal(batch.detectedCount, 0);
}
// Small movement is visible before it is valid for existing firmware. No all-key
// gate: one eligible key is enough, while undetected settings remain untouched.
{
  const { batch, cursor } = prepared();
  pressFrame(batch, cursor, { 0: 2010 });
  pressFrame(batch, cursor, { 0: 2012 });
  assert.equal(batch.keys[0].detected, true);
  assert.equal(batch.keys[0].eligible, false);
  assert.equal(batch.keys[0].span, 10);
  assert.equal(batch.detectedCount, 1);
  assert.equal(batch.eligibleCount, 0);
  assert.throws(() => batch.freeze(cursor.now), /적용 가능한/);
  pressFrame(batch, cursor, { 0: 2400 });
  pressFrame(batch, cursor, { 0: 2398 });
  assert.equal(batch.keys[0].pressed, 2398);
  assert.equal(batch.eligibleCount, 1);
  const result = batch.freeze(cursor.now);
  assert.equal(batch.state, "frozen");
  assert.deepEqual(result, [
    { ...configs()[0], flags: 7, released: 2000, pressed: 2398, bottom_deadzone: 0, curve_id: 0 },
  ]);
  result[0].pressed = 3000;
  assert.equal(
    batch.candidates()[0].pressed,
    2398,
    "frozen results are copied",
  );
  const original = configs();
  const before = structuredClone(original);
  for (const key of batch.candidates()) original[key.key] = key;
  assert.deepEqual(
    original.slice(1),
    before.slice(1),
    "untouched 13 configurations preserved",
  );
  pressFrame(batch, cursor, { 0: 2900 });
  assert.equal(batch.keys[0].pressed, 2398, "frozen endpoints cannot drift");
}
// Calibrating endpoints preserves modern bottom zones while legacy profiles
// acquire only the default zero. Neither source configuration is mutated.
{
  const original = configs();
  original[8].bottom_deadzone = 125;
  original[8].curve_id = 1;
  const before = structuredClone(original);
  const batch = new BatchCalibration();
  batch.start(original, 0);
  const cursor = feedBaseline(batch);
  pressFrame(batch, cursor, {0: 2600, 8: 1400});
  pressFrame(batch, cursor, {0: 2590, 8: 1410});
  assert.deepEqual(batch.freeze(cursor.now), [
    {...before[0], flags: 7, released: 2000, pressed: 2590, bottom_deadzone: 0, curve_id: 0},
    {...before[8], flags: 7, released: 2000, pressed: 1410, curve_id: 1},
  ]);
  assert.deepEqual(original, before);
  assert.equal(Object.hasOwn(original[0], "bottom_deadzone"), false);
}
// Bidirectional sensors, progressively deeper presses, short spikes, and release
// back through the baseline keep the deepest confirmed endpoint, not an outlier.
{
  const { batch, cursor } = prepared();
  pressFrame(batch, cursor, { 0: 2200, 8: 1800 });
  pressFrame(batch, cursor, { 0: 2210, 8: 1790 });
  assert.equal(batch.keys[0].pressed, 2200);
  assert.equal(batch.keys[8].pressed, 1800);
  pressFrame(batch, cursor, { 0: 2800, 8: 1200 });
  pressFrame(batch, cursor, { 0: 2790, 8: 1210 });
  assert.equal(batch.keys[0].pressed, 2790);
  assert.equal(batch.keys[8].pressed, 1210);
  pressFrame(batch, cursor, { 0: 4095, 8: 0 });
  pressFrame(batch, cursor, { 0: 2000, 8: 2000 });
  assert.equal(batch.keys[0].pressed, 2790);
  assert.equal(batch.keys[8].pressed, 1210);
  pressFrame(batch, cursor, { 0: 1990, 8: 2010 });
  pressFrame(batch, cursor, { 0: 1990, 8: 2010 });
  assert.equal(batch.keys[0].direction, 1);
  assert.equal(batch.keys[8].direction, -1);
  assert.deepEqual(
    batch.candidates().map((k) => k.key),
    [0, 8],
  );
}
// One half going silent while the other streams cannot leave an Apply window.
{
  const { batch, cursor } = prepared();
  pressFrame(batch, cursor, { 0: 2500 });
  pressFrame(batch, cursor, { 0: 2500 });
  assert.equal(batch.eligibleCount, 1);
  for (let n = 0; n < 12; n++) {
    cursor.now += 50;
    cursor.seq++;
    batch.add(0, status(cursor.seq), cursor.now);
  }
  assert.equal(batch.state, "error");
  assert.throws(() => batch.freeze(cursor.now));
  assert.deepEqual(batch.candidates(), []);
}
// Modulo-32-bit forward wrap works, duplicate reports cannot confirm a press.
{
  const batch = new BatchCalibration();
  batch.start(configs(), 0);
  const cursor = feedBaseline(batch, { sequenceBase: 0xfffffff0 });
  assert.equal(batch.state, "press");
  cursor.now += 50;
  cursor.seq++;
  const frame = status(cursor.seq, [2400, 2000, 2000, 2000, 2000, 2000, 2000]);
  assert.equal(batch.add(0, frame, cursor.now), true);
  assert.equal(batch.add(0, frame, cursor.now + 1), false);
  assert.equal(batch.detectedCount, 0);
  batch.add(1, status(cursor.seq), cursor.now + 1);
  cursor.now += 50;
  cursor.seq++;
  batch.add(0, { ...frame, sample_sequence: cursor.seq }, cursor.now);
  batch.add(1, status(cursor.seq), cursor.now);
  assert.equal(batch.eligibleCount, 1);
  batch.tick(cursor.now - 1);
  assert.equal(batch.state, "error", "backwards time rejected");
  batch.cancel();
  assert.equal(batch.state, "idle");
  assert.equal(batch.detectedCount, 0);
  assert.deepEqual(batch.candidates(), []);
}
console.log(
  "Batch calibration: 3s released window, fresh sample gates, confirmed bidirectional peaks, early detection and partial firmware-compatible candidates PASS",
);
