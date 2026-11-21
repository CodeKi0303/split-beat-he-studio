// Firmware 0.3.48 pointer binding (kind 7): codec parity with host/protocol.py,
// validation, capability gate and labels. No device access.
import assert from "node:assert/strict";
import { encodeBinding, decodeBinding, bindingRecord, requireBindingCapability, CAP_POINTER, CAP_MOUSE_BUTTON } from "../web/protocol.mjs";
import { bindingLabel } from "../web/key-catalog.mjs";

for (const record of [
  { input: 0, kind: 7, code: 800, modifiers: 0 },
  { input: 20, kind: 7, code: -25, modifiers: 0 },
  { input: 14, kind: 7, code: -4000, modifiers: 1 },
]) assert.deepEqual(decodeBinding(encodeBinding(record)), record);
assert.deepEqual([...encodeBinding({ input: 20, kind: 7, code: -25, modifiers: 1 })], [20, 7, 0xe7, 0xff, 1, 0]);
for (const bad of [{ code: 0 }, { code: 4001 }, { code: -4001 }, { modifiers: 2 }])
  assert.throws(() => bindingRecord({ input: 0, kind: 7, code: 100, modifiers: 0, ...bad }));
assert.throws(() => requireBindingCapability({ input: 0, kind: 7, code: 100, modifiers: 0 }, CAP_MOUSE_BUTTON), /0\.3\.48/);
requireBindingCapability({ input: 0, kind: 7, code: 100, modifiers: 0 }, CAP_POINTER);
assert.equal(bindingLabel({ kind: 7, code: 800, modifiers: 0 }), "포인터 → 800");
assert.equal(bindingLabel({ kind: 7, code: -5, modifiers: 1 }), "포인터 ↑ 5");
console.log("Pointer binding: codec/wire layout, validation, capability gate and labels PASS");
