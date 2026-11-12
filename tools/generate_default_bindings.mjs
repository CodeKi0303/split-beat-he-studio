// The shared JSON contains mappings only, never calibration or device identity.
import { readFile, writeFile } from "node:fs/promises";
import { bindingRecord } from "../web/protocol.mjs";
const fixture = JSON.parse(await readFile(new URL("../web/default-bindings.json", import.meta.url), "utf8"));
if (fixture.schema !== "split-beat-he-default-bindings-v1" || fixture.bindings?.length !== 28)
  throw Error("Expected the canonical 28-input default mapping");
const bindings = fixture.bindings.map(bindingRecord);
if (bindings.some((binding, input) => binding.input !== input)) throw Error("Default inputs must be ordered 0..27");
const source = `// Generated from default-bindings.json by tools/generate_default_bindings.mjs.\n// Only disconnected preview and a fresh simulator use these defaults.\nconst records = [\n${bindings.map(binding => "  " + JSON.stringify(binding)).join(",\n")}\n];\nexport const DEFAULT_BINDINGS = Object.freeze(records.map(binding => Object.freeze(binding)));\nexport function defaultBindings() { return structuredClone(DEFAULT_BINDINGS); }\n`;
const target = new URL("../web/default-bindings.mjs", import.meta.url);
if (process.argv.includes("--check")) {
  if (await readFile(target, "utf8") !== source) throw Error("Generated default-bindings.mjs is stale");
} else await writeFile(target, source);
