# 使用与开发参考

产品介绍见 [Chat Bridge](../README.md)。本页保留详细使用说明、运行限制和构建方法。

macOS 原生菜单栏应用，通过消息通道继续电脑上的 Agent 会话。

当前为 **0.3.0 开发预览**：接入 Codex、Claude Code、Cursor、Grok、OpenCode 和 Hermes Agent。启动及每 30 秒自动检查命令行程序、运行时连接和登录／模型配置，状态同步到看板、设置和消息命令。就绪后可直接发送文字，支持停止和单次审批。iMessage／微信提供消息通道。Claude Chat／Cowork 不在本次范围内。

Bridge 启动或恢复的 Codex／Claude Code 会话默认使用 full 权限，普通命令、文件操作和网络访问无需逐次审批；仍受 macOS 系统权限与运行时管理策略约束。Codex 使用 `danger-full-access`＋`never`，Claude Code 使用 `bypassPermissions`。桌面端正在持有的 Codex 会话经原生队列执行时，沿用桌面端权限；如仍有审批提示，需在 Codex 原会话开启 full 权限，或释放该会话后由 Bridge 恢复。异常审批仍可用 `/approve`／`/deny` 处理。

技术栈：SwiftUI / AppKit + 随包 Node.js 24.21.0 + TypeScript + SQLite。Codex 使用 App Server，Claude Code 使用官方 Agent SDK，其余四个使用官方 ACP 接口；可选开启 JEV 智能路由。见 [六 Agent 接入决策](decisions/004-agent-discovery-and-acp.md)和 [JEV 路由决策](decisions/005-semantic-routing.md)。

## 构建与运行

需要 macOS、Xcode Command Line Tools 和 Python 3。首次构建需要联网下载固定 Node 版本和锁定的 npm／Swift Package 依赖。Node 下载会核验官方 SHA-256。

~~~sh
bash scripts/build-app.sh
open "dist/Chat Bridge.app"
~~~

构建会运行 TypeScript 与 Swift 测试，生成自带 Node／SQLite 的应用，默认使用钥匙串中的 Apple Development 证书签名；多证书环境可通过 `CHAT_BRIDGE_SIGNING_IDENTITY` 指定证书 SHA-1。使用同一开发身份更新，避免临时签名随构建改变应用身份。没有证书时，可显式设置 `CHAT_BRIDGE_SIGNING_IDENTITY=-` 使用 ad-hoc 签名，但更新后可能需要重新授权完全磁盘访问。开发签名不等于发行签名，仍需 Developer ID、公证和干净机器验收。

启动时显示双栏会话窗口：左侧选择 Agent，右侧查看消息；点击齿轮打开设置。关闭窗口后仍在菜单栏运行。

菜单栏会话浮窗右上角的 ↗ 可打开应用看板，并在 Dock 显示 Chat Bridge 图标。当前会话和草稿保持不变；关闭看板或切回菜单栏浮窗时，Dock 图标隐藏，服务继续后台运行。看板最小化后可点击 Dock 恢复。

~~~sh
# 检查真正装进应用的服务与 SQLite，而非系统 Node
BRIDGE_NODE="$(python3 scripts/bootstrap-runtime.py)"
"$BRIDGE_NODE" scripts/smoke-bundle.mjs
~~~

本地数据目录为 ~/Library/Application Support/Chat Bridge。服务仅通过父子进程管道通信，没有 HTTP 监听端口。不要同时手动运行多个服务访问同一个数据库。

## 当前可验证的内容

开启智能路由后，手机直接发送意图，例如“列出 Claude 的商城项目会话”“用 Codex 新建一个无项目会话分析这段代码”。JEV 区分查看、切换、新建、续聊、任务控制和目标纠错；查看列表不会改变当前目标。只有无法判断、目标冲突、服务失效或开启确认目标模式时，才显示处理选项。原消息保留，回复 `01`、选项文字或“手动选择目标”即可继续，无需记忆命令；本地选择不再调用 JEV。多条消息待选时先选消息，项目和会话支持翻页。发送“选错了”可更正目标；已发送或结果不确定的任务不会自动重发。完整能力、失败情况和文本示例见 [会话路由与文本兜底](decisions/006-conversation-routing-options.md)。

以下斜杠命令继续作为手动操作方式保留：

Codex 使用本机 App Server 运行时；其余 Agent 需要对应的本机 CLI。登录与模型配置沿用各 CLI。浮窗输入区的文件夹按钮可搜索运行时提供的项目与会话。手机发送 `/agent` 查看检测状态，使用 `/agent codex`、`/agent claude`、`/agent cursor`、`/agent grok`、`/agent opencode` 或 `/agent hermes` 切换，再发送 `/project`（或 `/projects`），回复 `01`、`02` 等编号选择项目；随后自动列出会话，再回复编号选择。列表只显示编号与名称，超过一页时发送 `/more`，下一页接着编号。`/sessions` 查看当前项目会话，`/sessions all` 查看全部。`/new` 保留当前项目，`/project none` 切到无项目，`/status` 显示当前目标和检测状态。

手动命令的编号只用于发送列表的通道，列表 10 分钟后或当前目标改变后失效；重新获取列表再选择。没有项目时直接列出会话，没有会话时直接发消息新建。选择会话后，普通文字和数字都继续聊天；手动命令列表中发送其他文字会退出编号选择。智能路由的文本选项使用独立的持久化菜单；选择过程中的无效回复会重新提示，过期选项刷新后需要再次选择。

浏览列表和历史不会执行任务；ACP 历史通过加载原 ID 回放。发送时恢复原 ID，运行结束后释放本桥接持有的 Codex 会话。若 Codex 桌面端仍持有原会话，消息进入该会话的原生队列，由桌面端继续执行，窗口可以保持打开；桥接按消息唯一 ID 读取对应正文和完成结果。排队和执行状态可通过 `/status` 查看，这类任务的停止、队列移除与审批在 Codex 原会话中处理。原生队列不可用时任务保持未发送；已提交但断线的任务不会自动重发。Codex 项目与队列接口依赖本机版本的实验性协议；历史目前显示最近部分文字消息。见 [桌面会话续聊验证](verification/codex-session-queue-2026-09-19.md)。

- 六个 Agent 均可设为默认 Agent；菜单栏只显示 Chat Bridge Logo，点击恢复上次会话，保留草稿。Agent 在看板或设置中切换。
- 原生无底色聊天面板，每张消息卡单独使用磨砂。
- 浮窗与看板支持 Markdown 标题、粗体、列表、引用、链接、表格和代码块；保留普通换行，宽表格与长代码行在卡内横向滚动。用户消息靠右、灰色底，AI 回复靠左。
- 六个 Agent 的公开正文持续显示；同一条消息原位更新，完成时不重复追加。思考、工具调用及工具原始输出不进入正文。iMessage／微信按完成的正文消息顺序发送，不逐 token 刷屏。见 [流式正文验证](verification/streaming-2026-09-19.md)。
- 默认 Agent、显示名称与保活偏好持久化；没有连接通道时不申请保活断言。
- 无项目首次会话、会话复用、事件去重、输入来源限制、原路回复、创建并发、迟到响应及发送不确定状态的核心测试。
- 桌面输入在发送时核对选择版本，防止旧输入框跟随远程切换而发错会话。

智能路由启用“自动选择”后，独立新请求与旧任务的澄清分别处理；查看其他 Agent 不会取消远程任务。自然语言停止、取消和恢复会调用任务控制，不会排成普通提示词。不同 Agent 可同时工作，同一个 Agent 按顺序执行；排队时回复可读的 Agent、项目、Session 和等待状态。

微信或 iMessage 可以直接发送“用 Codex 创建名为‘卡牌游戏’的项目，先给出方案”或“用 Claude 创建名为‘商城’的项目，先写需求”。应用先创建独立项目目录，再启动该项目内的“项目启动”会话，发送两行回执 `Codex > 卡牌游戏 > 项目启动` 和 `已收到✅`，随后回传 AI 正文。无项目会话显示“无项目”，Claude 默认显示为“Claude”。Codex 使用官方配置和桌面入口登记项目；新建空目录只信任该目录，既有目录仍须明确确认。Claude 使用 Claude Code 本地项目与会话，不包含 Claude Chat／Cowork。创建失败不会把提示词发进无项目会话；同名新项目使用独立目录，重复投递不会重复创建，追问继续原会话。新会话在项目根目录启动，避免项目已登记但任务仍留在默认工作区。见 [远程创建项目验证](verification/remote-project-creation-2026-09-21.md)。

无项目会话完成任务后，如果答案明确链接到工作目录内唯一的项目根目录（例如包含 `project.godot` 或 `package.json`），应用会登记项目并关联原 Session、缩短标题。Codex 通过官方 `codex app <目录>` 请求桌面添加项目，再同步原生项目与标题。首次添加未信任的目录时，先在原微信/iMessage 对话中说明目录及权限；回复“信任此项目”后，应用通过官方配置接口仅保存此目录的信任设置，再发起桌面登记，无需远程用户点击桌面信任框。回复“不信任此项目”或超时不会更改信任设置。后台项目记录与桌面侧栏登记分别核对，未完成登记或会话归属时会明确提示。其他 Agent 保存在桥接项目目录中，原 Session ID 和工作目录保留。存在多个项目时不自动猜测。

设置 → 消息通道可开始 iMessage 配对或微信扫码。新安装不会自动读 Messages、读微信凭据或登录账号。绑定成功后才能收发；“已提交”不代表手机已送达。微信和 iMessage 输入目前仅支持文字，收到的附件与语音不会执行。桌面输入框输入 `@文件名` 或点击左侧回形针即可搜索本机文件，在候选列表中点击或按方向键／回车添加，每条消息最多 10 个文件、每个文件不超过 50 MiB；文件先保存本机副本，发送时交给目标 Agent 读取。AI 答案中明确链接的本地视频、图片和常见文档可作为附件回传到原通道：文件须位于 Session 工作目录内，每个文件不超过 50 MB，每次最多 8 个。应用先保存并校验副本，微信加密上传，iMessage 发送本地文件；发送结果不确定时不会自动重发。

桌面主窗口和菜单栏对话可直接预览 Markdown 中的图片与视频链接，支持本地绝对路径、`file://` 和 HTTP(S) 地址。图片点击可打开原图；视频先显示封面，点击后在对话中播放，离开该视图时暂停。已有对话同样生效，无需重发消息。预览失败会保留原链接并提示；相对路径不会猜测所属目录，视频解码格式以 macOS 支持范围为准。

已绑定的 iMessage 若显示 EPERM／EACCES，表示系统拒绝读取 Messages。在通道设置中点击「完全磁盘访问设置」，为当前应用授权。启动读取失败后，应用每隔 5 秒自动尝试恢复；权限生效后继续处理未读消息，无需再次点击重连。若系统仍拒绝访问，可完全退出并重新打开。已有绑定和读取位置保留，无需重新配对；首次从 ad-hoc 切换到开发证书仍可能需要重新授权。

检测到读取权限被拒绝时，应用会尝试通过 iMessage 向已绑定的手机号发送一条权限提醒，附上开启路径。发送提醒不读取 Messages 数据库；同一次故障只尝试一次，重启和重连不重复，权限恢复后才允许下一次故障提醒。若发送也失败，本机显示「权限提醒未能确认发出」，不会自动重试。未配对时只在本机提示；数据库缺失或结构不兼容不会误报为权限关闭。

每次新绑定完成后，会向该用户自动发送一份中文命令指南，介绍状态查询、Agent／会话切换、停止任务及单次审批。iMessage 连接就绪后发送；微信若尚无回复上下文，会等绑定用户的首条来信后发送，可先发送 `/status`。指南随待发消息持久化，重启／重连不重复发送，解绑会取消待发指南；提交结果不确定时不自动重发。已有绑定可发送 `/help`查看同一份指南。

界面显示「检测中／未安装／待登录／可用／连接异常」。自动检测不创建会话、不发送测试提示；「可用」表示本机运行时和账号／模型配置检查通过，不保证远端额度或每次推理成功。新增 ACP Agent 上次执行失败会显示「执行异常」，跨重启保留；允许修复配置后主动再发，成功后清除提示。安装或登录完成后自动刷新；已有待执行任务需明确继续，不会自动重发。无项目会话使用应用专用工作目录；原会话 ID 无法恢复时明确报错，不创建替代会话。iMessage SDK 使用较新的 Messages 数据库结构，旧版 macOS 和系统权限归因必须另行真机验收。

## 文档

- [六 Agent 自动探测与验证](verification/agent-availability-2026-09-20.md)
- [会话路由能力与文本兜底](decisions/006-conversation-routing-options.md)
- [完整技术方案](technical-plan.md)
- [实施进度与当前限制](implementation-status.md)
- [菜单栏与会话交互](menubar-interaction.md)
- [验证记录与发布验收](verification-checklist.md)
- [通道实现决策](decisions/002-durable-channel-transports.md)
- [第二阶段验证](verification/phase2-2026-09-18.md)
- [授权后恢复验证](verification/authorization-2026-09-18.md)
- [Codex 官方运行时实测](verification/codex-runtime-2026-09-18.json)
- [第三阶段验证](verification/phase3-2026-09-18.md)
- [原应用项目与会话接入验证](verification/native-catalog-2026-09-19.md)
- [项目与会话编号选择验证](verification/numbered-menus-2026-09-19.md)
- [iMessage 恢复与开发签名验证](verification/imessage-recovery-2026-09-19.md)
- [iMessage 权限消息提醒验证](verification/imessage-notice-2026-09-19.md)
- [权限开启后自动重连与手机送达验证](verification/imessage-auto-reconnect-2026-09-19.md)
- [Markdown 消息卡与左右布局验证](verification/message-markdown-2026-09-19.md)
- [构建记录](verification/build-phase3-2026-09-18.log)

项目采用 MIT 许可证。嵌入式 Node 与 npm 依赖保留各自许可证；MarkdownUI、NetworkImage 和 swift-cmark 的许可证随原生资源包分发。
