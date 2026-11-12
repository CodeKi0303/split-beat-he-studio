import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_BINDINGS, defaultBindings } from "../web/default-bindings.mjs";
import { inputBindingLabel, inputLabel, inputPositionLabel } from "../web/input-labels.mjs";
import { INPUTS, CONTROLS, HALVES } from "../web/layout.mjs";
import { DemoTransport } from "../web/demo.mjs";
import { OP, decodeBinding, encodeBinding } from "../web/protocol.mjs";

const fixture = JSON.parse(await readFile(new URL("../web/default-bindings.json", import.meta.url), "utf8"));
const golden = [
  [1,43,0],[1,4,0],[1,22,0],[1,7,0],[1,9,0],[1,225,0],[1,44,0],
  [1,40,0],[1,51,0],[1,15,0],[1,14,0],[1,13,0],[1,229,0],[1,0,64],
  [1,58,0],[1,62,0],[1,41,0],[1,79,0],[1,80,0],[1,40,0],
  [1,58,0],[1,59,0],[1,75,0],[1,78,0],[2,1,0],[2,-1,0],[1,82,0],[1,81,0],
].map(([kind, code, modifiers], input) => ({ input, kind, code, modifiers }));
assert.equal(fixture.schema, "split-beat-he-default-bindings-v1");
assert.deepEqual(Object.keys(fixture).sort(), ["bindings", "description", "schema"]);
assert.deepEqual(fixture.bindings, golden, "all 28 saved mapping tuples, including modifier-only and wheel inputs");
assert.deepEqual(DEFAULT_BINDINGS, golden);
assert.deepEqual(defaultBindings(), golden);
execFileSync(process.execPath, [fileURLToPath(new URL("../tools/generate_default_bindings.mjs", import.meta.url)), "--check"]);
const modified = defaultBindings(); modified[0].code = 29;
assert.equal(defaultBindings()[0].code, 43, "a caller cannot modify the baseline");

const names = ["Tab","A","S","D","F","L Shift","Space","Enter","; / :","L","K","J","R Shift","R Alt",
  "F1","F5","Esc","→","←","Enter","F1","F2","Page Up","Page Down","스크롤 ↑","스크롤 ↓","↑","↓"];
for (let id = 0; id < 28; id++) assert.equal(inputBindingLabel(id), names[id]);
assert.equal(inputLabel(1), "A · 왼쪽 Hall 2");
assert.equal(inputLabel(7), "Enter · 오른쪽 Hall 1");
assert.equal(inputLabel(19), "Enter · 오른쪽 노브 클릭");
assert.notEqual(inputLabel(14), inputLabel(20), "two F1 bindings identify MX and roller separately");
assert.equal(inputPositionLabel(20), "왼쪽 롤러 CW");
assert.equal(inputPositionLabel(21), "왼쪽 롤러 CCW");
const custom = defaultBindings();
custom[1] = { input: 1, kind: 1, code: 29, modifiers: 0 };
custom[0] = { input: 0, kind: 0, code: 0, modifiers: 0 };
custom[7] = { input: 7, kind: 1, code: 0, modifiers: 0 };
assert.equal(inputLabel(1, custom), "Z · 왼쪽 Hall 2", "current active mapping wins immediately");
assert.equal(inputBindingLabel(0, custom), "미지정");
assert.equal(inputBindingLabel(7, custom), "미지정");
assert.equal(inputBindingLabel(1, []), "미지정", "existing empty mapping cannot fall back to A");

const physical = { inputs: INPUTS, halves: HALVES, controls: CONTROLS.map(({ defaultLabel, ...rest }) => rest) };
assert.equal(createHash("sha256").update(JSON.stringify(physical)).digest("hex"),
  "d7ed778a3ee27baea3227a15aa9dac9bf1b1ca10adcacd1ac562b47697c87fb2",
  "physical geometry, input IDs, legacy physical labels and source references remain exact");
assert.ok(CONTROLS.every(control => !Object.hasOwn(control, "defaultLabel")), "no obsolete second mapping authority");

const demo = new DemoTransport();
const beforeKeys = structuredClone(demo.profile.keys);
assert.deepEqual(demo.profile.bindings, golden);
assert.ok(beforeKeys.every(key => key.released === 0 && key.pressed === 0 && !(key.flags & 4)), "default fixture does not import a user's calibration");
const userBinding = { input: 0, kind: 1, code: 29, modifiers: 2 };
demo.command(OP.SET_BINDING, encodeBinding(userBinding));
assert.deepEqual(decodeBinding(demo.command(OP.GET_BINDING, Uint8Array.of(0))), userBinding);
assert.deepEqual(demo.profile.keys, beforeKeys, "mapping changes do not touch Hall settings");
assert.deepEqual(defaultBindings(), golden);
console.log("Default mapping: all28 frozen tuples, generated parity, immutable defaults, current/unbound labels, duplicate disambiguation, exact physical geometry and mapping-only demo PASS");
