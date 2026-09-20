// Offline product artwork. Reuses the production SwiftUI views with fictional in-memory state.
// No service is started, no account is read, and no UI action is dispatched.
import AppKit
import SwiftUI

@main @MainActor
struct NativeDemo {
    static func main() throws {
        let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        NSApplication.shared.setActivationPolicy(.prohibited)
        NSApplication.shared.appearance = NSAppearance(named: .aqua)
        let service = BridgeService()
        service.isRunning = true
        service.status = "Local service running"
        service.probes = Dictionary(uniqueKeysWithValues: Agent.all.map {
            ($0.id, AgentProbe(installed: true, ready: ["codex", "claude"].contains($0.id),
                              reason: ["codex", "claude"].contains($0.id) ? "Connected" : "Sign in to connect",
                              status: ["codex", "claude"].contains($0.id) ? "ready" : "needs_login"))
        })
        service.state.preferences.keepAlive = true
        service.state.routing = RoutingState(provider: "openrouter", mode: "auto", implementation: "codex", configured: true)
        service.state.channels = ChannelStates(
            weixin: WeixinState(status: "connected", bound: true, connected: true),
            imessage: IMessageState(status: "connected", bound: true, connected: true,
                                   email: "demo@example.com", phone: "+1 202 555 0146"))
        service.state.projects = [
            ProjectSummary(id: "website", shortId: "P01", name: "Website", roots: ["/Demo/website"], agent: "codex"),
            ProjectSummary(id: "travel", shortId: "P02", name: "Travel", roots: ["/Demo/travel"], agent: "codex")
        ]
        service.state.sessions = [
            SessionSummary(id: "nav", shortId: "S01", title: "Mobile nav", agent: "codex", mode: "code", projectId: "website"),
            SessionSummary(id: "landing", shortId: "S02", title: "Landing page", agent: "codex", mode: "code", projectId: "website"),
            SessionSummary(id: "weekend", shortId: "S03", title: "Weekend plan", agent: "codex", mode: "code", projectId: "travel"),
            SessionSummary(id: "copy", shortId: "S04", title: "Launch copy", agent: "claude", mode: "code")
        ]
        func select(_ agent: String = "codex", session: String? = "nav", project: String? = "website") {
            service.viewedAgent = agent
            service.state.selection = Selection(agent: agent, projectId: project, sessionId: session)
            service.state.messages = []
            service.state.jobs = []
            service.drafts = [:]
        }
        func message(_ role: String, _ value: String) {
            service.state.messages.append(Message(id: UUID().uuidString, sessionId: service.state.selection.sessionId ?? "new",
                                                  role: role, text: value))
        }
        func job(_ status: String) {
            service.state.jobs = [JobSummary(id: "Jdemo", text: "Product demo task", status: status,
                                             target: service.state.selection, sessionId: service.state.selection.sessionId)]
        }
        func main(_ name: String) throws {
            try capture(MainView(service: service, settings: {}), width: 1060, height: 580, to: output.appendingPathComponent(name + ".png"))
        }
        func floating(_ name: String) throws {
            try capture(ChatView(service: service, settings: {}, close: {}), width: 460, height: 565,
                        to: output.appendingPathComponent(name + ".png"))
        }
        select()
        message("user", "Continue Website and check the mobile navigation.")
        message("assistant", "Back in Website · Mobile nav.\n\nDesktop navigation is ready. Let’s finish the mobile layout.")
        try main("overview")
        for (tab, name) in [(0, "agents"), (1, "channels"), (3, "routing"), (2, "general")] {
            try capture(SettingsView(service: service, openAgent: { _ in }, close: {}, tab: tab),
                        width: 760, height: 1100, to: output.appendingPathComponent("settings-" + name + ".png"))
        }
        try capture(SessionBrowser(service: service, close: {}, projects: service.state.projects ?? [],
                                   sessions: service.state.sessions.filter { $0.agent == "codex" }),
                    width: 362, height: 460, to: output.appendingPathComponent("sessions.png"))
        try capture(SessionBrowser(service: service, close: {}, projects: service.state.projects ?? [],
                                   sessions: service.state.sessions.filter { $0.projectId == "website" }, project: "website"),
                    width: 362, height: 460, to: output.appendingPathComponent("project-sessions.png"))
        select("claude", session: nil, project: nil)
        try main("new-session")
        select()
        message("user", "Continue Website and check the mobile navigation.")
        message("assistant", "Back in **Website · Mobile nav**.\n\nDesktop navigation is ready.")
        try floating("menu-ready")
        let menuPrompt = "Add a loading state to the submit button."
        for count in stride(from: 0, through: menuPrompt.count, by: 2) {
            service.drafts[service.draftKey] = String(menuPrompt.prefix(count))
            try floating("menu-draft-\(count)")
        }
        service.drafts = [:]
        message("user", menuPrompt)
        job("running")
        try floating("menu-running")
        service.state.jobs = []
        message("assistant", "Added a loading state and blocked duplicate submissions.\n\n**2 checks passed.**")
        try floating("menu-done")
        select()
        try main("wechat-idle")
        message("user", "Codex, continue Website and fix the mobile navigation.")
        job("routing")
        try main("wechat-routing")
        job("running")
        try main("wechat-running")
        service.state.jobs = []
        message("assistant", "Mobile navigation is fixed.\n\n- Menu opens on small screens\n- Closes after selecting a page\n- **3 checks passed**")
        try main("wechat-done")
        select("claude", session: "copy", project: nil)
        try main("imessage-idle")
        message("user", "Start a Claude chat with no project. Write 3 launch lines.")
        job("routing")
        try main("imessage-routing")
        job("running")
        try main("imessage-running")
        service.state.jobs = []
        message("assistant", "1. Send from your phone. Your Mac gets to work.\n2. Step away. Keep creating.\n3. Take your AI conversations with you.")
        try main("imessage-done")
        select()
        message("user", "Continue that project and summarize the changes.")
        service.state.jobs = [JobSummary(id: "Jdemo", text: "Continue that project and summarize the changes.", status: "awaiting_route",
            error: "I found two possible chats. Choose a target.", target: service.state.selection,
            routing: RoutePendingSummary(options: [RouteOptionSummary(id: "1", label: "Codex · Website · Mobile nav"),
                                                  RouteOptionSummary(id: "2", label: "Claude · No project · Launch copy")]))]
        try main("fallback")
        job("running")
        try main("fallback-running")
        service.state.jobs = []
        message("assistant", "Website changes summarized:\n\n- Submit button loading state\n- Mobile navigation fixes\n\n[Download changelog](https://example.com/changelog.md)")
        try main("final")
        print("Rendered native production views with offline demo fixtures.")
    }

    static func capture<V: View>(_ view: V, width: CGFloat, height: CGFloat, to url: URL) throws {
        let host = NSHostingView(rootView: view.environment(\.colorScheme, .light).environment(\.locale, Locale(identifier: "en")))
        host.frame = NSRect(x: 0, y: 0, width: width, height: height)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.backgroundColor = .clear
        window.isOpaque = false
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.16))
        host.layoutSubtreeIfNeeded()
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(width * 2), pixelsHigh: Int(height * 2),
                                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        rep.size = NSSize(width: width, height: height)
        host.cacheDisplay(in: host.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])!.write(to: url)
        window.close()
    }
}
