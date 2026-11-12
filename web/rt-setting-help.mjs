const descriptions = {
  actuation: {
    title: "작동 지점",
    paragraphs: [
      "키를 놓은 위치를 0 mm로 보았을 때 처음 입력이 켜지는 깊이입니다. 작동점을 1.00 mm로 설정하면 1.00 mm까지 눌렀을 때 입력됩니다.",
      "RT를 켜면 첫 입력 이후에는 눌림·복귀 RT의 이동량으로 재입력과 해제를 판단합니다. 상단 데드존까지 돌아오면 초기화되어 다음 입력은 다시 작동점을 지나야 합니다.",
      "RT를 끄면 작동점 이상에서 입력을 유지하고, 작동점보다 얕아지면 해제합니다.",
    ],
  },
  rt: {
    title: "래피드 트리거",
    paragraphs: [
      "처음 작동점을 지난 뒤, 아래로 움직인 거리와 위로 움직인 거리로 입력·해제를 판단합니다. 눌림 RT와 복귀 RT를 각각 설정할 수 있습니다.",
      "기본값인 ‘미해제 재입력 허용’ 꺼짐에서는 입력이 켜진 동안 계속 누른 상태를 유지합니다. 새 입력을 만들려면 먼저 복귀 RT만큼 올라와 해제된 뒤, 눌림 RT만큼 다시 내려가야 합니다.",
      "복귀 RT 0.80 mm를 가정하면 2.00 → 1.30 → 1.90 mm에서는 입력이 계속 켜져 있습니다. 1.20 mm에서 해제된 다음, 눌림 RT가 0.60 mm이면 1.80 mm에서 재입력됩니다. 이 예시는 미해제 재입력이 꺼져 있고, 데드존의 영향을 받지 않으며 해제 후 더 얕게 올라가지 않은 경우입니다.",
    ],
  },
  retrigger: {
    title: "미해제 재입력 허용",
    paragraphs: [
      "기본값은 꺼짐입니다. 켜면 복귀 RT만큼 올라오지 않아 입력이 켜져 있어도, 위로 움직였다가 눌림 RT만큼 다시 내려갈 때 새 입력을 만듭니다. RT가 켜져 있어야 적용됩니다.",
      "복귀 RT 0.80 mm, 눌림 RT 0.60 mm라면 2.00 → 1.30 mm에서는 계속 켜져 있지만, 1.90 mm로 다시 내려갈 때 해제 → 눌림을 차례로 전송합니다. 위로 돌아온 가장 얕은 지점이 재입력 기준이 됩니다.",
      "게임에는 실제 키를 뗀 것으로 전달되므로 롱노트가 끊길 수 있습니다. 롱노트를 유지하려면 꺼 두세요. 상단 데드존은 입력을 끄고, 하단 데드존의 입력 유지 동작은 이 옵션보다 우선합니다.",
      "미해제 재입력을 지원하는 펌웨어에서 사용할 수 있습니다. 지원하지 않는 장치에서는 옵션이 비활성화됩니다.",
    ],
  },
  rtPress: {
    title: "눌림 RT",
    paragraphs: [
      "RT로 입력이 해제된 다음, 키가 올라온 가장 얕은 지점에서 다시 얼마나 내려가야 입력할지 정합니다.",
      "눌림 RT가 0.60 mm이고 키가 1.20 mm까지 올라왔다면 1.80 mm에서 재입력됩니다. 0.90 mm까지 더 올라왔다면 새 기준은 0.90 mm가 되어 1.50 mm에서 재입력됩니다.",
      "값이 작을수록 작은 움직임으로 재입력됩니다. 기본 설정에서는 아직 해제되지 않은 키를 계속 누른 상태로 유지합니다. ‘미해제 재입력 허용’을 켜면 해제 전의 복귀 움직임에도 이 거리를 적용합니다. 처음 누를 때는 작동점을 사용합니다.",
    ],
  },
  rtRelease: {
    title: "복귀 RT",
    paragraphs: [
      "입력이 켜진 뒤 가장 깊게 누른 지점에서 얼마나 올라와야 해제할지 정합니다. 더 깊게 누르면 그 지점으로 기준도 내려갑니다.",
      "복귀 RT가 0.80 mm라면 2.00 mm에서 1.20 mm까지 올라와야 해제됩니다. 기본값인 ‘미해제 재입력 허용’ 꺼짐에서는 1.30 mm까지만 올라왔다가 1.90 mm로 다시 내려가도 입력이 계속 켜져 있으므로 새 입력은 발생하지 않습니다.",
      "값을 늘리면 롱노트 유지 중 작은 복귀에 더 여유가 생기고, 연타할 때는 더 많이 올려야 해제됩니다. 상단·하단 데드존에 들어가면 해당 구간의 동작이 먼저 적용됩니다.",
    ],
  },
  topDeadzone: {
    title: "상단 데드존",
    paragraphs: [
      "키를 놓은 위치 근처에서 입력을 꺼 두는 구간입니다. 0.10 mm로 설정하면 0~0.10 mm에서는 입력을 해제합니다.",
      "상단 데드존 안의 인식 이동량은 0 mm로 표시합니다. 경계를 벗어나면 원래 이동량을 그대로 표시하며 중간 범위를 늘리지 않습니다.",
      "이 구간에 들어가면 RT의 눌림·복귀 기준도 초기화됩니다. 다음 첫 입력은 다시 작동점까지 눌러야 합니다.",
      "손을 뗐을 때의 센서 흔들림이나 얕은 움직임을 무시하는 데 씁니다. 작동점보다 작은 값으로 설정해야 합니다.",
    ],
  },
  bottomDeadzone: {
    title: "하단 데드존",
    paragraphs: [
      "RT를 켰을 때 바닥 근처에서 입력을 켠 채 유지하는 구간입니다. 총 이동거리 3.40 mm, 하단 데드존 0.20 mm라면 3.20~3.40 mm가 해당합니다.",
      "하단 데드존 안의 인식 이동량은 설정한 총 스트로크로 표시합니다. 위 예시에서는 3.40 mm이며, 이 표시 규칙은 RT를 꺼도 적용됩니다. 센서 ADC 진단 값은 그대로 확인할 수 있습니다.",
      "이 구간 안에서는 복귀 RT만큼 움직여도 입력이 유지됩니다. 위쪽 경계를 벗어나면 그 경계를 기준으로 복귀 RT를 계산합니다.",
      "바닥까지 누른 롱노트에서 힘이 조금 풀려도 입력을 유지하는 데 씁니다. 0 mm로 설정하면 사용하지 않으며, RT가 켜져 있을 때 적용됩니다.",
    ],
  },
};

/** Non-interactive descriptions are anchored to independent help buttons. */
export function mountRTSettingHelp() {
  const popup = document.createElement("aside");
  popup.id = "rtSettingHelp";
  popup.className = "rt-setting-help";
  popup.setAttribute("role", "tooltip");
  popup.hidden = true;
  document.body.append(popup);
  let active = null, pinned = false, closeTimer = null;

  function close() {
    clearTimeout(closeTimer);
    if (active) {
      active.setAttribute("aria-expanded", "false");
      active.removeAttribute("aria-describedby");
    }
    active = null; pinned = false; popup.hidden = true;
  }
  function position() {
    if (!active) return;
    const anchor = active.getBoundingClientRect();
    popup.style.maxHeight = `${Math.max(120, window.innerHeight - 24)}px`;
    const width = popup.offsetWidth, height = popup.offsetHeight;
    const left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12));
    const below = anchor.bottom + 8;
    const top = below + height <= window.innerHeight - 12 ? below : Math.max(12, anchor.top - height - 8);
    popup.style.left = `${left}px`; popup.style.top = `${top}px`;
  }
  function open(button, description) {
    clearTimeout(closeTimer);
    if (active !== button) { close(); active = button; }
    const title = document.createElement("strong"); title.textContent = description.title;
    popup.replaceChildren(title, ...description.paragraphs.map((text) => {
      const paragraph = document.createElement("p"); paragraph.textContent = text; return paragraph;
    }));
    popup.hidden = false;
    button.setAttribute("aria-expanded", "true");
    button.setAttribute("aria-describedby", popup.id);
    position();
  }
  function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (!pinned && active !== document.activeElement && !popup.matches(":hover")) close();
    }, 120);
  }
  for (const [id, description] of Object.entries(descriptions)) {
    const input = document.getElementById(id), label = input?.closest("label");
    if (!label) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rt-help-button";
    button.dataset.rtHelp = id;
    button.textContent = "i";
    button.setAttribute("aria-label", `${description.title} 설명`);
    button.setAttribute("aria-controls", popup.id);
    button.setAttribute("aria-expanded", "false");
    if (input.type === "checkbox") {
      const group = document.createElement("span"); group.className = "rt-check-help";
      label.replaceWith(group); group.append(label, button);
    } else {
      // Keep help outside the label so opening it cannot focus a range input.
      const group = document.createElement("div"); group.className = "rt-field-help";
      label.replaceWith(group); group.append(label, button);
      if (label.classList.contains("actuation-field")) group.classList.add("actuation-field");
    }
    button.addEventListener("pointerenter", (event) => { if (event.pointerType !== "touch") open(button, description); });
    button.addEventListener("pointerleave", scheduleClose);
    button.addEventListener("focus", () => open(button, description));
    button.addEventListener("blur", scheduleClose);
    button.addEventListener("click", (event) => {
      event.preventDefault(); event.stopPropagation();
      if (active === button && pinned) close();
      else { open(button, description); pinned = true; }
    });
  }
  popup.addEventListener("pointerenter", () => clearTimeout(closeTimer));
  popup.addEventListener("pointerleave", scheduleClose);
  document.addEventListener("pointerdown", (event) => {
    if (active && !popup.contains(event.target) && !active.contains(event.target)) close();
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
  window.addEventListener("resize", position);
  window.addEventListener("scroll", position, true);
  document.addEventListener("visibilitychange", () => { if (document.hidden) close(); });
  return { close };
}
