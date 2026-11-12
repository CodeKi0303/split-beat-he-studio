import { INPUTS, CONTROLS, HALVES } from "./layout.mjs?v=studio-owlab1";
import { DEFAULT_BINDINGS } from "./default-bindings.mjs?v=studio-default-layout1";
import { bindingLabel } from "./key-catalog.mjs?v=studio-default-layout1";

function inputRecord(id) {
  if (!Number.isInteger(id) || !INPUTS[id]) throw Error("Input must be 0..27");
  return INPUTS[id];
}
export function inputBinding(id, bindings = DEFAULT_BINDINGS) {
  inputRecord(id);
  // An existing but unbound/partial profile must not inherit a default key.
  return (bindings ?? DEFAULT_BINDINGS).find(binding => binding.input === id) ?? null;
}
export function inputBindingLabel(id, bindings) {
  const binding = inputBinding(id, bindings);
  if (!binding || binding.kind === 0 || (binding.kind === 1 && !binding.code && !binding.modifiers)) return "미지정";
  return bindingLabel(binding);
}
export function inputPositionLabel(id) {
  const input = inputRecord(id), side = HALVES[input.side].label;
  if (input.type === "hall") return `${side} Hall ${input.hallIndex % 7 + 1}`;
  if (input.type === "digital") return `${side} MX ${CONTROLS.find(control => control.id === input.controlId).label}`;
  const direction = input.direction === "click" ? "클릭" : input.direction.toUpperCase();
  return `${side} ${input.type === "roller" ? "롤러" : "노브"} ${direction}`;
}
export function inputLabel(id, bindings) {
  return `${inputBindingLabel(id, bindings)} · ${inputPositionLabel(id)}`;
}
export function inputKeycapLabel(id, bindings) {
  const label = inputBindingLabel(id, bindings);
  if (!INPUTS[id].direction || INPUTS[id].direction === "click") return label;
  return ({ "Page Up": "Pg↑", "Page Down": "Pg↓", "스크롤 ↑": "휠↑", "스크롤 ↓": "휠↓" })[label] ?? label;
}
