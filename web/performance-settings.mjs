import {
  CAP_BOTTOM_DEADZONE,
  CAP_HALL_CURVE,
  keyRecord,
  requireKeyCapability,
  validateProfile,
} from "./protocol.mjs?v=studio-owlab1";
import { mmToNormalized } from "./telemetry.mjs?v=studio-owlab1";

const distanceFields = [
  "actuation", "rt_press", "rt_release", "top_deadzone", "bottom_deadzone",
];
const allowedFields = new Set([
  ...distanceFields, "noise_deadband", "enabled", "rapid_trigger", "curve_id",
]);
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const message = (error) => error instanceof Error ? error.message : String(error);
const result = (values = {}) => ({
  profile: null, appliedKeys: [], complete: false, error: null,
  unexpectedChanges: false, ...values,
});

/** Build a patch in physical mm for each selected Hall key. Unedited fields,
 * calibration endpoints, and the calibration-valid flag stay per-key. This is
 * pure validation: it never contacts a device or silently clamps a distance.
 */
export function proposePerformanceSettings(
  profile, selectedIds, travelMm, draft, capabilities = 0,
) {
  const original = validateProfile(profile);
  if (!(Array.isArray(selectedIds) || selectedIds instanceof Set))
    throw Error("설정할 Hall 키를 선택하세요.");
  const ids = [...selectedIds];
  if (!ids.length || ids.length > 14 || new Set(ids).size !== ids.length ||
      ids.some((id) => !Number.isInteger(id) || id < 0 || id >= 14))
    throw Error("중복 없이 Hall 키 0–13을 선택하세요.");
  if (!Array.isArray(travelMm) || travelMm.length !== 14)
    throw Error("Hall 키 14개의 총 이동거리가 필요합니다.");
  if (!draft || typeof draft !== "object" || Array.isArray(draft) ||
      !Object.keys(draft).length || Object.keys(draft).some((field) => !allowedFields.has(field)))
    throw Error("변경할 작동점·RT·데드존 설정을 입력하세요.");
  if (!Number.isInteger(capabilities) || capabilities < 0)
    throw Error("장치 기능 정보를 확인할 수 없습니다.");
  for (const field of ["enabled", "rapid_trigger"])
    if (Object.hasOwn(draft, field) && typeof draft[field] !== "boolean")
      throw Error(`${field}: 켜짐 또는 꺼짐을 선택하세요.`);
  if (Object.hasOwn(draft, "noise_deadband") &&
      (!Number.isInteger(draft.noise_deadband) || draft.noise_deadband < 0 || draft.noise_deadband > 100))
    throw Error("센서 데드밴드는 ADC 0–100 정수로 입력하세요.");
  for (const field of distanceFields)
    if (Object.hasOwn(draft, field) &&
        (typeof draft[field] !== "number" || !Number.isFinite(draft[field]) || draft[field] < 0))
      throw Error(`${field}: 0 이상의 거리를 입력하세요.`);
  if (draft.bottom_deadzone > 0 && !(capabilities & CAP_BOTTOM_DEADZONE))
    throw Error("하단 데드존은 펌웨어 업데이트 후 적용할 수 있습니다.");
  if (Object.hasOwn(draft, "curve_id") &&
      (!Number.isInteger(draft.curve_id) || draft.curve_id < 0 || draft.curve_id > 1))
    throw Error("지원하지 않는 Hall 거리 곡선입니다.");
  if (draft.curve_id && !(capabilities & CAP_HALL_CURVE))
    throw Error("비선형 거리 보정은 펌웨어 0.3.5 업데이트 후 적용할 수 있습니다.");

  return ids.map((id) => {
    const before = original.keys[id], key = { ...before };
    const total = travelMm[id];
    if (typeof total !== "number" || !Number.isFinite(total) || total < 0.1 || total > 10)
      throw Error(`Hall ${id}: 총 이동거리는 0.10–10.00 mm여야 합니다.`);
    if (distanceFields.some((field) => Object.hasOwn(draft, field)) && !(before.flags & 4))
      throw Error(`Hall ${id}: 먼저 캘리브레이션을 완료하세요.`);
    const distance = Object.fromEntries(distanceFields.map((field) => [field,
      Object.hasOwn(draft, field) ? draft[field] : (before[field] ?? 0) * total / 1000,
    ]));
    if (distance.top_deadzone >= distance.actuation ||
        distance.actuation + distance.bottom_deadzone > total + 1e-9)
      throw Error(`Hall ${id}: 작동점은 상단 데드존보다 깊고 하단 데드존보다 위에 있어야 합니다.`);
    for (const field of distanceFields) {
      if (!Object.hasOwn(draft, field)) continue;
      if (draft[field] > total)
        throw Error(`Hall ${id}: ${field}가 총 이동거리 ${total.toFixed(2)} mm를 넘습니다.`);
      key[field] = mmToNormalized(draft[field], total);
    }
    if (Object.hasOwn(draft, "noise_deadband")) key.noise_deadband = draft.noise_deadband;
    if (Object.hasOwn(draft, "curve_id")) key.curve_id = draft.curve_id;
    if (Object.hasOwn(draft, "enabled")) key.flags = (key.flags & ~1) | Number(draft.enabled);
    if (Object.hasOwn(draft, "rapid_trigger")) key.flags = (key.flags & ~2) | (Number(draft.rapid_trigger) << 1);
    if ((key.flags & 1) && !(key.flags & 4))
      throw Error(`Hall ${id}: 활성화하려면 먼저 캘리브레이션을 완료하세요.`);
    if ((key.bottom_deadzone ?? 0) > 0 && !(capabilities & CAP_BOTTOM_DEADZONE))
      throw Error("하단 데드존은 펌웨어 업데이트 후 적용할 수 있습니다.");
    requireKeyCapability(key, capabilities);
    try { return keyRecord(key); }
    catch (error) { throw Error(`Hall ${id}: ${message(error)}`); }
  });
}

/** Apply explicit Hall settings to RAM with output OFF and exact full-profile
 * readback. No SAVE, enable, rollback or retry; partial results are reported.
 */
export async function applyPerformanceSettings(client, originalProfile, candidates) {
  let original, proposed, expected;
  try {
    original = validateProfile(originalProfile);
    if (!Array.isArray(candidates) || !candidates.length || candidates.length > 14)
      throw Error("적용할 Hall 설정을 선택하세요.");
    const seen = new Set();
    proposed = candidates.map((value) => {
      const key = keyRecord(value), before = original.keys[key.key];
      if (seen.has(key.key)) throw Error("같은 Hall 키가 중복되었습니다.");
      seen.add(key.key);
      if (key.released !== before.released || key.pressed !== before.pressed ||
          (key.flags & 4) !== (before.flags & 4))
        throw Error(`Hall ${key.key}: 작동 설정은 캘리브레이션을 변경할 수 없습니다.`);
      if (!(before.flags & 4) && distanceFields.some((field) =>
          (key[field] ?? 0) !== (before[field] ?? 0)))
        throw Error(`Hall ${key.key}: 먼저 캘리브레이션을 완료하세요.`);
      if ((key.flags & 1) && !(key.flags & 4))
        throw Error(`Hall ${key.key}: 활성화하려면 먼저 캘리브레이션을 완료하세요.`);
      return key;
    });
    expected = structuredClone(original);
    for (const key of proposed) expected.keys[key.key] = { ...key };
    expected = validateProfile(expected);
  } catch (error) { return result({ error: message(error) }); }

  let failure = null, preflightPassed = false, attempted = false;
  try {
    if (proposed.some((key) => key.curve_id)) {
      const deviceInfo = await client.info();
      for (const key of proposed) requireKeyCapability(key, deviceInfo.capabilities);
    }
    if (await client.output(false) !== false)
      throw Error("키 출력 해제를 확인하지 못했습니다.");
    const before = validateProfile(await client.getConfig());
    if (!equal(before, original))
      return result({ profile: before, unexpectedChanges: true,
        error: "장치 설정이 변경되었습니다. 다시 확인 후 적용하세요. 설정을 쓰지 않았습니다." });
    preflightPassed = true;
    for (const key of proposed) {
      attempted = true;
      const echoed = keyRecord(await client.setKey({ ...key }));
      if (!equal(echoed, key)) throw Error(`Hall ${key.key}: 설정 응답이 요청과 다릅니다.`);
    }
  } catch (error) { failure = message(error); }

  let actual;
  try { actual = validateProfile(await client.getConfig()); }
  catch (error) {
    return result({ error: `${failure ? `${failure} · ` : ""}최종 RAM 읽기 확인 실패: ${message(error)}. ${attempted ? "일부 설정은 적용되었을 수 있습니다." : "설정을 쓰지 않았습니다."} 자동 재시도·저장은 하지 않았습니다.` });
  }
  const complete = preflightPassed && equal(actual, expected);
  const targets = new Set(proposed.map((key) => key.key));
  const appliedKeys = preflightPassed
    ? proposed.filter((key) => equal(actual.keys[key.key], key)).map((key) => key.key)
    : [];
  const unexpectedChanges = !preflightPassed ? !equal(actual, original) :
    !equal(actual.bindings, original.bindings) ||
    actual.keys.some((key, i) => !targets.has(i) && !equal(key, original.keys[i])) ||
    actual.keys.some((key, i) => targets.has(i) &&
      !equal(key, original.keys[i]) && !equal(key, expected.keys[i]));
  return result({ profile: actual, appliedKeys, complete, unexpectedChanges,
    error: complete ? null : `${failure ? `${failure} · ` : ""}${appliedKeys.length}/${proposed.length}개 설정을 확인했습니다.${unexpectedChanges ? " 요청하지 않은 변경도 발견했습니다." : ""} 자동 재시도·저장은 하지 않았습니다.` });
}
