import SwiftUI

/// Welcome: the conversation from the intro's menu bar panel, at rest.
struct WelcomeArt: View {
    @Environment(\.colorScheme) private var scheme
    private static let messages: [IntroMessage] = [
        IntroMessage(kind: .user(source: "weixin"), text: "用 Codex 做个 Deep Research：2026 年的 AI 浏览器，首次引导都是怎么设计的？"),
        IntroMessage(kind: .agent("codex"), quote: "用 Codex 做个 Deep Research：2026 年的 AI 浏览器…", status: "已参考 23 个来源", blocks: [
            .init(kind: .paragraph, segments: [("调研完成。几款产品的共同做法：", false)]),
            .init(kind: .item(1), segments: [("开场直接叠在桌面上", false)]),
            .init(kind: .item(2), segments: [("先演示一句话能做什么", false)]),
            .init(kind: .item(3), segments: [("设置不超过五步，都能跳过", false)])]),
        IntroMessage(kind: .user(source: "desktop"), text: "把结论整理成一页摘要，发回微信"),
        IntroMessage(kind: .agent("codex"), quote: "把结论整理成一页摘要，发回微信", blocks: [
            .init(kind: .paragraph, segments: [("已整理成一页摘要，也发回了微信：", false)]),
            .init(kind: .file(size: "6 KB"), segments: [("onboarding-summary.md", false)])])
    ]
    var body: some View {
        let dark = scheme == .dark
        ArtFrame(background: AnyShapeStyle(LinearGradient(colors: dark ? [Color(hex: 0x0E1638), Color(hex: 0x22306F)]
                                                                     : [Color(hex: 0x9DBBF2), Color(hex: 0xC9D8F5), Color(hex: 0xEEDDD5)],
                                                          startPoint: .top, endPoint: .bottom))) {
            VStack(spacing: 10) {
                ReplicaThread(messages: Self.messages, compact: true)
                    .scaleEffect(0.86, anchor: .bottom)
                HStack {
                    Text("发送给 Codex…").foregroundStyle(.tertiary)
                    Spacer()
                    Image(systemName: "arrow.up").font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 22, height: 22).background(.primary.opacity(0.4), in: Circle())
                }
                .font(.system(size: 12)).padding(.horizontal, 16).frame(height: 50)
                .background(ReplicaBubble(user: false))
            }
            .padding(.leading, 16).padding(.trailing, 76).padding(.vertical, 14)
        }
    }
}

/// Agents: the main window's grid, following what is checked on the left.
struct AgentsArt: View {
    var checks: [String: OnboardingCard.AgentCheck]
    var picked: Set<String>
    var body: some View {
        ArtFrame {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 7) {
                    ForEach(0..<3, id: \.self) { _ in Circle().fill(.primary.opacity(0.12)).frame(width: 10, height: 10) }
                    Text("Chat Bridge").font(.system(size: 12)).foregroundStyle(.tertiary).padding(.leading, 4)
                }
                .padding(.horizontal, 13).frame(height: 34)
                Divider()
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                    ForEach(Agent.all) { agent in
                        let check = checks[agent.id] ?? .checking, on = picked.contains(agent.id)
                        switch check {
                        case .checking:
                            AgentCardReplica(agent: agent, status: "检测中", preview: "正在确认登录和配置…", look: .normal, busy: true, height: 96)
                        case .available:
                            AgentCardReplica(agent: agent, status: "可用", preview: on ? "已接入，手机可以调用" : "可用，未接入",
                                             look: on ? .selected : .normal, height: 96)
                        case .unavailable(let reason):
                            AgentCardReplica(agent: agent, status: "不可用", preview: reason, look: .unavailable, height: 96)
                        case .missing:
                            AgentCardReplica(agent: agent, status: "未安装", preview: "没有在这台 Mac 上找到", look: .unavailable, height: 96)
                        }
                    }
                }
                .padding(.leading, 16).padding(.trailing, 76).padding(.top, 16)
                .animation(.easeOut(duration: 0.25), value: picked)
            }
        }
    }
}

/// Routing: a numbered text menu, or Jev reading plain language and choosing the agent, the session and whether to start one.
struct RoutingArt: View {
    var smart: Bool
    @State private var shown = 0
    var body: some View {
        ArtFrame {
            VStack(spacing: 0) {
                HStack(spacing: 9) {
                    AppTile(size: 24).clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                    Text("Chat Bridge").font(.system(size: 13, weight: .semibold))
                    Text(smart ? "智能路由" : "文本菜单").font(.system(size: 11)).foregroundStyle(.secondary)
                        .padding(.horizontal, 7).padding(.vertical, 2).background(.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
                    Spacer()
                }
                .padding(.horizontal, 16).frame(height: 46)
                Divider()
                VStack(spacing: 9) {
                    ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                        if index < shown { item.transition(.offset(y: 10).combined(with: .opacity)) }
                    }
                }
                .padding(.leading, 16).padding(.trailing, 76).padding(.vertical, 12)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .bottom).clipped()
                .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.18)], startPoint: .top, endPoint: .bottom))
                HStack {
                    Text("发消息").foregroundStyle(.tertiary); Spacer()
                    Image(systemName: "arrow.up").font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 30, height: 30).background(Brand.tile, in: Circle())
                }
                .font(.system(size: 12.5)).padding(.leading, 12).padding(.trailing, 5).frame(height: 44)
                .background(OnboardingPalette.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(.primary.opacity(0.09)))
                .padding(.leading, 16).padding(.trailing, 76).padding(.bottom, 12)
            }
        }
        .task(id: smart) {
            shown = 0
            for index in 1...items.count {
                try? await Task.sleep(nanoseconds: index == 1 ? 200_000_000 : 380_000_000)
                if Task.isCancelled { return }
                withAnimation(.spring(response: 0.42, dampingFraction: 0.85)) { shown = index }
            }
        }
    }
    private var items: [AnyView] {
        if !smart {
            return [
                AnyView(me(Text("把登录页的按钮改成圆角"))),
                AnyView(bot(VStack(alignment: .leading, spacing: 4) {
                    Text("发给哪个会话？回复编号：")
                    Text("1. Codex › 官网改版 › 登录页")
                    Text("2. Claude › travel-checklist › 新建会话")
                    Text("3. 选择其他 Agent").foregroundStyle(.secondary)
                })),
                AnyView(me(Text("1"))),
                AnyView(receipt("Codex › 官网改版 › 登录页"))
            ]
        }
        return [
            AnyView(me(Text("用 ") + mark("Claude", Brand.sky) + Text(" 在 ") + mark("travel-checklist", Brand.cloud) + Text(" 里加一个分享页"))),
            AnyView(decision([("Agent", "Claude", nil), ("项目", "travel-checklist", nil), ("会话", "新建", "没有相关会话")])),
            AnyView(receipt("Claude › travel-checklist › 新会话")),
            AnyView(me(mark("继续刚才那个", Color(hex: 0xF4C77B)) + Text("，把测试补上"))),
            AnyView(decision([("Agent", "Claude", "沿用"), ("会话", "继续「分享页」", nil)])),
            AnyView(receipt("Claude › travel-checklist › 分享页"))
        ]
    }
    private func mark(_ text: String, _ color: Color) -> Text {
        Text(text).foregroundColor(.primary).bold().underline(color: color.opacity(0.9))
    }
    private func me(_ text: Text) -> some View {
        text.font(.system(size: 13)).padding(.horizontal, 13).padding(.vertical, 8)
            .background(OnboardingPalette.accent.opacity(0.16), in: UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: 16, bottomTrailingRadius: 5, topTrailingRadius: 16, style: .continuous))
            .frame(maxWidth: .infinity, alignment: .trailing)
    }
    private func bot<Content: View>(_ content: Content) -> some View {
        HStack(alignment: .bottom, spacing: 9) {
            AppTile(size: 24).clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            content.font(.system(size: 12.5)).padding(.horizontal, 13).padding(.vertical, 10)
                .background(OnboardingPalette.card, in: UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: 5, bottomTrailingRadius: 16, topTrailingRadius: 16, style: .continuous))
                .overlay(UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: 5, bottomTrailingRadius: 16, topTrailingRadius: 16, style: .continuous).strokeBorder(.primary.opacity(0.09)))
            Spacer(minLength: 0)
        }
    }
    private func receipt(_ target: String) -> some View {
        (Text(target).foregroundColor(.primary).bold() + Text("　已收到✅")).font(.system(size: 12)).foregroundStyle(.secondary)
            .padding(.horizontal, 11).padding(.vertical, 5).background(.primary.opacity(0.05), in: Capsule())
    }
    private func decision(_ rows: [(String, String, String?)]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("Jev 路由判断", systemImage: "sparkles").font(.system(size: 11, weight: .semibold)).foregroundStyle(OnboardingPalette.accent)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 6) {
                    Text(row.0).foregroundStyle(.secondary).frame(width: 44, alignment: .leading)
                    Text(row.1).fontWeight(.semibold)
                    if let note = row.2 { Text(note).font(.system(size: 11)).foregroundStyle(.secondary) }
                }
            }
        }
        .font(.system(size: 12)).padding(.horizontal, 12).padding(.vertical, 9).frame(width: 250, alignment: .leading)
        .background(OnboardingPalette.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(.primary.opacity(0.09)))
        .shadow(color: .black.opacity(0.06), radius: 9, y: 6)
    }
}

/// Done: where Chat Bridge lives, a click away in the menu bar.
struct MenuBarArt: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let ink = scheme == .dark ? Color(hex: 0xF2F1EC) : Color(hex: 0x17191C)
        ArtFrame {
            ZStack(alignment: .topLeading) {
                HStack(spacing: 14) {
                    ZStack {
                        Circle().strokeBorder(ink, lineWidth: 1.6).frame(width: 26, height: 26)
                        MenuBarIcon(ink: ink).scaleEffect(0.78)
                    }
                    Image(systemName: "wifi"); Image(systemName: "battery.75percent")
                    Text(MenuBarReplica.clock()).monospacedDigit()
                }
                .font(.system(size: 12)).foregroundStyle(ink)
                .frame(maxWidth: .infinity, alignment: .trailing).padding(.trailing, 90).frame(height: 30)
                .background(.primary.opacity(0.04)).overlay(alignment: .bottom) { Divider() }
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 9) {
                        AgentIcon(agent: Agent.find("codex")).frame(width: 24, height: 24)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("周末计划").font(.system(size: 13, weight: .semibold))
                            Text("Codex › 旅行清单").font(.system(size: 11)).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.horizontal, 14).frame(height: 52)
                    Divider()
                    VStack(spacing: 9) {
                        ReplicaMessage(message: IntroMessage(kind: .user(source: "desktop"), text: "把周日下午空出来"), compact: true)
                        ReplicaMessage(message: IntroMessage(kind: .agent("codex"), blocks: [
                            .init(kind: .paragraph, segments: [("已空出周日 14:00–18:00，把看展挪到了周六上午。", false)])]), compact: true)
                    }
                    .scaleEffect(0.86, anchor: .bottom)
                    .padding(.horizontal, 12).frame(maxHeight: .infinity, alignment: .bottom)
                    HStack {
                        Text("上次的草稿还在…").foregroundStyle(.tertiary); Spacer()
                        Image(systemName: "arrow.up").font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                            .frame(width: 26, height: 26).background(Brand.tile, in: Circle())
                    }
                    .font(.system(size: 12)).padding(.leading, 12).padding(.trailing, 5).frame(height: 40)
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(.primary.opacity(0.09)))
                    .padding(12)
                }
                .frame(width: 300, height: 330)
                .background(OnboardingPalette.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.primary.opacity(0.09)))
                .shadow(color: .black.opacity(0.14), radius: 24, y: 12)
                .offset(x: 40, y: 44)
            }
        }
    }
}
