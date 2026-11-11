import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { analyzeAutoFit, evaluateAutoFit } from "../web/auto-fit.mjs";
import { SampledRT } from "../web/rhythm-analysis.mjs";
import { rawToTravel } from "../web/hall-curve.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
const baseConfig = { key: 0, flags: 7, released: 3500, pressed: 500,
  actuation: 180, rt_press: 30, rt_release: 40, top_deadzone: 15,
  bottom_deadzone: 0, noise_deadband: 5, curve_id: 0 };
function rawAtDepth(depth, config) {
  let low = 0, high = Math.abs(config.pressed - config.released);
  const sign = Math.sign(config.pressed - config.released);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rawToTravel(config.released + middle * sign, config) >= depth) high = middle;
    else low = middle + 1;
  }
  return config.released + low * sign;
}
function phase(config, duration, depth) {
  const model = new SampledRT(config);
  const rows = [];
  for (let timeMs = 0; timeMs <= duration; timeMs += 10) {
    const raw = rawAtDepth(Math.round(depth(timeMs)), config);
    rows.push({ timeMs, raw, sequence: (0xffffff00 + timeMs / 10) >>> 0, pressed: model.step(raw).pressed });
  }
  return rows;
}
function inputFor(config = baseConfig, preference = "balanced") {
  return { keyConfig: clone(config), totalTravelMm: 3.4, preference, phases: {
    released: phase(config, 3000, (t) => t % 30 / 10),
    resting: phase(config, 3000, (t) => 8 + t % 50 / 10),
    tapping: phase(config, 5000, (t) => {
      if (t < 100 || t > 4900) return 0;
      const local = (t - 100) % 600;
      if (local < 100) return local * 8;
      if (local < 180) return 800;
      if (local < 330) return Math.max(0, 800 - (local - 180) * 800 / 150);
      return 0;
    }),
    holding: phase(config, 5000, (t) => 900 - (t % 600) / 6),
  } };
}
const validCases = [
  { name: "linear-down-balanced", input: inputFor() },
  { name: "linear-up-repeat", input: inputFor({ ...baseConfig, released: 500, pressed: 3500 }, "repeat") },
  { name: "nonlinear-up-hold", input: inputFor({ ...baseConfig, released: 500, pressed: 3500, curve_id: 1 }, "hold") },
];
function comparison(result) {
  return { ready: result.ready, config: result.recommendation?.config,
    metrics: result.recommendation?.metrics, evidence: result.evidence,
    baselineMetrics: result.baseline?.metrics, observedMetrics: result.observedMetrics };
}
for (const { input } of validCases) {
  const before = clone(input), result = analyzeAutoFit(input);
  assert.equal(result.ready, true, JSON.stringify(result.reasons));
  assert.deepEqual(input, before, "Analysis must never mutate supplied settings or samples");
  assert.equal(result.recommendation.requiresRetest, true);
  for (const field of ["released", "pressed", "curve_id", "noise_deadband", "key"])
    assert.equal(result.recommendation.config[field], input.keyConfig[field]);
  assert.equal(result.recommendation.config.flags & 5, input.keyConfig.flags & 5);
  for (const field of ["restActivations", "missedTaps", "extraTaps", "missedReleases", "holdDrops", "holdUnpressedFraction"])
    assert.equal(result.recommendation.metrics[field], 0, field);
  assert(result.evidence.tapCycles >= 6);
  const evaluation = evaluateAutoFit(result.recommendation.config, input);
  assert.deepEqual(evaluation.metrics, result.recommendation.metrics);
  assert.equal(evaluation.observedMetrics.holdDrops, result.observedMetrics.holdDrops,
    "Observed firmware states must stay independent of candidate simulation");
}

function rejected(name, mutate) {
  const input = inputFor(); mutate(input);
  const result = analyzeAutoFit(input);
  assert.equal(result.ready, false, name);
  assert(result.reasons.length > 0, name);
}
rejected("missing-phase", (input) => { delete input.phases.holding; });
rejected("duplicate-sequence", (input) => { input.phases.resting[10].sequence = input.phases.resting[9].sequence; });
rejected("sample-gap", (input) => { for (const row of input.phases.tapping.slice(20)) row.timeMs += 110; });
rejected("stale-row", (input) => { input.phases.holding[100].fresh = false; });
rejected("reversed-time", (input) => { input.phases.released[30].timeMs = -10; });
rejected("wrong-release-pose", (input) => { input.phases.released = phase(input.keyConfig, 3000, () => 200); });
rejected("wrong-hold-pose", (input) => { input.phases.holding = phase(input.keyConfig, 3000, () => 10); });
rejected("too-few-taps", (input) => { input.phases.tapping = input.phases.tapping.slice(0, 251); });
rejected("no-taps", (input) => { input.phases.tapping = phase(input.keyConfig, 3000, () => 700); });
rejected("uncalibrated-key", (input) => { input.keyConfig.flags &= ~4; });
rejected("disabled-key", (input) => { input.keyConfig.flags &= ~1; });
rejected("mismatched-key", (input) => { input.key = 1; });
rejected("invalid-key", (input) => { input.keyConfig.key = 14; });

const fixturePath = new URL("./fixtures/auto-fit.json", import.meta.url);
if (process.argv.includes("--write-fixtures")) {
  await mkdir(new URL("./fixtures/", import.meta.url), { recursive: true });
  await writeFile(fixturePath, JSON.stringify({ schema: "split-auto-fit-parity-v1",
    valid: validCases.map((item) => ({ ...item, expected: comparison(analyzeAutoFit(item.input)) })) }) + "\n");
} else {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  for (const item of fixture.valid) assert.deepEqual(comparison(analyzeAutoFit(item.input)), item.expected, item.name);
}
console.log("Auto fit: independent tap cycles, held-state continuity, fixed/RT candidate replay, polarity/curve parity, observed states and incomplete evidence gates PASS");
