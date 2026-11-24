# Split-Beat HE Studio 변경 기록

새 버전이 위에 있습니다. 버전 규칙은 [펌웨어 저장소의 VERSIONING.md](https://github.com/CodeKi0303/split-beat-he-firmware/blob/main/VERSIONING.md)를 따릅니다.

## v1.1.0 — 2026-11-24

#### Keyboard profiles

- 사이드바에 프로필 1–4 버튼이 생겼습니다. 누르면 그 프로필로 바뀌고, 빈 칸(+)을 누르면 현재 프로필을 복사해 새 프로필을 만들고 바로 전환합니다.
- **프로필** 탭에서 이름 바꾸기(UTF-8 16바이트, 한글 5자), 전환, 삭제, 빈 칸에서 만들기를 할 수 있습니다. 파일로 보관·불러오기는 같은 탭의 아래쪽에 남아 있고 현재 프로필을 다룹니다.
- 작동점·RT·데드존과 키 매핑은 프로필마다 따로, 보정·노이즈·거리 곡선은 공통입니다. 바꾼 뒤 ‘키보드에 저장’을 눌러야 유지됩니다.
- 펌웨어 0.4.0 이상이 필요합니다. 이전 펌웨어에서는 프로필 버튼이 나오지 않고, 프로필 탭에 업데이트 안내가 나옵니다.

시뮬레이터 브라우저 테스트로 확인했습니다. 실제 키보드에서는 아직 시험하지 않았습니다.

## v1.0.19 — 2026-11-21

#### Calibration first for new keyboards

When you connect a keyboard with uncalibrated Hall keys, Studio now opens **캘리브레이션** straight away. A banner names the keys that still need calibration, and the calibration menu item shows how many remain. A keyboard whose keys are all calibrated opens as before.

- If output-on is refused because keys are uncalibrated, Studio now says so and points to calibration.
- The BUSY hint now names the real **좌우에 적용** button.
- The sidebar links the new user guide at [docs.codekilab.com](https://docs.codekilab.com/).

Validated with browser tests against a simulated keyboard. Not yet used with a physical keyboard.

## v1.0.18 — 2026-11-21

#### Roller and knob pointer acceleration

When a roller or knob is mapped to **포인터 이동**, the key mapping screen now shows **빠르게 돌릴 때 가속**: 끔, ×2, ×3, ×5, ×9 or ×16. Slow turns move the set pixels per detent; faster turns move more, up to the chosen multiplier. The mapping label shows it, for example "포인터 ↑ 20 · 가속 ×5". The setting needs firmware c86 v0.3.49 or later; older firmware is refused before anything is written. Hall keys and MX switches do not show it.

Validated with unit tests and browser tests against a simulated keyboard. Not yet used with a physical keyboard.

## v1.0.17 — 2026-11-21

#### Consistent keyboard layout on 작동점 · RT

The 작동점 · RT tab now uses the same full-width keyboard panel as every other tab. Before, wide screens switched it to its own two-column layout, with a narrower sidebar and smaller keys that hid their travel readouts. The multi-select controls (여러 키 선택, 전체/왼쪽/오른쪽/선택 해제) are now a plain row styled like the board heading. Selection behavior is unchanged.

Validated with Studio unit tests and browser tests against a simulated keyboard.

## v1.0.16 — 2026-11-21

#### Pointer movement in key mapping

**키 매핑 → 마우스** now has **포인터 이동** arrows (← ↑ ↓ →) and a speed field. The unit follows the selected input:
- Hall keys: px/s at full depth; the pointer goes faster the deeper you press.
- MX switches: px/s, starting at 30% and reaching full speed after 0.35 s.
- Rollers and knobs: px per detent.

The default is 800 px/s for keys and 20 px for rollers. Pointer movement needs firmware c86 v0.3.48 or later; older firmware is refused before anything is written.

Validated with unit tests and browser tests against a simulated keyboard. Not yet used with a physical keyboard.

## v1.0.15 — 2026-11-20

#### Firmware updates inside Studio

The left/right firmware update moved from a separate page into Studio's new **펌웨어** tab. Load the official release (or pick the two `.fw.json` files), press **양쪽 버전 확인**, agree, and press **좌우 업데이트**.

- Studio hands its keyboard connection to the update; no second device chooser appears. It refuses to hand it over while settings are unsaved or a measurement or calibration is running.
- While update mode holds the keyboard, **키보드 연결** is locked. After the update, or after **업데이트 모드 종료**, press **키보드 연결** again.
- **키보드 연결** now reuses the one keyboard this site is already allowed to open, without the chooser. The chooser still appears the first time, or when several keyboards are allowed.
- The tab shows the latest release next to the installed version, and the new-version notice opens it. The old `update.html` address redirects to the tab.

#### Shorter text

Long or repeated explanations were shortened or removed in the 작동점 · RT, calibration, sensor, rhythm and profile tabs.

Validated with Studio unit tests and browser tests against a simulated keyboard, including a new end-to-end firmware tab test (hand-over, unsaved-settings guard, right-then-left update, chooser-free reconnect). Not yet used with a physical keyboard.

## v1.0.14 — 2026-11-20

#### Raw, averaged and decision values on the curve graph

The **센서 진단/설정 → ADC → 거리 곡선** card now shows, for the selected key:
- the raw ADC code (solid red line)
- the moving average (dashed purple line)
- the decision code the firmware actually uses after the noise deadband (white dot on the key's applied curve)

A line under the graph lists the three codes and the judged distance in mm. All three come from the same firmware snapshot and refresh about every 0.1 s.

- Left keys work with firmware 0.3.36 and later.
- Right keys need firmware c86 v0.3.47 for the decision value. The right half averages before sending, so only the averaged code is available as "raw" for those keys.
- With older firmware the card falls back to the raw STATUS value.

Validated with unit tests and browser tests against a simulated keyboard. Not yet used with a physical keyboard.

## v1.0.13 — 2026-11-20

#### Draw the ADC-to-distance curve

**센서 진단/설정 → ADC → 거리 곡선** shows the selected key's straight-line, Owlab Ti reference and custom curves on one graph: ADC position within the calibrated range (% and codes above rest) against judged distance in mm, with the actuation point and the live ADC position. Drag on the graph to draw the custom curve; it is kept non-decreasing. Choose the curve and the scope (selected key, left, right or all Hall keys) and press **곡선 적용**; the result is read back from the keyboard. **키보드에 저장** keeps it. The 작동점 · RT tab's curve list also offers the custom curve.

- The custom curve needs firmware c86 v0.3.46 or later; older firmware is refused before any write.
- It is one table shared by the whole keyboard. JSON profiles do not include it.
- The ADC settings note now states the 0.3.46 default moving average of 8.
- Also includes the 0.3.44 telemetry codec and the 0.3.45 diagnostic fields.

Validated with unit tests and browser tests against the simulated keyboard (drawing with the mouse, applying to all keys, per-key straight line, output restore). Not yet used with a physical keyboard.

## v1.0.12 — 2026-11-19

Key output now stays as you set it. Studio turns output off only when you press 출력 끄기; disconnecting leaves it unchanged. The firmware still turns output off while settings, calibration or ADC changes are written; Studio remembers your choice and turns output back on once its operation or measurement finishes. Rhythm, auto-fit and interference measurements keep output off only while they run.

If 출력 켜기 is refused with BUSY, the right half dropped at some point and the firmware waits for a paired ADC setting. Studio now says so: press ADC 설정 적용 in 센서 진단/설정 once, then turn output on.

Validation: all 18 Node suites and 15 isolated Edge browser regressions passed, including a new output-keep scenario. This release does not install firmware or change device settings.

## v1.0.11 — 2026-11-18

Hall actuation, press/release RT and top/bottom deadzones can now be entered in 0.001 mm steps. Studio works in 1/10000 of the switch stroke to match C86 firmware v0.3.43; with older firmware it stays compatible and rounds mm input to that firmware's 1/1000 step. Live travel shows three decimals. Exported profiles add `travel_max`, and profiles exported before this release import with the same depths. The 0.001 mm step is a setting resolution; decisions still move with the sensor's ADC steps.

Validation: all 18 Node suites and 14 isolated Edge browser regressions passed, plus the firmware repository's C core / Python / Studio codec parity checks. This Studio release does not install firmware or change device settings; the updater offers the paired C86 v0.3.43 packages.

## v1.0.10 — 2026-11-12

리듬 연습에서 목표와 매칭된 눌림을 관측하면 해당 노트 머리가 사라집니다. 눌림이 매칭된 롱노트는 판정선 아래로 몸통이 내려가지 않으며, 해제 목표는 남겨 두었다가 실제 해제와 매칭되면 나머지 표시를 지웁니다.

기록 재생에서는 해당 입력이 관측된 시점에 맞춰 표시를 지웁니다. 놓친 노트와 측정 기록은 유지합니다. 화면 표시만 바꾸며 소리 재생·판정 목표·펌웨어는 변경하지 않습니다. 기존 정식 C86 펌웨어 v0.3.42와 함께 제공됩니다.

검증: Node 테스트 18개, 브라우저 테스트 3개 및 데스크톱·모바일 화면 확인.

#### 자세히 (이전 README에서 옮김)

**판정한 노트 표시**

목표에 대응하는 눌림을 관측하면 해당 노트 머리가 사라집니다. 길게 누르는 노트는 판정선 위의 남은 유지 구간과 해제 지점을 계속 표시하고, 해제를 관측하면 해당 표시도 사라집니다. 누르지 않은 노트를 자동으로 성공 처리하지 않으며, 기록을 되돌려 보면 해당 시점까지 관측된 판정만 반영합니다. 소리·BPM·실제 판정·센서 기록은 바꾸지 않습니다.

## v1.0.9 — 2026-11-12

단일 키 노트 연습에 **노트 속도** 슬라이더를 추가했습니다. 0.5×–4.0× 범위에서 연습 중에도 조절할 수 있으며, 선택한 속도를 이 브라우저에 기억합니다. 기본 1.0×에서는 화면 위쪽에서 입력 기준선까지 1.800초, 2.0×에서는 0.900초가 걸립니다.

시각적 이동 속도만 조절합니다. BPM, 기존 Web Audio 소리 재생, 눌림·해제 목표 시점, 센서 기록과 판정에는 영향을 주지 않습니다. 키보드 설정을 변경하거나 저장하지 않습니다.

이 릴리스는 Studio 화면 변경이며 펌웨어 릴리스를 추가하지 않습니다. 기존 정식 C86 펌웨어 v0.3.42와 함께 제공됩니다.

검증: Node 테스트 18개, 브라우저 테스트 3개 및 데스크톱·모바일 화면 확인.

#### 자세히 (이전 README에서 옮김)

**노트 속도**

단일 키 노트 연습의 **노트 속도**를 0.5×–4.0×로 조절할 수 있습니다. 기본 1.0×에서는 화면 위쪽에서 입력 기준선까지 1.800초, 2.0×에서는 0.900초가 걸립니다. 연습 중에도 바꿀 수 있으며, 노트의 시각적 이동만 달라집니다. BPM·소리 재생·눌림과 해제의 목표 시점·측정 결과는 바뀌지 않습니다. 속도는 이 브라우저에 기억하며 키보드에 저장할 필요가 없습니다. 오디오 출력은 기존 Web Audio 방식을 유지합니다.

## v1.0.8 — 2026-11-12

센서 설정과 시간 그래프를 **센서 진단/설정**에 모았습니다. 센서 노이즈 데드밴드, 좌우 공통 ADC 스캔레이트·이동평균을 설정하고, 최근 10·30·60초의 ADC 보고값·인식 이동량 및 지원되는 이동평균 전후 값을 볼 수 있습니다. 다른 키의 동시 변화를 기준값 대비 그래프로 비교하며, 기존 키 간 영향 비교 측정도 유지합니다. 설정 적용 후 값을 다시 읽어 확인합니다. 노이즈 데드밴드는 별도로 키보드에 저장하며, ADC 스캔레이트·이동평균 조정은 실행 중에만 유지되고 프로필 저장에 포함되지 않습니다.

리듬 연습의 준비음이 선택한 BPM과 분할 박자를 따릅니다. 단일 키 노트 레인, 유지·해제 꼬리, EARLY/LATE 표시와 최근 눌림·해제 기록을 추가했습니다. 브라우저 관측 오차가 목표 시각과 겹치면 빠름·늦음을 단정하지 않습니다.

검증: Node 테스트 18개, 브라우저 테스트 7개 및 데스크톱·모바일 화면 확인. 이 릴리스는 Studio 화면 변경이며 펌웨어 릴리스를 추가하지 않습니다. 기존 정식 C86 펌웨어 v0.3.42와 함께 제공됩니다.

#### 자세히 (이전 README에서 옮김)

**센서 진단/설정과 리듬 연습**

**센서 진단/설정**에서 센서 노이즈 데드밴드와 좌우 공통 ADC 스캔레이트·이동평균을 설정합니다. 노이즈는 선택 키·왼쪽·오른쪽·전체 범위를 고를 수 있으며, 보정·작동점·RT는 유지됩니다. 설정 적용 시 키 출력을 끄고 실제 값을 다시 읽어 검증합니다. 노이즈 설정은 별도로 ‘키보드에 저장’해야 영구 보관됩니다. ADC 스캔레이트·이동평균은 런타임 설정이므로 저장 버튼과 무관하게 전원 재연결·재부팅 시 펌웨어 기본값으로 돌아갑니다. 노이즈 데드밴드는 작은 센서 변화가 입력 판정에 반영되는 기준이며, ADC 그래프의 흔들림을 직접 제거하는 필터와는 다릅니다.

시간 그래프는 최근 10·30·60초를 선택합니다. ADC 보고값과 인식 이동량, 지원하는 왼쪽 키의 이동평균 전·후를 확인할 수 있습니다. **다른 키의 동시 변화**는 각 키의 관찰 구간 첫 값을 기준으로 겹쳐 보여 줍니다. 키별 표시를 끄거나 같은 쪽·반대쪽·전체로 범위를 바꿀 수 있습니다. 이 그래프는 동시 변화를 관찰하며 원인을 확정하지 않습니다. 기존의 손 떼기 → 선택 키 누르기 비교 측정도 유지됩니다.

리듬 측정의 준비 한 마디에는 선택한 BPM과 분할 박자에 맞춰 메트로놈이 들립니다. 120 BPM의 8·12·16비트는 각각 250·166.7·125 ms 간격입니다. 준비음에는 판정 목표를 만들지 않으며, 첫 연습 입력의 빠른 판정 구간은 유지합니다. 기존 센서 그래프와 함께 **단일 키 노트 레인**, 유지·해제 꼬리, **EARLY/LATE 타이밍 인디케이터**와 최근 눌림·해제 기록을 표시합니다. 브라우저가 관측한 시간 범위가 목표를 포함하면 빠름/늦음을 단정하지 않습니다. 게임의 실제 판정 범위나 USB 입력 지연을 재현하는 기능은 아닙니다.

## v1.0.7 — 2026-11-12

Studio's disconnected preview and fresh simulator now share the saved 28-input default mapping: left Hall Tab/A/S/D/F/L Shift/Space and right Hall Enter/semicolon/L/K/J/R Shift/R Alt, with the matching MX, knob and roller bindings.

Connected device mappings take priority. Remapping immediately updates key labels, selection titles, accessible names, calibration and measurement guidance. Duplicate Enter/F1 mappings identify their side and physical control; unbound inputs show 미지정. An unexpected disconnect labels retained mappings as last read. Existing profiles, sensor calibration, RT and deadzone settings are not overwritten by these defaults.

The canonical mapping JSON and generated browser defaults are checked against all 28 frozen binding tuples. Physical geometry, input IDs and source references are unchanged. Validation passed all 16 Node suites and six isolated browser regressions, including the existing deadzone display behavior.

This Studio release does not install firmware or change device settings. The updater uses the current stable C86 v0.3.42 packages.

#### 자세히 (이전 README에서 옮김)

**현재 매핑으로 키 찾기**

연결 전 미리보기와 새 데모의 기본 매핑을 저장된 28개 입력 배치에 맞췄습니다. 기본값에는 키 매핑만 포함하며, 센서 보정·작동점·RT·데드존 설정은 포함하지 않습니다.

| 위치 | 기본 매핑 |
| --- | --- |
| 왼쪽 Hall 1–7 | Tab · A · S · D · F · L Shift · Space |
| 오른쪽 Hall 1–7 | Enter · ; · L · K · J · R Shift · R Alt |
| 왼쪽 MX 1 / 4 | F1 / F5 |
| 오른쪽 MX 1 / 4 | → / ← |
| 왼쪽 노브 클릭 / CW / CCW | Esc / Page Up / Page Down |
| 오른쪽 노브 클릭 / CW / CCW | Enter / ↑ / ↓ |
| 왼쪽 롤러 CW / CCW | F1 / F2 |
| 오른쪽 롤러 CW / CCW | 스크롤 ↑ / 스크롤 ↓ |

연결하면 **현재 키보드에서 읽은 매핑이 우선**합니다. 기존 설정이나 가져온 프로필을 기본값으로 덮어쓰지 않습니다. 키 카드·선택 제목·접근성 이름·보정 및 측정 안내는 현재 매핑을 따라 갱신되며, 해제한 매핑은 **미지정**으로 표시합니다. 같은 Enter나 F1은 왼쪽/오른쪽과 Hall 번호·MX 위치·노브 클릭·회전 방향으로 구분합니다. 키의 실제 좌표와 입력 ID는 바꾸지 않았습니다. `CW`·`CCW`는 전기적 회전 방향을 뜻합니다.

공통 원본은 [web/default-bindings.json](web/default-bindings.json)입니다. 변경 후 `node tools/generate_default_bindings.mjs`로 브라우저 기본값을 생성하며, `--check`와 테스트에서 28개 값 및 물리 배치 일치를 확인합니다.

## v1.0.6 — 2026-11-12

Recognized key travel now shows zero inside the top deadzone and the configured full switch stroke inside the bottom deadzone. Both boundaries are inclusive; the middle range keeps its original values. The same display rule works with RT on or off and with older firmware that reports unclamped travel.

Key cards, live bars, travel statistics and rhythm graphs use the same endpoints. Raw ADC, calibration and raw-derived noise diagnostics remain available. Rhythm exports retain the received travel/raw values and add separate recognizedTravel/recognizedMm display fields. Disconnecting clears the last live travel value.

Validation: all 15 Node test suites and isolated browser regressions for boundary displays, performance settings, rhythm and accessible help passed. No physical-device result is inferred from these browser tests.

This is a Studio UI release. The official downloadable C86 firmware remains v0.3.36; this release does not install firmware or change key settings.

#### 자세히 (이전 README에서 옮김)

**데드존과 인식 이동량**

키 카드, 실시간 막대, 센서 진단의 이동량 보기와 리듬 그래프는 **상단 데드존 경계까지 0**, **하단 데드존 경계부터 총 스트로크**로 표시합니다. 경계는 포함하며 중간 범위를 늘리거나 줄이지 않습니다. 예를 들어 총 스트로크 3.40 mm에서 상·하단 데드존을 각각 0.30 mm로 설정하면, 위쪽 구간은 0 mm, 아래쪽 구간은 3.40 mm로 표시합니다. 이 표시 규칙은 RT를 꺼도 같습니다.

ADC 보고값·보정·노이즈/키 간 영향 진단은 그대로 확인할 수 있습니다. 인식 이동량의 흔들림이 0이어도 센서 잡음이 없다는 뜻은 아닙니다. 리듬 내보내기는 장치가 보낸 `travel`·`raw`를 보존하고, 표시용 `recognizedTravel`·`recognizedMm`를 별도로 담습니다. `travel` 자체에 데드존을 적용하는 펌웨어에서도 같은 표시를 유지합니다. 이 화면 변경만으로 펌웨어를 설치하거나 키 설정을 바꾸지 않습니다.

## v1.0.5 — 2026-11-12

RT settings now include accessible info popovers and optional retrigger-before-release per Hall key, including group editing. Default off; old firmware cannot enable the option. New mode requires C86 v0.3.37 candidate firmware; current stable firmware v0.3.36 remains unchanged. Synthetic release/press can interrupt long notes; sensor snapshots cannot verify those pulses.

#### 자세히 (이전 README에서 옮김)

**RT 설정**

**작동점 · RT**의 각 `i` 버튼에서 작동점, 눌림·복귀 거리, 상·하단 데드존의 동작과 예시를 확인할 수 있습니다. 마우스를 올리거나 키보드로 포커스를 옮기면 열리고, 터치 화면에서는 버튼을 누릅니다. Escape 또는 바깥 영역을 눌러 닫습니다.

**미해제 재입력 허용**은 Hall 키마다 설정하며 기본값은 **꺼짐**입니다. 여러 키를 선택해 함께 변경할 수 있습니다. 켜면 RT로 해제되기 전에도 위로 움직였다가 눌림 RT만큼 다시 내려갈 때 USB 해제 → 눌림을 전송합니다. **게임에는 키를 뗀 것으로 전달되므로 롱노트가 끊길 수 있습니다.** RT를 끄면 이 옵션은 동작하지 않으며 선택값은 유지됩니다. 적용은 선택한 키의 RAM만 변경하고, 보관하려면 별도로 **키보드에 저장**합니다.

이 옵션은 지원 기능을 보고하는 **C86 펌웨어 v0.3.37 이상**에서 사용할 수 있으며, 현재 정식 펌웨어 **v0.3.42에도 포함**됩니다. 미지원 장치에서는 옵션이 비활성화되고 기존 설정을 그대로 사용할 수 있습니다. Studio 배포만으로 펌웨어를 기록하거나 이 옵션을 켜지 않습니다.

브라우저 센서 스냅샷으로 짧은 USB 해제·눌림을 검증할 수 없어, 미해제 재입력 옵션을 켠 키는 자동 맞춤을 시작할 수 없습니다. RT와 이 옵션이 모두 켜져 있으면 리듬 판정 측정도 제한됩니다. 해당 측정은 옵션을 끈 뒤 진행합니다.

## v1.0.4 — 2026-11-11

Guided automatic RT fitting for a calibrated Hall key. Measure resting, tapping and holding behavior, compare balanced/repeat/hold preferences, apply a recommendation and verify it with a fresh capture. Settings save remains available through the normal save action.

## v1.0.3 — 2026-11-09

Select a common ADC scan rate and moving average for all 14 Hall keys. The diagnostics table shows the confirmed window for each key. Right-side values can be read back with v0.3.36.

## v1.0.2 — 2026-11-09

Adds 8/16/32/64/96 kHz and Raw/2/4/6/8-frame ADC controls. C86 v0.3.34 supports one-action left/right configuration. The left Hall diagnostics can overlay pre- and post-average ADC values.

## v1.0.1 — 2026-11-08

Updates the C86 left and right boards as one version-matched pair. Checks both boards before writing, updates the right side first, skips identical running images, and verifies the final versions and CRCs.

## v1.0.0 — 2026-11-08

WebHID mapping, calibration, sensor and rhythm diagnostics, and C86 USB firmware updates.
