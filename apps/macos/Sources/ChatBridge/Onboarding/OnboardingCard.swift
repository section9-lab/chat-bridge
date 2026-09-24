import SwiftUI
import ServiceManagement
import CoreImage.CIFilterBuiltins

/// The setup card that follows the intro: five short steps, each backed by the live service.
struct OnboardingCard: View {
    @ObservedObject var service: BridgeService
    @ObservedObject var flight: OnboardingFlight
    var finish: () -> Void
    @State private var step = 0
    @State private var forward = true
    @State private var picked: Set<String> = []
    @State private var touched: Set<String> = []
    @State private var pairing = Pairing.idle
    @State private var routeMode = RouteMode.menu
    @State private var provider = "typesafe"
    @State private var apiKey = ""
    @State private var loginEnabled = LaunchAtLogin.isEnabled
    @State private var loginError: String?
    @AppStorage("imessage.setup.email") private var email = ""
    @AppStorage("imessage.setup.phone") private var phone = ""
    @State private var verificationCode = ""

    enum Pairing { case idle, weixin, imessage }
    enum RouteMode { case menu, smart }

    init(service: BridgeService, flight: OnboardingFlight, step: Int = 0, pairing: Pairing = .idle, finish: @escaping () -> Void) {
        self.service = service
        self.flight = flight
        self.finish = finish
        _step = State(initialValue: step)
        _pairing = State(initialValue: pairing)
    }
    private static let progress: [CGFloat] = [0.08, 0.3, 0.52, 0.74, 0.92]
    private static let labels = ["开始设置", "继续", "继续", "继续", "完成"]

    var body: some View {
        ZStack(alignment: .topLeading) {
            Capsule().fill(.primary.opacity(0.06)).frame(width: 780, height: 5)
                .overlay(alignment: .leading) {
                    Capsule().fill(Brand.progress).frame(width: 780 * (flight.flying ? 1 : Self.progress[step]))
                        .animation(.timingCurve(0.2, 0.7, 0.2, 1, duration: 0.8), value: step)
                }
                .offset(x: 40, y: 28)
            VStack(alignment: .leading, spacing: 0) {
                ZStack(alignment: .topLeading) {
                    stepContent.id(step).transition(slide)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                actions
            }
            .frame(width: 384, height: 420, alignment: .topLeading)
            .offset(x: 40, y: 66)
            art.id(step).transition(slide)
                .frame(width: 460, height: 400, alignment: .topLeading)
                .offset(x: 462, y: 66)
        }
        .frame(width: 860, height: 520, alignment: .topLeading)
        .background(OnboardingPalette.card)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(.primary.opacity(0.08)))
        .shadow(color: .black.opacity(0.28), radius: 46, y: 24)
        .scaleEffect(flight.flying ? 0.03 : 1, anchor: .topTrailing)
        .opacity(flight.flying ? 0 : 1)
        .onAppear { refreshPicks(); syncRouting() }
        .onChanged(of: service.probes.map { "\($0.key):\($0.value.isAvailable)" }.sorted()) { _ in refreshPicks() }
    }

    private var slide: AnyTransition {
        .asymmetric(insertion: .offset(x: forward ? 16 : -16).combined(with: .opacity),
                    removal: .offset(x: forward ? -16 : 16).combined(with: .opacity))
    }
    private func go(_ next: Int) {
        guard (0...4).contains(next), next != step else { return }
        if step == 1 && next > step { saveAgents() }
        forward = next > step
        withAnimation(.timingCurve(0.2, 0.7, 0.2, 1, duration: 0.42)) { step = next }
    }

    // MARK: Steps

    @ViewBuilder private var stepContent: some View {
        switch step {
        case 0: welcome
        case 1: agents
        case 2: channels
        case 3: routing
        default: done
        }
    }
    private func title(_ text: String) -> some View {
        StaggeredText(text: text, font: .system(size: 27, weight: .regular)).padding(.bottom, 12)
    }
    private func lede(_ text: Text) -> some View {
        text.font(.system(size: 14)).foregroundStyle(.secondary).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 0) {
            title("欢迎使用 Chat Bridge")
            lede(Text("把") + Text("微信").foregroundColor(.primary).bold() + Text("和 ") + Text("iMessage").foregroundColor(.primary).bold()
                 + Text(" 连到这台 Mac 上的 AI Agent，离开电脑，也能接着聊。"))
            VStack(alignment: .leading, spacing: 11) {
                feature("arrow.clockwise", "接着聊", "继续电脑上的会话，项目和上下文都还在。")
                feature("text.bubble", "直接说", "一句话选好 Agent、项目和会话，不必记命令。")
                feature("tray.and.arrow.down", "拿结果", "回复和产出的文件，回到原来的聊天里。")
            }.padding(.top, 20)
            Text("人在远方，会话在手边。\n只要一分钟；以后每一项都能在设置里改。")
                .font(.system(size: 13.5)).foregroundStyle(.secondary).lineSpacing(4).padding(.top, 20)
        }
    }
    private func feature(_ symbol: String, _ name: String, _ detail: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: symbol).font(.system(size: 13)).foregroundStyle(.secondary).frame(width: 18)
            (Text(name + "  ").foregroundColor(.primary).bold() + Text(detail)).font(.system(size: 13.5)).foregroundStyle(.secondary)
        }
    }

    // Agents: detect what is installed, check each one can run, then pick the ones the phone may use.
    enum AgentCheck: Equatable { case checking, available(String), unavailable(String), missing }
    private func check(_ agent: Agent) -> AgentCheck {
        guard service.isRunning, let probe = service.probes[agent.id] else { return .checking }
        if probe.ready {
            if let error = probe.executionError { return .unavailable(Self.firstLine(error)) }
            return .available(probe.version.map { $0.isEmpty ? "可用" : "可用 · " + $0 } ?? "可用")
        }
        switch probe.status {
        case nil, "checking": return .checking
        case "missing": return .missing
        default: return .unavailable(Self.firstLine(probe.reason))
        }
    }
    private static func firstLine(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
    }
    private var available: [String] { Agent.all.filter { if case .available = check($0) { return true }; return false }.map(\.id) }
    private var scanning: Bool { Agent.all.contains { check($0) == .checking } }
    private func refreshPicks() {
        let ready = Set(available), enabled = Set(service.state.preferences.enabledAgents)
        for id in ready where !touched.contains(id) && enabled.contains(id) { picked.insert(id) }
        picked.formIntersection(ready)
    }
    /// Keeps every agent that was not deliberately turned off, so one that is fixed later works without a trip to Settings.
    private func saveAgents() {
        guard service.isRunning else { return }
        let ready = Set(available)
        let enabled = Agent.all.map(\.id).filter { !ready.contains($0) || picked.contains($0) }
        if !enabled.isEmpty && enabled != service.state.preferences.enabledAgents { service.preferences(["enabledAgents": enabled]) }
    }
    private var agents: some View {
        let found = Agent.all.filter { check($0) != .missing && check($0) != .checking }.count
        return VStack(alignment: .leading, spacing: 0) {
            title("检测这台 Mac 上的 Agent")
            lede(Text("Chat Bridge 会找出已安装的 Agent，逐个确认能不能用：") + Text("是否登录").foregroundColor(.primary).bold() + Text("、")
                 + Text("账号是否付费").foregroundColor(.primary).bold() + Text("、") + Text("API Key 是否配好").foregroundColor(.primary).bold()
                 + Text("。勾选要从手机调用的那几个。"))
            HStack {
                if !service.isRunning { Text("正在启动本地服务…") }
                else if scanning { Text("正在检测… \(Agent.all.filter { check($0) != .checking }.count) / \(Agent.all.count)") }
                else { Text("发现 \(found) 个 · \(available.count) 个可用 · 已选 \(picked.count) 个") }
                Spacer()
                Button("重新检测") { Task { await service.refresh() } }.buttonStyle(.link).disabled(!service.isRunning || scanning)
            }
            .font(.system(size: 12)).foregroundStyle(.secondary).monospacedDigit().padding(.top, 18).padding(.bottom, 10)
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                ForEach(Agent.all) { agent in agentChoice(agent) }
            }
        }
    }
    private func agentChoice(_ agent: Agent) -> some View {
        let state = check(agent), on = picked.contains(agent.id)
        let detail: String
        switch state {
        case .checking: detail = "检测中…"
        case .available(let text): detail = text
        case .unavailable(let reason): detail = reason
        case .missing: detail = "未安装"
        }
        let usable: Bool = { if case .available = state { return true }; return false }()
        return Button {
            touched.insert(agent.id)
            if on { picked.remove(agent.id) } else { picked.insert(agent.id) }
        } label: {
            HStack(spacing: 10) {
                AgentIcon(agent: agent).frame(width: 24, height: 24)
                VStack(alignment: .leading, spacing: 1) {
                    Text(service.displayName(agent.id)).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Text(detail).font(.system(size: 11.5)).lineLimit(usable ? 1 : 2)
                        .foregroundStyle(usable || state == .checking || state == .missing ? AnyShapeStyle(.secondary) : AnyShapeStyle(OnboardingPalette.warn))
                }
                Spacer(minLength: 4)
                if state == .checking { Spinner(size: 13) }
                else if usable {
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .strokeBorder(on ? Color.clear : Color.secondary.opacity(0.6), lineWidth: 1.5)
                        .background(on ? OnboardingPalette.accent : .clear, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                        .overlay(Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.white).opacity(on ? 1 : 0))
                        .frame(width: 17, height: 17)
                }
            }
            .padding(.horizontal, 11).frame(height: 54)
            .background(on ? OnboardingPalette.accent.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .strokeBorder(on ? OnboardingPalette.accent.opacity(0.65) : Color.primary.opacity(0.1),
                                  style: StrokeStyle(lineWidth: 1, dash: usable || state == .checking ? [] : [4, 3]))
            }
            .opacity(state == .missing ? 0.55 : 1)
            .contentShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        }
        .buttonStyle(.plain).disabled(!usable)
        .help(detail)
        .accessibilityLabel(service.displayName(agent.id) + "，" + detail)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    // Channels: WeChat by QR code, iMessage by replying OK; Telegram is coming.
    private var weixin: WeixinState { service.state.channels?.weixin ?? WeixinState() }
    private var imessage: IMessageState { service.state.channels?.imessage ?? IMessageState() }
    private var channels: some View {
        let connected = (weixin.connected ? 1 : 0) + (imessage.connected ? 1 : 0)
        return VStack(alignment: .leading, spacing: 0) {
            title("连接你的聊天软件")
            lede(Text("至少连一个。微信凭据只写入这台 Mac 的") + Text("钥匙串").foregroundColor(.primary).bold() + Text("。"))
            HStack { Text("消息通道").fontWeight(.semibold); Spacer(); Text("\(connected) / 2 已连接").monospacedDigit() }
                .font(.system(size: 12)).foregroundStyle(.secondary).padding(.top, 20).padding(.bottom, 10)
            Divider()
            channelRow("bubble.left.and.bubble.right", "微信", "扫码绑定自己的微信") { weixinAccessory }
                .contentShape(Rectangle()).onTapGesture { if weixin.status != "idle" || weixin.bound { pairing = .weixin } }
            Divider()
            channelRow("message", "iMessage", "Mac 邮箱与 iPhone 手机号配对，需要完全磁盘访问") { imessageAccessory }
                .contentShape(Rectangle()).onTapGesture { pairing = .imessage }
            Divider()
            channelRow("paperplane", "Telegram", "即将支持") {
                Text("Coming soon").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                    .padding(.horizontal, 8).padding(.vertical, 3).background(.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
            }
            .opacity(0.55).accessibilityLabel("Telegram，即将支持")
            Divider()
        }
    }
    private func channelRow<Accessory: View>(_ symbol: String, _ name: String, _ detail: String, @ViewBuilder accessory: () -> Accessory) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 17)).foregroundStyle(.secondary).frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.system(size: 13.5, weight: .semibold))
                Text(detail).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 8)
            accessory()
        }
        .padding(.vertical, 12)
    }
    @ViewBuilder private var weixinAccessory: some View {
        if weixin.connected { doneLabel("已连接") }
        else if weixin.bound { pill("重新连接") { pairing = .weixin; service.weixin("reconnect") } }
        else if ["loading", "wait", "scaned", "need_verifycode", "awaiting_confirmation", "connecting"].contains(weixin.status) {
            busyLabel(weixin.statusLabel)
        } else { pill("连接") { pairing = .weixin; service.weixin("start") } }
    }
    @ViewBuilder private var imessageAccessory: some View {
        if imessage.connected { doneLabel("已配对") }
        else if imessage.bound { pill("重新连接") { pairing = .imessage; service.imessage("reconnect") } }
        else if ["preparing", "dispatching_verification", "awaiting_phone", "connecting"].contains(imessage.status) {
            busyLabel(imessage.statusLabel)
        } else { pill("配对") { pairing = .imessage } }
    }
    private func pill(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action).buttonStyle(SettingsButtonStyle()).disabled(!service.isRunning || service.channelBusy)
    }
    private func doneLabel(_ text: String) -> some View {
        Label(text, systemImage: "checkmark.circle.fill").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(OnboardingPalette.ok)
    }
    private func busyLabel(_ text: String) -> some View {
        HStack(spacing: 6) { Spinner(size: 12); Text(text) }.font(.system(size: 12)).foregroundStyle(.secondary)
    }

    // Routing: a numbered text menu, or smart routing through Jev; the service matters only for the latter.
    private var routingState: RoutingState { service.state.routing ?? RoutingState() }
    private static let providerOrder = ["typesafe", "vercel", "openrouter"]
    private var providers: [RoutingProvider] {
        RoutingProvider.all.sorted { (Self.providerOrder.firstIndex(of: $0.id) ?? 9) < (Self.providerOrder.firstIndex(of: $1.id) ?? 9) }
    }
    private var chosenProvider: RoutingProvider { RoutingProvider.all.first { $0.id == provider } ?? RoutingProvider.all[0] }
    private func syncRouting() {
        Task {
            _ = await service.routing("get")
            let state = routingState
            routeMode = state.mode == "off" ? .menu : .smart
            if let current = state.provider, state.configured { provider = current }
        }
    }
    private func setMode(_ mode: RouteMode) {
        withAnimation(.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.3)) { routeMode = mode }
        let state = routingState
        Task {
            if mode == .menu, state.mode != "off" { _ = await service.routing("configure", params: ["mode": "off"]) }
            if mode == .smart, state.configured, state.mode == "off", state.provider == provider {
                _ = await service.routing("configure", params: ["mode": "auto"])
            }
        }
    }
    private func saveKey() {
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines), id = provider
        guard !key.isEmpty else { return }
        Task {
            if routingState.provider != id { _ = await service.routing("configure", params: ["provider": id]) }
            if await service.routing("key.save", params: ["provider": id, "apiKey": key]) {
                apiKey = ""
                _ = await service.routing("configure", params: ["mode": "auto"])
            }
        }
    }
    private var routing: some View {
        let state = routingState
        return VStack(alignment: .leading, spacing: 0) {
            title("选择路由方式")
            lede(Text("手机上的消息要落到某个 Agent 的某个会话里。可以回复编号自己选，也可以交给 ") + Text("Jev").foregroundColor(.primary).bold() + Text(" 模型判断。"))
            VStack(spacing: 8) {
                modeChoice(.menu, "文本菜单", "回复编号选择 Agent 和会话，无需配置")
                modeChoice(.smart, "智能路由", "直接说要做什么，Jev 决定 Agent、会话和是否新建")
            }.padding(.top, 16)
            if routeMode == .smart {
                VStack(alignment: .leading, spacing: 7) {
                    HStack { Text("路由服务").fontWeight(.semibold); Spacer(); Text("Jev 模型 · 按量计费") }
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                    HStack(spacing: 6) {
                        ForEach(providers) { item in
                            let on = provider == item.id
                            Button {
                                provider = item.id
                                if routingState.provider != item.id { Task { _ = await service.routing("configure", params: ["provider": item.id]) } }
                            } label: {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(item.name).font(.system(size: 12.5, weight: .semibold))
                                    Text(["typesafe": "官方", "vercel": "AI Gateway", "openrouter": "聚合服务"][item.id] ?? "")
                                        .font(.system(size: 11)).foregroundStyle(.secondary)
                                }
                                .padding(.horizontal, 10).padding(.vertical, 6).frame(maxWidth: .infinity, alignment: .leading)
                                .background(on ? OnboardingPalette.accent.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(on ? OnboardingPalette.accent.opacity(0.65) : .primary.opacity(0.1)))
                                .contentShape(RoundedRectangle(cornerRadius: 10))
                            }
                            .buttonStyle(.plain).disabled(service.routingBusy)
                        }
                    }
                    HStack(spacing: 8) {
                        SecureField(state.configured && state.provider == provider ? "已保存；填写新 Key 可替换" : "粘贴 \(chosenProvider.name) API Key", text: $apiKey)
                            .textFieldStyle(.roundedBorder).font(.system(size: 12)).onSubmit(saveKey)
                        Button("保存并验证", action: saveKey).buttonStyle(SettingsButtonStyle())
                            .disabled(!service.isRunning || service.routingBusy || apiKey.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    HStack(spacing: 8) {
                        if service.routingBusy { Spinner(size: 11) }
                        if let error = service.routingError { Text(error).foregroundStyle(OnboardingPalette.warn).lineLimit(2) }
                        else if state.configured && state.provider == provider { Text(state.mode == "off" ? "Key 已存入钥匙串" : "Key 已存入钥匙串 · 智能路由已开启") }
                        else { Text("没有 Key 时仍使用文本菜单，可以稍后在设置里填写") }
                        Spacer(minLength: 6)
                        Link("获取 Key ↗", destination: chosenProvider.keyURL)
                    }
                    .font(.system(size: 11.5)).foregroundStyle(.secondary)
                }
                .padding(.top, 12)
                .transition(.opacity.combined(with: .offset(y: -6)))
            }
        }
    }
    private func modeChoice(_ mode: RouteMode, _ name: String, _ detail: String) -> some View {
        let on = routeMode == mode
        return Button { setMode(mode) } label: {
            HStack(alignment: .top, spacing: 12) {
                Circle().strokeBorder(on ? OnboardingPalette.accent : Color.secondary.opacity(0.7), lineWidth: on ? 5 : 1.5)
                    .frame(width: 16, height: 16).padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(.system(size: 13.5, weight: .semibold))
                    Text(detail).font(.system(size: 12)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(on ? OnboardingPalette.accent.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(on ? OnboardingPalette.accent.opacity(0.65) : .primary.opacity(0.1)))
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private var done: some View {
        VStack(alignment: .leading, spacing: 0) {
            title("就这样，可以出门了")
            lede(Text("Chat Bridge 住在") + Text("菜单栏").foregroundColor(.primary).bold() + Text("。只要 Mac 保持唤醒、联网，手机上的消息就不会错过。"))
            Divider().padding(.top, 18)
            toggleRow("power", "登录时启动", loginError ?? "登录 Mac 后，在菜单栏随时待命", isOn: Binding(get: { loginEnabled }, set: { enabled in
                loginError = LaunchAtLogin.set(enabled); loginEnabled = LaunchAtLogin.isEnabled
            }))
            Divider()
            toggleRow("moon", "锁屏后台保活", "通道连接时防止系统空闲睡眠，不影响锁屏", isOn: Binding(get: { service.state.preferences.keepAlive }, set: { value in
                service.preferences(["keepAlive": value])
            }))
            .disabled(!service.isRunning)
            Divider()
            VStack(alignment: .leading, spacing: 4) {
                Text("出门前，在微信里试一句：").font(.system(size: 12.5)).foregroundStyle(.secondary)
                Text("「用 Claude 新建一个无项目会话，给我三个早餐点子。」").font(.system(size: 13.5)).textSelection(.enabled)
            }
            .padding(.horizontal, 14).padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading)
            .background(.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(.primary.opacity(0.08)))
            .padding(.top, 18)
        }
    }
    private func toggleRow(_ symbol: String, _ name: String, _ detail: String, isOn: Binding<Bool>) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 17)).foregroundStyle(.secondary).frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.system(size: 13.5, weight: .semibold))
                Text(detail).font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Toggle(name, isOn: isOn).labelsHidden().toggleStyle(.switch).controlSize(.small)
        }
        .padding(.vertical, 12)
    }

    private var actions: some View {
        HStack(spacing: 6) {
            Button { step < 4 ? go(step + 1) : finish() } label: {
                HStack(spacing: 9) { Text(Self.labels[step]); Text("↵").opacity(0.55) }
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(OnboardingPalette.buttonInk)
                    .padding(.leading, 16).padding(.trailing, 13).frame(height: 34)
                    .background(OnboardingPalette.button, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            }
            .buttonStyle(.plain).keyboardShortcut(.defaultAction)
            .disabled(step == 1 && service.isRunning && !scanning && !available.isEmpty && picked.isEmpty)
            if step > 0 { Button("返回") { go(step - 1) }.buttonStyle(GhostButtonStyle()) }
            if step == 3 { Button("跳过") { go(4) }.buttonStyle(GhostButtonStyle()) }
        }
    }

    // MARK: Illustrations

    @ViewBuilder private var art: some View {
        switch step {
        case 0: WelcomeArt()
        case 1: AgentsArt(checks: Dictionary(uniqueKeysWithValues: Agent.all.map { ($0.id, check($0)) }), picked: picked)
        case 2: pairingArt
        case 3: RoutingArt(smart: routeMode == .smart)
        default: MenuBarArt()
        }
    }
    @ViewBuilder private var pairingArt: some View {
        switch pairing {
        case .idle: ArtFrame { PairingIdle() }
        case .weixin: ArtFrame { WeChatPairing(service: service, code: $verificationCode) }
        case .imessage: ArtFrame(light: true) { IMessagePairing(service: service, email: $email, phone: $phone) }
        }
    }
}

/// Lets the coordinator fold the card into the menu bar icon as it moves the window there.
@MainActor final class OnboardingFlight: ObservableObject {
    @Published var flying = false
}

enum OnboardingPalette {
    static let card = Color.adaptive(0xFFFFFF, 0x131417)
    static let accent = Color.adaptive(0x5B8BE6, 0x87AEF5)
    static let warn = Color.adaptive(0xB36A12, 0xE6A94F)
    static let ok = Color.adaptive(0x2E9A5F, 0x4CC38A)
    static let button = Color.adaptive(0x17191C, 0xECEBE6)
    static let buttonInk = Color.adaptive(0xFFFDF8, 0x17191C)
    static let artFill = Color.adaptive(0xF7F8FA, 0x18191D)
}

struct GhostButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 13)).foregroundStyle(.secondary)
            .padding(.horizontal, 10).frame(height: 34)
            .background(configuration.isPressed ? Color.primary.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
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

// MARK: - Live pairing

/// The card's right-hand frame; it runs past the card's edge, which crops it.
struct ArtFrame<Content: View>: View {
    var light = false
    var background: AnyShapeStyle? = nil
    @ViewBuilder var content: Content
    var body: some View {
        let framed = content
            .frame(width: 460, height: 400, alignment: .topLeading)
            .background(background ?? (light ? AnyShapeStyle(Color.white) : AnyShapeStyle(OnboardingPalette.artFill)))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.primary.opacity(0.08)))
            .shadow(color: .black.opacity(0.1), radius: 25, y: 10)
        // The iMessage pairing shows the iPhone, which keeps iOS's light look whatever the Mac uses.
        if light { framed.environment(\.colorScheme, .light) } else { framed }
    }
}

struct PairingIdle: View {
    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 14) {
                Image(systemName: "laptopcomputer").font(.system(size: 34, weight: .light))
                HStack(spacing: 5) { ForEach(0..<6, id: \.self) { _ in Circle().frame(width: 3, height: 3) } }.opacity(0.5)
                Image(systemName: "iphone").font(.system(size: 30, weight: .light))
            }
            .foregroundStyle(.secondary).padding(.bottom, 8)
            Text("把手机上的聊天软件连到这台 Mac").font(.system(size: 14, weight: .semibold))
            Text("点左侧的“连接”或“配对”开始。\n微信扫码，iMessage 回复一条 OK。")
                .font(.system(size: 12.5)).foregroundStyle(.secondary).multilineTextAlignment(.center).lineSpacing(4)
        }
        .frame(width: 398, height: 400)
    }
}

struct WeChatPairing: View {
    @ObservedObject var service: BridgeService
    @Binding var code: String
    private var state: WeixinState { service.state.channels?.weixin ?? WeixinState() }
    var body: some View {
        let status = state.status
        VStack(spacing: 7) {
            HStack(spacing: 8) { SourceIcon(source: "weixin").frame(width: 18, height: 18); Text("微信扫码绑定") }
                .font(.system(size: 13, weight: .semibold)).padding(.bottom, 6)
            ZStack {
                RoundedRectangle(cornerRadius: 16, style: .continuous).fill(.white)
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(.black.opacity(0.08)))
                    .shadow(color: .black.opacity(0.12), radius: 16, y: 8)
                if state.connected || state.bound {
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 64)).foregroundStyle(Brand.wechat)
                } else if let content = state.qrContent, ["wait", "scaned", "need_verifycode"].contains(status), let qr = Self.qrImage(content) {
                    Image(nsImage: qr).interpolation(.none).resizable().scaledToFit().padding(10)
                        .accessibilityLabel("微信绑定二维码，请使用自己的微信扫码")
                    if status != "wait" {
                        VStack(spacing: 4) {
                            Image(systemName: "iphone.badge.checkmark").font(.system(size: 34)).foregroundStyle(Brand.wechat)
                            Text("已扫码").font(.system(size: 13.5, weight: .semibold))
                            Text("请在手机上确认").font(.system(size: 11.5)).foregroundStyle(.secondary)
                        }
                        .foregroundStyle(Brand.charcoal)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(.white.opacity(0.9), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    }
                } else if status == "awaiting_confirmation" {
                    Image(systemName: "person.crop.circle.badge.checkmark").font(.system(size: 54)).foregroundStyle(Brand.wechat)
                } else if status == "expired" || status == "error" {
                    Image(systemName: "qrcode").font(.system(size: 60)).foregroundStyle(.black.opacity(0.18))
                } else {
                    Spinner(size: 22, color: .gray)
                }
            }
            .frame(width: 176, height: 176)
            Text(headline).font(.system(size: 14, weight: .semibold)).padding(.top, 10)
            Text(note).font(.system(size: 11.5)).foregroundStyle(.secondary).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true).frame(width: 300)
            if status == "need_verifycode" {
                HStack {
                    SecureField("微信显示的验证码", text: $code).textFieldStyle(.roundedBorder).frame(width: 150)
                        .onSubmit(verify)
                    Button("验证", action: verify).buttonStyle(SettingsButtonStyle()).disabled(code.isEmpty)
                }
            }
            if status == "awaiting_confirmation" {
                Text(state.ownerId ?? "").font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                Button("确认绑定此账号") { service.weixin("confirm", params: ["attemptId": state.attemptId ?? ""]) }
                    .buttonStyle(SettingsButtonStyle())
            }
            if status == "expired" || status == "error" {
                Button("重新获取二维码") { service.weixin("start") }.buttonStyle(SettingsButtonStyle())
            } else if ["loading", "wait", "scaned", "need_verifycode", "awaiting_confirmation"].contains(status) && !state.bound {
                Button("取消扫码") { service.weixin("cancel") }.buttonStyle(.link).font(.system(size: 11.5))
            }
            if let error = service.channelErrors["weixin"] {
                Text(error).font(.system(size: 11)).foregroundStyle(OnboardingPalette.warn).frame(width: 300)
            }
        }
        .disabled(service.channelBusy || !service.isRunning)
        .frame(width: 398, height: 400)
    }
    private var headline: String {
        if state.connected || state.bound { return "微信已连接" }
        switch state.status {
        case "loading": return "正在获取二维码"
        case "wait": return "用手机微信扫一扫"
        case "scaned": return "已扫码，等待手机确认"
        case "need_verifycode": return "输入微信显示的验证码"
        case "awaiting_confirmation": return "确认绑定这个微信账号"
        case "expired": return "二维码已过期"
        case "error": return "连接异常"
        default: return "正在准备"
        }
    }
    private var note: String {
        if state.connected || state.bound { return "凭据已写入这台 Mac 的钥匙串" }
        switch state.status {
        case "wait": return "使用自己的微信扫码，二维码几分钟内有效"
        case "scaned": return "在微信里点“确认登录”即可"
        case "awaiting_confirmation": return "仅允许这个扫码账号控制本机 Agent"
        default: return state.message ?? "请稍候"
        }
    }
    private func verify() { service.weixin("verify", params: ["code": code]); code = "" }
    static func qrImage(_ text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8); filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let image = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return NSImage(cgImage: image, size: NSSize(width: output.extent.width, height: output.extent.height))
    }
}

/// iMessage pairs by a request sent from this Mac to the iPhone; replying OK there finishes it.
struct IMessagePairing: View {
    @ObservedObject var service: BridgeService
    @Binding var email: String
    @Binding var phone: String
    private var state: IMessageState { service.state.channels?.imessage ?? IMessageState() }
    var body: some View {
        if !state.bound && ["idle", "error"].contains(state.status) && !state.connected { form } else { conversation }
    }
    private var form: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) { SourceIcon(source: "imessage").frame(width: 18, height: 18); Text("iMessage 配对") }
                .font(.system(size: 13, weight: .semibold))
            Text("Mac 用邮箱发送，iPhone 用手机号接收。请先在“消息 → 设置 → iMessage”里，把“发起新对话”设为下面的邮箱。")
                .font(.system(size: 11.5)).foregroundStyle(.secondary).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 6) {
                Text("Mac 的 iMessage 邮箱").font(.system(size: 11.5)).foregroundStyle(.secondary)
                TextField("例如 name@icloud.com", text: $email).textFieldStyle(.roundedBorder)
                Text("iPhone 手机号").font(.system(size: 11.5)).foregroundStyle(.secondary).padding(.top, 4)
                TextField("含国家区号，例如 +8613800000000", text: $phone).textFieldStyle(.roundedBorder)
            }
            .font(.system(size: 12))
            HStack(spacing: 10) {
                Button("发送配对请求") { service.imessage("start", params: ["email": email, "phone": phone]) }
                    .buttonStyle(SettingsButtonStyle())
                    .disabled(!service.isRunning || service.channelBusy || email.isEmpty || phone.isEmpty)
                Button("完全磁盘访问设置") {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") { NSWorkspace.shared.open(url) }
                }.buttonStyle(.link).font(.system(size: 11.5))
            }
            Text("会向这个手机号发一条配对请求；在 iPhone 上回复 OK 即可完成。读取回复需要完全磁盘访问。")
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let message = service.channelErrors["imessage"] ?? state.message {
                Text(message).font(.system(size: 11)).foregroundStyle(OnboardingPalette.warn).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.leading, 24).padding(.trailing, 86).padding(.top, 26)
        .frame(width: 460, height: 400, alignment: .topLeading)
    }
    /// What the iPhone shows while pairing: the request from this Mac, the OK reply, and the confirmation.
    private var conversation: some View {
        let paired = state.connected || state.bound, status = state.status
        return VStack(spacing: 0) {
            VStack(spacing: 3) {
                AppTile(size: 36).clipShape(Circle())
                Text("Chat Bridge").font(.system(size: 12, weight: .semibold))
                Text("你的 iPhone 上 · 来自 \(state.email ?? email)").font(.system(size: 10.5)).foregroundStyle(Color(hex: 0x8A8A8E))
            }
            .frame(maxWidth: .infinity).frame(height: 82)
            .background(Color(hex: 0xF8F8FA)).overlay(alignment: .bottom) { Rectangle().fill(Color(hex: 0xD6D6DB)).frame(height: 0.5) }
            .padding(.trailing, 62)
            VStack(spacing: 6) {
                if status == "preparing" || status == "dispatching_verification" {
                    HStack(spacing: 7) { Spinner(size: 12, color: .gray); Text(status == "preparing" ? "正在检查 Messages 读取权限…" : "正在向 \(state.phone ?? phone) 发送配对请求…") }
                        .font(.system(size: 12)).foregroundStyle(Color(hex: 0x8A8A8E))
                } else {
                    Text("iMessage\n今天").font(.system(size: 10.5)).foregroundStyle(Color(hex: 0x8A8A8E)).multilineTextAlignment(.center)
                    bubble("Chat Bridge 配对请求\n请确认本条消息的发件邮箱是 \(state.email ?? email)。\n如果这是你刚在 Mac 上发起的请求，请在此对话回复 OK。", outgoing: false)
                    if paired {
                        bubble("OK", outgoing: true)
                        bubble("配置完成，已绑定此账号。", outgoing: false)
                        Label("认证成功，已配对", systemImage: "checkmark.circle.fill").font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Color(hex: 0x2E9A5F)).padding(.top, 6)
                    } else {
                        HStack(spacing: 7) { Spinner(size: 11, color: .gray); Text("等待你在 iPhone 上回复 OK · 10 分钟内有效") }
                            .font(.system(size: 11.5)).foregroundStyle(Color(hex: 0x8A8A8E)).padding(.top, 6)
                        Button("取消配对") { service.imessage("disconnect") }.buttonStyle(.link).font(.system(size: 11.5))
                    }
                }
                if let error = service.channelErrors["imessage"] {
                    Text(error).font(.system(size: 11)).foregroundStyle(OnboardingPalette.warn).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.leading, 18).padding(.trailing, 84).padding(.vertical, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        }
        .foregroundStyle(.black)
        .frame(width: 460, height: 400)
        .animation(.spring(response: 0.42, dampingFraction: 0.85), value: paired)
    }
    private func bubble(_ text: String, outgoing: Bool) -> some View {
        Text(text).font(.system(size: 13.5)).lineSpacing(2).foregroundStyle(outgoing ? .white : .black)
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(TailBubble(outgoing: outgoing).fill(outgoing ? Color(hex: 0x0A84FF) : Color(hex: 0xE9E9EB)))
            .frame(maxWidth: 250, alignment: outgoing ? .trailing : .leading)
            .frame(maxWidth: .infinity, alignment: outgoing ? .trailing : .leading)
            .transition(.offset(y: 10).combined(with: .opacity))
    }
}
