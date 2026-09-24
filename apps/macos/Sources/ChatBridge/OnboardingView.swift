import SwiftUI
import ServiceManagement

/// First-run setup beside the brand painting. Nothing here is required: every choice stays editable in Settings,
/// and channel pairing opens the matching Settings tab so there is only one pairing flow to maintain.
struct OnboardingView: View {
    @ObservedObject var service: BridgeService
    @Environment(\.colorScheme) private var colorScheme
    var openSettings: (Int) -> Void
    var finish: () -> Void
    @State private var loginEnabled = LaunchAtLogin.isEnabled
    @State private var loginError: String?
    private static let artwork = Agent.resourceBundle
        .url(forResource: "bridge-courtyard", withExtension: "jpg", subdirectory: "Onboarding")
        .flatMap(NSImage.init(contentsOf:))

    private var weixin: WeixinState { service.state.channels?.weixin ?? WeixinState() }
    private var imessage: IMessageState { service.state.channels?.imessage ?? IMessageState() }

    var body: some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
                ScrollView {
                    setup(compact: geometry.size.height < 700)
                        .padding(.horizontal, geometry.size.width < 1000 ? 28 : 48)
                        .padding(.vertical, geometry.size.height < 700 ? 20 : 28)
                        .frame(maxWidth: 520)
                        .frame(maxWidth: .infinity, minHeight: geometry.size.height, alignment: .center)
                }
                .scrollIndicators(.hidden)
                .frame(width: max(400, geometry.size.width * 0.5))
                artwork
                    .clipShape(RoundedRectangle(cornerRadius: 20))
                    .padding([.top, .bottom, .trailing], 14)
                    .accessibilityHidden(true)
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            // Agents are often installed or signed in from Terminal while this page waits.
            loginEnabled = LaunchAtLogin.isEnabled
            if service.isRunning { Task { await service.refresh() } }
        }
    }

    private var artwork: some View {
        GeometryReader { proxy in
            Group {
                if let image = Self.artwork {
                    Image(nsImage: image).resizable().scaledToFill()
                } else {
                    LinearGradient(colors: [Color(red: 0.53, green: 0.68, blue: 0.96), Color(red: 0.4, green: 0.58, blue: 0.92)],
                                   startPoint: .top, endPoint: .bottom)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .clipped()
            .overlay(alignment: .bottomLeading) {
                Text("人在远方，\n会话在手边。")
                    .font(.system(size: 28, weight: .medium)).lineSpacing(6)
                    .foregroundStyle(.white).shadow(color: .black.opacity(0.18), radius: 10, y: 2)
                    .padding(32)
            }
        }
    }

    private func setup(compact: Bool) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(nsImage: AppLogo.statusImage()).renderingMode(.template)
                Text("Chat Bridge")
            }
            .font(.system(size: 17, weight: .semibold))
            .accessibilityElement(children: .combine)
            .padding(.bottom, compact ? 16 : 28)
            Text("离开电脑，也能接着聊。")
                .font(.system(size: compact ? 28 : 34, weight: .semibold)).tracking(-1)
                .lineLimit(1).minimumScaleFactor(0.85)
            Text("选好默认 Agent，连接微信或 iMessage，\n就能从手机继续 Mac 上的会话。")
                .font(.system(size: 14)).foregroundStyle(.secondary)
                .multilineTextAlignment(.center).lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 10).padding(.bottom, compact ? 18 : 24)
            form(compact: compact)
            HStack {
                Button("退出 Chat Bridge") { NSApp.terminate(nil) }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                Spacer()
                Button("开始使用", systemImage: "arrow.right", action: finish)
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    .keyboardShortcut(.defaultAction)
            }
            .padding(.top, compact ? 18 : 24)
        }
        .frame(maxWidth: .infinity)
    }

    private func form(compact: Bool) -> some View {
        let available = Agent.all.filter { service.probes[$0.id]?.isAvailable == true }.count
        let connected = (weixin.connected ? 1 : 0) + (imessage.connected ? 1 : 0)
        return VStack(alignment: .leading, spacing: 0) {
            caption("默认 Agent", trailing: service.isRunning ? "\(available) 个可用" : "正在启动本地服务…")
                .padding(.bottom, 10)
            agentGrid
            agentHint
            caption("消息通道", trailing: "\(connected) / 2 已连接")
                .padding(.top, compact ? 16 : 20).padding(.bottom, 2)
            row("微信", symbol: "bubble.left.and.bubble.right", detail: "扫码绑定自己的微信，凭据保存在钥匙串", compact: compact) {
                channelStatus(connected: weixin.connected, label: weixin.statusLabel, action: "连接")
            }
            Divider()
            row("iMessage", symbol: "message", detail: "Mac 邮箱与 iPhone 手机号配对，需要完全磁盘访问", compact: compact) {
                channelStatus(connected: imessage.connected, label: imessage.statusLabel, action: "配对")
            }
            Divider()
            row("智能路由（可选）", symbol: "arrow.triangle.branch", detail: "一句话选好 Agent、项目和会话，不必记命令", compact: compact) {
                if service.state.routing?.configured == true {
                    doneLabel("已启用")
                } else {
                    Button("配置") { openSettings(3) }.buttonStyle(SettingsButtonStyle())
                }
            }
            Divider()
            row("登录时启动", symbol: "power", detail: loginError ?? "在菜单栏随时待命，手机消息不会错过", compact: compact) {
                Toggle("登录时启动", isOn: Binding(get: { loginEnabled }, set: { enabled in
                    loginError = LaunchAtLogin.set(enabled)
                    loginEnabled = LaunchAtLogin.isEnabled
                }))
                .labelsHidden().toggleStyle(.switch).controlSize(.small)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.5), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.secondary.opacity(0.16), lineWidth: 1))
    }

    private func caption(_ title: String, trailing: String) -> some View {
        HStack {
            Text(title).fontWeight(.medium)
            Spacer()
            Text(trailing).monospacedDigit()
        }
        .font(.caption).foregroundStyle(.secondary)
    }

    private var agentGrid: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3), spacing: 8) {
            ForEach(Agent.all) { agentCard($0) }
        }
    }

    @ViewBuilder private var agentHint: some View {
        if service.isRunning, !Agent.all.contains(where: { service.probes[$0.id]?.isAvailable == true }),
           !service.probes.isEmpty, !service.probes.values.contains(where: { $0.status == "checking" }) {
            Text("还没有可用的 Agent。在 Mac 上安装并登录 Codex、Claude Code 等后，这里会自动更新。")
                .font(.caption).foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true).padding(.top, 10)
        }
    }

    private func agentCard(_ agent: Agent) -> some View {
        let probe = service.probes[agent.id]
        let available = probe?.isAvailable == true
        let selected = service.state.preferences.defaultAgent == agent.id
        let status = probe?.statusLabel ?? "检测中"
        return Button {
            service.preferences(["defaultAgent": agent.id])
        } label: {
            HStack(spacing: 8) {
                Image(nsImage: agent.icon(dark: colorScheme == .dark))
                    .resizable().scaledToFit().frame(width: 22, height: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(service.displayName(agent.id)).font(.system(size: 13, weight: .semibold))
                        .lineLimit(1).minimumScaleFactor(0.8)
                    Text(status).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
                if probe == nil || probe?.status == "checking" {
                    ProgressView().controlSize(.mini)
                } else if available {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selected ? Color.accentColor : Color.secondary.opacity(0.5))
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected && available ? Color.accentColor.opacity(0.06) : Color(nsColor: .controlBackgroundColor),
                        in: RoundedRectangle(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10).strokeBorder(
                    selected && available ? Color.accentColor.opacity(0.65) : Color.secondary.opacity(0.18),
                    style: StrokeStyle(lineWidth: 1, dash: available ? [] : [4, 3]))
            }
            .opacity(available ? 1 : 0.6)
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .disabled(!available || !service.isRunning)
        .help(probe?.executionError ?? probe?.reason ?? "正在自动检测安装与登录状态")
        .accessibilityLabel("\(service.displayName(agent.id))，\(status)，\(selected ? "默认 Agent" : "设为默认 Agent")")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func row<Accessory: View>(_ title: String, symbol: String, detail: String, compact: Bool,
                                      @ViewBuilder accessory: () -> Accessory) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 18)).foregroundStyle(.secondary).frame(width: 28)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 14, weight: .semibold))
                Text(detail).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            accessory()
        }
        .padding(.vertical, compact ? 11 : 14)
    }

    /// Pairing happens in Settings, which already walks through QR codes, verification and permissions.
    @ViewBuilder private func channelStatus(connected: Bool, label: String, action: String) -> some View {
        if connected {
            doneLabel("已连接")
        } else {
            HStack(spacing: 8) {
                if label != "未连接" { Text(label).font(.caption).foregroundStyle(.secondary) }
                Button(action) { openSettings(1) }.buttonStyle(SettingsButtonStyle())
                    .disabled(!service.isRunning)
            }
        }
    }

    private func doneLabel(_ title: String) -> some View {
        Label(title, systemImage: "checkmark.circle.fill")
            .font(.system(size: 12, weight: .medium)).foregroundStyle(.green)
    }
}

enum LaunchAtLogin {
    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }
    /// Returns a message when the system did not apply the change.
    static func set(_ enabled: Bool) -> String? {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            return isEnabled == enabled ? nil : "请在系统设置的“登录项”中确认。"
        } catch { return error.localizedDescription }
    }
}
