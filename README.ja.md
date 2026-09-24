<div align="center">
  <img src="docs/assets/brand/chat-bridge-app-icon.png" alt="Chat Bridge" width="112" height="112">
  <h1>Chat Bridge</h1>
  <p>Mac の AI との会話を、WeChat と iMessage へ。</p>
  <p><a href="README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <strong>日本語</strong> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <a href="README.es.md">Español</a></p>

![macOS](https://img.shields.io/badge/macOS-13.5%2B-17191C?style=flat-square)
[![Release](https://img.shields.io/github/v/release/section9-lab/chat-bridge?include_prereleases&style=flat-square&color=D5C5A8&labelColor=17191C)](https://github.com/section9-lab/chat-bridge/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-17191C?style=flat-square)](LICENSE)

</div>

## デモ

<p align="center"><img src="docs/assets/chat-bridge-intro.gif" alt="Chat Bridge の初回起動イントロ。アイコンがメニューバーに収まり、手に持った iPhone から iMessage で Claude に、WeChat で Codex に依頼すると Mac にも各ステップが表示され、最後にメニューバーのパネルから続きを送信する" width="960"></p>
<p align="center"><a href="docs/assets/chat-bridge-intro.mp4">高画質 MP4 · 一時停止できます</a> · <a href="docs/assets/chat-bridge-intro-poster.png">静止画プレビュー</a></p>
<p align="center"><sub>アプリの初回起動時に流れる 54 秒のイントロを、ネイティブの SwiftUI 画面から録画しました（画面は中国語）。タスクと返信は架空で、実際のアカウントには接続していません。</sub></p>

## Mac を離れても、会話の続きを

Chat Bridge は、WeChat と iMessage を Mac 上の AI エージェントにつなぐメニューバーアプリです。スマートフォンから作業を依頼したり、既存の会話を続けたりできます。結果は元のチャットに届きます。

- **続きから始める** — プロジェクトと文脈を保ったまま、既存の会話を再開。
- **自然な言葉で伝える** — 会話の作成、プロジェクトの選択、エージェントの切り替えをひと言で。
- **成果を受け取る** — 返信に加えて、作業で作成された画像、動画、文書も受信。
- **ロゴをひとつクリック** — メニューバーから最後に使った会話と下書きを開く。

## たとえば、こんなメッセージ

> Codex で「旅行リスト」プロジェクトの続きを開いて、週末の予定をまとめて。

> Claude でプロジェクトなしの会話を作って、朝食の案を3つ教えて。

> Claude の「ストア」プロジェクトにある会話を一覧にして。

スマートルーティングを有効にすると、送信先を意図から判断します。判断できない場合は元のメッセージを保持し、テキストの選択肢を表示します。番号や選択肢の文言を返信するだけで続けられます。

受け付けた作業の送信先が表示されます。現在の受付表示は中国語です。

```text
Codex > 旅行清单 > 周末计划
已收到✅
```

## 3ステップで始める

[Releases](https://github.com/section9-lab/chat-bridge/releases) で DMG を選びます。Apple Silicon は **arm64**、Intel は **x86_64** です。開いて **Chat Bridge** を **Applications** にドラッグしてください。公開版がまだない場合は、下記の手順でソースからビルドできます。

DMG は ad-hoc 署名で、Apple の公証を受けていません。初回起動がブロックされた場合は、配布元を確認してから「システム設定 → プライバシーとセキュリティ」でこのアプリの「このまま開く」を選択します。更新後はフルディスクアクセスを再度許可する必要がある場合があります。

<details>
<summary>ソースからビルドして起動</summary>

Xcode Command Line Tools、Python 3、インターネット接続が必要です。リポジトリのルートで実行してください。

```sh
bash scripts/build-app.sh
open "dist/Chat Bridge.app"
```

既定では Apple Development 証明書で署名します。証明書がない場合は、ビルドコマンドの前に `CHAT_BRIDGE_SIGNING_IDENTITY=-` を付けてください。このローカル署名では、更新後にフルディスクアクセスを再度許可する必要がある場合があります。

</details>

1. **エージェントを接続** — Mac にインストールしてログインし、Chat Bridge で状態を確認します。
2. **メッセージアプリを連携** — 「設定 → メッセージチャネル」で WeChat の QR コードを読み取るか、iMessage のペアリングを完了します。
3. **最初のメッセージを送信** — スマートルーティングのサービスを設定して自動選択を有効にし、スマートフォンから依頼します。メニューバーの会話パネルでも直接入力できます。

スマートルーティングを使わない場合も、アプリ内の選択やテキストメニュー、手動コマンドで送信先を切り替えられます。

## いつものエージェントで

**Codex · Claude Code · Cursor · Grok · OpenCode · Hermes Agent**

各エージェントのローカルのログイン状態とモデル設定を使います。プロジェクト内の新規会話、プロジェクトなしの会話、既存の会話の再開に対応しています。利用可否はインストール、認証、モデルサービス、ランタイムの機能によって異なります。Claude Chat と Cowork は未対応です。

## ご利用の前に

- **macOS 13.5 以降**が必要です。Mac をスリープさせず、ネット接続と Chat Bridge の起動を維持してください。iMessage には「メッセージ」へのログインとフルディスクアクセスが必要です。古いデータベースとの互換性は検証が必要です。
- Mac では **@ファイル名** を入力すると候補からローカルファイルを検索・添付できます。左側のクリップからも同じ検索を開けます（1 メッセージ最大 10 件、各 50 MiB まで）。返信には元のメッセージの引用を表示します。WeChat と iMessage の入力は引き続き**テキストのみ**で、受信した音声・画像・添付ファイルは作業として実行しません。条件を満たす成果ファイルは元のチャットへ送信できます。
- メッセージからファイルの変更、コマンド実行、ネットワークアクセスが行われます。Bridge が作成・再開する Codex／Claude Code の会話は、既定で完全な実行権限を使います。自分の信頼できるアカウントだけを連携してください。
- 会話の状態は Mac に保存されます。メッセージは選択したチャネルとエージェントのサービスで処理され、スマートルーティング利用時はメッセージと送信先に関する情報が設定済みのサービスにも渡ります。
- 送信結果が不明な場合、自動で再送・再実行しません。アプリの画面は現在、主に中国語です。

## 関連情報

[問題を報告](https://github.com/section9-lab/chat-bridge/issues) · [MIT ライセンス](LICENSE)
