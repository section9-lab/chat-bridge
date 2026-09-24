<div align="center">
  <img src="docs/assets/brand/chat-bridge-app-icon.png" alt="Chat Bridge" width="112" height="112">
  <h1>Chat Bridge</h1>
  <p>Mac에서 나누던 AI 대화를 WeChat과 iMessage에서 이어가세요.</p>
  <p><a href="README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <strong>한국어</strong> · <a href="README.fr.md">Français</a> · <a href="README.es.md">Español</a></p>

![macOS](https://img.shields.io/badge/macOS-13.5%2B-17191C?style=flat-square)
[![Release](https://img.shields.io/github/v/release/section9-lab/chat-bridge?include_prereleases&style=flat-square&color=D5C5A8&labelColor=17191C)](https://github.com/section9-lab/chat-bridge/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-17191C?style=flat-square)](LICENSE)

</div>

## 사용 모습

<p align="center"><img src="docs/assets/chat-bridge-intro.gif" alt="Chat Bridge 첫 실행 인트로: 아이콘이 메뉴 막대로 들어가고, 손에 든 iPhone에서 iMessage로 Claude에, WeChat으로 Codex에 작업을 보내면 Mac에도 각 단계가 표시되며, 마지막으로 메뉴 막대 패널에서 후속 요청을 보냅니다" width="960"></p>
<p align="center"><a href="docs/assets/chat-bridge-intro.mp4">고화질 MP4 · 일시 정지 가능</a> · <a href="docs/assets/chat-bridge-intro-poster.png">정지 화면 미리보기</a></p>
<p align="center"><sub>앱을 처음 실행할 때 나오는 54초 인트로를 네이티브 SwiftUI 화면에서 녹화했습니다(중국어 화면). 작업과 응답은 예시 데이터이며 실제 계정에는 연결하지 않습니다.</sub></p>

## Mac을 떠나도 대화는 계속됩니다

Chat Bridge는 WeChat과 iMessage를 Mac의 AI 에이전트에 연결하는 메뉴 막대 앱입니다. 휴대폰에서 작업을 요청하거나 기존 대화를 이어가세요. 결과는 메시지를 보낸 채팅으로 돌아옵니다.

- **이어서 대화하기** — 프로젝트와 맥락을 유지한 채 기존 대화를 계속합니다.
- **원하는 일을 말하기** — 자연어로 대화를 만들고, 프로젝트를 고르고, 에이전트를 바꿉니다.
- **결과 받기** — 답변뿐 아니라 작업으로 만든 이미지, 영상, 문서도 받습니다.
- **로고 하나로 열기** — 메뉴 막대의 로고를 누르면 마지막 대화와 작성 중인 메시지가 다시 열립니다.

## 이렇게 말해 보세요

> Codex로 ‘여행 목록’ 프로젝트를 이어서 주말 계획을 정리해 줘.

> Claude에서 프로젝트 없는 새 대화를 만들고 아침 메뉴 세 가지를 추천해 줘.

> Claude의 ‘쇼핑몰’ 프로젝트에 있는 대화를 보여 줘.

스마트 라우팅을 켜면 메시지의 의도를 보고 대상을 선택합니다. 판단하기 어려우면 원문을 보관하고 텍스트 선택지를 보여 줍니다. 번호나 선택지 문구로 답하면 이어서 진행할 수 있습니다.

작업을 접수하면 대상이 표시됩니다. 현재 접수 안내는 중국어로 표시됩니다.

```text
Codex > 旅行清单 > 周末计划
已收到✅
```

## 세 단계로 시작하기

[Releases](https://github.com/section9-lab/chat-bridge/releases)에서 DMG를 선택하세요. Apple Silicon은 **arm64**, Intel은 **x86_64**입니다. DMG를 열고 **Chat Bridge**를 **Applications**로 드래그하세요. 아직 공개된 버전이 없다면 아래 설명에 따라 소스에서 빌드할 수 있습니다.

DMG는 ad-hoc 서명을 사용하며 Apple 공증을 받지 않았습니다. 첫 실행이 차단되면 다운로드 출처를 확인한 뒤 **시스템 설정 → 개인정보 보호 및 보안 → 확인 없이 열기**에서 이 앱의 실행을 허용하세요. 업데이트 후 전체 디스크 접근 권한을 다시 부여해야 할 수 있습니다.

<details>
<summary>소스에서 빌드하고 실행하기</summary>

Xcode Command Line Tools, Python 3, 인터넷 연결이 필요합니다. 저장소 루트에서 실행하세요.

```sh
bash scripts/build-app.sh
open "dist/Chat Bridge.app"
```

기본적으로 Apple Development 인증서로 서명합니다. 인증서가 없다면 빌드 명령 앞에 `CHAT_BRIDGE_SIGNING_IDENTITY=-`를 붙이세요. 이 로컬 서명 방식은 업데이트 후 전체 디스크 접근 권한을 다시 부여해야 할 수 있습니다.

</details>

1. **에이전트 연결** — Mac에 원하는 에이전트를 설치하고 로그인한 뒤 Chat Bridge에서 연결 상태를 확인합니다.
2. **메시지 채널 연결** — 설정 → 메시지 채널에서 WeChat QR 코드를 스캔하거나 iMessage 페어링을 완료합니다.
3. **첫 메시지 보내기** — 스마트 라우팅 서비스를 설정하고 자동 선택을 켠 다음 휴대폰에서 요청하세요. 메뉴 막대 대화창에서도 바로 대화할 수 있습니다.

스마트 라우팅 없이도 앱에서 대상을 선택하거나 텍스트 메뉴와 수동 명령을 사용할 수 있습니다.

## 평소 쓰던 에이전트와 함께

**Codex · Claude Code · Cursor · Grok · OpenCode · Hermes Agent**

각 에이전트의 로컬 로그인과 모델 설정을 그대로 사용합니다. 프로젝트 내 새 대화, 프로젝트 없는 대화, 기존 대화 재개를 지원합니다. 실제 사용 가능 여부는 설치, 인증, 모델 서비스 및 런타임 기능에 따라 달라집니다. Claude Chat과 Cowork는 아직 지원하지 않습니다.

## 시작하기 전에

- **macOS 13.5 이상**이 필요합니다. Mac이 깨어 있고 인터넷에 연결되어 있어야 하며 Chat Bridge가 실행 중이어야 합니다. iMessage는 메시지 앱 로그인과 전체 디스크 접근 권한도 필요합니다. 이전 데이터베이스와의 호환성은 추가 검증이 필요합니다.
- Mac에서 **@파일명**을 입력하면 추천 목록에서 로컬 파일을 검색하고 첨부할 수 있습니다. 왼쪽 클립으로도 같은 검색을 열 수 있습니다(메시지당 최대 10개, 파일당 50 MiB). 답변에는 원래 메시지의 인용이 표시됩니다. WeChat과 iMessage 입력은 계속 **텍스트만** 지원하며, 받은 음성·이미지·첨부 파일은 작업으로 실행하지 않습니다. 조건을 충족하는 결과 파일은 원래 채팅으로 보낼 수 있습니다.
- 메시지로 파일 수정, 명령 실행, 네트워크 접근이 이루어질 수 있습니다. Bridge에서 만들거나 재개한 Codex／Claude Code 대화는 기본적으로 전체 실행 권한을 사용합니다. 본인의 신뢰할 수 있는 계정만 연결하세요.
- 대화 상태는 Mac에 저장됩니다. 메시지는 선택한 메시지 채널과 에이전트 서비스에서 처리됩니다. 스마트 라우팅 사용 시 메시지와 관련 대상 정보가 설정한 라우팅 서비스에도 전달됩니다.
- 전송 결과가 불확실하면 자동으로 다시 보내거나 재실행하지 않습니다. 앱 화면은 현재 주로 중국어입니다.

## 더 알아보기

[문제 신고](https://github.com/section9-lab/chat-bridge/issues) · [MIT 라이선스](LICENSE)
