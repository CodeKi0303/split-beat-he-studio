import { validateFirmware } from "./fw-protocol.mjs";

export const releaseAssetName = (role) => `c86-${role}-app.fw.json`;
export const releaseAssetPath = (role) => `firmware/${releaseAssetName(role)}`;
const MAX_PACKAGE_BYTES = 450000;
const roles = ["left", "right"];

export function firmwareVersionNumber(major, minor, patch) {
  if (![major, minor, patch].every((part, i) => Number.isInteger(part) && part >= 0 && part <= (i === 2 ? 65535 : 255))) return null;
  return major * 0x1000000 + minor * 0x10000 + patch;
}

export function validateRelease(data) {
  if (data?.schema !== "split-studio-release-v1" || data.hardware !== 86 || !data.firmware) throw Error("릴리스 목록 형식 오류");
  for (const role of roles) {
    const entry = data.firmware[role];
    const match = typeof entry?.version === "string" && /^(\d{1,3})\.(\d{1,3})\.(\d{1,5})$/.exec(entry.version);
    const version = match && firmwareVersionNumber(...match.slice(1).map(Number));
    if (!version || entry.versionNumber !== version || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !Number.isInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > MAX_PACKAGE_BYTES) throw Error("릴리스 펌웨어 정보 오류");
  }
  const { left, right } = data.firmware;
  if (left.versionNumber !== right.versionNumber || left.version !== right.version) throw Error("릴리스 좌우 펌웨어 버전이 다릅니다.");
  return data;
}

export async function fetchStudioRelease() {
  const response = await fetch(new URL("release.json", import.meta.url), { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Error("게시된 릴리스를 불러올 수 없습니다.");
  return validateRelease(await response.json());
}

export async function fetchReleaseFirmware(release, role) {
  if (!roles.includes(role)) throw Error("잘못된 업데이트 대상");
  const entry = release.firmware[role];
  const response = await fetch(new URL(releaseAssetPath(role), import.meta.url), { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error("릴리스 파일을 불러올 수 없습니다.");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== entry.bytes) throw Error("릴리스 파일 크기 불일치");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (sha !== entry.sha256) throw Error("릴리스 파일 SHA256 불일치. 페이지를 새로고침하세요.");
  const source = new TextDecoder().decode(bytes);
  const { manifest } = await validateFirmware(source);
  if (manifest.role !== role || manifest.version !== entry.version || manifest.version_number !== entry.versionNumber) throw Error("릴리스 버전 또는 대상 불일치");
  return source;
}
