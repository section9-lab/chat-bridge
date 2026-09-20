import AppKit
import SwiftUI

struct FrostedBubble: View {
    @Environment(\.colorScheme) private var colorScheme
    var cornerRadius: CGFloat = 22
    var user = false
    var body: some View {
        FrostedMaterial(cornerRadius: cornerRadius)
            .overlay(RoundedRectangle(cornerRadius: cornerRadius)
                .fill(user ? Color(white: colorScheme == .dark ? 0.25 : 0.88).opacity(0.94)
                           : .white.opacity(colorScheme == .dark ? 0.08 : 0.88)))
            .overlay(RoundedRectangle(cornerRadius: cornerRadius)
                .strokeBorder(.white.opacity(colorScheme == .dark ? 0.2 : 0.55), lineWidth: 0.75))
            .shadow(color: .black.opacity(colorScheme == .dark ? 0.22 : 0.07), radius: 12, x: 0, y: 6)
    }
}

private struct FrostedMaterial: NSViewRepresentable {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var cornerRadius: CGFloat
    var blendingMode: NSVisualEffectView.BlendingMode = .behindWindow
    var material: NSVisualEffectView.Material = .popover
    var maskImage: NSImage? = nil
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.blendingMode = blendingMode
        view.material = material
        view.state = .active
        view.wantsLayer = true
        view.layer?.cornerRadius = cornerRadius
        view.layer?.masksToBounds = true
        return view
    }
    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        view.layer?.cornerRadius = cornerRadius
        view.maskImage = maskImage
        view.state = reduceTransparency ? .inactive : .active
        view.layer?.backgroundColor = reduceTransparency ? NSColor.windowBackgroundColor.cgColor : NSColor.clear.cgColor
    }
}

private enum MaterialMasks {
    static let feathered: NSImage = {
        let image = NSImage(size: NSSize(width: 65, height: 65), flipped: false) { bounds in
            guard let context = NSGraphicsContext.current?.cgContext,
                  let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                    colors: [0.0, 0, 0.16, 0.5, 0.84, 1, 1, 0.84, 0.5, 0.16, 0, 0]
                        .map { NSColor.black.withAlphaComponent($0).cgColor } as CFArray,
                    locations: [0, 0.04, 0.125, 0.25, 0.375, 0.49, 0.51, 0.625, 0.75, 0.875, 0.96, 1]) else { return false }
            context.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: bounds.width, y: 0), options: [])
            context.setBlendMode(.destinationIn)
            context.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: bounds.height), options: [])
            return true
        }
        image.capInsets = NSEdgeInsets(top: 32, left: 32, bottom: 32, right: 32)
        image.resizingMode = .stretch
        return image
    }()
    static let fadeDown = NSImage(size: NSSize(width: 1, height: 48), flipped: false) { bounds in
        NSGradient(starting: .clear, ending: .black)?.draw(in: bounds, angle: 90)
        return true
    }
}

struct MessageBubble<Content: View>: View {
    var user = false
    var maxWidth: CGFloat = 310
    @ViewBuilder var content: Content
    var body: some View {
        HStack {
            if user { Spacer(minLength: 44) }
            content
                .padding(.horizontal, 18).padding(.vertical, user ? 10 : 12)
                .background(FrostedBubble(user: user))
                .frame(maxWidth: maxWidth, alignment: user ? .trailing : .leading)
            if !user { Spacer(minLength: 44) }
        }
    }
}

struct ChatView: View {
    @ObservedObject var service: BridgeService
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var settings: () -> Void
    var close: () -> Void
    var workspace = false
    var openDashboard: () -> Void = {}
    @FocusState private var focused: Bool
    @State private var choosingSession = false
    @State private var dashboardHovered = false
    private var ready: Bool { service.canSend }
    private var messages: [Message] {
        service.state.selection.agent == service.viewedAgent ? service.state.messages : []
    }
    private var draft: Binding<String> {
        Binding(get: { service.drafts[service.draftKey] ?? "" }, set: { service.drafts[service.draftKey] = $0 })
    }
    var body: some View {
        VStack(spacing: workspace ? 0 : 18) {
            if workspace {
                workspaceHeader
                Divider().opacity(0.45)
            }
            messageList
                .overlay(alignment: .topTrailing) {
                    if !workspace {
                        Button(action: openDashboard) {
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(dashboardHovered ? Color.accentColor : Color.secondary)
                                .frame(width: 30, height: 30)
                                .background(.background.opacity(0.85), in: Circle())
                                .overlay(Circle().strokeBorder(dashboardHovered ? Color.accentColor : Color.secondary.opacity(0.35), lineWidth: 1))
                                .contentShape(Circle())
                        }
                        .buttonStyle(.plain).help("打开应用看板").accessibilityLabel("打开应用看板")
                        .onHover { dashboardHovered = $0 }
                        .padding(.top, 8).padding(.trailing, 12)
                    }
                }
            if workspace { Divider().opacity(0.45).padding(.horizontal, 24) }
            composer
        }
        .padding(.horizontal, workspace ? 0 : 24)
        .padding(.bottom, workspace ? 0 : 30)
        .background {
            if !workspace && !reduceTransparency {
                FrostedMaterial(cornerRadius: 0, maskImage: MaterialMasks.feathered).opacity(0.24)
            }
        }
        .onExitCommand(perform: close)
    }
    private var workspaceHeader: some View {
        HStack(spacing: 9) {
            Image(nsImage: Agent.find(service.viewedAgent).icon(dark: colorScheme == .dark))
                .resizable().scaledToFit().frame(width: 30, height: 30)
                .frame(width: 38, height: 38)
            VStack(alignment: .leading, spacing: 2) {
                Text(service.displayName(service.viewedAgent)).font(.system(size: 16, weight: .semibold))
                Text(Agent.find(service.viewedAgent).comingSoon ? "即将支持" : service.viewedSession?.title ?? "无项目 · 尚无会话")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Menu {
                Button("新建会话") { service.send("/new") }.disabled(!ready)
                Button("当前状态") { service.send("/status") }
                Divider()
                Button("切换项目与会话") { choosingSession = true }
            } label: { Image(systemName: "ellipsis") }
            .menuStyle(.borderlessButton).frame(width: 24).help("会话菜单")
            .disabled(Agent.find(service.viewedAgent).comingSoon || !service.isRunning)
        }
        .buttonStyle(.plain).padding(.horizontal, 22).padding(.vertical, 18)
    }
    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: workspace ? 15 : 8) {
                    if messages.isEmpty && workspace {
                        workspaceEmptyState
                    } else if messages.isEmpty {
                        MessageBubble {
                            VStack(alignment: .leading, spacing: 10) {
                                Image(systemName: ready ? "bubble.left.and.bubble.right" : "link.badge.plus")
                                    .font(.system(size: 23, weight: .light))
                                Text(Agent.find(service.viewedAgent).comingSoon ? service.displayName(service.viewedAgent) + " 即将支持" :
                                    service.opening.contains(service.viewedAgent) ? "正在打开会话…" : ready ? "开始你的第一条消息" : "等待 Agent 连接")
                                    .font(.system(size: 17, weight: .medium))
                                Text(Agent.find(service.viewedAgent).comingSoon ? "会话功能将在接入后开放。" :
                                    ready ? "这里会继续同一个 Agent 会话。" :
                                    service.probes[service.viewedAgent]?.reason ?? "正在自动检测安装与登录状态。")
                                    .font(.system(size: 13)).foregroundStyle(.secondary).lineSpacing(4)
                                if !ready {
                                    Button("查看连接状态", action: settings).buttonStyle(.link)
                                }
                            }
                        }
                    }
                    ForEach(messages) { message in
                        conversationMessage(user: message.role == "user") {
                            VStack(alignment: .leading, spacing: 8) {
                                MessageMarkdown(text: message.text).equatable()
                                if message.truncated == true {
                                    Text("此处为消息摘要").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }.id(message.id)
                    }
                    ForEach(service.state.jobs.filter {
                        ["routing", "awaiting_route"].contains($0.status) ||
                        $0.target.agent == service.viewedAgent && ($0.sessionId ?? $0.target.sessionId) == service.state.selection.sessionId && $0.status != "completed"
                    }.prefix(3)) { job in
                        MessageBubble {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(job.id).font(.caption.monospaced()).foregroundStyle(.secondary)
                                Text(job.error ?? job.statusLabel).font(.system(size: 13))
                                TaskControls(service: service, job: job)
                            }
                        }
                    }
                    ForEach((service.state.approvals ?? []).filter { approval in
                        service.state.jobs.contains { $0.id == approval.jobId && $0.target.agent == service.viewedAgent }
                    }) { approval in
                        MessageBubble { ApprovalCard(service: service, approval: approval) }
                    }
                    if let notice = service.notice {
                        MessageBubble { Text(notice).font(.system(size: 13)).textSelection(.enabled) }
                    }
                    if let error = service.lastError, !error.hasPrefix("AGENT_UNAVAILABLE:") {
                        MessageBubble {
                            Label(error.replacingOccurrences(of: "AGENT_UNAVAILABLE: ", with: ""), systemImage: "info.circle")
                                .font(.system(size: 12)).foregroundStyle(.secondary)
                        }
                    }
                    Color.clear.frame(height: 1).id("end")
                }.padding(.horizontal, workspace ? 24 : 12)
                    .padding(.top, workspace ? 24 : 48).padding(.bottom, workspace ? 24 : 32)
            }
            .scrollIndicators(workspace ? .hidden : .never).scrollContentBackground(.hidden)
            .overlay(alignment: .top) {
                if !workspace && !reduceTransparency {
                    FrostedMaterial(cornerRadius: 0, blendingMode: .withinWindow, material: .headerView,
                                    maskImage: MaterialMasks.fadeDown)
                        .frame(height: 48)
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
            }
            // Keep scroll input in empty gaps, and feather this hit surface with the content.
            .background(Color.black.opacity(workspace ? 0 : 0.004))
            .mask(alignment: .top) {
                if workspace {
                    Rectangle()
                } else {
                    VStack(spacing: 0) {
                        LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
                            .frame(height: 48)
                        Rectangle()
                        LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                            .frame(height: 32)
                    }
                    .mask {
                        HStack(spacing: 0) {
                            LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing)
                                .frame(width: 12)
                            Rectangle()
                            LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                                .frame(width: 12)
                        }
                    }
                }
            }
            .onChange(of: service.state.messages.count) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: messages.last?.text) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: service.state.approvals?.count) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: service.notice) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: service.viewedAgent) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
        }
    }
    private var composer: some View {
        VStack(spacing: 12) {
            HStack(alignment: .bottom, spacing: 12) {
                TextField(ready ? "发送给 " + service.displayName(service.viewedAgent) + "…" : "连接就绪后即可发送", text: draft, axis: .vertical)
                    .textFieldStyle(.plain).font(.system(size: workspace ? 15 : 14)).lineLimit(1...5)
                    .focused($focused).disabled(!ready)
                    .onSubmit { send() }
                    .accessibilityLabel("会话消息")
                    .frame(minHeight: workspace ? nil : 52, alignment: .topLeading)
                Button(action: send) {
                    if workspace {
                        HStack(spacing: 7) {
                            Text("发送").font(.system(size: 13, weight: .medium))
                            Image(systemName: "return").font(.system(size: 12))
                        }
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .background(.primary.opacity(0.06), in: Capsule())
                    } else {
                        Image(systemName: "arrow.up.circle.fill").font(.system(size: 26, weight: .light))
                    }
                }
                .buttonStyle(.plain).disabled(!ready || draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .keyboardShortcut(.return, modifiers: .command).help("发送消息")
            }
            HStack(spacing: 8) {
                Button { choosingSession = true } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "folder")
                        Text(service.viewedSession?.title ?? service.state.projects?.first(where: {
                            $0.agent == service.viewedAgent && $0.id == service.state.selection.projectId
                        })?.name ?? "选择项目与会话").lineLimit(1).truncationMode(.middle)
                        Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
                    }.font(.system(size: 11)).foregroundStyle(.secondary)
                }
                .buttonStyle(.plain).accessibilityLabel("切换项目与会话")
                .disabled(!service.isRunning || Agent.find(service.viewedAgent).comingSoon)
                .popover(isPresented: $choosingSession, arrowEdge: .top) {
                    SessionBrowser(service: service) { choosingSession = false }
                }
                Spacer(minLength: 4)
                Button { Task { _ = await service.navigate("/new") } } label: {
                    Image(systemName: "square.and.pencil").font(.system(size: 13)).foregroundStyle(.secondary)
                }.buttonStyle(.plain).help("在当前项目新建会话").accessibilityLabel("新建会话")
                    .disabled(!ready)
            }
        }
        .padding(.horizontal, workspace ? 16 : 20).padding(.vertical, workspace ? 14 : 16)
        .background { if !workspace { FrostedBubble(cornerRadius: 28) } }
        .padding(workspace ? 14 : 0)
    }
    private var workspaceEmptyState: some View {
        let agent = Agent.find(service.viewedAgent)
        return VStack(spacing: 16) {
            Image(nsImage: agent.icon(dark: colorScheme == .dark))
                .resizable().scaledToFit().frame(width: 48, height: 48)
                .padding(18).background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 25))
            VStack(spacing: 10) {
                Text(agent.comingSoon ? service.displayName(agent.id) + " 即将支持" :
                    service.opening.contains(agent.id) ? "正在打开会话…" :
                    ready ? "和 " + service.displayName(agent.id) + " 继续对话" : "等待连接 " + service.displayName(agent.id))
                    .font(.system(size: 21, weight: .medium))
                Text(agent.comingSoon ? "你可以先把它固定到菜单栏。\n会话功能将在接入后开放。" :
                    ready ? "从这里发送消息，继续同一个会话。" :
                    service.probes[agent.id]?.reason ?? "正在自动检测安装与登录状态。")
                    .font(.system(size: 13)).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center).lineSpacing(5)
            }
            if !ready {
                Button(action: settings) {
                    Label(agent.comingSoon ? "管理 Agent" : "查看连接设置", systemImage: "slider.horizontal.3")
                        .font(.system(size: 12, weight: .medium))
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .background(.primary.opacity(0.06), in: Capsule())
                }.buttonStyle(.plain).padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity).padding(.vertical, 76)
    }
    private func conversationMessage<Content: View>(user: Bool, @ViewBuilder content: () -> Content) -> some View {
        MessageBubble(user: user, maxWidth: workspace ? 640 : 310) {
            VStack(alignment: .leading, spacing: 10) {
                if workspace {
                    HStack(spacing: 7) {
                        if !user {
                            Image(nsImage: Agent.find(service.viewedAgent).icon(dark: colorScheme == .dark))
                                .resizable().scaledToFit().frame(width: 20, height: 20)
                        }
                        Text(user ? "你" : service.displayName(service.viewedAgent))
                            .font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
                    }
                }
                content()
            }
        }
    }
    private func send() {
        let text = draft.wrappedValue
        guard ready, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        service.send(text, clearDraft: true)
    }
}

private struct SessionBrowser: View {
    @ObservedObject var service: BridgeService
    var close: () -> Void
    @State private var projects: [ProjectSummary] = []
    @State private var sessions: [SessionSummary] = []
    @State private var project = "all"
    @State private var query = ""
    @State private var nextOffset: Int?
    @State private var loading = false
    @State private var error: String?
    @State private var generation = UUID()
    @State private var catalogAgent = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Agent", selection: Binding(get: { service.viewedAgent }, set: { service.openAgent($0) })) {
                Text("Codex").tag("codex")
                Text("Claude Code").tag("claude")
            }.pickerStyle(.segmented)
            HStack {
                Picker("项目", selection: $project) {
                    Text("全部项目").tag("all")
                    Text("无项目").tag("none")
                    ForEach(projects) { Text($0.name).tag($0.id) }
                }
                Button { Task { await load(refresh: true) } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain).help("刷新原应用的项目与会话")
            }
            TextField("搜索会话", text: $query).textFieldStyle(.roundedBorder)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 3) {
                    ForEach(sessions) { session in
                        Button {
                            Task { if await service.navigate("/use " + session.shortId) { close() } }
                        } label: {
                            HStack(spacing: 8) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(session.title).font(.system(size: 12, weight: .medium)).lineLimit(2)
                                    Text(projects.first(where: { $0.id == session.projectId })?.name ?? "无项目")
                                        .font(.system(size: 10)).foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 4)
                                if session.id == service.state.selection.sessionId { Image(systemName: "checkmark").font(.system(size: 11)) }
                            }.padding(9).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                        }.buttonStyle(.plain).disabled(!service.opening.isEmpty)
                    }
                    if let nextOffset {
                        Button("加载更多会话") { Task { await load(offset: nextOffset) } }.padding(8).disabled(loading)
                    }
                    if loading { ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(12) }
                    if !loading && sessions.isEmpty { Text("没有匹配的会话").foregroundStyle(.secondary).padding(12) }
                }
            }.frame(height: 280)
            if let error { Text(error).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
            Divider()
            Button(project == "all" || project == "none" ? "新建无项目会话" : "在此项目新建会话") {
                let code = projects.first(where: { $0.id == project })?.shortId ?? "none"
                Task { if await service.navigate("/project " + code) { close() } }
            }.disabled(!service.opening.isEmpty || service.state.selection.agent != service.viewedAgent)
        }
        .padding(16).frame(width: 330)
        .onChange(of: service.viewedAgent) { _, _ in project = "all"; query = "" }
        .task(id: service.viewedAgent + ":" + project + ":" + query) {
            try? await Task.sleep(nanoseconds: 150_000_000)
            if !Task.isCancelled { await load(refresh: catalogAgent != service.viewedAgent) }
        }
    }
    private func load(offset: Int = 0, refresh: Bool = false) async {
        let current = UUID(); generation = current; loading = true; error = nil
        let agent = service.viewedAgent
        do {
            let result = try await service.catalog(project: project == "all" ? nil : project, query: query, offset: offset, refresh: refresh)
            guard generation == current, service.viewedAgent == agent, !Task.isCancelled else { return }
            projects = result.projects
            catalogAgent = agent
            sessions = offset == 0 ? result.sessions : sessions + result.sessions
            nextOffset = result.nextOffset
        } catch {
            guard generation == current else { return }
            self.error = error.localizedDescription
        }
        if generation == current { loading = false }
    }
}
