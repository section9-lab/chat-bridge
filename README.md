<div align="center">
  <img src="docs/assets/brand/chat-bridge-app-icon.png" alt="Chat Bridge" width="112" height="112">
  <h1>Chat Bridge</h1>
  <p>Your desktop AI conversations, in WeChat and iMessage.</p>
  <p><strong>English</strong> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <a href="README.es.md">Español</a></p>

![macOS](https://img.shields.io/badge/macOS-14%2B-17191C?style=flat-square)
[![Release](https://img.shields.io/github/v/release/section9-lab/chat-bridge?include_prereleases&style=flat-square&color=D5C5A8&labelColor=17191C)](https://github.com/section9-lab/chat-bridge/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-17191C?style=flat-square)](LICENSE)

</div>

## See it in action

<p align="center"><img src="docs/assets/chat-bridge-intro.gif" alt="Chat Bridge's first-launch intro: the icon settles into the menu bar, a handheld iPhone sends tasks to Claude over iMessage and to Codex over WeChat while the Mac mirrors each step, then a follow-up goes out from the menu bar panel" width="960"></p>
<p align="center"><a href="docs/assets/chat-bridge-intro.mp4">HD MP4 · pause to explore</a> · <a href="docs/assets/chat-bridge-intro-poster.png">Still preview</a></p>
<p align="center"><sub>The app's 54-second first-launch intro, recorded from its native SwiftUI views (Chinese UI). Tasks and replies are fictional; no live accounts are connected.</sub></p>

## Step away from your Mac. Keep the conversation going.

Chat Bridge is a macOS menu bar app that connects WeChat and iMessage to the AI agents on your Mac. Start a task from your phone, continue an existing conversation, and receive the result in the same chat.

- **Pick up where you left off** — Continue existing conversations with their project and context.
- **Say what you need** — Create a conversation, choose a project, or switch agents in plain language.
- **Get the result** — Receive replies and files your task produces, including images, videos, and documents.
- **One familiar place** — Click the single menu bar logo to reopen your last conversation and draft.

## Try saying

> Use Codex to continue the Travel Checklist project and plan my weekend.

> Start a Claude conversation without a project and suggest three breakfast ideas.

> List Claude's conversations in the Store project.

With smart routing enabled, Chat Bridge identifies your intended destination. When it cannot decide, it keeps your original message and offers text options. Reply with a number or an option to continue.

A receipt shows exactly where each task goes, for example:

```text
Codex > Travel > Weekend plan
Received ✅
```

## Get started in three steps

Choose a DMG from [Releases](https://github.com/section9-lab/chat-bridge/releases): **arm64** for Apple Silicon or **x86_64** for Intel. Open it and drag **Chat Bridge** to **Applications**. If no release is available yet, build from source below.

The DMGs use ad-hoc signing and are not notarized by Apple. If the first launch is blocked, review the download and use **System Settings → Privacy & Security → Open Anyway** for this app. Updates may require granting Full Disk Access again.

<details>
<summary>Build and run from source</summary>

Requires Xcode Command Line Tools, Python 3, and internet access. Run from the repository root:

```sh
bash scripts/build-app.sh
open "dist/Chat Bridge.app"
```

The build uses an Apple Development signing certificate by default. Without one, prefix the build command with `CHAT_BRIDGE_SIGNING_IDENTITY=-`. Updates to this locally signed build may require granting Full Disk Access again.

</details>

1. **Connect an agent** — Install and sign in to your preferred agent on the Mac, then check its status in Chat Bridge.
2. **Pair a messaging channel** — Open Settings → Messaging Channels. Scan the WeChat QR code or complete iMessage pairing.
3. **Send your first message** — Configure a routing provider and enable automatic selection in Smart Routing. Tell the agent what you need from your phone, or chat directly in the menu bar panel.

Without smart routing, choose a destination in the app or use text menus and manual commands.

## Works with your agents

**Codex · Claude Code · Cursor · Grok · OpenCode · Hermes Agent**

Uses each agent's local sign-in and model configuration. Start a conversation in a project, chat without a project, or resume an existing conversation. Availability depends on installation, authentication, model services, and runtime capabilities. Claude Chat and Cowork are not supported yet.

## Before you start

- Requires **macOS 14+**, with the Mac awake, online, and Chat Bridge running. iMessage also requires Messages sign-in and Full Disk Access; compatibility with older Messages databases still needs validation.
- On your Mac, type **@filename** to search and attach local files from inline suggestions; the paperclip on the left opens the same search (up to 10 per message, 50 MiB each). Replies quote the original message. WeChat and iMessage input remains **text only**; incoming voice, images, and attachments are not executed as tasks. Eligible output files can be returned to the originating chat.
- Messages can trigger file changes, commands, and network access. Codex and Claude Code conversations created or resumed by Bridge use full execution permissions by default. Pair only your own trusted accounts.
- Conversation state stays on your Mac. Messages are processed by your selected messaging and agent services; smart routing also sends the message and relevant destination context to your configured routing provider.
- Uncertain sends are not automatically retried or executed again. The app interface, system receipts, and the intro above are currently primarily Chinese.

## More

[Report an issue](https://github.com/section9-lab/chat-bridge/issues) · [Release process](docs/releasing.md) · [MIT License](LICENSE)
