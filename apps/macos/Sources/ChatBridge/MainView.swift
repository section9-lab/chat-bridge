import SwiftUI

struct MainView: View {
    @ObservedObject var service: BridgeService
    @Environment(\.colorScheme) private var colorScheme
    var settings: () -> Void
    @State private var search = ""
    @State private var hasChosenAgent = false
    @FocusState private var searchFocused: Bool

    private var agents: [Agent] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return Agent.all.filter {
            query.isEmpty || service.displayName($0.id).localizedCaseInsensitiveContains(query) ||
                $0.name.localizedCaseInsensitiveContains(query)
        }
    }
    var body: some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
                sidebar
                    .frame(width: min(440, max(380, geometry.size.width * 0.43)))
                ChatView(service: service, settings: settings, close: {}, workspace: true)
                    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 20))
                    .overlay(RoundedRectangle(cornerRadius: 20).stroke(.primary.opacity(0.04), lineWidth: 1))
                    .padding([.top, .trailing, .bottom], 8)
            }
        }
        .background {
            WindowBackground().overlay(Color(nsColor: .windowBackgroundColor).opacity(0.2)).ignoresSafeArea()
        }
        .frame(minWidth: 800, minHeight: 580)
        .onChange(of: service.state.selection.agent) { _, agent in
            if !hasChosenAgent { service.viewedAgent = agent }
        }
    }
    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack(spacing: 12) {
                Text("Chat Bridge").font(.system(size: 13, weight: .medium)).foregroundStyle(.secondary)
                    .padding(.leading, 65)
                Spacer(minLength: 0)
                Button(action: settings) {
                    Image(systemName: "gearshape").font(.system(size: 18))
                        .frame(width: 32, height: 32).contentShape(Circle())
                }
                .buttonStyle(.plain).help("设置").accessibilityLabel("设置")
                .keyboardShortcut(",", modifiers: .command)
            }
            .padding(.top, 8)
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("搜索 Agent", text: $search)
                    .textFieldStyle(.plain).font(.system(size: 13)).focused($searchFocused)
                    .accessibilityLabel("搜索 Agent")
                Button { searchFocused = true } label: {
                    Text("⌘F").font(.system(size: 11)).foregroundStyle(.tertiary)
                }.buttonStyle(.plain).keyboardShortcut("f", modifiers: .command)
                    .accessibilityLabel("搜索 Agent")
                if !search.isEmpty {
                    Button { search = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }.buttonStyle(.plain).accessibilityLabel("清除搜索")
                }
            }
            .padding(.horizontal, 17).frame(height: 44)
            .background(.primary.opacity(0.055), in: Capsule())
            ScrollView {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                    ForEach(agents) { agent in agentCard(agent) }
                }
                if agents.isEmpty {
                    VStack(spacing: 8) {
                        Text("没有找到 Agent").font(.system(size: 14, weight: .medium))
                        Text("试试名称或你设置的显示名。")
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity).padding(.top, 40)
                }
            }.scrollIndicators(.hidden)
            HStack(spacing: 6) {
                Circle().fill(service.isRunning ? Color.green : Color.secondary).frame(width: 6, height: 6)
                Text(service.isRunning ? "本地服务运行中" : "本地服务未就绪")
                Spacer()
                Text(AppVersion.current).foregroundStyle(.tertiary)
            }.font(.system(size: 10)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 22).padding(.bottom, 22)
    }
    private func agentCard(_ agent: Agent) -> some View {
        let selected = service.viewedAgent == agent.id
        let probe = service.probes[agent.id]
        let unavailable = agent.comingSoon || probe?.isAvailable != true
        let state = agent.comingSoon ? "即将支持" : probe?.statusLabel ?? "检测中"
        let label = service.displayName(agent.id) + "，" + state + (unavailable ? "，暂不可用" : "，打开会话")
        let hint = probe?.executionError ?? probe?.reason ?? "正在自动检测"
        return Button {
            hasChosenAgent = true
            service.openAgent(agent.id)
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(service.displayName(agent.id)).font(.system(size: 15, weight: .semibold))
                            .lineLimit(2).multilineTextAlignment(.leading)
                        Text(agent.comingSoon ? "Coming soon" : probe?.statusLabel ?? "检测中")
                            .font(.system(size: 11)).opacity(selected ? 0.8 : 0.6)
                    }
                    Spacer(minLength: 0)
                    Image(nsImage: agent.icon(dark: colorScheme == .dark))
                        .resizable().scaledToFit().frame(width: 30, height: 30)
                        .padding(4).background(.white.opacity(selected ? 0.92 : 0.45), in: Circle())
                }
                Spacer(minLength: 8)
                Text(preview(for: agent)).font(.system(size: 11)).lineLimit(2)
                    .multilineTextAlignment(.leading).opacity(selected ? 0.85 : 0.55)
            }
            .foregroundStyle(selected ? Color.white : Color.primary)
            .padding(17).frame(maxWidth: .infinity, alignment: .leading).frame(height: 132)
            .background {
                RoundedRectangle(cornerRadius: 20)
                    .fill(selected ? Color.accentColor : Color.primary.opacity(unavailable ? 0 : 0.035))
            }
            .overlay {
                if !selected && unavailable {
                    RoundedRectangle(cornerRadius: 20)
                        .strokeBorder(.primary.opacity(0.18), style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 20))
        }
        .buttonStyle(.plain)
        .disabled(unavailable)
        .accessibilityLabel(label)
        .accessibilityHint(hint)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
    private func preview(for agent: Agent) -> String {
        if agent.comingSoon { return "更多 Agent，陆续接入。" }
        if let probe = service.probes[agent.id], !probe.ready { return probe.reason }
        if let error = service.probes[agent.id]?.executionError { return error }
        if service.state.selection.agent == agent.id, let message = service.state.messages.last {
            return message.text
        }
        if service.opening.contains(agent.id) { return "正在打开会话…" }
        if service.probes[agent.id]?.ready == true { return "继续你的本地会话" }
        return "正在自动检测安装与登录状态"
    }
}
