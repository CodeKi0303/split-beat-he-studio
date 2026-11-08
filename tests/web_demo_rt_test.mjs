import assert from "node:assert/strict";
import { DemoTransport, demoRTState, demoRTStep } from "../web/demo.mjs";
import { OP, encodeBinding, encodeKey, decodeStatus } from "../web/protocol.mjs";

const cfg = {
  key: 0, flags: 7, released: 1000, pressed: 3000,
  actuation: 200, rt_press: 100, rt_release: 100,
  top_deadzone: 20, bottom_deadzone: 0, noise_deadband: 5,
};
const raw = (n) => 1000 + n * 2;
const step = (state, n, key = cfg) => demoRTStep(state, key, raw(n));

// Exact transitions mirror the firmware's released, initial actuation,
// dynamic peak-relative release and trough-relative re-press behavior.
let s = demoRTState();
for (const [travel, pressed] of [[0,false],[199,false],[202,true],[700,true],[602,true],[600,false],[400,false],[498,false],[500,true],[20,false]]) {
  step(s, travel, { ...cfg, noise_deadband: 0 });
  assert.equal(s.pressed, pressed, `travel=${travel}`);
}

// Raw noise latching happens before normalization/RT, not as a distance offset.
s = demoRTState();
demoRTStep(s, cfg, 1000);
demoRTStep(s, cfg, 1004);
assert.equal(s.filtered, 1000);
demoRTStep(s, cfg, 1005);
assert.equal(s.filtered, 1005);
assert.equal(s.travel, 3);

// Bottom-zone dwell remains pressed. Leaving it must traverse release RT
// relative to the lower-zone boundary rather than a hidden bottom extreme.
s = demoRTState();
const bottom = { ...cfg, bottom_deadzone: 200 };
for (const [travel, pressed] of [[0,false],[1000,true],[950,true],[800,true],[750,true],[700,false]]) {
  step(s, travel, bottom);
  assert.equal(s.pressed, pressed, `bottom travel=${travel}`);
}

// Calibration direction, disabled keys, and fixed actuation are separate.
s = demoRTState();
const reverse = { ...cfg, released: 3000, pressed: 1000 };
demoRTStep(s, reverse, 2500);
assert.equal(s.travel, 250);
assert.equal(s.pressed, true);
demoRTStep(s, { ...reverse, flags: 6 }, 2000);
assert.equal(s.travel, 500);
assert.equal(s.pressed, false);
demoRTStep(s, { ...cfg, flags: 3 }, 3000);
assert.equal(s.travel, 1000);
assert.equal(s.pressed, false);
demoRTStep(s, { ...cfg, flags: 3, released: 0, pressed: 0 }, 3000);
assert.equal(s.travel, 0);
s = demoRTState();
for (const [travel, pressed] of [[0,false],[300,true],[197,false]]) {
  step(s, travel, { ...cfg, flags: 5 });
  assert.equal(s.pressed, pressed);
}

// STATUS reports firmware-like pressed state even with live HID output off.
// Simulated timing is fixed here; no browser/hardware is opened.
let now = 0;
const t = new DemoTransport({ clock: () => now });
const status = (side = 0) => decodeStatus(t.command(OP.STATUS, Uint8Array.of(side)));
for (let key = 0; key < 14; key++)
  t.command(OP.SET_KEY, encodeKey({ ...cfg, key }));
assert.equal(status().pressed_mask, 0);
t.pose[0] = 700;
now += 10;
let report = status();
assert.equal(report.output_enabled, false);
assert.equal(report.pressed_mask & 1, 1);
assert.ok(Math.abs(report.travel[0] - 700) <= 2);
t.pose[0] = 500;
now += 10;
assert.equal(status().pressed_mask & 1, 0);
t.pose[7] = 500;
now += 10;
report = status(1);
assert.equal(report.pressed_mask & (1 << 7), 1 << 7);
assert.equal(report.output_enabled, false);
t.command(OP.OUTPUT, Uint8Array.of(1));
assert.equal(t.pressedMask, 0, "OUTPUT resets engine state once");
report = status(1);
assert.equal(report.output_enabled, true);
assert.equal(report.pressed_mask & (1 << 7), 1 << 7);
t.command(OP.OUTPUT, Uint8Array.of(0));
assert.equal(status(1).pressed_mask & (1 << 7), 1 << 7, "output off does not stop sensor decisions");
t.command(OP.SET_KEY, encodeKey({ ...cfg, key: 7, flags: 6 }));
assert.equal(status(1).pressed_mask & (1 << 7), 0);
assert.equal(status(1).output_enabled, false);

t.command(OP.SET_BINDING, encodeBinding({ input: 0, kind: 6, keys: [4, 5, 6], modifiers: 2 }));
t.command(OP.SET_BINDING, encodeBinding({ input: 1, kind: 1, code: 4, modifiers: 0 }));
t.pose[0] = t.pose[1] = 700;
status();
const usages = () => {
  const bitmap = t.keyboardReport();
  return Array.from({ length: 256 }, (_, i) => i).filter((i) => bitmap[i >> 3] & (1 << (i & 7)));
};
assert.deepEqual(usages(), [], "output off keeps the report neutral");
t.command(OP.OUTPUT, Uint8Array.of(1));
status();
assert.deepEqual(usages(), [4, 5, 6, 0xe1], "one press adds all chord usages to the bitmap");
t.pose[0] = 0;
status();
assert.deepEqual(usages(), [4], "a separately held overlapping usage stays down");
t.pose[1] = 0;
status();
assert.deepEqual(usages(), []);

console.log("Demo RT: actuation, raw noise latch, top/bottom zones, dynamic press/release, reverse calibration and output-independent STATUS masks PASS (simulation only)");
