import AppKit

struct Agent: Identifiable {
    let id: String
    let name: String
    let bundleID: String?
    let symbol: String
    let comingSoon: Bool
    static let all = [
        Agent(id: "codex", name: "Codex", bundleID: "com.openai.codex", symbol: "command", comingSoon: false),
        Agent(id: "claude", name: "Claude", bundleID: "com.anthropic.claudefordesktop", symbol: "asterisk", comingSoon: false),
        Agent(id: "pi", name: "Pi", bundleID: nil, symbol: "pi", comingSoon: false),
        Agent(id: "hermes", name: "Hermes Agent", bundleID: nil, symbol: "paperplane", comingSoon: false)
    ]
    static func find(_ id: String) -> Agent { all.first { $0.id == id } ?? all[0] }
    var applicationURL: URL? { bundleID.flatMap { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) } }
    static let resourceBundle: Bundle = {
        if let url = Bundle.main.url(forResource: "ChatBridge_ChatBridge", withExtension: "bundle"),
           let bundle = Bundle(url: url) { return bundle }
        return .module
    }()
    func icon(dark: Bool) -> NSImage {
        let variant = dark ? "dark" : "light"
        if let url = Self.resourceBundle.url(forResource: id + "-" + variant, withExtension: "png", subdirectory: "AgentIcons"),
           let image = NSImage(contentsOf: url) {
            image.size = NSSize(width: 18, height: 18)
            image.accessibilityDescription = name
            return image
        }
        return NSImage(systemSymbolName: symbol, accessibilityDescription: name) ?? NSImage()
    }
}

struct Preferences: Decodable {
    var defaultAgent = "codex"
    var pinned = ["codex", "claude", "pi"]
    var keepAlive = false
    var names: [String: String] = [:]
    /// Agents the phone channel may use. The Mac app can still open any of them.
    var enabledAgents = Agent.all.map(\.id)
    private enum CodingKeys: String, CodingKey { case defaultAgent, pinned, keepAlive, names, enabledAgents }
    init() {}
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        defaultAgent = try values.decode(String.self, forKey: .defaultAgent)
        pinned = try values.decode([String].self, forKey: .pinned)
        keepAlive = try values.decode(Bool.self, forKey: .keepAlive)
        names = try values.decode([String: String].self, forKey: .names)
        enabledAgents = try values.decodeIfPresent([String].self, forKey: .enabledAgents) ?? Agent.all.map(\.id)
    }
}
struct Selection: Decodable {
    var agent = "codex"
    var mode = "code"
    var version: Int?
    var projectId: String?
    var sessionId: String?
}
struct SessionSummary: Decodable, Identifiable {
    var id: String
    var shortId: String
    var title: String
    var agent: String
    var mode: String
    var projectId: String?
    var cwd: String?
}
struct ProjectSummary: Decodable, Identifiable {
    var id: String
    var shortId: String
    var name: String
    var roots: [String]
    var agent: String
}
struct SessionCatalog: Decodable {
    var projects: [ProjectSummary]
    var sessions: [SessionSummary]
    var nextOffset: Int?
}
struct Message: Decodable, Identifiable {
    var id: String
    var sessionId: String
    var role: String
    var text: String
    var truncated: Bool?
    var replyTo: ReplyQuote?
    var attachments: [MessageAttachment]?
    var source: String?
}
enum MessageSource {
    private static var cache: [String: NSImage] = [:]
    static func name(_ source: String?) -> String {
        switch source {
        case "weixin": return "微信"
        case "desktop": return "这台 Mac"
        default: return "你"
        }
    }
    /// The logo of the app the message came from, read from the installed app so no third-party artwork ships with Chat Bridge.
    static func icon(_ source: String?) -> NSImage? {
        guard let source else { return nil }
        if let cached = cache[source] { return cached }
        let image: NSImage?
        switch source {
        case "weixin": image = appIcon("com.tencent.xinWeChat")
        // A message typed on this Mac: the system computer symbol, as a peer of the phone channels.
        case "desktop": image = NSImage(systemSymbolName: "laptopcomputer", accessibilityDescription: "这台 Mac")
        default: image = nil
        }
        if let image { cache[source] = image }
        return image
    }
    private static func appIcon(_ bundleId: String) -> NSImage? {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { return nil }
        return NSWorkspace.shared.icon(forFile: url.path)
    }
}
struct ReplyQuote: Decodable {
    var id: String
    var text: String
}
struct MessageAttachment: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var path: String
    var size: Int
    var url: URL { URL(fileURLWithPath: path) }
}
struct JobOrigin: Decodable {
    var kind: String
}
struct JobSummary: Decodable, Identifiable {
    var id: String
    var text: String
    var origin: JobOrigin?
    var status: String
    var error: String?
    var target: Selection
    var sessionId: String?
    var externalControl: Bool?
    var routeMessage: String?
    var canContinue: Bool { ["waiting_agent", "awaiting_confirmation"].contains(status) }
    var canCancel: Bool { ["accepted", "preparing", "waiting_agent", "awaiting_confirmation"].contains(status) }
    var canStop: Bool { externalControl != true && ["dispatching", "running", "awaiting_approval"].contains(status) }
    var statusLabel: String {
        switch status {
        case "queued": return "已加入原会话队列，等待执行"
        case "running", "dispatching": return Agent.find(target.agent).name + " 正在执行…"
        case "awaiting_approval": return "等待你的单次确认"
        case "stopping": return "正在请求停止…"
        case "interrupted": return "任务已停止"
        case "completed": return "已完成"
        case "cancelled": return "已取消，任务未发送"
        case "failed": return "执行失败"
        case "uncertain": return "执行结果待确认"
        default: return "任务已接收，等待执行。"
        }
    }
}
struct ConnectorProviderState: Decodable {
    var configured = false
    var status = "unconfigured"
    var message: String?
}
struct ConnectorStateSummary: Decodable {
    var provider = ConnectorProviderState()
    var connectedCount = 0
    var attentionCount = 0
    var availableByAgent: [String: Int] = [:]
    var toolExecutionEnabled = false
}
struct ConnectorDefinition: Decodable, Identifiable, Hashable {
    var id: String
    var slug: String
    var name: String
    var description: String
    var category: String
    var authSchemes: [String]
}
struct ConnectorPolicy: Codable, Equatable {
    var accountId: String
    var allowedAgents: [String]
    var mode: String
}
struct ConnectedConnectorAccount: Decodable, Identifiable, Equatable {
    var id: String
    var connectorId: String
    var connectorSlug: String
    var connectorName: String
    var label: String?
    var status: String
    var createdAt: String?
    var lastUsedAt: String?
    var policy: ConnectorPolicy
}
struct ConnectorCatalogPage: Decodable {
    var items: [ConnectorDefinition]
    var nextCursor: String?
}
struct ConnectorLink: Decodable {
    var attemptId: String
    var redirectURL: URL
    var expiresAt: String
}

struct ApprovalSummary: Decodable, Identifiable {
    var id: String
    var jobId: String
    var kind: String
    var detail: String
    var reason: String
    var cwd: String
    var status: String
    var expiresAt: String
}
struct WeixinState: Decodable {
    var status = "idle"
    var bound = false
    var connected = false
    var attemptId: String?
    var qrContent: String?
    var ownerId: String?
    var accountId: String?
    var message: String?
    var statusLabel: String {
        if connected { return "已连接" }
        switch status {
        case "loading": return "正在获取二维码"
        case "wait": return "等待扫码"
        case "scaned": return "已扫码"
        case "need_verifycode": return "需要验证码"
        case "awaiting_confirmation": return "待本机确认"
        case "connecting", "connected": return "连接中"
        case "expired": return "已过期"
        case "error": return "连接异常"
        default: return "未连接"
        }
    }
}
struct ChannelStates: Decodable {
    var weixin: WeixinState
    var connected: Bool { weixin.connected }
}
struct DeliverySummary: Decodable, Identifiable {
    var id: String
    var jobId: String?
    var status: String
    var kind: String?
    var error: String?
}
struct BridgeState: Decodable {
    var preferences = Preferences()
    var selection = Selection()
    var sessions: [SessionSummary] = []
    var projects: [ProjectSummary]?
    var messages: [Message] = []
    var jobs: [JobSummary] = []
    var historyPartial = true
    var channels: ChannelStates?
    var deliveries: [DeliverySummary]?
    var approvals: [ApprovalSummary]?
    var probes: [String: AgentProbe]?
    var connectors: ConnectorStateSummary?
}
struct AgentSurface: Decodable, Identifiable {
    var kind: String
    var installed: Bool?
    var version: String?
    var executablePath: String?
    var candidates: [String]?
    var auth: String?
    var reason: String?
    var id: String { kind }
    var name: String { kind == "desktop" ? "桌面端" : "CLI" }
    var isInstalled: Bool { installed == true }
}
struct AgentProbe: Decodable {
    var installed = false
    var version: String?
    var ready = false
    var reason = "桌面会话接入尚未验证"
    var status: String?
    var executionError: String?
    var desktopInstalled: Bool?
    var surfaces: [AgentSurface]?
    var isAvailable: Bool { ready && executionError == nil }
    /// Short, non-technical wording for the agent card: "桌面端 + CLI" / "仅 CLI".
    var surfaceShort: String? {
        guard let surfaces, !surfaces.isEmpty else { return nil }
        let installed = surfaces.filter(\.isInstalled)
        guard !installed.isEmpty else { return nil }
        if surfaces.count == 1 { return surfaces[0].name == "CLI" ? "仅 CLI" : "仅" + surfaces[0].name }
        if installed.count == surfaces.count { return surfaces.map(\.name).joined(separator: " + ") }
        let only = installed.map(\.name).joined(separator: " + ")
        return only.contains("CLI") ? "仅 " + only : "仅" + only
    }
    var statusLabel: String {
        if ready && executionError != nil { return "执行异常" }
        if ready { return "可用" }
        switch status {
        case "checking", nil: return "检测中"
        case "missing": return "未安装"
        case "needs_login": return "待登录"
        default: return "连接异常"
        }
    }
}

enum NativeAgentHost {
    // Installation metadata is not proof that this process can control a desktop session.
    // Codex is the only agent with two supported surfaces: the desktop app and the CLI share
    // one session store and one app-server protocol. The others are CLI-only.
    static func probe(_ agent: Agent) -> [String: Any] {
        let bundle = agent.applicationURL.flatMap(Bundle.init(url:))
        let appVersion = bundle?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let desktopInstalled = bundle != nil
        var surfaces: [[String: Any]] = []
        var primaryPath: String?

        if agent.id == "codex" {
            var desktop: [String] = []
            if let bundle {
                let root = bundle.bundleURL
                desktop = [
                    root.appendingPathComponent("Contents/Resources/codex-cli/bin/codex").path,
                    root.appendingPathComponent("Contents/Resources/codex").path,
                    root.appendingPathComponent("Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex").path
                ]
            }
            let desktopPath = firstExecutable(desktop)
            let cli = executableCandidates(named: "codex")
            let cliPath = firstExecutable(cli)
            surfaces = [
                surface("desktop", installed: desktopPath != nil, version: appVersion,
                        executablePath: desktopPath, candidates: desktop),
                surface("cli", installed: cliPath != nil, executablePath: cliPath, candidates: cli)
            ]
            primaryPath = desktopPath ?? cliPath
        } else {
            var candidates = executableCandidates(named: agent.id == "cursor" ? "cursor-agent" : agent.id)
            if agent.id == "grok" { candidates.insert(NSHomeDirectory() + "/.grok/bin/grok", at: 0) }
            if agent.id == "opencode" { candidates.insert(NSHomeDirectory() + "/.opencode/bin/opencode", at: 0) }
            if agent.id == "hermes" { candidates.append(NSHomeDirectory() + "/.hermes/hermes-agent/venv/bin/hermes") }
            // Desktop installs a private Claude Code engine. Treat it as a CLI fallback, not as
            // proof that desktop sessions can be controlled.
            if agent.id == "claude" { candidates.append(contentsOf: claudeBundledEngines()) }
            let path = firstExecutable(candidates)
            primaryPath = path
            surfaces = [surface("cli", installed: path != nil, executablePath: path, candidates: candidates)]
        }

        let installed = surfaces.contains { $0["installed"] as? Bool == true }
        let reason: String
        if installed {
            reason = "已检测到运行时，正在检查登录状态。"
        } else if agent.id == "codex" && desktopInstalled {
            reason = "已检测到 Codex 桌面端，但未找到可用的内置运行时。请更新或重装 Codex 后重试。"
        } else if agent.id == "claude" && desktopInstalled {
            reason = "已检测到 Claude 桌面端，但缺少 Claude Code CLI。请安装命令行程序，安装后会自动检测。"
        } else if agent.id == "claude" {
            reason = "请先安装 Claude Code 命令行程序，安装后会自动检测。"
        } else {
            reason = "请先安装 " + (agent.id == "hermes" ? "Hermes Agent" : agent.name) + "，安装后会自动检测。"
        }

        var result: [String: Any] = [
            "installed": installed, "ready": false, "version": appVersion,
            "reason": reason, "desktopInstalled": desktopInstalled, "surfaces": surfaces,
            "capabilities": [
                "canListProjects": false, "canListSessions": false, "canCreateProjectless": false,
                "canResumeExactSession": false, "canReadHistory": false, "canSend": false,
                "canObserveCompletion": false, "canCancel": false, "canRelayApproval": false,
                "worksWhileLocked": false
            ]
        ]
        if let primaryPath { result["executablePath"] = primaryPath }
        return result
    }

    private static func surface(_ kind: String, installed: Bool, version: String? = nil,
                                executablePath: String?, candidates: [String]) -> [String: Any] {
        var value: [String: Any] = ["kind": kind, "installed": installed, "candidates": candidates]
        if let version, !version.isEmpty { value["version"] = version }
        if let executablePath { value["executablePath"] = executablePath }
        return value
    }

    private static func executableCandidates(named name: String) -> [String] {
        var directories = [
            NSHomeDirectory() + "/.local/bin", NSHomeDirectory() + "/.npm-global/bin",
            NSHomeDirectory() + "/.bun/bin", NSHomeDirectory() + "/.volta/bin",
            NSHomeDirectory() + "/bin", "/opt/homebrew/bin", "/usr/local/bin"
        ]
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            directories.append(contentsOf: path.split(separator: ":").map(String.init))
        }
        var seen = Set<String>()
        return directories.filter { seen.insert($0).inserted }.map { $0 + "/" + name }
    }

    private static func claudeBundledEngines() -> [String] {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        guard let root = support?.appendingPathComponent("Claude/claude-code") else { return [] }
        let versions = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        return versions.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
            .map { root.appendingPathComponent($0).appendingPathComponent("claude.app/Contents/MacOS/claude").path }
    }

    private static func firstExecutable(_ candidates: [String]) -> String? {
        candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }
}
