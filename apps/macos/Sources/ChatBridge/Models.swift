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
        Agent(id: "cursor", name: "Cursor", bundleID: "com.todesktop.230313mzl4w4u92", symbol: "cursorarrow", comingSoon: false),
        Agent(id: "grok", name: "Grok", bundleID: nil, symbol: "sparkle", comingSoon: false),
        Agent(id: "opencode", name: "OpenCode", bundleID: nil, symbol: "chevron.left.forwardslash.chevron.right", comingSoon: false),
        Agent(id: "hermes", name: "Hermes Agent", bundleID: nil, symbol: "paperplane", comingSoon: false)
    ]
    static func find(_ id: String) -> Agent { all.first { $0.id == id } ?? all[0] }
    var applicationURL: URL? { bundleID.flatMap { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) } }
    private static let iconBundle: Bundle = {
        if let url = Bundle.main.url(forResource: "ChatBridge_ChatBridge", withExtension: "bundle"),
           let bundle = Bundle(url: url) { return bundle }
        return .module
    }()
    func icon(dark: Bool) -> NSImage {
        let variant = dark ? "dark" : "light"
        if let url = Self.iconBundle.url(forResource: id + "-" + variant, withExtension: "png", subdirectory: "AgentIcons"),
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
    var pinned = ["codex", "claude", "cursor"]
    var keepAlive = false
    var names: [String: String] = [:]
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
}
struct JobSummary: Decodable, Identifiable {
    var id: String
    var text: String
    var status: String
    var error: String?
    var target: Selection
    var sessionId: String?
    var externalControl: Bool?
    var routing: RoutePendingSummary?
    var routeMessage: String?
    var canContinue: Bool { ["waiting_agent", "awaiting_confirmation", "awaiting_route"].contains(status) }
    var canCancel: Bool { ["accepted", "preparing", "waiting_agent", "awaiting_confirmation", "routing", "awaiting_route"].contains(status) }
    var canStop: Bool { externalControl != true && ["dispatching", "running", "awaiting_approval"].contains(status) }
    var statusLabel: String {
        switch status {
        case "routing": return "正在判断 Agent、项目和会话…"
        case "awaiting_route": return "等待选择目标，任务尚未发送"
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
struct RouteOptionSummary: Decodable, Identifiable {
    var id: String
    var label: String
}
struct RoutePendingSummary: Decodable {
    var options: [RouteOptionSummary]?
}
struct RoutingState: Decodable {
    var provider: String?
    var mode = "off"
    var planning = "claude"
    var implementation = "cursor"
    var research = "default"
    var configured = false
    var expired = false
    var verifiedAt: String?
    var trialEndsAt: String?
}

struct RoutingProvider: Identifiable {
    let id: String
    let name: String
    let keyURL: URL
    let infoURL: URL
    let note: String
    let recipients: String
    static let all = [
        Self(id: "vercel", name: "Vercel", keyURL: URL(string: "https://vercel.com/ai-gateway")!,
             infoURL: URL(string: "https://vercel.com/ai-gateway/models/jev")!,
             note: "Jev 限时免费，可能需要验证付款方式。此入口于 9 月 25 日暂停。", recipients: "Vercel／TypeSafe"),
        Self(id: "openrouter", name: "OpenRouter", keyURL: URL(string: "https://openrouter.ai/settings/keys")!,
             infoURL: URL(string: "https://openrouter.ai/typesafe/jev-1.13")!,
             note: "Jev 按量计费。保存并验证也会调用一次模型，请先确认账户额度。", recipients: "OpenRouter／TypeSafe")
    ]
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
struct IMessageState: Decodable {
    var status = "idle"
    var bound = false
    var connected = false
    var email: String?
    var phone: String?
    var message: String?
    var statusLabel: String {
        if connected { return "已连接" }
        switch status {
        case "preparing": return "检查权限"
        case "dispatching_verification": return "正在发送配对请求"
        case "awaiting_phone": return "等待手机回复 OK"
        case "connecting", "connected": return "连接中"
        case "error": return "需要检查"
        default: return "未连接"
        }
    }
}
struct ChannelStates: Decodable {
    var weixin: WeixinState
    var imessage: IMessageState?
    var connected: Bool { weixin.connected || imessage?.connected == true }
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
    var routing: RoutingState?
}
struct AgentProbe: Decodable {
    var installed = false
    var version: String?
    var ready = false
    var reason = "桌面会话接入尚未验证"
    var status: String?
    var executionError: String?
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
    static func probe(_ agent: Agent) -> [String: Any] {
        let bundle = agent.applicationURL.flatMap(Bundle.init(url:))
        var result: [String: Any] = [
            "installed": bundle != nil, "ready": false,
            "version": bundle?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
            "reason": bundle == nil ? "未检测到桌面应用" : "桌面会话接入尚未验证",
            "capabilities": [
                "canListProjects": false, "canListSessions": false, "canCreateProjectless": false,
                "canResumeExactSession": false, "canReadHistory": false, "canSend": false,
                "canObserveCompletion": false, "canCancel": false, "canRelayApproval": false,
                "worksWhileLocked": false
            ]
        ]
        let name = agent.id == "cursor" ? "cursor-agent" : agent.id
        var candidates = [NSHomeDirectory() + "/.local/bin/" + name, "/opt/homebrew/bin/" + name, "/usr/local/bin/" + name]
        if agent.id == "codex", let url = bundle?.bundleURL.appendingPathComponent("Contents/Resources/codex") {
            candidates.insert(url.path, at: 0)
        }
        if agent.id == "grok" { candidates.insert(NSHomeDirectory() + "/.grok/bin/grok", at: 0) }
        if agent.id == "opencode" { candidates.insert(NSHomeDirectory() + "/.opencode/bin/opencode", at: 0) }
        if agent.id == "hermes" { candidates.append(NSHomeDirectory() + "/.hermes/hermes-agent/venv/bin/hermes") }
        let path = candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
        result["installed"] = path != nil
        if let path { result["executablePath"] = path }
        return result
    }
}
