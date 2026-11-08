import assert from "node:assert/strict";
import { KeyboardClient } from "../web/device.mjs";
import { DemoTransport } from "../web/demo.mjs";
import {
  parseUiProfile,
  makeUiProfile,
  validateTravelArray,
} from "../web/ui-profile.mjs";
import {
  KEY_OPTIONS,
  MEDIA_OPTIONS,
  MODIFIERS,
  bindingLabel,
} from "../web/key-catalog.mjs";

const device = await new KeyboardClient(new DemoTransport()).getConfig();
const travel = Array.from({ length: 14 }, (_, i) =>
  i === 0 ? 0.1 : i === 13 ? 10 : 3.65,
);
const wrapped = makeUiProfile(device, travel);
assert.equal(wrapped.schema, "split-studio-profile-v1");
assert.deepEqual(parseUiProfile(wrapped), { device, travelMm: travel });
assert.deepEqual(parseUiProfile(device), { device, travelMm: null });
assert.deepEqual(parseUiProfile(JSON.parse(JSON.stringify(wrapped))), {
  device,
  travelMm: travel,
});
// The returned object is detached from both caller-owned records and metadata.
wrapped.device.keys[0].actuation = 999;
wrapped.ui.totalTravelMm[0] = 4;
assert.notEqual(device.keys[0].actuation, 999);
assert.equal(travel[0], 0.1);
const valid = makeUiProfile(device, travel);
for (const bad of [
  null,
  {},
  [],
  { ...device, totalTravelMm: travel },
  { ...valid, surprise: true },
  { ...valid, schema: "future-profile" },
  { ...valid, ui: { ...valid.ui, surprise: true } },
  { ...valid, device: { ...device, board: "C86" } },
])
  assert.throws(() => parseUiProfile(bad));
for (const badValue of [
  0.099,
  10.001,
  null,
  "4",
  NaN,
  Infinity,
  -Infinity,
  false,
]) {
  const bad = travel.slice();
  bad[3] = badValue;
  assert.throws(() => validateTravelArray(bad));
  assert.throws(() => parseUiProfile({ ...valid, ui: { totalTravelMm: bad } }));
}
for (const bad of [[], Array(13).fill(4), Array(15).fill(4), Array(14)])
  assert.throws(() => validateTravelArray(bad));
assert.deepEqual(
  validateTravelArray(Array(14).fill(3.333)),
  Array(14).fill(3.333),
);

const codes = KEY_OPTIONS.map((k) => k.code);
assert.equal(new Set(codes).size, codes.length);
assert.ok(KEY_OPTIONS.every((k) => typeof k.label === "string" && k.group));
for (const code of [
  4, 29, 30, 39, 0x3a, 0x45, 0x68, 0x73, 0x90, 0x91, 0xe0, 0xe7,
])
  assert.ok(codes.includes(code), `missing keyboard usage ${code}`);
assert.deepEqual(
  MEDIA_OPTIONS.map((m) => m.code),
  [0xb5, 0xb6, 0xb7, 0xcd, 0xe2, 0xe9, 0xea],
);
assert.deepEqual(
  MODIFIERS.map((m) => m.bit),
  [1, 2, 4, 8, 16, 32, 64, 128],
);
assert.equal(
  bindingLabel({ kind: 1, code: 4, modifiers: 3 }),
  "L Ctrl + L Shift + A",
);
assert.equal(bindingLabel({ kind: 1, code: 0, modifiers: 1 }), "L Ctrl");
assert.match(bindingLabel({ kind: 1, code: 0x90, modifiers: 0 }), /한\/영/);
assert.equal(bindingLabel({ kind: 1, code: 0x66, modifiers: 0 }), "HID 0x66");
assert.equal(bindingLabel({ kind: 2, code: -1, modifiers: 0 }), "스크롤 ↓");
assert.equal(bindingLabel({ kind: 5, code: 5, modifiers: 0 }), "마우스 앞으로");
assert.equal(bindingLabel(null), "미지정");
console.log("UI profile wrapper and HID key catalog: passed");
