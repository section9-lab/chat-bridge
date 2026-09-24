# Cindy 调研

日期：2026-09-24。源码版本：[makecindy/cindy](https://github.com/makecindy/cindy) commit b7c5d0a（2026-09-23），下文文件路径相对仓库根目录。

Cindy 和 Chat Bridge 是部分重叠的竞品，不是完全同类的产品。重合度最高的场景是「个人微信 → 本机 Claude Code / Codex」，而且 Cindy 是大厂出品、免费、开源。它做不到的地方，正好是 Chat Bridge 的差异点：IM 端按语义路由到项目和会话、不依赖云端、默认不开端口。

**标注说明：** 【码】= 读源码核实；【文】= 仓库内文档或注释；【官】= 官网或 README 的宣称。

## 1. 基本信息

- **作者是中国团队：心动网络（XD Inc.，上海，TapTap 母公司）。**
  - 【码】`package.json` 的 author 字段和 `NOTICE` 都写的是 XD Inc.；官方安装包内置 TapDB 统计（TapTap 的产品）。
  - 【官】cindy.cn 页面标注「心动」，备案号沪ICP备11033765号-90。
  - 贡献者多带 XD 后缀，如 DavidShenXD、GaoWeiLiuXD。
  - 【文】`docs/product-rules/region-and-editions.md` 刻意把产品定位为「全球产品」，写明要避免「某中国公司的海外版」这种联想。
- **许可证：只有客户端是 Apache-2.0。** 采用 DCO，不需要签 CLA。
- **规模与成熟度**（2026-09-24 的数据）：
  - 2805 star、420 fork；仓库 2026-07-22 才建。
  - 共 54 个 release，最新 v0.1.92 发布于 2026-09-23，几乎每天一版。
  - issue 总数 2368，其中 open 1292、带 bug 标签的 open 533；PR 约 2600；贡献者 100 多人。
  - 代码量极大：desktop main 约 60 万行（不含测试），renderer 约 42 万行，mobile 约 14.5 万行。单个 `maker-ipc/register.ts` 就有 18705 行。
  - 结论：还处在 0.1.x，迭代极快，稳定性一般。
- **平台：**
  - 【官】桌面端是 Electron（macOS / Windows / Linux），手机端是 Expo（iOS / Android），另外支持 SSH 远端。
  - Harness 实际是三个：Claude Code、Codex、Pi。README 说「首批 CC+Codex」，但官网和代码里都有 Pi。
- **商业模式**【官】：Free（自带 key 或已有订阅）、Plus（国际版 $20/月起，国内 ¥100/月起，托管模型网关）、Team（待上线）、Enterprise（联系销售）。
  - **「官方服务」**：provider 为 `xd`。登录后从 model-access 服务拉取网关的 endpoint 和 key（【码】`apps/desktop/src/main/model-access/credentialsSync.ts:7-22`）。
  - **「授权 Coding Plan」**是复用本机已有的 CLI 凭证【码】：
    - Claude：读 macOS 钥匙串 `Claude Code-credentials` 或 `~/.claude/.credentials.json`（`maker-host/claude-credentials-store.ts:42`），再作为 `CLAUDE_CODE_OAUTH_TOKEN` 注入（`claude-oauth-spawn-env.ts:17`）。
    - Codex：把 `~/.codex/auth.json` 硬链接到隔离目录 `<userData>/codex-home`（`auth-adapters.ts:172`）。
    - 订阅还可以交叉使用，有服务条款风险：代理用 Claude Code 的身份头，把 Claude 订阅的 OAuth token 注入给 Codex（`codex-proxy-host.ts:1344-1360`）；Claude Code 也能经 Responses 桥用 ChatGPT 订阅。
  - **「自带 Key」**：BYOK 或自定义 provider 经本地协议桥接入，也支持本地 Ollama。
  - **不登录（「跳过登录」）**：只能用本机 agent；手机、device-link、官方网关都不可用（【码】`appCapabilities.ts:24-37`）。

## 2. 架构

**进程**【码】：
- **桌面端**是 Electron。main 进程里跑 maker-host / maker-ipc / localDb / im / device-link，再加若干 utilityProcess。
  - 编排核心 `packages/maker-core` 不依赖 Electron。
- **Harness 子进程：**
  - Claude Code：每个会话一个 `claude` CLI 子进程，通过 Claude Agent SDK 0.2.112 的 `query()` 驱动，内置 CLI 为 2.1.280。
  - Codex：全局只有一个 `codex app-server`（0.156.0），走 stdio JSON-RPC，多个会话按 threadId 复用。
  - Pi：每个会话一个 `pi --mode rpc`（0.85.1）。
- **手机端**不运行任何 agent，只是控制端。
- **SSH 远端**跑 cc-mgr / pi-manager 守护进程，只监听 unix socket。

**云端（闭源）：**
- 【文】README 写明「服务端位于独立仓库」，另见 `docs/product-rules/shared-task-mode.md` 提到的 cindy-server。
- 【码】端点清单在 `config/endpoint.global.json`：auth、device-link relay、model-access、oss、heartbeat、`wss://telegram-hook|slack-hook|x-hook`、voice、skillhub、plugin、oauth-broker 等。

**数据存储**【码】：
- 本地 SQLite：`<userData>/cindy-<ownerId>.db`（`localDb/modelDefaultsProfile.ts:11`）。
- 记忆：`<userData>/maker-memory/<工作目录名>/MEMORY.md`（`packages/maker-core/src/memory/storage.ts:45-59`）。
- 没发现会话上传到云端的接口；官网也宣称文件和对话默认留在本机。

**网络模型**【码】：
- device-link 和 IM 都不开监听端口，全部主动向外拨出。
- 本机服务都绑 127.0.0.1：OAuth 回调、`anthropic-compat-proxy`、`codexHttpBridge`（带 bearer token，`:429`）。
- **例外：** 联系人同步绑定 `0.0.0.0` 的 TCP，外加 UDP 53546 组播（`contacts-sync/lanTransport.ts:113`）；载荷做了 AES-GCM 加密。

## 3. Agent 接入方式

- **Claude Code**【码】：用 Agent SDK 的 `query()`，`pathToClaudeCodeExecutable` 指向内置 CLI（`maker-core/src/agents/claude-code/index.ts:3782,3803`）。审批走 `canUseTool`，统一接到 Cindy 自己的审批 UI。
- **Codex**【码】：用 app-server 协议（`agents/codex/app-server/stdioTransport.ts:66`）。权限映射在 `codex/index.ts:537-566`：
  - ask → on-request + workspace-write；
  - auto → Codex 原生 `auto_review`；
  - bypass → never + danger-full-access。
- **Pi**【码】：来自 `earendil-works/pi`。Pi 自己没有审批机制，Cindy 注入一个扩展拦截 `tool_call` 来实现审批。
- **没有 ACP**【码】：全仓库搜不到 agent-client-protocol。
- **「native harness」有两个意思：**
  - 代码里指 Claude Code 和 Codex 这两个「可继承本机 CLI 凭证」的 harness（`maker-host/model-discovery/connection-source.ts:4-10`）。
  - README 说的「自研 Harness 在酝酿」是未来的计划，目前没有代码【官】。Pi 被定位为「未来的基座 harness」（`docs/dev-rules/pi-harness.md:140`）【文】。
- **模型与 harness 解耦**【码】：
  - Claude Code 的 `ANTHROPIC_BASE_URL` 指向本机 loopback 代理，可以跑非 Anthropic 模型。
  - Codex 固定使用 `model_provider=cindy_gateway`，再经 Responses↔Chat / Anthropic 协议桥接其他模型。

## 4. 用户怎么选 Agent / 模型

- **模型优先的选择器**【文】：用户只选模型，harness 按推荐映射自动配好，但始终可见、可改（`docs/product-rules/model-selector-unified.md:9`）。
  - 推荐是确定性规则，不用模型判断【码】（`packages/model-providers/src/unifiedSelection.ts:357-398`）：anthropic-messages → CC，openai-responses → Codex，其余 → Pi。
- **没有自动路由。** 「Cindy Fast / Smart」智能模式「本版不做」（同文档第 20 行）。
- **Agent 自己也能改运行时配置**【文】：通过 MCP 工具 `set_session_runtime`。
  - 失败自动降级默认关闭；开启后不跨 harness、最多换两次（`docs/product-rules/session-runtime-control.md`）。

## 5. 多 Agent 编排与跨 harness 上下文传递（重点）

### 编排：Orca

结构是一个 Lead 会话加多个 Worker 会话。Worker 是完整会话，每个都可以单独指定 claude-code / codex / pi 和模型（【码】`packages/lizi-mcps/src/orca/server.ts:92-104`）。工具面是一个 MCP server `cindy_orca`，共 18 个工具（`docs/dev-rules/orca-team-architecture.md:106-126`）。这里的 Orca 是 Cindy 内部的功能名，和 stablyai/orca 无关。

**Lead 怎么派活**【码】（`packages/orca-workflow/src/orca-bridge-prompt.ts`）：
- 派单必须写明 Intent / Decisions / Boundaries / Task。
- 多角色任务在一个批次里并行发出；派完后 Lead 零输出结束本轮，不轮询。
- Worker 的回报作为新消息异步唤醒 Lead。

**Worker 怎么回报：**
- Worker 调用 `send_to_lead` 回报。
- 如果忘了回报，系统会把它最后的输出加上 `[Auto-bridged…]` 前缀转给 Lead（`maker-ipc/orcaTeamService.ts:539-565`）。
- Worker 需要上下文时，可以用 `read_lead_history` 分页读取 Lead 的对话记录；只能读自己所属的 Lead，也不会唤醒它。

**审查：**
- Worker 的规则是「实现 → 跑 /review → 修 → 直到干净」。
- `/review` 会新建一个独立的 Reviewer 任务：不 resume 开发会话、关闭记忆、强制 ask 权限、只给只读工具白名单（【码】`reviewer/reviewSessionPolicy.ts`；`claude-code/index.ts:1552`）。
- Reviewer 只拿到结构化证据，不传开发过程的推理（【文】`docs/product-rules/review-product-direction.md`）。

### 跨 harness 切换时，新 harness 到底收到什么【码】

入口在 `maker-ipc/sessionAgentSwitchHandler.ts`，交接文本由 `apps/desktop/src/main/maker-ipc/agentHandoff.ts` 生成。

**交接内容不是完整转写，也不是 LLM 摘要，而是代码拼出来的确定性文本**（`agentHandoff.ts:1-12`），依次包括：
1. 开头说明：以第一人称继续，不向用户提及切换；工作区状态永远优先于记录（`:595`）。
2. 「Work ledger」：改动过的文件（最多 20 个）、最近的命令及结果（最多 10 条）、失败的尝试（`:262-321`，`:626`）。
3. 更早各轮的单行索引（总共 3000 字符预算）。
4. 最近 4 轮逐字记录，单条最多 2000 字符（`:71-86`）。
5. 检索指引：告诉新引擎用 `search_chat_history` / `get_chat_history`（按 session_id 过滤）去翻原文（`:680`）。
6. 结束标记。
- 总长硬上限 16000 字符；超限时先缩减逐字轮数，保证检索指引和结束标记不被截掉。

**怎么送进去：**
- 交接文本只前置到下一条用户消息的实际发送内容上，数据库里存和界面显示的仍是用户原文（`makerSendTransaction.ts:1164`）。
- 全文持久化在一个 `agent_switch` 边界行里；重启后也能从数据库重建「待注入」状态。

**切回原引擎（「停泊」机制，Phase 2）：**
- 每个引擎离场时，它的原生会话被「停泊」保留。
- 切回时 resume 那个停泊会话，只补充离场期间的增量（`sessionAgentSwitchHandler.ts:527-551`）。

**记忆和工具怎么保持连续：**
- 三个 harness 共用 Cindy 自己的按工作目录划分的记忆：启动时把 MEMORY.md 快照注入 system prompt，同时挂 `cindy_memory` MCP，并让模型忽略各 harness 自带的记忆。
- 同一组 MCP server 挂给三个 harness。
- Skills 通过软链接共享。
- `cross-agent-convert/` 可以迁移 CLAUDE.md↔AGENTS.md、agents、hooks 和 MCP 配置。

**限制：**
- SSH 远端、Orca、Review 会话不支持切换 harness（`sessionAgentSwitchHandler.ts:417-426`）。
- 运行中的 Worker 不能换模型（【文】orca 文档坑点 #6）。
- 同一 harness 内换模型会沿用原生历史，已出现跨 provider 的消息 ID 不兼容：#4738（Gemini→GPT）。另有 #4600 切到 Codex 后报 LAZY_CREATE_FAILED。
- 所以「中途切换、上下文连续」只在一定程度上成立：切 harness 时历史被压缩成有损交接，细节要靠检索补回。

## 6. 隔离

- **worktree 可选，不强制**【码】：
  - 位置是 `<repo>/.cindy-worktrees/<name>`，分支 `cindy/<name>`（`worktree/WorktreeManager.ts:1007-1009`）。
  - 打开 worktree 时，Lead 和所有 Worker 共用同一个 worktree；Worker 也可以单独指定 `working_dir`。
- **没有容器。** 只有 Codex 自带的 workspace-write 沙箱。
- **Orca Worker 默认 Full access**【码】：默认值是 `bypassPermissions`（`shared/orca-worker-permission-mode.ts:5`），而且只能在 auto 和 bypass 两档之间选。
- **回滚**【码】：每个会话有一条影子 git 保存点链，挂在 `refs/cindy/savepoints/<sessionId>`（`git-snapshot/savepointRefs.ts:4-14`）。

## 7. IM 接入

### 两套独立体系【码】

- **个人 bot（纯本地，桌面端直连 IM 平台）：**
  - 飞书 / Lark：官方 SDK 的 WebSocket。
  - Telegram：长轮询 getUpdates。
  - Discord：Gateway。
  - 钉钉：Stream 模式。
  - 企业微信：AI bot 长连接。
  - 个人微信：iLink 长轮询 `ilinkai.weixin.qq.com`；协议改编自 Tencent/openclaw-weixin v2.4.6（`packages/wechat-ilink/UPSTREAM.md`）。
  - 桌面端要先登录、本地库就绪后才会连接（`im/index.ts:39-53`）。
- **官方 bot（经 Cindy 云中继）：** Slack、官方 Telegram bot、X。桌面端用登录 token 主动拨出 WSS 到云端（`hook-control/transport.ts:4-7`）。
- **没有 QQ。**

### 绑定方式【码】

- 微信：扫码登录。
- 飞书：填 appId / appSecret，或用 device-code 二维码一键注册。
- Telegram / Discord：填 bot token 和 owner 的用户 ID。
- 钉钉 / 企业微信：填 key 和 secret。
- 凭证用 safeStorage 加密存在本地。

### 怎么选目标（没有语义路由）【码】

1. 先看 `/ctr` 接管绑定：命中就发给那个桌面会话。
2. 否则每个聊天对应一个固定会话 ID，例如 `feishu_${appId}_${user}`（`feishu/adapter.ts:267`）；群和话题各自独立成一条。
3. 以上都没有就新建会话。
- 默认 harness 是 Claude Code，默认权限 auto（`im/index.ts:145-201`）。
- 工作目录默认是托管目录 `im-working-dir/<botId>`。只有 Telegram 支持 `/project` 切到项目目录。
- 用户在 issue 里集中抱怨「一个微信号没法操作多个项目」「没法跨会话总控」：#1413、#2533、#2691、#2916、#3704。**这正是 Chat Bridge 的差异点。**

### 审批【码】

- **卡片渠道**（飞书 / Telegram / Discord）：按钮为「允许一次 / 本任务总是允许 / 拒绝」。群里触发的审批卡发到 owner 私聊。
- **文本渠道**（微信 / 钉钉 / 企业微信）：回复「允许 / 拒绝」。超时：微信 30 分钟、企业微信 10 分钟。
- 卡片发出前先对工具参数脱敏；删除类等破坏性调用在出卡前直接硬拒（`turnRunner.ts:3313-3330`）。
- **白名单偏弱：**
  - 飞书、钉钉、企业微信是「第一个私聊的人成为 owner」。
  - 钉钉群里任何成员 @ 都能触发。
  - 微信没看到发送者白名单。

### 回复与定时任务【码】

- **微信回复：** 最终结果写入 SQLite outbox 带重试；任务进行中大约每 2 分钟发一次「任务仍在处理中…」。
- **Telegram / 飞书回复：** 流式编辑消息，1.5 秒节流。
- **定时任务：** 结果回推到桌面通知、飞书 owner 私聊、企业微信群和手机推送。

## 8. 手机 / 远程

- **连接方式：只经云端中继**【码】。手机和桌面都主动连 `device-link.cindy.app` 的 WSS。
  - 同账号即可互联，没有扫码或配对码。
  - 用 Bearer token 认证；桌面端「允许远程控制」默认关闭（`device-link/settings-store.ts:50-53`）。
- **没有端到端加密**【码】：信封是明文 JSON，只受到中继那一段的 TLS 保护，中继可以读到内容（`packages/device-link/src/client.ts:2117`）。
  - 协议注释说载荷「对 relay 不透明」，意思只是中继不解析，并不是加密了（`device-link-protocol/src/protocol.ts:4-7`）。
  - 只有插件 OAuth、联系人同步、远程桌面解锁密码这三处另做了 X25519 / AES 加密。
- **手机能做的事**【码】（`packages/device-link/src/allowlist.ts:603-611`）：发消息、审批、换模型或 harness、改权限、浏览读写文件、执行 `desktop-cmd:run`、管理 Orca。
- **远程桌面**：视频走 WebRTC，信令经中继，必要时用 TURN。
- **手机没有免登录模式**【文】。

## 9. 会话持久化、恢复与失败处理【码】

- **双份记录：**
  - Cindy 自己在 SQLite 里存完整的 sessions / messages，用于显示、检索和交接。
  - 另存原生会话 ID `sdk_session_id`，下次发消息时懒恢复（`localDb/schema.ts:86,137`）。
- **故障自愈：**
  - 响应中途断流（如 "Connection closed mid-response"）：自动续跑，按连续失败次数限额（`maker-ipc/interruptedTurnAutoResume.ts`）。
  - 上下文溢出：同一任务内关掉原生窗口、写交接、重新起窗；只有在本轮没有副作用时才自动重放（`contextOverflowRollover.ts`）。
- **Orca 重启恢复：** 靠数据库里的 `orca_teams` / `orca_workers` 懒重建团队状态。
- **其他：**
  - 离线推送队列（128 条，5 分钟过期）。
  - 官方 bot 的最终结果离线时缓存，重连后重放。
  - 回收 Claude 退出后遗留的孤儿子进程。

## 10. 评价与对 Chat Bridge 的启示

**优点：**
- 大厂投入、完全免费，三端加 SSH 覆盖完整。
- 交接、回滚、审批这些细节打磨得很深，工程上大量「用代码保证确定性，而不是靠 prompt」。
- IM 渠道覆盖广，国内平台齐全。

**缺点：**
- 太重、太复杂，bug 多（533 个 open bug）。
- 手机和官方 bot 强依赖闭源云，且没有端到端加密。
- IM 只能绑到固定会话或托管目录，没有项目路由。
- Worker 默认 Full access。

**值得借鉴：**
1. 交接文本构造器：工作台账 + 最近 N 轮逐字 + 索引 + 检索工具 + 结束标记；只加在实际发送内容前，不改落库原文；持久化到边界行；切回原引擎时 resume 停泊会话并只补增量。可以直接作为 Chat Bridge 「规划 → 实现 → 审查」接力时的交接格式。
2. 渠道说明每轮追加到用户消息，而不是写进 system prompt，保持 prompt cache 前缀稳定（`mobileClientPromptNote.ts`、`hook-control/outbound.ts:55`）。
3. 附件协议：在最终回复里写 `[名](xdt-file:///路径)`，由宿主自动作为 IM 附件发出。
4. IM 审批：文本渠道回复「允许 / 拒绝」、卡片发出前脱敏、破坏性操作出卡前硬拒、群审批转 owner 私聊。
5. 微信可靠性：outbox 加重试；游标与入站在同一事务提交；定期发「仍在处理」；`errcode -14` 触发重新登录。另注意 #3515：长时间没有入站消息后，`context_token` 过期导致主动发送失败。Chat Bridge 用同一个 iLink，发送时带的是最近一条入站消息的 token（`bridge/src/weixin.ts:92`），长时间运行的编排任务可能遇到同样的问题，需要实测。
6. Orca 的异步队列加 auto-bridge 兜底；按 threadId 路由 MCP 身份，识别不了就拒绝而不是猜；Reviewer 用新会话 + 只读白名单 + 无记忆。
7. 影子 git 保存点；CLAUDE.md ↔ AGENTS.md 配置迁移。

**应避免：**
- 无端到端加密的云中继；手机强制注册账号。Chat Bridge「本地、不开端口」是优势，将来如果做远程，一定要做端到端加密。
- Worker 默认 bypass 权限；绑定 `0.0.0.0`；「第一个私聊的人成为 owner」这种白名单策略。
- 同一 harness 内换模型时沿用原生历史导致的协议兼容问题；把所有逻辑堆进 1.8 万行的单文件。

## 引用

- https://cindy.app/
- https://cindy.cn/
- https://cindy.app/download/
- https://github.com/makecindy/cindy
- https://github.com/makecindy/cindy/releases/tag/v0.1.92
- issues：#572 #1413 #2533 #2691 #2916 #3515 #3704 #4600 #4738（均在 https://github.com/makecindy/cindy/issues/ 下）
- https://github.com/Tencent/openclaw-weixin（微信 iLink 协议的上游）
- https://github.com/earendil-works/pi
