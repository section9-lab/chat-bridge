# Multica 调研

日期：2026-09-24。源码版本：[multica-ai/multica](https://github.com/multica-ai/multica) commit 0516dd5（2026-09-23），下文文件路径相对仓库根目录。

标注说明：【代码】= 读源码核实；【官方】= README、文档或官网的说法；【二手】= 第三方来源。

## 1. 基本信息
- **上游仓库**：真正的上游是 `multica-ai/multica`。gh API 显示它不是 fork，创建于 2026-01-13。`CloudEngineHub/multica`、`danielabelski/multica` 都是它的 fork，均为 0 star。有第三方博客把 danielabelski 当成原始仓库，这是错的。
- **官网与文档**：官网 multica.ai，文档在 multica.ai/docs。
- **作者/公司**：Multica, Inc.（`NOTICE:2`）。
  - 主要贡献者是 Jiayuan Zhang（forrestchang）和联合创始人 Bohan Jiang（Bohan-J）【gh API】。
  - 有第三方文章称 2026-04-22 公开发布【二手】。
- **许可证**：自定义的 "Multica License"，即 Apache-2.0 加附加条款（`LICENSE:17-45`）。
  - 未取得商业授权，不得用它为第三方提供托管服务，也不得作为组件嵌进对外销售的产品。
  - 不得去掉 UI 上的 logo 和版权信息。
  - 组织内部自用不受限。
  - **对 Chat Bridge 的含义：只能借鉴思路，不能拷贝代码。**
- **热度与成熟度**：
  - 51.2k star，6.6k fork，issue 932 个未关闭 / 共 2654 个。
  - 最新版本 v0.5.2（2026-09-23），工作日几乎每天发版。
  - 服务端 Go 非测试代码约 34 万行；`internal/daemon/daemon.go` 一个文件就有 10,629 行。
  - 仍是 0.x 版本，但迭代和测试密度都很高。
- **平台形态**：
  - Web 用 Next.js 16。
  - 桌面用 Electron，自带 daemon 管理（`apps/desktop/src/main/daemon-manager.ts`）。
  - iOS 用 Expo，目前只能从源码自签安装，免费签名 7 天过期（`mobile-app.mdx`）。
- **商业模式**：
  - 托管版叫 Multica Cloud，配额由私有的 Cloud entitlement 服务下发。
  - 自托管时不配置 `MULTICA_CLOUD_URL` 就不限额（`server/internal/entitlement/README.md`）【代码】。
  - 官网只写了 free trial，`/pricing` 返回 404。

## 2. 架构【代码】
- **服务端**：
  - Go 实现（Chi + gorilla/websocket + sqlc），数据库是 PostgreSQL 17。
  - 附件存本地盘或 S3（`internal/storage/`），多实例之间通过 Redis 中继实时事件（`internal/realtime/redis_relay.go`）。
  - issue、评论、会话 ID、技能、run 日志都存在服务端数据库里。
- **daemon 与服务端的连接**：由 daemon 主动外连。
  - 它连 `{server}/api/daemon/ws`，请求头带 `Authorization: Bearer` 和能力声明（`server/internal/daemon/wakeup.go:100-134,521`）。
  - WebSocket 上跑两类东西：唤醒信号和 `tasks.claim` RPC。连不上时退回 HTTP 轮询，默认 30s（`wsrpc.go:15-24`；`CLI_AND_DAEMON.md:251-257`）。
  - 心跳每 15s 一次；开始、上报消息、完成、失败、写 session 等操作走 HTTP `/api/daemon/tasks/{id}/...`（`client.go`）。
- **三种 token**（`internal/auth/jwt.go:60-88`）：
  - `mul_`：用户的个人访问令牌（PAT），浏览器登录后签发，有效期 90 天。
  - `mdt_`：daemon 专用 token。
  - `mat_`：按任务签发，绑定 (agent, task)。daemon 把它作为 `MULTICA_TOKEN` 注入 agent 进程，服务端以它为准覆盖身份头，防止伪造（`middleware/auth.go:100-110`）。
- **daemon 在本机开了端口**：监听 `127.0.0.1:19514`，提供 `/health`、`/shutdown`、`/repo/checkout`（`health.go:95-97,401-405`；`config.go:71`）。

## 3. Agent 接入【代码】
所有 CLI 都实现同一个接口 `Backend.Execute(ctx, prompt, opts) → Session{Messages, Result}`。消息类型分为 text / thinking / tool-use / tool-result / status / error / log（`server/pkg/agent/agent.go:18-23`，工厂函数在 `:432`）。

| CLI | 调用方式 | 代码位置 |
|---|---|---|
| Claude Code | `claude -p --output-format stream-json --input-format stream-json --verbose --permission-mode bypassPermissions --disallowedTools AskUserQuestion [--model] [--effort] [--resume id]`；prompt 以 stdin JSON 发送；工具授权请求（`control_request`）一律回 allow | `claude.go:791-850,521-550` |
| Codex | `codex app-server --listen stdio://`，JSON-RPC 流程为 initialize → thread/resume（失败则退回 thread/start）→ turn/start；审批请求一律 accept | `codex.go:357-370,2020-2110,2930-2937` |
| Cursor | `cursor-agent -p --output-format stream-json --yolo --workspace <cwd> [--resume]`；prompt 走 stdin，避免 Windows 下 argv 被重新拆分 | `cursor.go:1017-1054` |
| OpenCode | `opencode run --format json --dangerously-skip-permissions [--session]` | `opencode.go:95,139` |
| Grok / Hermes / Kimi / Kiro / Qoder 等 | 走 ACP，共用 hermesClient：session/new 或 load → session/prompt；权限请求（`session/request_permission`）自动选一个安全的授权选项 | `grok.go:54-67`；`hermes.go:1240-1252` |

- **自定义参数**：用户传的参数要经过 blockedArgs 过滤，不能覆盖协议相关的 flag（`claude.go:778-788`）。
- **会话恢复**：
  - 流里一出现 session_id 就立刻回写服务端。
  - 下一次 run 用 `GetLastTaskSession` 按 (agent, issue) 取回 session_id 和工作目录（`server/pkg/db/queries/agent.sql:1035`）。
  - resume 失败时，在提示词里插一段"上下文已丢失"的说明（continuity notice）（`internal/daemon/prompt.go:15-47`）。

## 4. 任务分派
- **入口**【代码+官方】，形式像给同事派活：
  - 把 issue 的 assignee 设成某个 agent：新建或改派且状态不是 backlog 时入队（`service/issue_trigger.go:97`）。
  - 在评论里 @agent。
  - 其他入口：chat、IM Bot、Autopilot（cron 定时）、quick-create（一句话建 issue）。
- **自动选择 Agent**【代码】：服务端没有语义路由，自动选人全靠 LLM agent 自己判断，有两条路：
  - Squad 的 leader 读成员名册后 @成员（`handler/squad_briefing.go:33-110`）。
  - 内置的 "Mika"（Chief of Staff 角色）按提示词自己分派（`service/builtin_agents/mika/INSTRUCTIONS.md:6,14-19`）。
- **IM 渠道**：一个 Bot 只绑一个 agent（`channels.mdx:26`）。

## 5. 多 Agent 编排与上下文传递【代码】
- **接力方式**：
  - Squad leader 发一条 @成员 的评论来委派，然后结束本轮。
  - 成员发更新或完成后，leader 会被自动重新触发（`squad_briefing.go:49-90`）。
  - 子 issue 可以按 stage 分组。某个 stage 全部完成（stage barrier）时，由服务端发一条系统评论 @父 issue 的 assignee（`handler/issue_child_done.go:19-50`）。
  - 这个通知原来由 agent 自己发，结果出现了自提及循环和 planner 之间来回踢皮球，所以改成服务端发。
- **提示词里到底放了什么**：采用"薄提示词 + 让 agent 自己拉取"的模式。
  - 每轮 user prompt 只包含：issue ID、触发评论的原文（标明作者是用户、另一个 agent 还是平台）、run 开始前堆积的其他评论（合并进同一次 run），以及要执行的读取命令（`prompt.go:201-247,360-470`）。
  - 读取命令例如 `multica issue get`、`comment list --roots-only --summary`、`--thread <id> --tail 30`。
  - **上一个 Agent 的输出不会被塞进提示词。** 只有它恰好是触发评论时才会原文出现，其余历史都要 agent 自己用 CLI 去读。
  - leader 协议还明确要求"不要复述 issue 和历史，成员自己会读"。
- **稳定信息写进工作目录的 CLAUDE.md 或 AGENTS.md**（按 CLI 选文件，`execenv/runtime_config.go:197-222`）：
  - 内容包括 agent 身份与 instructions、工作区/项目/仓库信息、可用命令、工作流、技能名单、@mention 的语义。
  - 每轮都会变的块（发起人、已连接的应用、continuity notice）追加在 user 消息末尾，目的是保住 prompt cache（`prompt.go:49-78`；`runtime_config_sections.go:1039-1100`）。
- **跨 run 的状态**：靠 issue 的 metadata 键值对、评论和恢复出来的 CLI 会话。
  - Codex 自带的 memory 被主动关掉，理由是内容不透明、会跨任务泄漏（`execenv/codex_memory.go:13-30`）。
  - Codex 自带的 multi_agent 也被关掉，因为父 turn 结束就会判完成，子 agent 的产出会丢（`execenv/codex_multi_agent.go:13-20`）。
- **防循环**：
  - 同一 (issue, agent) 已有待执行任务时会去重合并（`handler/comment.go:3096-3106`）。
  - 提示词里写明"@agent 等于发起一次付费 run，不要客套地 @"（`runtime_config_sections.go:898-925`）。
- **局限**：编排规则主要靠提示词约束。评论最多的 issue #1943 里，用户反映"skill 约束不够强，流程状态容易失控"，希望有内置的 workflow 编排器。

## 6. "compound skills"（技能累积）
这句是旧版仓库描述，fork 里还保留着，现在的描述已经换掉了。代码里的实际机制【代码】：
- **存储**：技能是工作区级别的数据库记录，表为 `skill` 和 `skill_file`（`migrations/008_structured_skills.up.sql:4,17`），通过 `agent_skill` 表和 agent 多对多绑定。
- **来源**（`skills.mdx:20-31`）：
  - 手写创建。
  - 从本地文件夹或归档导入。
  - 按 URL 从 GitHub、ClawHub、skills.sh 导入，之后可以一键从源更新。
  - 从某台 runtime 机器上拷贝现有技能。
- **注入**：
  - 领任务时下发技能包，daemon 按 hash 缓存（`daemon/skill_cache.go`）。
  - 然后写进各 CLI 的原生目录，比如 `.claude/skills`、`.cursor/skills`，Codex 则写进每个任务独立的 `CODEX_HOME`（`execenv/context.go:133-157`）。
  - 提示词里只列技能名（`runtime_config_sections.go:873-896`）。
- **没有自动提炼**：没找到任何"任务完成后自动总结成技能"的机制。所谓累积，就是一个由人维护的共享库，agent 也可以调 `multica skill create` 来写。issue #1211 讨论的正是"团队知识不能像技能一样累积"。
- **安全**：导入的技能既不审核也不沙箱（`skills.mdx:104-106`）。

## 7. 隔离【代码】
- **默认工作目录**：
  - 每个任务一个目录 `~/multica_workspaces/<ws>/<task>/{workdir,output,logs}`，workdir 一开始是空的。
  - agent 运行 `multica repo checkout` 时，从 `.repos/` 下的 bare 仓库缓存切出一个 git worktree（`execenv.go:409-500`；`CLI_AND_DAEMON.md:306`）。
- **local_directory 模式**：直接在用户自己的目录里跑，同一路径用互斥锁串行。
- **本地 worktree 模式**：每个会话一条分支，先把用户未提交的改动回放进去，全程不写用户原目录（`local_worktree.go:1-20`）。
- **没有文件系统沙箱**：
  - Claude 用 bypassPermissions，Codex 用 danger-full-access。macOS 上 Codex 这么设是因为 Seatbelt 沙箱会把网络断掉（`codex_sandbox.go:16-27`）。
  - 官方建议自己套一层边界：专用 Unix 用户、容器或 VM（`security-model.mdx:44`）。

## 8. 手机端、远程、审批与通知
- **手机与远程**：
  - 因为 daemon 主动外连，iOS 或 Web 任何设备都能远程派任务。
  - iOS 客户端没有推送：`apps/mobile/package.json` 里没有 expo-notifications 依赖【代码】。
  - IM 支持飞书、Slack、钉钉、企微、Telegram，都挂在服务端；没有微信个人号和 iMessage。
- **审批与权限**：
  - 工具级别的审批全部自动放行。
  - 官方说的"审查门"其实是 issue 状态 in_review，"done 留给人来置"只写在提示词里（`runtime_config_sections.go:765-800`），没在服务端找到强制校验。
  - 权限控制做在另一层：哪个成员能运行哪些 agent。
- **通知**：只有 Inbox 加桌面横幅，同一个 issue 的多条通知合并成一条（`inbox.mdx`）。

## 9. 会话持久化与失败处理【代码+官方】
- **daemon 离线**：
  - 排队中的任务不会因为等太久而过期。只有 runtime 失联超过重连宽限期、并且任务本身也排了这么久，才判为失败。
  - 运行中失联的，约 3 分钟内标为离线（`tasks.mdx:146-169`）。
  - daemon 重启后通过 `recover-orphans` 回收中断的任务。
  - 终态结果先写进本地文件做成的发件箱，崩溃后可以重放（`terminal_report_queue.go:34-90`）。
- **自动重试**：
  - 只有这几类失败会自动重试：runtime 离线、daemon 重启回收、超时、Codex 长时间无输出、模型网络中断、技能包下载失败。
  - 默认最多 2 次；网络中断可到 3 次，最后一次延迟约 5 秒（`service/task.go:5216-5262`）。
  - 认证、配额、配置类错误不重试。上下文溢出这类会"毒化"会话的错误，重试时换新 session。
- **超时**：没有总时长上限，只有一个 2 小时的空闲看门狗（`CLI_AND_DAEMON.md:265-276`）。
- **运行中追加指令**：用户的新消息可以注入到正在跑的这一轮里（`Session.Supplement`；`daemon/task_supplement.go`）。

## 10. 优缺点与对 Chat Bridge 的启示
**优点**：
- 接的 CLI 最多（26 个）。
- 失败分类细，恢复链路完整。
- issue 是单一事实源，可审计。
- prompt cache 的处理很讲究。

**缺点**：
- 强依赖服务端和 Postgres。
- 本地 daemon 仍然监听一个 loopback 端口。
- 零沙箱，审批全部放行。
- 编排靠提示词约束，没有语义路由。
- 代码量巨大，而且大量补丁是针对具体 CLI 版本打的，维护成本高。
- 许可证限制嵌入使用。

**值得借鉴**：
1. **headless 下禁掉 Claude 的 AskUserQuestion**（`claude.go:798-805`）。无人值守时这个工具拿到的是空答案，问题被静默吞掉。Chat Bridge 应把这类提问转成一条发给用户的消息。
2. **稳定信息和易变信息分开放**：稳定的说明写进 CLAUDE.md/AGENTS.md 的受管区块，不覆盖用户原有内容；每轮会变的内容追加在消息末尾，保住 cache。
3. **交接用"共享产出 + 薄提示词"**：规划、实现、审查的产出落在会话级的共享记录里，下一棒只拿触发内容和读取入口，不整段拼接历史。
4. **流程推进交给确定性的状态机**：参照 stage 完成由服务端检测并触发，不要让 agent 自己发"下一棒"的通知，避免来回踢皮球。
5. **session_id 一出现就保存**；resume 失败时明确告诉 agent 和用户"上下文已丢失"。
6. **失败原因要分类**：只对可重试的类别自动重试；上下文溢出类换新会话。
7. **最终回复先落盘成发件箱，再投递**到微信或 iMessage，桥接进程重启后可以补发。
8. **处理运行中的新消息**：注入到当前轮次；run 开始前堆积的消息合并进同一次 run。
9. **关掉 Codex 自带的 multi_agent**，否则父 turn 结束就会判完成，子 agent 的产出会丢。

**应避免**：
1. 全局 bypass 加自动批准。IM 远程入口被注入的面更大，Chat Bridge 应保留审批或只读模式。
2. 为了健康检查之类的需求开端口，这会破坏"默认不监听"的定位。
3. 纯靠提示词来编排多 Agent。
4. 一个 Bot 只绑一个 agent 的模型。Chat Bridge 的语义路由正是差异化所在。
5. 拷贝它的代码（许可证限制）。

## 引用
- https://github.com/multica-ai/multica（commit 0516dd5）
- https://github.com/multica-ai/multica/releases/tag/v0.5.2
- https://multica.ai
- https://multica.ai/docs/security-model
- https://multica.ai/docs/skills
- https://multica.ai/docs/tasks
- https://multica.ai/docs/channels
- https://multica.ai/docs/squads（仓库内对应 `apps/docs/content/docs/*.mdx`）
- https://github.com/multica-ai/multica/issues/1943
- https://github.com/multica-ai/multica/issues/1211
- https://github.com/multica-ai/multica/issues/815
- fork 示例：https://github.com/CloudEngineHub/multica · https://github.com/danielabelski/multica
- 【二手】https://agentpedia.codes/blog/multica-guide
