import { KEY_OPTIONS, MEDIA_OPTIONS } from "./key-catalog.mjs";

const keyboardNames = new Map(KEY_OPTIONS.map(({ code, label }) => [code, label]));
const letters = (text) => Array.from(text, (letter) => [0x04 + letter.charCodeAt(0) - "A".charCodeAt(0)]);
const functionKeys = Array.from({ length: 12 }, (_, i) => [0x3a + i]);

const mainRows = [
  [[0x29], [null], ...functionKeys.slice(0, 4), [null, "", 0.5],
    ...functionKeys.slice(4, 8), [null, "", 0.5], ...functionKeys.slice(8)],
  [[0x35, "`"], ...Array.from({ length: 10 }, (_, i) => [0x1e + i]),
    [0x2d, "-"], [0x2e, "="], [0x2a, "Backspace", 2]],
  [[0x2b, "Tab", 1.5], ...letters("QWERTYUIOP"), [0x2f, "["], [0x30, "]"], [0x31, "\\", 1.5]],
  [[0x39, "Caps", 1.75], ...letters("ASDFGHJKL"), [0x33, ";"], [0x34, "'"], [0x28, "Enter", 2.25]],
  [[0xe1, "Shift", 2.25], ...letters("ZXCVBNM"), [0x36, ","], [0x37, "."], [0x38, "/"], [0xe5, "Shift", 2.75]],
  [[0xe0, "Ctrl", 1.25], [0xe3, "Win", 1.25], [0xe2, "Alt", 1.25], [0x2c, "Space", 6.25],
    [0xe6, "Alt", 1.25], [0xe7, "Win", 1.25], [0x65, "Menu", 1.25], [0xe4, "Ctrl", 1.25]],
];

const navRows = [
  [[0x46, "PrtSc"], [0x47, "ScrLk"], [0x48]],
  [[0x49, "Ins"], [0x4a], [0x4b, "PgUp"]],
  [[0x4c, "Del"], [0x4d], [0x4e, "PgDn"]],
  [],
  [[null], [0x52]],
  [[0x50], [0x51], [0x4f]],
];

// 104 ANSI positions plus four extension keys above the number pad.
const padKeys = [
  [0x68, "F13", 1, 1], [0x69, "F14", 2, 1], [0x90, "한/영", 3, 1], [0x91, "한자", 4, 1],
  [0x53, "Num", 1, 2], [0x54, "/", 2, 2], [0x55, "*", 3, 2], [0x56, "-", 4, 2],
  [0x5f, "7", 1, 3], [0x60, "8", 2, 3], [0x61, "9", 3, 3], [0x57, "+", 4, 3, 1, 2],
  [0x5c, "4", 1, 4], [0x5d, "5", 2, 4], [0x5e, "6", 3, 4],
  [0x59, "1", 1, 5], [0x5a, "2", 2, 5], [0x5b, "3", 3, 5], [0x58, "Enter", 4, 5, 1, 2],
  [0x62, "0", 1, 6, 2], [0x63, ".", 3, 6],
];

function node(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function mountBindingPicker(root, { onPick }) {
  const targets = [];
  const placedKeys = new Set();

  function target(kind, code, text, label = text, className = "") {
    const button = node("button", `binding-picker-key ${className}`.trim(), text);
    button.type = "button";
    button.dataset.kind = String(kind);
    button.dataset.code = String(code);
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", "false");
    button.title = label;
    button.addEventListener("click", (event) => onPick({ kind, code, shiftKey: event.shiftKey }));
    targets.push({ button, kind, code });
    return button;
  }

  function keyboardKey(code, text = keyboardNames.get(code)) {
    placedKeys.add(code);
    return target(1, code, text, keyboardNames.get(code), code >= 0xe0 ? "binding-picker-modifier" : "");
  }

  function keyboardRows(rows, className) {
    const block = node("div", `binding-picker-keyblock ${className}`);
    for (const keys of rows) {
      const row = node("div", "binding-picker-keyrow");
      for (const [code, text, width = 1] of keys) {
        const key = code === null ? node("span", "binding-picker-spacer") : keyboardKey(code, text);
        key.style.gridColumn = `span ${width * 4}`;
        row.append(key);
      }
      block.append(row);
    }
    return block;
  }

  const keyboard = node("div", "binding-picker-keyboard");
  const scroll = node("div", "binding-picker-scroll");
  scroll.setAttribute("role", "region");
  scroll.setAttribute("aria-label", "108키 키보드 출력 선택");
  const board = node("div", "binding-picker-board");
  const pad = node("div", "binding-picker-pad");
  for (const [code, text, column, row, width = 1, height = 1] of padKeys) {
    const key = keyboardKey(code, text);
    key.style.gridColumn = `${column} / span ${width}`;
    key.style.gridRow = `${row} / span ${height}`;
    pad.append(key);
  }
  board.append(keyboardRows(mainRows, "binding-picker-main"), keyboardRows(navRows, "binding-picker-nav"), pad);
  scroll.append(board);

  const extra = node("details", "binding-picker-extra");
  const extraKeys = node("div", "binding-picker-extra-keys");
  const extraCodes = new Set();
  for (const { code, label } of KEY_OPTIONS) {
    if (!code || placedKeys.has(code)) continue;
    extraCodes.add(code);
    extraKeys.append(target(1, code, label));
  }
  extra.append(node("summary", "", "기타 키"), extraKeys);
  keyboard.append(scroll, extra);

  const mouse = node("div", "binding-picker-mouse");
  mouse.setAttribute("role", "group");
  mouse.setAttribute("aria-label", "마우스 출력 선택");
  const shell = node("div", "binding-picker-mouse-shell");
  const mouseFace = node("div", "binding-picker-mouse-face");
  const wheel = node("div", "binding-picker-mouse-wheel");
  wheel.append(target(2, 1, "↑", "스크롤 위"), target(5, 3, "클릭", "마우스 가운데 버튼"),
    target(2, -1, "↓", "스크롤 아래"));
  mouseFace.append(target(5, 1, "왼쪽", "마우스 왼쪽 버튼", "binding-picker-mouse-left"), wheel,
    target(5, 2, "오른쪽", "마우스 오른쪽 버튼", "binding-picker-mouse-right"));
  const thumb = node("div", "binding-picker-mouse-thumb");
  thumb.append(target(5, 5, "앞으로", "마우스 앞으로 버튼"), target(5, 4, "뒤로", "마우스 뒤로 버튼"));
  shell.append(mouseFace, thumb);
  const pan = node("div", "binding-picker-mouse-pan");
  pan.append(target(3, -1, "←", "가로 스크롤 왼쪽"), node("span", "", "가로 스크롤"),
    target(3, 1, "→", "가로 스크롤 오른쪽"));
  mouse.append(shell, pan);

  const media = node("div", "binding-picker-media");
  media.setAttribute("role", "group");
  media.setAttribute("aria-label", "미디어 출력 선택");
  for (const { code, label } of MEDIA_OPTIONS) media.append(target(4, code, label));

  root.classList.add("binding-picker");
  root.replaceChildren(keyboard, mouse, media);

  function render({ kind, codes = [], modifiers = 0, disabled = false }) {
    const keyboardActive = kind === 1 || kind === 6;
    keyboard.hidden = !keyboardActive;
    mouse.hidden = kind !== 2 && kind !== 3 && kind !== 5;
    media.hidden = kind !== 4;
    const selected = new Set(codes);
    for (const { button, kind: targetKind, code } of targets) {
      const pressed = targetKind === 1 && keyboardActive
        ? selected.has(code) || (code >= 0xe0 && Boolean(modifiers & (1 << (code - 0xe0))))
        : targetKind === kind && selected.has(code);
      button.disabled = disabled;
      button.setAttribute("aria-pressed", String(pressed));
    }
    if (keyboardActive && codes.some((code) => extraCodes.has(code))) extra.open = true;
  }

  return { render };
}
