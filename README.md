# Split-Beat HE Studio

[studio.codekilab.com](https://studio.codekilab.com/)에서 Chrome으로 키보드를 연결합니다. 물리 키를 골라 매핑하고, Hall 키를 보정한 뒤 작동점·Rapid Trigger·데드존을 설정합니다. 센서와 리듬 진단도 이 화면에서 확인할 수 있습니다.

## 시작하기

1. PC와 왼쪽 PC용 USB-C를 연결하고, 좌우 split 케이블을 연결합니다.
2. **키보드 연결**을 눌러 장치를 선택합니다. 캘리브레이션에서 키를 놓은 값과 끝까지 누른 값을 수집한 다음 적용합니다.
3. 매핑과 작동점을 설정하고 **키보드에 저장**합니다. 펌웨어 업데이트 전에 Studio 연결을 종료합니다.
4. **펌웨어 업데이트**에서 보드를 선택하고 새 버전을 확인합니다. 정식 파일 선택 → 대상 확인 → 기록 동의 순으로 진행합니다. 오른쪽은 왼쪽 USB를 통해 갱신합니다.

[하드웨어 주문](https://github.com/CodeKi0303/split-beat-he-hardware) · [펌웨어 릴리스](https://github.com/CodeKi0303/split-beat-he-firmware/releases) · [수평 휠](https://github.com/CodeKi0303/split-beat-he-wheel)

## 개발과 배포

```sh
python -m http.server 8877 --bind 127.0.0.1 --directory web
node tests/web_firmware_update_test.mjs
```

Chrome에서 `http://127.0.0.1:8877/`을 엽니다. 운영 산출물에는 장치 시뮬레이터를 포함하지 않습니다.

Studio의 정식 릴리스 또는 펌웨어 저장소의 배포 요청으로 Actions가 실행됩니다. 최신 정식 Studio 릴리스의 웹 코드와 최신 정식 C86 좌우 앱을 검증하고 한 배포에 담습니다. 운영 대상은 Cloudflare Pages `split-studio`와 `studio.codekilab.com`입니다. GitHub Actions의 `CLOUDFLARE_ACCOUNT_ID` 변수와 `CLOUDFLARE_API_TOKEN` Secret을 설정합니다.

직접 작성한 코드는 [MIT](LICENSE)입니다.
