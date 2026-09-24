# Paseo 调研

日期：2026-09-24。源码版本：[getpaseo/paseo](https://github.com/getpaseo/paseo) commit c4771ca（2026-09-23）；为核实上下文传递，另读了 [getpaseo/hub](https://github.com/getpaseo/hub)（下文文件路径前缀 `paseo-hub/`）。

Paseo 是一个本机常驻的 Node.js daemon，外面挂桌面、手机、Web 和 CLI 四种客户端。编排不在 daemon 里做：多 Agent 协作由一个 Agent 通过 MCP 工具去调度其他 Agent，handoff 时给下一个 Agent 的提示词是 LLM 按模板写的简报，系统不附带任何 transcript。

**标注约定**
- 下文 `srv/` 代表 `packages/server/src/server/`。
- 【代码】是在源码里核实过的；【宣称】来自官方文档或官网。

## 1. 基本信息
- **作者**：Mohamed Boudra 个人（`LICENSE:1`），官网称"无投资人、无公司"。
- **许可证**：Apache-2.0（`LICENSE:6-8`）。
- **仓库数据**（gh api，2026-09-24）：18,163 star，2,084 fork，905 个 open issue。仓库建于 2025-10-13，最新发布 v0.9.1（2026-09-22）。
- **成熟度**：从 0.1.1（2026-02）到现在 CHANGELOG 已有 121 个版本，迭代极快，仍是 0.x。作者提交约 4,776 次，远超其他贡献者，单人维护风险明显。
- **形态**：Electron 桌面（mac/Linux/Win）、Expo 手机（iOS/Android）、Web、CLI、TypeScript SDK，另有 Docker 镜像。
- **商业模式**：
  - 核心免费开源，靠 GitHub Sponsors 和 $500/月 的赞助位（README）。
  - Hub（由 GitHub/Slack/Discord 事件触发 Agent）托管版 €15/席位/月，也可免费自托管（paseo.sh/hub）。

## 2. 架构
- **进程**【代码】：
  - daemon：Node 进程，supervisor 管 worker，重启时 respawn（`docs/architecture.md:475`）。
  - 客户端：Expo 应用、Electron（托管一个子进程 daemon）、CLI。
  - 中继：可选的云端 relay，是一个单独的 Elixir 服务（paseo-relay 仓库）。
- **存储**：都在 `~/.paseo/` 下。
  - 每个 Agent 一个 JSON 文件；timeline 只在内存里。
  - 持久的对话记录以各 provider 自己的历史为准（`docs/architecture.md:388,457-473`）。
- **网络模型**：
  - 默认监听 `127.0.0.1:6767`，也可以改成 Unix socket【代码 `srv/config.ts:470-481`】。
  - relay 模式下 daemon 主动外连 `relay.paseo.sh:443`，以此穿透 NAT【代码 `srv/pairing-offer.ts:34-38`】。
  - 其他连法：Tailscale 直连，或 SSH 隧道。
  - 新安装默认不开 relay，要用户同意才开【宣称】。代码注释说明旧配置仍兼容为开启（`srv/config.ts:302`）。

## 3. Agent 接入【代码】

| Agent | 接入方式 | 代码位置 |
|---|---|---|
| Claude Code | 官方 `@anthropic-ai/claude-agent-sdk` 的 `query()`，用 `claude_code` 预设系统提示词再追加内容 | `claude/query.ts:2`、`claude/agent.ts:3286-3305` |
| Codex | spawn `codex app-server`，走 stdio JSON-RPC | `codex-app-server-agent.ts:7088-7101` |
| OpenCode | `opencode serve --port` 加 `@opencode-ai/sdk` | `opencode/server-manager.ts:318` |
| Pi / OMP | `pi --mode rpc` / `omp --mode rpc-ui` | `pi/runtime.ts:122` |
| Copilot | ACP：`copilot --acp` | `copilot-acp-agent.ts:87` |
| Cursor | ACP：`cursor-agent acp` | `provider-registry.ts:250` |

- Kimi、Kiro、Trae 以及自定义 Agent 都走通用 ACP。ACP 目录里列了 Grok、Hermes、Gemini 等 30 多个【宣称】。
- node-pty 只用在内置终端，不用来驱动 Agent。

## 4. 怎么选 Agent
- 全部显式选择，daemon 里没有自动路由。
- CLI 必须带 `--provider`，否则报 `MISSING_PROVIDER`（`packages/cli/src/utils/provider-model.ts`）。
- App 会记住每个 provider 上次的设置，默认偏好为空（`packages/app/src/create-agent-preferences/preferences.ts:93`）。
- "Agent profiles"可以写"When to use"说明，给负责编排的 Agent 读，由 LLM 自己挑【宣称，`public-docs/agent-profiles.md`】。
- Hub workflow 支持一个"分类器 step"：它输出一个 JSON，用来选 Agent 的字段只能取 `enum` 里列出的值。后续 step 用这个结果从预先写好的命名配置里选 Agent【代码 `paseo-hub/src/workflows/engine.ts:986-999`】。

## 5. 多 Agent 编排（重点）
- **怎么调度**：Agent 调用 MCP 工具（`create_agent`、`send_agent_prompt`、`list_agents` 等，`srv/agent/tools/paseo-tools.ts:1407,1869`），或者直接调 CLI。
  - 工具注入默认关闭（`srv/config.ts:539-540`），但有 shell 的 Agent 走 CLI 不受这个开关限制。
  - 可以并行；子 Agent 显示在父 Agent 的"subagents track"里。
- **谁来规划**：父 Agent（LLM）自己规划。系统不提供 planner。
- **下一个 Agent 的提示词里到底有什么**【代码】：
  - 首条提示词就是 `initialPrompt` 去掉首尾空白后原样传入，系统不注入父 Agent 的 transcript、diff 或摘要（`srv/agent/create-agent/create.ts:349-366`）。
  - 从父 Agent 继承的只有三样：
    - cwd；
    - 同 provider 时的 providerOptions（`paseo-tools.ts:645-653`）；
    - 同 provider 时的 mode。跨 provider 时，只有 unattended 模式能桥接，其他情况直接报错，不去猜（`srv/agent/create-agent-mode.ts:57-81`）。
  - 系统提示词只追加用户配置的全局 `appendSystemPrompt`（`srv/agent/agent-manager.ts:5131-5141`）。
- **上下文靠什么交接**：靠 `paseo-handoff` skill 让发起方 LLM 按固定模板写一份自包含简报。
  - 模板字段：Task / Context / Relevant files / Current state / What was tried / Decisions / Acceptance criteria / Constraints。
  - skill 明确写着接收方"zero context"（`skills/paseo-handoff/SKILL.md:9,23-51`）。
- **结果怎么回传**【代码】：
  - 子 Agent 完成、出错、要权限、被关闭时，系统向父 Agent 注入一条用 `<paseo-system>` 包起来的消息，并以 steer 方式插入父 Agent 正在进行的回合。
  - 内容是状态行，加上子 Agent 最后一条回复（截断到 4,000 字符），要权限时再附上权限请求 JSON（`srv/agent/agent-prompt.ts:214-216,385-421,472-480`）。
- **其他编排模式**：
  - Committee：两个不同 provider 的 Agent 并行分析，强制加"不许改文件"后缀，分歧由编排 Agent 来回转述（`skills/paseo-committee/SKILL.md:30-45`）。
  - Hub 多 step 流程：按顺序执行，前一步只能通过显式写 `${{ steps.X.outputs }}`（结构化 JSON）把数据传给后一步。提示词是模板块渲染后拼起来的（`paseo-hub/src/workflows/engine.ts:951-955,1000-1012`）。

## 6. 隔离
- 以 git worktree 为主，路径是 `~/.paseo/worktrees/<源仓库hash>/<slug>`（`public-docs/worktrees.md:19-27`）。
- 没有每个 Agent 一个容器；Docker 只是把整个 daemon 装进一个容器。
- 各 provider 自带的 sandbox 参数可以透传。
- 但 Claude 的启动参数固定带 `allowDangerouslySkipPermissions: true`【代码 `claude/agent.ts:3294`，issue #3363 仍 open】。

## 7. 手机与远程
- **配对**：扫码或打开配对链接。daemon 的公钥放在 URL fragment 里（`app.paseo.sh/#offer=`）。
- **加密**：NaCl box（Curve25519 + XSalsa20-Poly1305），daemon 用长期密钥，手机每次连接用临时密钥（`packages/relay/src/crypto.ts:5-6`；`SECURITY.md:22-39`）。官方自己承认：同一会话内没有防重放。
- **认证**：拿到配对链接就等于拿到 owner 权限。所有连接都以 `principalId:"owner"` 接入（`srv/websocket-server.ts:487-490`）。没找到按设备撤销的机制。
- **直连**：可以设 bearer 密码，以 bcrypt 存储。
- **推送**：daemon 直接调 Expo 推送服务（`srv/push/push-service.ts:24`），正文是最后回复或权限详情的前 220 字符明文（`packages/protocol/src/agent-attention-notification.ts:1,178-188`）。这段内容不在端到端加密范围内。
  - 用户在线或正看着这个 Agent 时不推送；出错不推送（`srv/agent-attention-policy.ts:42-80`）。
  - iOS 后台断连导致消息滞后，见 issue #3464。

## 8. 人在回路
- **审批入口**：各 provider 的审批统一归一化后发给客户端。
  - Claude 走 `canUseTool`（`claude/agent.ts:3296`）。
  - Codex 走 `requestApproval` handler（`codex-app-server-agent.ts:3831-3834`）。
  - ACP 走 `requestPermission`；ACP 的多选类权限请求永远不自动批准。
- **Agent 之间的审批**：父 Agent 收到子 Agent 的权限请求后，可以自己调 `respond_to_permission` 批准。
  - 这个工具和 `list_pending_permissions` 都没有归属校验，能看到并批准全机器所有 Agent 的请求（`paseo-tools.ts:3098-3160`）。
  - MCP 调用方身份只靠 URL 参数 `?callerAgentId=`，所有 Agent 共用同一个 token（`srv/agent/runtime-mcp-config.ts:50`；`srv/bootstrap.ts:640`）。
- **审查**：有 diff 面板、审查评论草稿、PR 面板，都在客户端里。

## 9. 持久化、恢复与失败
- **恢复**：Agent 被关闭后仍可恢复，通过 `ensureAgentLoaded` 续接 provider 原生会话（`docs/agent-lifecycle.md:17-22`）。provider 会话失效时会 reload 一次再重试（`agent-prompt.ts:120-127`）。
- **崩溃**：回合之间进程死掉，目前只有 Claude 能检测到（`agent-lifecycle.md:31-38`）。中断结果不确定时拒绝接收新任务，避免会话"脑裂"（`agent-lifecycle.md:47-51`）。
- **结果不明**：
  - 投递回执先落盘 `pending`，发送后改成 `completed`。
  - 重试时如果发现回执停在 `pending`，返回 `agent_request_outcome_unknown`，不重发（`srv/message-receipts/index.ts:40-55`）。
  - 创建流程同理（`srv/creation/index.ts:190-212`）。
- **额度**：只做用量展示。它从钥匙串读 Claude 的 OAuth token，去调 `api.anthropic.com/api/oauth/usage`（`services/quota-fetcher/providers/claude.ts:24,469`）。没有额度用尽后自动切换 provider 的逻辑。

## 10. 优缺点与对 Chat Bridge 的启示
**优点**：provider 覆盖最广（官方 SDK、app-server、ACP 三条路都有）；幂等和"结果不明"语义做得严谨；worktree 隔离加完成通知，编排闭环可用。

**缺点**：
- 本机端口没有鉴权，任何本地进程（包括 Agent 自己）都是 owner。
- Agent 之间的权限与身份边界形同虚设。
- handoff 完全依赖 LLM 写的简报，信息会丢。
- 推送内容会发到第三方。
- 复杂度高：`agent-manager.ts` 5,324 行，905 个 open issue，单人维护。

**值得借鉴**：
1. 照搬回执加 `outcome_unknown` 的做法，给微信/iMessage 的重复投递做"至多一次"加显式"不确定"状态。
2. 子 Agent 结果回传用 `<paseo-system>` 包裹、截断，并插入父 Agent 当前回合，同时明确告诉父 Agent"不要轮询"。
3. 用 handoff 八段模板当交接格式。建议由桥接进程自动附上 diff、文件列表和最后回复，不要全靠 LLM 转述。
4. Hub 的三个做法：
   - 每个会话线程对应一个 Agent 会话，线程里的后续消息接着用它（`continuation: conversation`）；
   - 回复要调显式的 `reply` 工具，结束要调 `finish_execution`，并可规定"必须回复过才算完成"；
   - 分类器输出限定在 enum 里，这个思路可以直接给语义路由加上边界。
5. 跨 provider 时 mode 不继承、直接报错；用户在线时不推送。
6. profile 的"When to use"说明可以当路由提示用。

**应避免**：
1. 不要开本地无鉴权端口。Chat Bridge 默认不开监听端口，这是优势，要保住。
2. 编排工具要按调用者做鉴权：每个 Agent 一个 token，只能操作自己的子 Agent，审批永远只交给人。
3. 不要无条件给 Agent 开 bypass 权限。
4. 配对链接要能撤销，并且有有效期。
5. 通知预览要提醒用户：内容会经过第三方（微信和 iMessage 的消息内容本来就会经过腾讯和 Apple）。

## 引用
- https://github.com/andyrewlee/awesome-agent-orchestrators （Paseo 条目）
- https://github.com/getpaseo/paseo
- https://github.com/getpaseo/hub
- https://github.com/getpaseo/paseo-relay
- https://paseo.sh/
- https://paseo.sh/hub
- https://github.com/getpaseo/paseo/issues/3363
- https://github.com/getpaseo/paseo/issues/3464
- https://github.com/getpaseo/paseo/releases
