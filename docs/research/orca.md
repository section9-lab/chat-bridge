# Orca 调研

日期：2026-09-24。源码版本：[stablyai/orca](https://github.com/stablyai/orca) commit dac82f6（2026-09-23），下文文件路径相对仓库根目录。【代码】表示读源码核实过，【官方】表示出自文档或官网、没有逐条验证。

**先说结论：** Orca 是一个开源的 Electron 桌面应用，在各自独立的 git worktree 里跑 39 种编程 Agent。绝大多数 Agent 通过 PTY 终端接入，没有 ACP。选 Agent 只有显式指定和默认两种方式，没有语义路由。多 Agent 编排由一个 LLM Agent 担任主管，Agent 之间只通过文本传递上下文。上游任务的结果不会自动交给下游任务。

## 1. 基本信息
- **清单链接与官网：** awesome 清单指向 https://github.com/stablyai/orca，官网是 https://onOrca.dev。
- **作者：** Stably AI，旧金山，YC 投资【官方，官网页脚】。
- **许可证：** MIT【代码 LICENSE】。
- **热度（GitHub API）：** 76.4k star、5.0k fork。
- **活跃度：** 仓库 2026-03-17 创建；最新版 v1.4.209 发布于 2026-09-23，几乎每天发版。
- **积压：** 开放 issue 3,197，开放 PR 3,463。
- **体量：** `src/` 下非测试 TypeScript 约 180 万行，测试文件 9,039 个。
- **成熟度：** 迭代极快，但编排、结构化聊天、Agent 休眠、Cloud VM 都还标着"实验"；手机端是 beta，Android 最新包 v0.0.50。
- **平台形态：** Electron 43 + React 19 + node-pty + xterm.js + Monaco（package.json）。手机端是 Expo 55 / React Native 0.83（mobile/package.json）。
- **商业模式：** 桌面免费开源，用户用自己的模型订阅。企业版走销售咨询。中继、推送网关和账号服务由 Stably 托管，其中认证和 API 服务在私有仓库里（cloud/README.md 的 "What is not here" 一节）【官方】。

## 2. 架构
**进程与语言：** 全部是 TypeScript，另有少量原生模块，比如 `native/computer-use-macos` 是 Swift【代码】。
- **Runtime：** 跑在 Electron 主进程里，负责 RPC、git、worktree 和持久化。无头部署用 `orca serve`，也叫 orcad。
- **终端守护进程：** 以脱离主进程的方式运行，持有所有 PTY，通过 `daemon-v<N>.sock` 通信（docs/reference/orcad-operations.md）。
- **Hook 服务：** 监听 `127.0.0.1` 的随机端口（src/main/agent-hooks/server/server-lifecycle.ts:175）。Agent 自带的 hook 用 curl 带 token 往这里 POST 状态（hook-post-command.ts:14-18）。
- **CLI：** 通过 `runtime.sock` 加 token 连接 runtime。
- **SSH 远端守护：** 在 `src/relay/`，和手机中继同名但不是一个东西。
- **云端：** `cloud/apps/relay`（director 加若干 cell，跑在 GCP 上）和 `cloud/apps/push`（经 APNs/FCM 推送）。

**数据存储：**
- 普通状态存在 userData 目录下的 JSON 文件：
  - `orca-data.json`（profile-storage-paths.ts:7）
  - `agent-sessions.json`（agent-session-record-store-file.ts:30）
  - `orca-devices.json` 和 `orca-e2ee-keypair.json`（mobile-pairing-files.ts:1-2）
- 编排数据存在 SQLite 文件 `orchestration.db`，用 node:sqlite（orca-runtime-automation-operations.ts:154）。

**手机怎么连到桌面：**
- **LAN 直连：** 桌面开 WebSocket 服务，端口 6768，默认只绑 127.0.0.1。只有用户生成 LAN/二维码配对码时，才重新绑定到 0.0.0.0（runtime-rpc-pairing-types.ts:17-22、runtime-rpc-network-exposure.ts:7-35）【代码】。`orca serve` 则默认对外开放。
- **中继：** 手机和桌面各自向中继 cell 发起出站 WebSocket，由中继拼接两边的帧（cloud/README.md:3-8）。走中继需要登录 Orca 账号（mobile.mdx:42）。
- **Tailscale：** 也支持，改地址不用重新配对（mobile.mdx:84-89）。

## 3. Agent 接入方式
共 39 个 Agent id（src/shared/tui-agent.ts:3-42），分三条通道接入。

1. **PTY 终端：主通道，覆盖全部 Agent。** 每个 Agent 有一份配置（src/shared/tui-agent-config.ts）：
   - 包括检测命令、启动命令、提示词注入方式（argv / flag-prompt / stdin-after-start / hermes-query，见 :4-10）、就绪信号，以及预先写好的"信任此目录"文件。
   - 例子：Hermes 用 `hermes --tui` 启动（:281-287）；Cursor 用 `cursor-agent` 并预写 `.workspace-trusted`（:246-251）。
   - Agent 状态主要靠它自带的 hook 上报，加上解析终端 OSC 序列（docs/reference/agent-status-store.md）。
2. **结构化会话：实验功能，只支持 Claude 和 Codex**（agent-session-provider-handle.ts:10）。
   - Claude 走 `@anthropic-ai/claude-agent-sdk`，但进程由 Orca 自己拉起用户本机的 `claude`（claude-agent-sdk-process-spawn.ts:29-50）。
   - Codex 启动 `codex app-server`，走 stdio 上的 JSON-RPC（codex-structured-launch-resolution.ts:80）。
   - 限制：只能本机、不能是 WSL、不能用自定义命令（structured-native-chat-launch-route.ts:74-102）。
   - 不满足条件时自动降级为 PTY，回执里写明原因（agent-launch-mode.ts:5-9）。
3. **Chat UI：** 读取 Agent 自己写的 JSONL 转录文件，渲染成聊天视图，支持 Claude/Codex/Grok/OMP（src/main/native-chat/transcript-line-decoders-*.ts）。

**没有 ACP。** 全仓只有 Prime Agent 的 `--mode acp` 被识别出来，而且是当作"非交互模式"排除掉（prime-agent-headless-command.ts:3-6）【代码】。

另外，Orca 提供一个伪造的 `tmux` 替身，让 Claude Agent Teams 的队友以 Orca 原生分屏的形式出现（claude-agent-teams-tmux-dispatcher.ts:18-29）。

## 4. 用户怎么选 Agent
只有显式指定和默认两种方式【代码】。
- `pickTuiAgent` 的逻辑：先用用户设置的默认 Agent（前提是已安装、没被禁用）；否则按固定顺序 claude → claude-agent-teams → openclaude → codex → grok… 取第一个已安装的（src/shared/tui-agent-selection.ts:6-71）。
- 桌面、手机（mobile/src/tasks/mobile-tui-agents.ts:68）和 CLI 共用这套逻辑。
- 编排时用 `--agent` 显式指定。
- 没有语义或 LLM 路由。界面上的 "Smart" 只是在 GitHub/Linear/GitLab/分支里搜索任务来源（mobile.mdx:31）。

## 5. 多 Agent / "fleet" 编排
**并行：** 核心卖点是"同一个 prompt 分给多个 worktree、多个 Agent 赛跑，由人挑出赢家"（recipes/parallel-agents.mdx）【官方】。实际做法是人手动开多个 worktree 并粘贴同一个提示词。

**监督式编排：** 实验功能【代码 + cli/orchestration.mdx】。
- 数据模型是 Run、Task（带依赖的 DAG）、Dispatch、Message 和 Decision gate，都存在 SQLite 里。
- **主管就是一个 LLM Agent。** 它靠内置的 `skills/orchestration` 学会调用 `orca orchestration task-create / worker-start / check --wait` 这些命令。
- 原来由宿主自动调度的命令已经退役，调用后什么都不做（orchestration.mdx:17-21）。

**Agent 之间怎么传上下文（代码核实）：全部是文本。**
- **下发给 worker：** 主管写的 `task.spec`，加上 Orca 生成的一段前言，拼成一条 prompt。前言里包含 worker 身份、taskId/dispatchId、"必须用 CLI 回报"、"禁止用 AskUserQuestion" 等规则。
  - 这条 prompt 会粘贴进 worker 的 PTY，或者作为结构化会话的一轮对话发送（preamble.ts:49-143、deliver-worker-dispatch-preamble.ts:44-59、coordinator-task-dispatch.ts:114-139）。
  - 唯一自动附加的内容是"已解决的 decision gate 的问题和答案"（coordinator-task-dispatch.ts:131-135）。
- **worker 回报：** worker 必须执行 `send --type worker_done --body "<三句话摘要>" --files-modified --report-path`（preamble.ts:74-88），消息写入 SQLite。主管用 `check --wait` 收取，或用 `worker-read` 读 worker 的转录归档。
- **唤醒空闲 Agent：** 往它的 PTY 里打一行 "You have N orchestration messages. Run `orca orchestration check`"（formatter.ts:121）。
- **DAG 依赖只控制"何时可以开始"**，完成一个任务只会改下游任务的状态（task-store.ts:210-233）。上游结果不会自动注入下游 spec，只能靠主管自己转写。
- **不需要监督的"交接"：** 用 `worktree create --agent codex --prompt "<task brief>"`，上下文完全靠 brief 这段文字（skill-guides/orca-cli.md:25-39）。

**可靠性设计：**
- 用 dispatchId 防止旧的重试误把新任务标成完成。
- 心跳每 5 分钟一次；超过 10 分钟没心跳只告警，不自动判失败（coordinator-task-dispatch.ts:16-18）。
- 同一任务失败 3 次熔断（dispatch-circuit-breaker.ts:2）。
- 支持用 `--on` 把 worker 派到 SSH 或远端 Orca 服务器上。

## 6. 隔离
- 默认用 git worktree（src/relay/git-handler-worktree-ops.ts:74-75），也支持不是 git 仓库的普通文件夹工作区。
- 没有内置容器。可选的 "Cloud VM" 由仓库里 `orca.yaml` 定义的脚本拉起 Vercel Sandbox / Fly / Modal / 本地 Docker，再用 `orca serve` 或 SSH 连回来，Orca 只做一层薄封装（ways-to-run.mdx:72-78）。

## 7. 手机端
**功能范围**【官方 mobile.mdx:17-34；手机可调用的 RPC 由 294 个方法的白名单限定，见 runtime-rpc-mobile-method-allowlist.ts】：
- 看各台主机上的 worktree 和 Agent 状态。
- 终端视图，外加 Live 直通按键。
- Chat UI：@文件、/命令、图片、语音听写、切换模型。
- 回应审批和问题（`agentSession.respondToApproval` / `respondToQuestion`）。
- 暂存、提交、推送、合并 PR（白名单里有 `github.mergePR`）。
- 新建 worktree、启动 Agent；切换账号、查看用量。

**认证：** 一次性配对码，加每台设备一个可单独撤销的 token（device-registry.ts:1-4, 25-40）。

**加密：** 应用层端到端加密，LAN 直连和中继两种连接都走这一层（mobile-e2ee-v2-contract.ts:4）。
- 桌面有一把长期的 X25519 公钥，放在配对码或二维码里（e2ee-keypair.ts:1-6）。
- v2 握手派生出两个方向各自的密钥、一个会话 ID 和防重放计数器（mobile-e2ee-v2-desktop-session.ts:38-76）。
- 每帧用 tweetnacl 的 secretbox 加密（mobile-e2ee-v2-framing.ts:12-26）。

**通知：** 桌面用同一把 X25519 密钥向 Stably 的推送网关证明身份，由网关经 APNs/FCM 推到手机。**通知标题（最多 80 字）和正文（最多 180 字）是明文交给网关的**（cloud/packages/push-contract/src/send-messages.ts:27-28）。

## 8. 人在回路
- **审批：**
  - PTY 模式下，审批就是 Agent 自己 TUI 里的提示，人从桌面或手机回复。
  - 结构化 Claude 会话里，SDK 的 `canUseTool` 权限请求会变成卡片（claude-permission-presentation.ts）。
  - 编排中的 worker 被要求用 `orchestration ask` 去问主管，而不是问人（preamble.ts:102-114）。
- **审查：** 用户在 diff 上逐行批注，Orca 把批注合成一条纯文本 prompt，格式是 `File/Line/User comment`（src/shared/diff-comments-format.ts:7-34），再选择发给哪个 Agent 或新开一个（annotate-ai-diff.mdx）。这其实就是人工驱动的"实现 → 审查 → 返工"接力。
- **合并：** 在应用内提交、推送、建 PR 或 MR、合并；落选的 worktree 和分支一键删除。

## 9. 会话持久化与恢复、失败处理
- **进程存活：** PTY 由守护进程持有，退出、升级、崩溃后都能重新接上。机器重启后只恢复布局和 scrollback，Agent 进程已经没了（model/session-restore.mdx）【官方】。
- **会话恢复：** 用各家 CLI 原生的 resume，比如 `claude --resume`、`codex resume`、`opencode --session`、`grok --resume`（src/shared/agent-session-resume.ts:261-307）。
- **休眠（实验）：** 空闲 30 分钟后结束 PTY，重新打开时自动 resume。Cursor、Hermes、Copilot 这类不能恢复的 Agent 不参与休眠（agents/hibernation.mdx）。
- **结构化会话：** 保存每家 provider 自己的会话标识链（Claude 是 sessionId+leafUuid，Codex 是 threadId），能区分"继续"和"分叉"（agent-session-provider-handle.ts）。
- **仍然开着的相关 issue：** 中继配对失败 #11714、终端出现乱字符 #13077。编排上手失败 #10775 已关闭。

## 10. 优缺点与对 Chat Bridge 的启示
**优点：**
- Agent 覆盖面非常广。
- 终端守护进程和 UI 分离，升级或崩溃不打断 Agent。
- 安全默认值好：端口默认只听本机、配对时才开放，中继全部出站，应用层端到端加密，每设备 token，手机方法白名单。
- 编排协议设计严谨：ID 防串、心跳、熔断、decision gate。

**缺点：**
- 体量巨大，实验开关泛滥，issue 积压严重。
- 主要依赖往 PTY 里注入文字、再解析屏幕，每个 Agent 都有大量就绪判断的特殊处理，比较脆弱。
- 主管是 LLM，需要装 skill、学 CLI；DAG 不自动传结果。
- 通知正文明文经过 Stably；中继依赖 Stably 的账号和云服务。

**值得借鉴：**
1. **显式交接协议。** 下游 Agent 的输入里注入"角色 + taskId/dispatchId + 必须用结构化 done 消息回报（摘要、改动文件、报告路径）"。而且应该比 Orca 多走一步：由 Bridge 在接力时自动把上游的 done 摘要和 diff 统计注入下游。Orca 恰恰没做这一步。
2. 用 dispatchId 防止过期回报；心跳只告警；失败 N 次熔断。
3. 状态检测优先用 hook（loopback 地址 + token），不要靠解析屏幕。
4. 结构化接入失败时自动降级，并告诉用户原因（参考 Orca 的启动回执）。
5. 把"批注 → 合成一条 prompt → 选择 Agent"的格式，复用到"审查结果回灌给实现 Agent"。
6. 恢复时存 provider 原生的会话 id，区分"继续"和"分叉"。
7. 将来如果做手机直连：保持默认不监听，只在显式配对时开放，加应用层端到端加密、每设备 token 和方法白名单。

**应避免：**
- 不要把编排的决策交给 LLM 自己读 CLI 文档去做。Chat Bridge 的路由本来就是宿主侧决策，接力也应该由 Bridge 决定。
- 不要去铺几十个 Agent 的 PTY 特殊处理，优先用 ACP 或 SDK 这类结构化协议。
- 不要让消息正文明文经过第三方网关。

## 引用
- https://github.com/andyrewlee/awesome-agent-orchestrators
- https://github.com/stablyai/orca
- https://github.com/stablyai/orca/releases
- https://www.onorca.dev
- https://www.onorca.dev/enterprise
- https://www.onorca.dev/docs/mobile
- https://www.onorca.dev/docs/cli/orchestration
- https://www.onorca.dev/docs/agents/native-chat
- https://www.onorca.dev/docs/agents/hibernation
- https://www.onorca.dev/docs/model/session-restore
- https://www.onorca.dev/docs/ways-to-run
- https://www.onorca.dev/docs/review/annotate-ai-diff
- https://www.onorca.dev/docs/recipes/parallel-agents
- https://github.com/stablyai/orca/issues/11714
- https://github.com/stablyai/orca/issues/13077
- https://github.com/stablyai/orca/issues/10775
