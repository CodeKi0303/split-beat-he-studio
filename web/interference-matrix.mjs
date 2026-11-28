import { CONTROLS } from "./layout.mjs?v=studio-owlab1";

const hall = CONTROLS.filter((control) => control.type === "hall")
  .sort((a, b) => a.inputs[0] - b.inputs[0]);
// C86 matched phase-pair scans, firmware src/adc_scan_async64.inc.
// Use STATUS physical key IDs, including repeated conversions within one scan.
const verifiedRankVersions = new Set(["0.3.46", "0.3.47", "0.3.48", "0.3.49", "0.4.0", "0.5.0"]);
const rankOrder = [
  [[0, 1, 2, 3, 0, 1, 2, 3], [4, 5, 6, 6, 5, 4]],
  [[7, 7, 8, 8, 9, 9, 10, 10], [11, 12, 12, 13, 13, 11]],
];

export function c86KeyRelation(source, observed) {
  const from = hall[source], to = hall[observed];
  if (from.side !== to.side || source === observed) return { nearby: false, nextAdc: null };
  const distance = Math.hypot(from.x - to.x, from.y - to.y);
  const bank = rankOrder[from.side].findIndex((order) =>
    order.some((id, rank) => id === source && order[rank + 1] === observed));
  return { nearby: distance <= 21, nextAdc: bank < 0 ? null : bank + 1 };
}

function physicalId(key) {
  return `${key < 7 ? "L" : "R"}${key % 7 + 1}`;
}

function heading(key, scope, label) {
  const th = document.createElement("th");
  th.scope = scope;
  th.textContent = `${physicalId(key)} · ${label(key)}`;
  return th;
}

const signedFormat = new Intl.NumberFormat("ko", { signDisplay: "exceptZero", maximumFractionDigits: 2 });
const signed = (value) => value === null ? "미보정" : signedFormat.format(value);

export function drawInterferenceMatrix(table, rows, unit, info, label) {
  const isC86 = info?.board_rev === 86;
  // Normal STATUS has no right-hand firmware version or live rank sequence.
  // Unknown versions may use another ADC sequence.
  const rankReference = isC86 && verifiedRankVersions.has(`${info.major}.${info.minor}.${info.patch}`);
  document.getElementById("matrixLegend").textContent = [
    "각 칸은 누른 동안의 평균에서 놓은 동안의 평균을 뺀 값입니다.",
    unit === "percent" ? "%는 관찰 키의 보정 스트로크 기준이며 +는 눌림 방향입니다." : "단위는 STATUS에서 관찰한 ADC 코드입니다.",
    isC86 ? "이웃은 같은 쪽 센서 중심 간 21 mm 이내입니다." : "",
    rankReference ? "ADC 표시는 양쪽 펌웨어 버전이 같을 때 같은 스캔의 바로 다음 변환입니다. 우측 버전은 이 화면에서 확인할 수 없습니다." : "",
  ].filter(Boolean).join(" ");
  const head = document.createElement("thead");
  const headers = head.insertRow();
  const corner = document.createElement("th");
  corner.scope = "col";
  corner.textContent = "누른 키 ↓ / 관찰 키 →";
  headers.append(corner);
  for (let key = 0; key < hall.length; key++) headers.append(heading(key, "col", label));
  const body = document.createElement("tbody");
  for (const source of [...rows.keys()].sort((a, b) => a - b)) {
    const tr = body.insertRow();
    tr.append(heading(source, "row", label));
    for (const value of rows.get(source).keys) {
      const td = tr.insertCell();
      td.textContent = signed(unit === "percent" ? value.meanDeltaPercent : value.meanDeltaRaw);
      const relation = c86KeyRelation(source, value.key);
      const notes = [];
      if (value.selected) notes.push("누른 키");
      if (isC86 && relation.nearby) notes.push("이웃");
      if (rankReference && relation.nextAdc) notes.push(`ADC${relation.nextAdc} 직후`);
      if (notes.length) {
        const small = document.createElement("small");
        small.textContent = notes.join(" · ");
        td.append(small);
      }
    }
  }
  table.replaceChildren(head, body);
}
