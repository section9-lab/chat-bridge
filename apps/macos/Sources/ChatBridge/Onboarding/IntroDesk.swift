import SwiftUI

/// The simulated Mac the intro plays on: wallpaper, menu bar, Chat Bridge's window and its menu bar panel.
struct IntroDesk: View {
    @ObservedObject var director: IntroDirector
    var body: some View {
        let layout = director.layout
        ZStack(alignment: .topLeading) {
            DeskWallpaper()
            WindowReplica(director: director)
            PanelReplica(director: director)
            MenuBarReplica(director: director)
            CursorReplica(director: director)
        }
        .frame(width: layout.size.width, height: layout.size.height, alignment: .topLeading)
    }
}

struct DeskWallpaper: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let dark = scheme == .dark
        GeometryReader { geometry in
            let size = geometry.size
            ZStack {
                LinearGradient(colors: dark ? [Color(hex: 0x0A1030), Color(hex: 0x152058), Color(hex: 0x1D2B6B)]
                                            : [Color(hex: 0x7EA5EE), Color(hex: 0xA8C3F3), Color(hex: 0xDAE3F4), Color(hex: 0xF0DCD3)],
                               startPoint: .top, endPoint: .bottom)
                RadialGradient(colors: [(dark ? Brand.skyDeep.opacity(0.55) : .white.opacity(0.9)), .clear], center: UnitPoint(x: 0.72, y: 0.32),
                               startRadius: 0, endRadius: size.width * 0.42)
                RadialGradient(colors: [Color(hex: 0xF6CBBC, opacity: dark ? 0.2 : 0.8), .clear], center: UnitPoint(x: 0.18, y: 0.66),
                               startRadius: 0, endRadius: size.width * 0.32)
                RadialGradient(colors: [Color(hex: 0xF4C796, opacity: dark ? 0.14 : 0.55), .clear], center: UnitPoint(x: 0.88, y: 0.84),
                               startRadius: 0, endRadius: size.width * 0.34)
            }
        }
    }
}

/// The menu bar as it stands on this Mac: the notch where there is one, and Chat Bridge's icon exactly where the real one is.
struct MenuBarReplica: View {
    @ObservedObject var director: IntroDirector
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let layout = director.layout, ink = scheme == .dark ? Color(hex: 0xF2F1EC) : Color(hex: 0x17191C)
        ZStack(alignment: .topLeading) {
            Rectangle().fill(scheme == .dark ? Color(hex: 0x0E1018, opacity: 0.45) : Color.white.opacity(0.4))
            HStack(spacing: 22) {
                Text("Chat Bridge").fontWeight(.semibold)
                Text("编辑")
            }
            .font(.system(size: 13.5)).foregroundStyle(ink)
            .frame(height: layout.menuBar).padding(.leading, 22)
            if let notch = layout.notch {
                UnevenRoundedRectangle(bottomLeadingRadius: 13, bottomTrailingRadius: 13, style: .continuous).fill(.black)
                    .frame(width: notch.upperBound - notch.lowerBound, height: layout.menuBar - 5)
                    .offset(x: notch.lowerBound)
            }
            HStack(spacing: 17) {
                Image(systemName: "wifi"); Image(systemName: "battery.75percent"); Image(systemName: "switch.2")
                Text(Self.clock()).monospacedDigit()
            }
            .font(.system(size: 13.5)).foregroundStyle(ink)
            .frame(maxWidth: .infinity, alignment: .trailing).padding(.trailing, 16)
            .frame(height: layout.menuBar)
            .mask(alignment: .trailing) {
                Rectangle().frame(width: max(0, layout.size.width - layout.statusItem.x - 20))
            }
            MenuBarIcon(active: director.iconActive, dot: director.iconDot, ink: ink)
                .position(x: layout.statusItem.x, y: layout.menuBar / 2)
        }
        .frame(width: layout.size.width, height: layout.menuBar)
    }
    static func clock() -> String {
        let date = Date(), calendar = Calendar.current, hour = calendar.component(.hour, from: date)
        let week = "日一二三四五六".map(String.init)[calendar.component(.weekday, from: date) - 1]
        return "\(calendar.component(.month, from: date))月\(calendar.component(.day, from: date))日 周\(week) "
            + (hour < 12 ? "上午" : "下午") + "\(hour % 12 == 0 ? 12 : hour % 12):" + String(format: "%02d", calendar.component(.minute, from: date))
    }
}

/// The template mascot of the status item, eyes cut out of the body.
struct MenuBarIcon: View {
    var active = false
    var dot = false
    var ink: Color
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6).fill(.white.opacity(0.35)).frame(width: 38, height: 26).opacity(active ? 1 : 0)
            ZStack {
                MascotBody().fill(ink)
                Capsule().frame(width: 2.5, height: 4.7).offset(x: -3.25, y: 0.35).blendMode(.destinationOut)
                Capsule().frame(width: 2.5, height: 4.7).offset(x: 3.25, y: 0.35).blendMode(.destinationOut)
            }
            .compositingGroup().frame(width: 22, height: 18)
            Circle().fill(Color(hex: 0xFF453A)).frame(width: 7, height: 7).offset(x: 12, y: -8).opacity(dot ? 1 : 0)
        }
    }
}

// MARK: - The window

struct WindowReplica: View {
    @ObservedObject var director: IntroDirector
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let frame = director.layout.window, dark = scheme == .dark
        let home = director.layout.statusItem
        HStack(spacing: 0) {
            sidebar.frame(width: frame.width * 0.4)
            pane.padding([.top, .trailing, .bottom], 10)
        }
        .frame(width: frame.width, height: frame.height)
        .background(dark ? Color(hex: 0x1E2026, opacity: 0.9) : Color(hex: 0xE8EEF6, opacity: 0.92))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(.black.opacity(0.14), lineWidth: 0.5))
        .shadow(color: .black.opacity(dark ? 0.5 : 0.3), radius: 40, y: 20)
        .scaleEffect(director.windowFolded ? 0.04 : director.windowOpen ? 1 : 0.92)
        .opacity(director.windowFolded || !director.windowOpen ? 0 : 1)
        .position(x: director.windowFolded ? home.x : frame.midX, y: director.windowFolded ? home.y : frame.midY)
    }
    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 16) {
                HStack(spacing: 8) {
                    Circle().fill(Color(hex: 0xFF5F57)); Circle().fill(Color(hex: 0xFEBC2E)); Circle().fill(Color(hex: 0x28C840))
                }.frame(width: 52, height: 12)
                Text("Chat Bridge").font(.system(size: 13, weight: .medium)).foregroundStyle(.secondary)
                Spacer()
                Image(systemName: "gearshape").font(.system(size: 17)).foregroundStyle(.secondary)
            }
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                Text("搜索 Agent").foregroundStyle(.tertiary)
                Spacer()
                Text("⌘F").font(.system(size: 11)).foregroundStyle(.tertiary)
            }
            .font(.system(size: 13)).padding(.horizontal, 16).frame(height: 40)
            .background(.primary.opacity(0.055), in: Capsule())
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                ForEach(Agent.all) { agent in
                    AgentCardReplica(agent: agent, status: IntroAgents.status[agent.id] ?? "",
                                     preview: director.previews[agent.id] ?? "",
                                     look: director.selected == agent.id ? .selected : IntroAgents.unavailable.contains(agent.id) ? .unavailable : .normal,
                                     busy: director.busy.contains(agent.id))
                }
            }
            Spacer(minLength: 0)
            HStack(spacing: 6) {
                Circle().fill(.green).frame(width: 6, height: 6)
                Text("本地服务运行中")
                Spacer()
                Text(AppVersion.current).foregroundStyle(.tertiary)
            }.font(.system(size: 10)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 20).padding(.vertical, 16)
    }
    private var pane: some View {
        let agent = Agent.find(director.selected)
        return VStack(spacing: 0) {
            HStack(spacing: 12) {
                AgentIcon(agent: agent).frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(agent.name).font(.system(size: 17, weight: .semibold))
                    Text(director.subtitle).font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "arrow.down.left").font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
                    .frame(width: 30, height: 30).overlay(Circle().strokeBorder(.primary.opacity(0.12)))
            }
            .padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 8)
            ReplicaThread(messages: director.conversations[director.selected] ?? [], compact: false)
                .padding(.horizontal, 20)
                .id(director.selected)
                .transition(.opacity)
            HStack(spacing: 12) {
                Image(systemName: "paperclip").font(.system(size: 16)).foregroundStyle(.secondary)
                Text("发送给 \(agent.name)…").font(.system(size: 14)).foregroundStyle(.tertiary)
                Spacer()
                HStack(spacing: 5) { Text("发送"); Image(systemName: "return") }
                    .font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
                    .padding(.horizontal, 13).frame(height: 30).background(.primary.opacity(0.06), in: Capsule())
            }
            .padding(.horizontal, 18).frame(height: 60)
            .overlay(alignment: .top) { Rectangle().fill(.primary.opacity(0.08)).frame(height: 0.5).padding(.horizontal, 12) }
        }
        .background(scheme == .dark ? Color(hex: 0x18191D, opacity: 0.96) : Color.white.opacity(0.96),
                    in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: .black.opacity(0.06), radius: 7, y: 2)
    }
}

/// The agents' states in the intro, matching the example in the onboarding demo.
enum IntroAgents {
    static let status = ["codex": "可用", "claude": "可用", "cursor": "未付费", "grok": "未安装", "opencode": "可用", "hermes": "未配置 Key"]
    static let unavailable: Set<String> = ["cursor", "grok", "hermes"]
}

struct AgentIcon: View {
    var agent: Agent
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Image(nsImage: agent.icon(dark: scheme == .dark)).resizable().scaledToFit()
    }
}

/// An agent card from the main window's grid.
struct AgentCardReplica: View {
    enum Look { case normal, selected, unavailable }
    var agent: Agent
    var status: String
    var preview: String
    var look: Look
    var busy = false
    var height: CGFloat = 124
    var body: some View {
        let selected = look == .selected
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(agent.name).font(.system(size: height < 110 ? 13.5 : 15, weight: .semibold)).lineLimit(1)
                    HStack(spacing: 5) {
                        Text(status).font(.system(size: 11)).opacity(selected ? 0.85 : 0.6)
                        if busy { Spinner(size: 9, color: selected ? .white : .secondary) }
                    }
                }
                Spacer(minLength: 0)
                AgentIcon(agent: agent).frame(width: height < 110 ? 20 : 26, height: height < 110 ? 20 : 26)
                    .padding(height < 110 ? 5 : 6).background(.white.opacity(selected ? 0.95 : 0.5), in: Circle())
            }
            Spacer(minLength: 0)
            Text(preview).font(.system(size: height < 110 ? 10.5 : 11, weight: selected ? .semibold : .regular))
                .lineLimit(2).multilineTextAlignment(.leading).opacity(selected ? 0.9 : 0.55)
        }
        .foregroundStyle(selected ? Color.white : Color.primary)
        .padding(height < 110 ? 12 : 15)
        .frame(maxWidth: .infinity, alignment: .leading).frame(height: height)
        .background {
            RoundedRectangle(cornerRadius: height < 110 ? 15 : 19, style: .continuous)
                .fill(selected ? Brand.selection : Color.primary.opacity(look == .unavailable ? 0 : 0.04))
        }
        .overlay {
            if look == .unavailable {
                RoundedRectangle(cornerRadius: height < 110 ? 15 : 19, style: .continuous)
                    .strokeBorder(.primary.opacity(0.18), style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
            }
        }
        .opacity(look == .unavailable ? 0.7 : 1)
    }
}

// MARK: - Conversation

/// A bottom-aligned run of messages that scrolls off the top, like the real conversation.
struct ReplicaThread: View {
    var messages: [IntroMessage]
    var compact: Bool
    var body: some View {
        VStack(spacing: compact ? 12 : 14) {
            ForEach(messages) { message in
                ReplicaMessage(message: message, compact: compact)
                    .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 14)).combined(with: .scale(scale: 0.98, anchor: .bottom)), removal: .opacity))
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .bottom)
        .clipped()
        .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: compact ? 0.16 : 0.12)],
                             startPoint: .top, endPoint: .bottom))
    }
}

/// A message drawn like ChatView's `MessageBubble`: frosted bubbles, the source beside a phone message,
/// and the answering agent above a reply under its quote.
struct ReplicaMessage: View {
    var message: IntroMessage
    var compact: Bool
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        switch message.kind {
        case .user(let source):
            HStack {
                Spacer(minLength: 44)
                HStack(alignment: .top, spacing: 6) {
                    SourceIcon(source: source).frame(width: compact ? 16 : 20, height: compact ? 16 : 20)
                    Text(message.text).font(.system(size: compact ? 13.5 : 14)).lineSpacing(3)
                        .padding(.horizontal, 18).padding(.vertical, 10)
                        .background(ReplicaBubble(user: true))
                }
                .frame(maxWidth: compact ? 310 : 440, alignment: .trailing)
            }
        case .agent(let id):
            VStack(alignment: .leading, spacing: 5) {
                if let quote = message.quote {
                    Label(quote, systemImage: "arrowshape.turn.up.right.fill")
                        .font(.system(size: compact ? 11.5 : 12)).foregroundStyle(.secondary).lineLimit(1)
                        .padding(.leading, 6).frame(maxWidth: compact ? 310 : 440, alignment: .leading)
                }
                HStack {
                    VStack(alignment: .leading, spacing: compact ? 6 : 9) {
                        HStack(spacing: compact ? 5 : 7) {
                            AgentIcon(agent: Agent.find(id)).frame(width: compact ? 15 : 18, height: compact ? 15 : 18)
                            Text(Agent.find(id).name).font(.system(size: compact ? 11 : 12, weight: .semibold)).foregroundStyle(.secondary)
                        }
                        if let status = message.status {
                            HStack(spacing: 7) {
                                if message.working { Spinner(size: 11) }
                                Text(status).monospacedDigit()
                            }.font(.system(size: 12)).foregroundStyle(.secondary)
                        }
                        ForEach(message.blocks) { block in ReplicaBlock(block: block, compact: compact) }
                    }
                    .padding(.horizontal, 18).padding(.vertical, 12)
                    .background(ReplicaBubble(user: false))
                    Spacer(minLength: 44)
                }
                .frame(maxWidth: compact ? 340 : 480, alignment: .leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct ReplicaBlock: View {
    var block: IntroMessage.Block
    var compact: Bool
    var body: some View {
        let size: CGFloat = compact ? 13 : 14
        switch block.kind {
        case .paragraph:
            styled.font(.system(size: size)).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
        case .item(let number):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(number).").monospacedDigit()
                styled
            }.font(.system(size: size)).fixedSize(horizontal: false, vertical: true)
        case .code:
            Text(block.text).font(.system(size: compact ? 12 : 13, design: .monospaced)).lineLimit(1)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        case .file(let bytes):
            HStack(spacing: 9) {
                Image(systemName: "doc").foregroundStyle(.secondary)
                Text(block.text).lineLimit(1)
                Spacer(minLength: 14)
                Text(bytes).font(.system(size: 11)).foregroundStyle(.secondary)
            }
            .font(.system(size: compact ? 12 : 12.5))
            .padding(.horizontal, 11).padding(.vertical, 8)
            .background(.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }
    private var styled: Text {
        block.segments.reduce(Text("")) { $0 + Text($1.text).fontWeight($1.bold ? .semibold : .regular) }
    }
}

/// FrostedBubble's colors without the visual effect view.
struct ReplicaBubble: View {
    var user: Bool
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let dark = scheme == .dark
        RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(user ? Color(white: dark ? 0.2 : 0.8).opacity(0.94) : (dark ? Color(hex: 0x2A2C31) : Color.white.opacity(0.94)))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(.white.opacity(dark ? 0.2 : 0.55), lineWidth: 0.75))
            .shadow(color: .black.opacity(dark ? 0.22 : 0.07), radius: 12, y: 6)
    }
}

/// The app a phone message came from, as ChatView shows it: the installed app's own icon.
struct SourceIcon: View {
    var source: String
    var body: some View {
        if source == "desktop" {
            Image(systemName: "laptopcomputer").resizable().scaledToFit().foregroundStyle(.secondary)
        } else if let icon = MessageSource.icon(source) {
            Image(nsImage: icon).resizable().scaledToFit()
        } else {
            RoundedRectangle(cornerRadius: 5, style: .continuous).fill(source == "weixin" ? Brand.wechat : Color(hex: 0x34C759))
                .overlay(Image(systemName: source == "weixin" ? "bubble.left.and.bubble.right.fill" : "message.fill")
                    .font(.system(size: 9)).foregroundStyle(.white))
        }
    }
}

// MARK: - The menu bar panel

struct PanelReplica: View {
    @ObservedObject var director: IntroDirector
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let frame = director.layout.panel, dark = scheme == .dark
        ZStack(alignment: .bottom) {
            ReplicaThread(messages: director.panel, compact: true).padding(.bottom, 110)
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .fill(dark ? Color(hex: 0x2A2C31, opacity: 0.96) : Color.white.opacity(0.92))
                    .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).strokeBorder(.white.opacity(dark ? 0.2 : 0.55), lineWidth: 0.75))
                    .shadow(color: .black.opacity(0.16), radius: 24, y: 12)
                HStack(spacing: 1) {
                    if director.panelTyped.isEmpty && !director.panelFocused {
                        Text("发送给 Codex…").foregroundStyle(.tertiary)
                    } else {
                        Text(director.panelTyped)
                        Caret()
                    }
                }
                .font(.system(size: 14)).lineLimit(1).padding(.horizontal, 22).padding(.top, 17)
                Image(systemName: "paperclip").font(.system(size: 16)).foregroundStyle(.secondary)
                    .position(x: 30, y: 96 - 24)
                Image(systemName: "arrow.up").font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(director.panelTyped.isEmpty ? Color.primary.opacity(0.42) : Brand.selection, in: Circle())
                    .position(x: frame.width - 28, y: 96 - 26)
            }
            .frame(height: 96)
        }
        .overlay(alignment: .topTrailing) {
            Image(systemName: "arrow.up.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Brand.selection)
                .frame(width: 30, height: 30).background(ReplicaBubble(user: false).clipShape(Circle()))
                .offset(x: 8, y: 4)
        }
        .frame(width: frame.width, height: frame.height)
        .scaleEffect(director.panelOpen ? 1 : 0.97, anchor: .topTrailing)
        .offset(y: director.panelOpen ? 0 : -8)
        .opacity(director.panelOpen ? 1 : 0)
        .position(x: frame.midX, y: frame.midY)
    }
}

struct Caret: View {
    @State private var on = true
    var body: some View {
        Rectangle().fill(Brand.selection).frame(width: 1.5, height: 17)
            .opacity(on ? 1 : 0)
            .onAppear { withAnimation(.easeInOut(duration: 0.5).repeatForever()) { on = false } }
    }
}

struct CursorReplica: View {
    @ObservedObject var director: IntroDirector
    var body: some View {
        Path { path in
            path.move(to: CGPoint(x: 1, y: 1)); path.addLine(to: CGPoint(x: 1, y: 16.6))
            path.addLine(to: CGPoint(x: 4.9, y: 12.9)); path.addLine(to: CGPoint(x: 7.6, y: 19))
            path.addLine(to: CGPoint(x: 10.1, y: 17.9)); path.addLine(to: CGPoint(x: 7.5, y: 11.9))
            path.addLine(to: CGPoint(x: 12.8, y: 11.9)); path.closeSubpath()
        }
        .fill(.black)
        .overlay(Path { path in
            path.move(to: CGPoint(x: 1, y: 1)); path.addLine(to: CGPoint(x: 1, y: 16.6))
            path.addLine(to: CGPoint(x: 4.9, y: 12.9)); path.addLine(to: CGPoint(x: 7.6, y: 19))
            path.addLine(to: CGPoint(x: 10.1, y: 17.9)); path.addLine(to: CGPoint(x: 7.5, y: 11.9))
            path.addLine(to: CGPoint(x: 12.8, y: 11.9)); path.closeSubpath()
        }.stroke(.white, style: StrokeStyle(lineWidth: 1.2, lineJoin: .round)))
        .frame(width: 14, height: 21)
        .scaleEffect(director.cursorDown ? 0.84 : 1.25, anchor: .topLeading)
        .shadow(color: .black.opacity(0.35), radius: 2, y: 1)
        .opacity(director.cursorShown ? 1 : 0)
        .position(x: director.cursor.x + 7, y: director.cursor.y + 10.5)
    }
}
