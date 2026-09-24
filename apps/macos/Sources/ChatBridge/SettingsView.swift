import SwiftUI
import ServiceManagement

struct WindowBackground: NSViewRepresentable {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.blendingMode = .behindWindow
        view.material = .sidebar
        view.state = .active
        return view
    }
    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        view.state = reduceTransparency ? .inactive : .active
        view.wantsLayer = true
        view.layer?.backgroundColor = reduceTransparency ? NSColor.windowBackgroundColor.cgColor : NSColor.clear.cgColor
    }
}

struct SettingsButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .padding(.horizontal, 13).frame(height: 29)
            .background(.primary.opacity(configuration.isPressed ? 0.1 : 0.055), in: Capsule())
            .opacity(isEnabled ? 1 : 0.35)
            .contentShape(Capsule())
    }
}

struct SettingsSegments<Value: Hashable>: View {
    var label: String
    var options: [(Value, String)]
    @Binding var selection: Value
    @Environment(\.isEnabled) private var isEnabled
    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.0) { value, title in
                Button { selection = value } label: {
                    Text(title)
                        .font(.system(size: 13, weight: selection == value ? .medium : .regular))
                        .foregroundStyle(selection == value ? .primary : .secondary)
                        .frame(maxWidth: .infinity).frame(height: 29)
                        .background {
                            if selection == value {
                                Capsule().fill(Color(nsColor: .controlBackgroundColor))
                                    .shadow(color: .black.opacity(0.07), radius: 1.5, y: 1)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(title + "，" + label)
                .accessibilityAddTraits(selection == value ? .isSelected : [])
            }
        }
        .padding(3).background(.primary.opacity(0.055), in: Capsule())
        .opacity(isEnabled ? 1 : 0.4)
    }
}

struct SettingsView: View {
    @ObservedObject var service: BridgeService
    @Environment(\.colorScheme) private var colorScheme
    var openAgent: (String) -> Void
    var close: () -> Void
    var showOnboarding: () -> Void = {}
    @State private var tab = 0
    @State private var rename: [String: String] = [:]
    @State private var loginEnabled = SMAppService.mainApp.status == .enabled
    @State private var loginError: String?
    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("设置").font(.system(size: 23, weight: .semibold))
                Text("Chat Bridge").font(.system(size: 13)).foregroundStyle(.secondary)
                Spacer()
                Button(action: close) {
                    HStack(spacing: 7) {
                        Image(systemName: "xmark").font(.system(size: 14, weight: .medium))
                        Text("Esc").font(.system(size: 11)).foregroundStyle(.tertiary)
                    }.padding(.vertical, 6).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(.secondary)
                .keyboardShortcut(.cancelAction).help("关闭设置")
                .accessibilityLabel("关闭设置")
            }
            .padding(.horizontal, 28).padding(.top, 25).padding(.bottom, 20)
            HStack {
                SettingsSegments(label: "设置分类", options: [(0, "Agent"), (3, "智能路由"), (1, "消息通道"), (2, "通用")], selection: $tab)
                    .frame(width: 390)
                Spacer()
            }.padding(.horizontal, 28).padding(.bottom, 20)
            separator
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        if tab == 0 { agents }
                        else if tab == 1 { channels }
                        else if tab == 3 { RoutingSettings(service: service) }
                        else { general }
                        if let error = service.lastError {
                            Label(error, systemImage: "info.circle")
                                .font(.system(size: 11)).foregroundStyle(.secondary)
                                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading).padding(28)
                }
                .scrollContentBackground(.hidden)
                .onChange(of: service.state.channels?.weixin.qrContent) { _, _ in
                    if tab == 1 { proxy.scrollTo("weixin", anchor: .top) }
                }
                .onChange(of: service.channelErrors) { _, errors in
                    if tab == 1, let channel = ["imessage", "weixin"].first(where: { errors[$0] != nil }) {
                        proxy.scrollTo(channel, anchor: .top)
                    }
                }
            }
            separator
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        Circle().fill(service.isRunning ? Color.green : Color.secondary).frame(width: 6, height: 6)
                        Text(service.isRunning ? "本地服务运行中" : "本地服务未就绪")
                            .font(.system(size: 11))
                    }
                    Text(AppVersion.current).font(.system(size: 10)).foregroundStyle(.secondary)
                }
                Spacer()
                Button { Task { await service.refresh() } } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(!service.isRunning).help("刷新状态").accessibilityLabel("刷新状态")
                Button("退出 Chat Bridge") { close(); NSApp.terminate(nil) }
            }
            .buttonStyle(SettingsButtonStyle())
            .padding(.horizontal, 28).padding(.vertical, 17)
        }
        .background {
            WindowBackground()
                .overlay(Color(nsColor: .windowBackgroundColor).opacity(0.3))
                .ignoresSafeArea()
        }
        .frame(minWidth: 560, maxWidth: .infinity, minHeight: 580, maxHeight: .infinity)
        .onExitCommand(perform: close)
    }
    private var separator: some View {
        Rectangle().fill(.primary.opacity(0.08)).frame(height: 0.5)
    }
    private func sectionHeading(_ title: String, detail: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
            if let detail {
                Text(detail).font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true).lineSpacing(3)
            }
        }
    }
    private var agents: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack(spacing: 24) {
                VStack(alignment: .leading, spacing: 7) {
                    Text("默认 Agent").font(.system(size: 14, weight: .medium))
                    Text("用于尚未选择会话时的首次消息。\n修改后，当前会话保持不变。")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Picker("默认 Agent", selection: Binding(get: { service.state.preferences.defaultAgent },
                    set: { service.preferences(["defaultAgent": $0]) })) {
                    ForEach(Agent.all) { agent in Text(service.displayName(agent.id)).tag(agent.id) }
                }
                .labelsHidden().frame(width: 172).disabled(!service.isRunning)
            }
            separator
            VStack(alignment: .leading, spacing: 12) {
                sectionHeading("Agent", detail: "点击名称编辑，或打开对应会话。菜单栏 Logo 会回到上次使用的会话。")
                VStack(spacing: 2) {
                    ForEach(Agent.all) { agent in agentRow(agent) }
                }
            }
            separator
            VStack(alignment: .leading, spacing: 14) {
                sectionHeading("Claude 模式")
                HStack(spacing: 18) {
                    modeLabel("Code", detail: service.probes["claude"]?.ready == true ? "已连接" : "需登录 Claude Code")
                    modeLabel("Chat", detail: "后续支持")
                    modeLabel("Cowork", detail: "后续支持")
                }
            }
        }
    }
    private func modeLabel(_ title: String, detail: String) -> some View {
        HStack(spacing: 7) {
            Text(title).font(.system(size: 12, weight: .medium))
            Text(detail).font(.system(size: 10)).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func agentRow(_ agent: Agent) -> some View {
        let probe = service.probes[agent.id]
        let reason = probe?.executionError ?? probe?.reason ?? "正在自动检测"
        let version = probe?.version.map { " · 版本 " + $0 } ?? ""
        return HStack(spacing: 13) {
            Image(nsImage: agent.icon(dark: colorScheme == .dark))
                .resizable().scaledToFit().frame(width: 27, height: 27)
                .frame(width: 36, height: 36)
            VStack(alignment: .leading, spacing: 5) {
                TextField(agent.name, text: Binding(get: { rename[agent.id] ?? service.displayName(agent.id) },
                    set: { rename[agent.id] = $0 }))
                    .textFieldStyle(.plain).font(.system(size: 14, weight: .medium))
                    .accessibilityLabel(agent.name + " 显示名称")
                    .onSubmit { saveName(agent) }
                Text(agent.comingSoon ? "即将支持 · 仅展示" : probe?.statusLabel ?? "检测中")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .help(reason + version)
            }
            Spacer(minLength: 0)
            if !agent.comingSoon { enabledToggle(agent) }
            if rename[agent.id] != nil {
                Button("保存") { saveName(agent) }.buttonStyle(SettingsButtonStyle())
            } else if !agent.comingSoon {
                Button("打开") { openAgent(agent.id) }.buttonStyle(SettingsButtonStyle())
                    .help("打开 " + agent.name + " 会话面板")
                    .disabled(!service.isRunning || probe?.isAvailable != true)
            }
        }.padding(.vertical, 9)
    }
    /// Whether the phone channels and smart routing may use this agent; at least one stays on.
    private func enabledToggle(_ agent: Agent) -> some View {
        let enabled = service.state.preferences.enabledAgents
        return Toggle("手机可用", isOn: Binding(get: { enabled.contains(agent.id) }, set: { on in
            let next = Agent.all.map(\.id).filter { $0 == agent.id ? on : enabled.contains($0) }
            if !next.isEmpty { service.preferences(["enabledAgents": next]) }
        }))
        .toggleStyle(.switch).controlSize(.mini).labelsHidden()
        .disabled(!service.isRunning || (enabled == [agent.id]))
        .help(enabled.contains(agent.id) ? "手机和智能路由可以使用 " + agent.name : "手机和智能路由不会使用 " + agent.name)
        .accessibilityLabel(agent.name + " 手机可用")
    }
    private func saveName(_ agent: Agent) {
        guard let value = rename[agent.id]?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty, value.count <= 36 else {
            service.lastError = "显示名称需要 1–36 个字符。"; return
        }
        var names = service.state.preferences.names
        names[agent.id] = value
        service.preferences(["names": names])
        rename.removeValue(forKey: agent.id)
    }
    private var channels: some View {
        VStack(alignment: .leading, spacing: 23) {
            sectionHeading("消息通道", detail: "从常用的消息应用，继续同一个 Agent 会话。")
            IMessageSettings(service: service).id("imessage")
            separator
            WeixinSettings(service: service).id("weixin")
            separator
            sectionHeading("更多通道")
            channelRow("Telegram", symbol: "paperplane", status: "即将支持", detail: "后续提供")
            channelRow("WhatsApp", symbol: "phone.bubble", status: "即将支持", detail: "后续提供")
            separator
            Label("通道共用当前 Agent 与会话，回复将返回发起消息的通道。", systemImage: "arrow.triangle.branch")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true).lineSpacing(3)
            if !service.state.jobs.isEmpty {
                separator
                sectionHeading("最近任务", detail: "继续操作保留任务原来的 Agent 和会话。发送状态不确定时，请在原应用核对。")
                ForEach(service.state.jobs.prefix(8)) { job in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(job.id + " · " + Agent.find(job.target.agent).name).font(.system(size: 11, design: .monospaced))
                        Text(job.error ?? (job.status == "completed" ? "已完成" : "等待执行"))
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                        TaskControls(service: service, job: job)
                    }
                }
            }
            if let uncertain = service.state.deliveries?.filter({ $0.status == "delivery_unknown" }), !uncertain.isEmpty {
                Label("有 \(uncertain.count) 条回复的提交结果不确定，请在原消息应用核对；未自动重发。", systemImage: "exclamationmark.bubble")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
    }
    private func channelRow(_ title: String, symbol: String, status: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 15) {
            Image(systemName: symbol).font(.system(size: 22, weight: .regular))
                .foregroundStyle(.secondary).frame(width: 36, height: 36)
            VStack(alignment: .leading, spacing: 9) {
                HStack {
                    Text(title).font(.system(size: 14, weight: .medium))
                    Spacer()
                    Text(status).font(.system(size: 10)).foregroundStyle(.secondary)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(.primary.opacity(0.045), in: Capsule())
                }
                Text(detail).font(.system(size: 12)).foregroundStyle(.secondary).lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
    private var general: some View {
        VStack(alignment: .leading, spacing: 24) {
            sectionHeading("运行偏好")
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("锁屏后台保活")
                    Spacer()
                    Toggle("锁屏后台保活", isOn: Binding(get: { service.state.preferences.keepAlive },
                        set: { service.preferences(["keepAlive": $0]) }))
                        .labelsHidden().disabled(!service.isRunning)
                }
                Text("通道连接时防止系统空闲睡眠，不影响锁屏或屏幕休眠。关机、注销和合盖休眠仍会中断任务。")
                    .font(.system(size: 12)).foregroundStyle(.secondary).lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
                Label(service.state.channels?.connected == true ?
                    (service.state.preferences.keepAlive ? "已连接通道，正在申请后台保活。" : "通道已连接，后台保活开关已关闭。") :
                    "当前没有已连接通道，保活尚未启用。", systemImage: "moon")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
            separator
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("登录时启动")
                    Spacer()
                    Toggle("登录时启动", isOn: Binding(get: { loginEnabled }, set: { enabled in
                        do {
                            if enabled { try SMAppService.mainApp.register() }
                            else { try SMAppService.mainApp.unregister() }
                            loginEnabled = SMAppService.mainApp.status == .enabled
                            loginError = loginEnabled == enabled ? nil : "请在系统设置的“登录项”中确认。"
                        } catch { loginError = error.localizedDescription }
                    })).labelsHidden()
                }
                Text("登录 Mac 后，让 Chat Bridge 在菜单栏随时待命。")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                if let loginError { Text(loginError).font(.caption).foregroundStyle(.secondary) }
            }
            separator
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("新手引导")
                    Spacer()
                    Button("打开引导", action: showOnboarding).buttonStyle(SettingsButtonStyle())
                }
                Text("重新播放介绍，再走一遍 Agent、消息通道和路由方式的设置。")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            separator
            VStack(alignment: .leading, spacing: 13) {
                sectionHeading("本地数据")
                Label("保存在此 Mac", systemImage: "internaldrive")
                    .font(.system(size: 14, weight: .medium))
                Text("选择、配置和任务保存在本机数据库。微信凭据只在确认绑定后写入钥匙串，回复所需的 context token 加密保存。")
                    .font(.system(size: 12)).foregroundStyle(.secondary).lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !service.isRunning {
                Button("重新启动本地服务") { service.retryService() }.buttonStyle(SettingsButtonStyle())
            }
        }
        .font(.system(size: 14, weight: .medium)).toggleStyle(.switch).controlSize(.small)
    }
}
