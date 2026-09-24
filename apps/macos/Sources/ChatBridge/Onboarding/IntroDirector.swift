import SwiftUI

/// One message in the simulated Chat Bridge window or menu bar panel.
struct IntroMessage: Identifiable {
    enum Kind { case user(source: String), agent(String) }
    struct Block: Identifiable {
        enum Kind { case paragraph, item(Int), code, file(size: String) }
        let id = UUID()
        var kind: Kind
        var segments: [(text: String, bold: Bool)]
        var text: String { segments.map(\.text).joined() }
    }
    let id = UUID()
    var kind: Kind
    var text = ""
    var quote: String?
    var status: String?
    var working = false
    var blocks: [Block] = []
}

/// One bubble in the simulated iMessage or WeChat conversation.
struct PhoneMessage: Identifiable {
    let id = UUID()
    var outgoing: Bool
    var text: String
    var stamp: String?
}

struct PhoneState {
    enum App { case home, messages, wechat }
    var app: App = .home
    var launched = false
    var chatOpen = false
    var rowPressed = false
    var keyboard = false
    var typed = ""
    var marked = ""
    var candidates: [String] = []
    var pressed: String?
    var returnKey = "换行"
    var returnActive = false
    var messages: [PhoneMessage] = [PhoneMessage(outgoing: false, text: "你好，我在 Mac 上待命。直接说你要做什么。", stamp: "昨天 22:10")]
    var wechat: [PhoneMessage] = [PhoneMessage(outgoing: false, text: "你好，我在 Mac 上待命。直接说你要做什么。", stamp: "昨天 22:10")]
    var touch = CGPoint.zero
    var touches = 0
}

/// Screen facts the intro needs to line its simulated desktop up with the real one.
struct IntroLayout {
    var size: CGSize
    var menuBar: CGFloat
    var notch: ClosedRange<CGFloat>?
    var statusItem: CGPoint
    var window: CGRect {
        let width = min(1000, size.width * 0.66), height = min(700, (size.height - menuBar) * 0.74)
        return CGRect(x: size.width - width - 70, y: menuBar + (size.height - menuBar - height) / 2, width: width, height: height)
    }
    var panel: CGRect {
        let height = min(566, (size.height - menuBar) * 0.62)
        return CGRect(x: statusItem.x + 14 - 340, y: menuBar + 9, width: 340, height: height)
    }
}

/// Plays the intro: the icon loads over the dimmed desktop and flies to the menu bar; the camera pulls back to a
/// phone in hand, which sends from Messages and WeChat while the Mac mirrors every step; then back on the Mac,
/// the window folds into the menu bar and a message goes out from the panel.
@MainActor
final class IntroDirector: ObservableObject {
    let layout: IntroLayout
    // Act one
    @Published var scrim = 0.0
    @Published var tileLoad = 0.0
    @Published var mascotLoad = 0.0
    @Published var eyes: CGFloat = 0
    @Published var titleShown = false
    @Published var flewHome = false
    @Published var tileHidden = false
    // The scene
    @Published var cam = 0.0
    @Published var scene = 1.0
    // The Mac
    @Published var windowOpen = false
    @Published var windowFolded = false
    @Published var selected = "codex"
    @Published var subtitle = "你好"
    @Published var conversations: [String: [IntroMessage]] = [:]
    @Published var previews: [String: String] = [
        "codex": "你好，我在。有什么需要我帮忙的吗？", "claude": "继续你的本地会话", "cursor": "账号未付费，暂不能调用。",
        "grok": "没有在这台 Mac 上找到 Grok。", "opencode": "继续你的本地会话", "hermes": "未配置 API Key，配好后会自动检测。"]
    @Published var busy: Set<String> = []
    @Published var iconDot = false
    @Published var iconActive = false
    @Published var panelOpen = false
    @Published var panel: [IntroMessage] = []
    @Published var panelTyped = ""
    @Published var panelFocused = false
    @Published var cursor = CGPoint.zero
    @Published var cursorShown = false
    @Published var cursorDown = false
    // The phone
    @Published var phone = PhoneState()

    init(layout: IntroLayout) {
        self.layout = layout
        conversations = ["codex": [
            IntroMessage(kind: .user(source: "desktop"), text: "你好"),
            IntroMessage(kind: .agent("codex"), quote: "你好", blocks: [.init(kind: .paragraph, segments: [("你好，我在。有什么需要我帮忙的吗？", false)])])
        ], "claude": []]
        cursor = CGPoint(x: layout.size.width * 0.55, y: layout.size.height * 0.62)
    }

    /// Runs to the end or until cancelled; either way the caller moves on to setup.
    func play() async {
        do { try await timeline() } catch {}
    }

    private func pause(_ seconds: Double) async throws { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
    private func animate(_ animation: Animation, then seconds: Double = 0, _ change: () -> Void) async throws {
        withAnimation(animation, change)
        if seconds > 0 { try await pause(seconds) }
    }

    private func timeline() async throws {
        // 1 — the desktop dims and the icon comes into focus, the mascot settling last; it opens its eyes and blinks.
        try await animate(.easeOut(duration: 1.0), then: 0.45) { scrim = 1 }
        withAnimation(.easeOut(duration: 1.5)) { tileLoad = 1 }
        try await animate(.easeOut(duration: 1.1).delay(0.45), then: 1.65) { mascotLoad = 1 }
        try await animate(.spring(response: 0.34, dampingFraction: 0.55), then: 0.35) { eyes = 1 }
        titleShown = true
        try await pause(0.65)
        try await animate(.linear(duration: 0.09), then: 0.09) { eyes = 0.07 }
        try await animate(.easeOut(duration: 0.16), then: 1.2) { eyes = 1 }
        // 2 — it flies home to the menu bar; the desktop comes back and Chat Bridge's window opens.
        titleShown = false
        withAnimation(.easeInOut(duration: 0.9).delay(0.2)) { scrim = 0 }
        try await animate(.timingCurve(0.6, 0, 0.2, 1, duration: 0.95), then: 0.75) { flewHome = true }
        try await animate(.easeIn(duration: 0.2), then: 0.35) { tileHidden = true }
        try await animate(.spring(response: 0.45, dampingFraction: 0.8), then: 1.0) { windowOpen = true }
        // 3 — the camera pulls back: the Mac is on the desk, and your phone is in your hand.
        try await animate(.timingCurve(0.65, 0, 0.35, 1, duration: 1.8), then: 2.15) { cam = 1 }
        try await animate(.timingCurve(0.65, 0, 0.35, 1, duration: 1.3), then: 1.6) { cam = 2 }
        // 4 — Messages → Claude; the Mac takes it at once, and the result lands in both places.
        try await openApp(.messages)
        try await openChat()
        try await focusField(returnKey: "换行")
        let webApp = "用 Claude 新建一个 WebApp 项目，做个旅行清单网页。"
        try await type(webApp)
        try await pause(0.25)
        try await tap(CGPoint(x: 366, y: 490))
        send(stamp: "iMessage · 今天 21:12")
        try await pause(0.35)
        select("claude", subtitle: webApp)
        append(IntroMessage(kind: .user(source: "imessage"), text: webApp), to: "claude")
        setPreview("claude", "正在创建项目…", busy: true)
        try await pause(0.55)
        append(IntroMessage(kind: .agent("claude"), quote: webApp, status: "正在创建项目…", working: true), to: "claude")
        try await pause(0.35)
        receive("Claude › 新会话\n已收到✅")
        try await pause(0.9)
        try await stream(into: "claude", [
            .init(kind: .paragraph, segments: [("已创建 ", false), ("travel-checklist", true), ("，用 Vite + React 初始化：", false)]),
            .init(kind: .code, segments: [("~/Documents/GitHub/travel-checklist", false)]),
            .init(kind: .paragraph, segments: [("首页和清单页已经写好，开发服务器在跑：", false)]),
            .init(kind: .code, segments: [("http://localhost:5173", false)])
        ])
        setPreview("claude", "已创建 travel-checklist，开发服务器在跑")
        try await pause(0.25)
        receive("已创建 travel-checklist，用 Vite + React 初始化。开发服务器在跑：localhost:5173")
        try await pause(1.3)
        // 5 — home, then WeChat → Codex: a deep research that keeps going as the camera heads back to the Mac.
        try await goHome()
        try await openApp(.wechat)
        try await openChat()
        try await focusField(returnKey: "发送")
        let research = "用 Codex 做个 Deep Research：2026 年的 AI 浏览器，首次引导都是怎么设计的？"
        try await type(research)
        try await pause(0.25)
        phone.pressed = "return"
        try await tap(CGPoint(x: 346, y: 747))
        phone.pressed = nil
        send(stamp: "21:13")
        try await pause(0.35)
        select("codex", subtitle: research)
        append(IntroMessage(kind: .user(source: "weixin"), text: research), to: "codex")
        setPreview("codex", "正在调研…", busy: true)
        try await pause(0.55)
        append(IntroMessage(kind: .agent("codex"), quote: research, status: "正在调研 · 已阅读 3 个来源", working: true), to: "codex")
        try await pause(0.35)
        receive("Codex › 新会话\n已收到✅")
        iconDot = true
        let findings = Task { @MainActor in
            for count in 4...23 {
                try await pause(0.11)
                updateLast(in: "codex") { $0.status = "正在调研 · 已阅读 \(count) 个来源" }
            }
            updateLast(in: "codex") { $0.status = "已参考 23 个来源"; $0.working = false }
            try await stream(into: "codex", [
                .init(kind: .paragraph, segments: [("调研完成。几款产品的共同做法：", false)]),
                .init(kind: .item(1), segments: [("开场直接叠在桌面上", false)]),
                .init(kind: .item(2), segments: [("先演示一句话能做什么", false)]),
                .init(kind: .item(3), segments: [("设置不超过五步，都能跳过", false)]),
                .init(kind: .file(size: "18 KB"), segments: [("ai-browser-onboarding.md", false)])
            ], keepStatus: true)
            setPreview("codex", "调研完成，附 ai-browser-onboarding.md")
        }
        defer { findings.cancel() }
        try await pause(1.4)
        // 6 — back into the Mac.
        try await animate(.timingCurve(0.65, 0, 0.35, 1, duration: 1.0), then: 1.15) { cam = 1 }
        try await animate(.timingCurve(0.65, 0, 0.35, 1, duration: 1.7), then: 1.75) { cam = 0 }
        _ = try await findings.value
        try await pause(0.9)
        // 7 — fold the window into the menu bar, then open the conversation from the icon at the top right.
        let window = layout.window
        try await animate(.easeOut(duration: 0.25), then: 0.25) { cursorShown = true }
        try await moveCursor(to: CGPoint(x: window.maxX - 42, y: window.minY + 38), duration: 0.8)
        try await click()
        try await animate(.timingCurve(0.55, 0, 0.25, 1, duration: 0.48), then: 0.55) { windowFolded = true }
        try await moveCursor(to: CGPoint(x: layout.statusItem.x + 2, y: layout.statusItem.y + 1), duration: 0.65)
        try await click()
        iconActive = true; iconDot = false
        panel = conversations["codex"] ?? []
        try await animate(.spring(response: 0.32, dampingFraction: 0.86), then: 0.7) { panelOpen = true }
        // 8 — and send the next step from the Mac itself.
        let panelBox = layout.panel
        try await moveCursor(to: CGPoint(x: panelBox.minX + 110, y: panelBox.maxY - 70), duration: 0.7)
        try await click()
        panelFocused = true
        try await animate(.easeOut(duration: 0.3)) { cursorShown = false }
        let followUp = "把结论整理成一页摘要，发回微信"
        for character in followUp {
            panelTyped.append(character)
            try await pause(0.055 + Double.random(in: 0...0.04))
        }
        try await pause(0.35)
        panelTyped = ""; panelFocused = false
        withAnimation(.spring(response: 0.42, dampingFraction: 0.85)) {
            panel.append(IntroMessage(kind: .user(source: "desktop"), text: followUp))
        }
        try await pause(0.6)
        withAnimation(.spring(response: 0.42, dampingFraction: 0.85)) {
            panel.append(IntroMessage(kind: .agent("codex"), quote: followUp, status: "正在整理…", working: true))
        }
        try await pause(1.1)
        panel[panel.count - 1].status = nil; panel[panel.count - 1].working = false
        try await streamPanel([
            .init(kind: .paragraph, segments: [("已整理成一页摘要，也发回了微信：", false)]),
            .init(kind: .file(size: "6 KB"), segments: [("onboarding-summary.md", false)])
        ])
        try await pause(1.7)
        // 9 — the panel folds away and the simulated desktop gives way to the real one.
        try await animate(.easeIn(duration: 0.28), then: 0.3) { panelOpen = false; iconActive = false }
        try await animate(.easeInOut(duration: 0.6), then: 0.6) { scene = 0 }
    }

    // MARK: The phone

    private func tap(_ point: CGPoint) async throws {
        phone.touch = point; phone.touches += 1
        try await pause(0.17)
    }
    private func openApp(_ app: PhoneState.App) async throws {
        try await tap(app == .messages ? PhoneLayout.messagesIcon : PhoneLayout.wechatIcon)
        phone.app = app; phone.launched = false; phone.chatOpen = false
        try await pause(0.02)
        try await animate(.spring(response: 0.5, dampingFraction: 0.86), then: 0.95) { phone.launched = true }
    }
    private func openChat() async throws {
        try await tap(CGPoint(x: 220, y: phone.app == .messages ? 228 : 184))
        phone.rowPressed = true
        try await pause(0.14)
        try await animate(.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.38), then: 0.42) { phone.chatOpen = true }
        phone.rowPressed = false
        try await pause(0.3)
    }
    private func focusField(returnKey: String) async throws {
        try await tap(CGPoint(x: 200, y: 790))
        phone.returnKey = returnKey; phone.returnActive = false
        try await animate(.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.35), then: 0.45) { phone.keyboard = true }
    }
    private func goHome() async throws {
        try await animate(.easeOut(duration: 0.3), then: 0.3) { phone.keyboard = false }
        try await animate(.timingCurve(0.4, 0, 0.2, 1, duration: 0.42), then: 0.45) { phone.launched = false }
        phone.app = .home
        try await pause(0.3)
    }
    /// Types on the pinyin keyboard: letters press their own key, each Chinese character a couple of keys
    /// with the pinyin marked in the field before the first candidate commits it.
    private func type(_ text: String) async throws {
        let letters = Array("qwertyuiopasdfghjklzxcvbnm")
        let common = Array("的一是在了有和人这中大为上个们来说到时要就出会可也你对生能而子那得于着下自之")
        for character in text {
            if character.isASCII && character.isLetter {
                phone.pressed = character.lowercased(); phone.typed.append(character); phone.candidates = []
                try await pause(0.09); phone.pressed = nil
                try await pause(Double.random(in: 0...0.04))
            } else if character == " " {
                phone.pressed = " "; phone.typed.append(character)
                try await pause(0.07); phone.pressed = nil
            } else if let scalar = character.unicodeScalars.first, (0x4E00...0x9FFF).contains(scalar.value) {
                for _ in 0..<2 {
                    let key = String(letters.randomElement()!)
                    phone.pressed = key; phone.marked += key
                    phone.candidates = [String(character)] + (0..<3).map { _ in String(common.randomElement()!) }
                    try await pause(0.05); phone.pressed = nil
                    try await pause(0.03)
                }
                phone.marked = ""; phone.typed.append(character)
                try await pause(0.04)
            } else {
                phone.typed.append(character); phone.candidates = []
                try await pause(0.09)
            }
            phone.returnActive = phone.returnKey == "发送"
        }
        phone.candidates = []
    }
    private func send(stamp: String) {
        let text = phone.typed
        phone.typed = ""; phone.returnActive = false
        withAnimation(.spring(response: 0.42, dampingFraction: 0.85)) {
            if phone.app == .wechat { phone.wechat.append(PhoneMessage(outgoing: true, text: text, stamp: stamp)) }
            else { phone.messages.append(PhoneMessage(outgoing: true, text: text, stamp: stamp)) }
        }
    }
    private func receive(_ text: String) {
        withAnimation(.spring(response: 0.42, dampingFraction: 0.85)) {
            if phone.app == .wechat { phone.wechat.append(PhoneMessage(outgoing: false, text: text)) }
            else { phone.messages.append(PhoneMessage(outgoing: false, text: text)) }
        }
    }

    // MARK: The Mac

    private func select(_ agent: String, subtitle: String) {
        withAnimation(.easeOut(duration: 0.25)) { selected = agent; self.subtitle = subtitle }
    }
    private func setPreview(_ agent: String, _ text: String, busy isBusy: Bool = false) {
        previews[agent] = text
        if isBusy { busy.insert(agent) } else { busy.remove(agent) }
    }
    private func append(_ message: IntroMessage, to agent: String) {
        withAnimation(.spring(response: 0.42, dampingFraction: 0.85)) { conversations[agent, default: []].append(message) }
    }
    private func updateLast(in agent: String, _ change: (inout IntroMessage) -> Void) {
        guard var list = conversations[agent], !list.isEmpty else { return }
        change(&list[list.count - 1]); conversations[agent] = list
    }
    /// Streams a reply into the agent's latest message: text character by character, code and files whole.
    private func stream(into agent: String, _ blocks: [IntroMessage.Block], keepStatus: Bool = false) async throws {
        if !keepStatus { updateLast(in: agent) { $0.status = nil; $0.working = false } }
        for block in blocks {
            try await reveal(block) { change in updateLast(in: agent) { change(&$0) } }
        }
    }
    private func streamPanel(_ blocks: [IntroMessage.Block]) async throws {
        for block in blocks {
            try await reveal(block) { change in change(&panel[panel.count - 1]) }
        }
    }
    private func reveal(_ block: IntroMessage.Block, _ edit: ((inout IntroMessage) -> Void) -> Void) async throws {
        switch block.kind {
        case .code, .file:
            withAnimation(.easeOut(duration: 0.3)) { edit { $0.blocks.append(block) } }
            try await pause(0.24)
        default:
            var shown = block; shown.segments = block.segments.map { (text: "", bold: $0.bold) }
            edit { $0.blocks.append(shown) }
            for (index, segment) in block.segments.enumerated() {
                for character in segment.text {
                    edit { $0.blocks[$0.blocks.count - 1].segments[index].text.append(character) }
                    try await pause(0.014 + Double.random(in: 0...0.014))
                }
            }
            try await pause(0.09)
        }
    }
    private func moveCursor(to point: CGPoint, duration: Double) async throws {
        try await animate(.timingCurve(0.45, 0, 0.2, 1, duration: duration), then: duration) { cursor = point }
    }
    private func click() async throws {
        withAnimation(.easeOut(duration: 0.08)) { cursorDown = true }
        try await pause(0.1)
        withAnimation(.easeOut(duration: 0.12)) { cursorDown = false }
        try await pause(0.12)
    }
}

/// Where things sit on the simulated iPhone, in its 393 × 852 pt screen.
enum PhoneLayout {
    static let size = CameraRig.phoneSize
    static let keyboard: CGFloat = 336
    static let messagesIcon = CGPoint(x: 243, y: 789)
    static let wechatIcon = CGPoint(x: 335, y: 789)
}
