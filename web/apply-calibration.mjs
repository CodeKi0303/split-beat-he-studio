import { keyRecord, validateProfile } from "./protocol.mjs?v=studio-owlab1";

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const equal = (a, b) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const message = (error) =>
  error instanceof Error ? error.message : String(error);
const result = (values = {}) => ({
  profile: null,
  appliedKeys: [],
  complete: false,
  error: null,
  unexpectedChanges: false,
  ...values,
});

/** Apply only observed Hall endpoints to RAM. Never SAVE, enable output, retry a
 * SET, or roll back a partially completed transaction. Readback, not an ACK,
 * determines which candidate records are known to be present after a failure.
 * Caller must keep its UI edits/capture frozen during this operation.
 */
export async function applyCalibration(client, originalProfile, candidates) {
  let original, proposed, expected;
  try {
    original = validateProfile(originalProfile);
    if (
      !Array.isArray(candidates) ||
      !candidates.length ||
      candidates.length > 14
    )
      throw Error("적용 가능한 Hall 보정값이 하나 이상 필요합니다.");
    const seen = new Set();
    proposed = candidates.map((value) => {
      const key = keyRecord(value);
      if (seen.has(key.key))
        throw Error("같은 Hall 키의 보정값이 중복되었습니다.");
      seen.add(key.key);
      const before = original.keys[key.key];
      if (key.flags !== (before.flags | 4))
        throw Error("보정은 기존 키 활성화와 RT 설정을 바꿀 수 없습니다.");
      for (const field of Object.keys(before)) {
        if (
          !["released", "pressed", "flags"].includes(field) &&
          key[field] !== before[field]
        )
          throw Error(
            `Hall ${key.key}: 보정 외 설정(${field})이 변경되었습니다.`,
          );
      }
      // Explicit even though keyRecord also enforces this for calibrated keys.
      if (Math.abs(key.pressed - key.released) < 128)
        throw Error(
          `Hall ${key.key}: 현재 펌웨어는 ADC 범위 128 이상이 필요합니다.`,
        );
      return key;
    });
    expected = structuredClone(original);
    for (const key of proposed) expected.keys[key.key] = { ...key };
    expected = validateProfile(expected);
  } catch (error) {
    return result({ error: message(error) });
  }

  let failure = null,
    preflightPassed = false,
    attempted = false;
  try {
    // Require the acknowledged OFF result before any SET_KEY request.
    const enabled = await client.output(false);
    if (enabled !== false) throw Error("키 출력 해제를 확인하지 못했습니다.");
    const before = validateProfile(await client.getConfig());
    if (!equal(before, original))
      return result({
        profile: before,
        error:
          "수집을 시작한 뒤 장치 설정이 바뀌었습니다. 새 설정을 확인하고 다시 수집하세요. 보정값을 쓰지 않았습니다.",
        unexpectedChanges: true,
      });
    preflightPassed = true;
    for (const key of proposed) {
      attempted = true;
      const echoed = keyRecord(await client.setKey({ ...key }));
      if (!equal(echoed, key))
        throw Error(`Hall ${key.key}: 보정 응답이 요청과 다릅니다.`);
    }
  } catch (error) {
    failure = message(error);
  }

  let actual;
  try {
    actual = validateProfile(await client.getConfig());
  } catch (error) {
    return result({
      error: `${failure ? `${failure} · ` : ""}최종 RAM 읽기 확인 실패: ${message(error)}. ${attempted ? "일부 보정값은 적용되었을 수 있습니다." : "보정 쓰기는 시작하지 않았습니다."} 자동 재시도와 Flash 저장은 하지 않았습니다.`,
    });
  }

  // A lost final ACK can still be conclusively resolved by an exact readback.
  const complete = preflightPassed && equal(actual, expected);
  const targetIds = new Set(proposed.map((key) => key.key));
  const appliedKeys = preflightPassed
    ? proposed
        .filter((key) => equal(actual.keys[key.key], key))
        .map((key) => key.key)
    : [];
  const unexpectedChanges =
    !equal(actual.bindings, original.bindings) ||
    actual.keys.some(
      (key, i) => !targetIds.has(i) && !equal(key, original.keys[i]),
    ) ||
    actual.keys.some(
      (key, i) =>
        targetIds.has(i) &&
        !equal(key, original.keys[i]) &&
        !equal(key, expected.keys[i]),
    );
  return result({
    profile: actual,
    appliedKeys,
    complete,
    unexpectedChanges,
    error: complete
      ? null
      : `${failure ? `${failure} · ` : ""}${appliedKeys.length}/${proposed.length}개 보정값을 최종 RAM에서 확인했습니다.${unexpectedChanges ? " 요청하지 않은 설정 변경도 발견했습니다." : ""} 자동 재시도와 Flash 저장은 하지 않았습니다.`,
  });
}
