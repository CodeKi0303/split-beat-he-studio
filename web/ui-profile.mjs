import { validateProfile } from "./protocol.mjs?v=studio-owlab1";

// UI metadata is deliberately outside the firmware's strict binary profile.
// Total travel describes switch stroke, not keycap/keyboard overall height.
const UI_SCHEMA = "split-studio-profile-v1";
function exactFields(value, names, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("|") !== [...names].sort().join("|")
  )
    throw Error(`${label}: 필드 불일치`);
}

export function validateTravelArray(value) {
  if (!Array.isArray(value) || value.length !== 14)
    throw Error("총 스트로크는 Hall 키 14개의 값이 필요합니다");
  const result = [];
  for (let i = 0; i < 14; i++) {
    const mm = value[i];
    if (
      !Object.hasOwn(value, i) ||
      typeof mm !== "number" ||
      !Number.isFinite(mm) ||
      mm < 0.1 ||
      mm > 10
    )
      throw Error(`Hall ${i}: 총 스트로크는 0.1–10 mm 숫자여야 합니다`);
    result.push(mm);
  }
  return result;
}

export function parseUiProfile(value) {
  if (value?.schema === "c77-profile-v1")
    return { device: validateProfile(value), travelMm: null };
  exactFields(value, ["schema", "device", "ui"], "설정 파일");
  if (value.schema !== UI_SCHEMA) throw Error("지원하지 않는 설정 파일 버전");
  exactFields(value.ui, ["totalTravelMm"], "화면 설정");
  return {
    device: validateProfile(value.device),
    travelMm: validateTravelArray(value.ui.totalTravelMm),
  };
}

export function makeUiProfile(profile, travelMm) {
  return {
    schema: UI_SCHEMA,
    device: validateProfile(profile),
    ui: { totalTravelMm: validateTravelArray(travelMm) },
  };
}
