// USB HID Keyboard/Keypad usages (page 0x07), not character/OS scan codes.
// Labels follow US legends; the host's language/layout determines characters.
// Reference: https://www.usb.org/hid (HID Usage Tables, Keyboard/Keypad page).
// Korean LANG1/LANG2 are usage 0x90/0x91; OS language settings still apply.
const options = [];
function row(code, label, group) {
  options.push({ code, label, group });
}
row(0, "조합키만 / 일반 키 없음", "기본");
for (let i = 0; i < 26; i++) row(4 + i, String.fromCharCode(65 + i), "문자");
for (let i = 0; i < 10; i++) row(30 + i, String((i + 1) % 10), "숫자");
[
  [0x28, "Enter"],
  [0x29, "Esc"],
  [0x2a, "Backspace"],
  [0x2b, "Tab"],
  [0x2c, "Space"],
  [0x2d, "- / _"],
  [0x2e, "= / +"],
  [0x2f, "[ / {"],
  [0x30, "] / }"],
  [0x31, "\\ / |"],
  [0x32, "Non-US #"],
  [0x33, "; / :"],
  [0x34, "' / \""],
  [0x35, "` / ~"],
  [0x36, ", / <"],
  [0x37, ". / >"],
  [0x38, "/ / ?"],
  [0x39, "Caps Lock"],
  [0x64, "Non-US \\"],
].forEach(([code, label]) => row(code, label, "기본·기호"));
for (let i = 0; i < 12; i++) row(0x3a + i, `F${i + 1}`, "기능키");
for (let i = 0; i < 12; i++) row(0x68 + i, `F${i + 13}`, "기능키");
[
  [0x46, "Print Screen"],
  [0x47, "Scroll Lock"],
  [0x48, "Pause"],
  [0x49, "Insert"],
  [0x4a, "Home"],
  [0x4b, "Page Up"],
  [0x4c, "Delete"],
  [0x4d, "End"],
  [0x4e, "Page Down"],
  [0x4f, "→"],
  [0x50, "←"],
  [0x51, "↓"],
  [0x52, "↑"],
  [0x65, "메뉴 / Application"],
].forEach(([code, label]) => row(code, label, "이동·편집"));
[
  [0x53, "Num Lock"],
  [0x54, "Num /"],
  [0x55, "Num *"],
  [0x56, "Num -"],
  [0x57, "Num +"],
  [0x58, "Num Enter"],
  [0x59, "Num 1"],
  [0x5a, "Num 2"],
  [0x5b, "Num 3"],
  [0x5c, "Num 4"],
  [0x5d, "Num 5"],
  [0x5e, "Num 6"],
  [0x5f, "Num 7"],
  [0x60, "Num 8"],
  [0x61, "Num 9"],
  [0x62, "Num 0"],
  [0x63, "Num ."],
  [0x67, "Num ="],
  [0x85, "Num ,"],
].forEach(([code, label]) => row(code, label, "숫자패드"));
[
  [0x90, "한/영 (LANG1)"],
  [0x91, "한자 (LANG2)"],
  [0x87, "Intl1 / ろ"],
  [0x88, "Intl2 / かな"],
  [0x89, "Intl3 / ¥"],
  [0x8a, "Intl4 / 変換"],
  [0x8b, "Intl5 / 無変換"],
  [0x8c, "Intl6 / Num ,"],
  [0x8d, "International7"],
  [0x8e, "International8"],
  [0x8f, "International9"],
  [0x92, "カタカナ (LANG3)"],
  [0x93, "ひらがな (LANG4)"],
  [0x94, "全角/半角 (LANG5)"],
].forEach(([code, label]) => row(code, label, "한글·일본어·국제"));
export const MODIFIERS = [
  { bit: 1, label: "L Ctrl" },
  { bit: 2, label: "L Shift" },
  { bit: 4, label: "L Alt" },
  { bit: 8, label: "L Win / ⌘" },
  { bit: 16, label: "R Ctrl" },
  { bit: 32, label: "R Shift" },
  { bit: 64, label: "R Alt" },
  { bit: 128, label: "R Win / ⌘" },
];
MODIFIERS.forEach((m, i) => row(0xe0 + i, m.label, "조합키"));
export const KEY_OPTIONS = options;
export const MEDIA_OPTIONS = [
  { code: 0xb5, label: "다음 곡" },
  { code: 0xb6, label: "이전 곡" },
  { code: 0xb7, label: "정지" },
  { code: 0xcd, label: "재생 / 일시 정지" },
  { code: 0xe2, label: "음소거" },
  { code: 0xe9, label: "음량 +" },
  { code: 0xea, label: "음량 −" },
];
const keyNames = new Map(KEY_OPTIONS.map(({ code, label }) => [code, label]));
const mediaNames = new Map(
  MEDIA_OPTIONS.map(({ code, label }) => [code, label]),
);
const hex = (code) => `HID 0x${Number(code).toString(16).toUpperCase()}`;
export function bindingLabel(binding) {
  if (!binding) return "미지정";
  switch (binding.kind) {
    case 0:
      return "미지정";
    case 1:
    case 6: {
      const labels = MODIFIERS.filter((m) => binding.modifiers & m.bit).map(
        (m) => m.label,
      );
      const keys = binding.kind === 6 ? binding.keys : binding.code ? [binding.code] : [];
      for (const key of keys) labels.push(keyNames.get(key) ?? hex(key));
      return labels.join(" + ") || "미지정";
    }
    case 2:
      return binding.code === 1 ? "스크롤 ↑" : "스크롤 ↓";
    case 3:
      return binding.code === 1 ? "가로 스크롤 →" : "가로 스크롤 ←";
    case 4:
      return mediaNames.get(binding.code) ?? hex(binding.code);
    case 5:
      return (
        [
          "",
          "마우스 왼쪽",
          "마우스 오른쪽",
          "마우스 가운데",
          "마우스 뒤로",
          "마우스 앞으로",
        ][binding.code] ?? "마우스 ?"
      );
    default:
      return "알 수 없는 매핑";
  }
}
