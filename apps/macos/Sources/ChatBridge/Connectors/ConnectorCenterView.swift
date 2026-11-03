import AuthenticationServices
import SwiftUI

private enum ConnectorFilter: String, CaseIterable, Identifiable {
    case all = "全部"
    case connected = "已连接"
    case attention = "需要处理"
    var id: String { rawValue }
    var symbol: String {
        switch self { case .all: return "square.grid.2x2"; case .connected: return "link"; case .attention: return "exclamationmark.triangle" }
    }
}

struct ConnectorCenterView: View {
    @ObservedObject var service: BridgeService
    @StateObject private var authentication = ConnectorAuthSession()
    @State private var filter: ConnectorFilter? = .all
    @State private var selection: String?
    @State private var catalog: [ConnectorDefinition] = []
    @State private var accounts: [ConnectedConnectorAccount] = []
    @State private var search = ""
    @State private var apiKey = ""
    @State private var loading = false
    @State private var loaded = false
    @State private var disconnecting: ConnectedConnectorAccount?
    @State private var removeKey = false

    private var configured: Bool { service.state.connectors?.provider.configured == true }
    private var visibleConnectors: [ConnectorDefinition] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return catalog.filter { connector in
            let matchesSearch = query.isEmpty || connector.name.localizedCaseInsensitiveContains(query) ||
                connector.description.localizedCaseInsensitiveContains(query) || connector.category.localizedCaseInsensitiveContains(query)
            let related = accounts.filter { $0.connectorSlug == connector.slug }
            let matchesFilter: Bool
            switch filter ?? .all {
            case .all: matchesFilter = true
            case .connected: matchesFilter = related.contains { $0.status == "active" }
            case .attention: matchesFilter = related.contains { !["active", "connecting"].contains($0.status) }
            }
            return matchesSearch && matchesFilter
        }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    private var selectedConnector: ConnectorDefinition? { catalog.first { $0.id == selection } }

    var body: some View {
        NavigationSplitView {
            sidebar
        } content: {
            connectorList
        } detail: {
            detail
        }
        .navigationTitle("连接器")
        .searchable(text: $search, placement: .toolbar, prompt: "搜索连接器")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await reload() } } label: {
                    if loading { ProgressView().controlSize(.small) } else { Image(systemName: "arrow.clockwise") }
                }
                .disabled(loading || !configured).help("刷新连接器").accessibilityLabel("刷新连接器")
            }
        }
        .task { if !loaded { await reload() } }
        .alert("断开连接？", isPresented: Binding(get: { disconnecting != nil }, set: { if !$0 { disconnecting = nil } })) {
            Button("取消", role: .cancel) { disconnecting = nil }
            Button("断开连接", role: .destructive) {
                guard let account = disconnecting else { return }
                disconnecting = nil
                Task {
                    if await service.disconnectConnectorAccount(account.id) { await reloadAccounts() }
                }
            }
        } message: {
            Text("Chat Bridge 将停止使用此账号，并请求撤销上游授权。已经提交的外部操作不会被撤回。")
        }
        .alert("移除 Composio API Key？", isPresented: $removeKey) {
            Button("取消", role: .cancel) {}
            Button("移除", role: .destructive) {
                Task {
                    if await service.removeConnectorKey() { catalog = []; accounts = []; selection = nil }
                }
            }
        } message: {
            Text("所有连接器会在此 Mac 上停用。此操作不会自动删除 Composio 中已有的连接账号。")
        }
        .frame(minWidth: 820, minHeight: 600)
    }

    private var sidebar: some View {
        List(selection: $filter) {
            Section("浏览") {
                ForEach(ConnectorFilter.allCases) { item in
                    Label {
                        HStack {
                            Text(item.rawValue)
                            Spacer()
                            if item == .connected, !accounts.isEmpty { Text("\(accounts.filter { $0.status == "active" }.count)").foregroundStyle(.secondary) }
                            if item == .attention {
                                let count = accounts.filter { !["active", "connecting"].contains($0.status) }.count
                                if count > 0 { Text("\(count)").foregroundStyle(.secondary) }
                            }
                        }
                    } icon: { Image(systemName: item.symbol) }
                    .tag(item)
                }
            }
            if configured {
                Section("服务") {
                    Label(service.state.connectors?.provider.status == "error" ? "Composio 需要检查" : "Composio 已连接",
                          systemImage: service.state.connectors?.provider.status == "error" ? "exclamationmark.circle" : "checkmark.circle")
                    Button("移除 API Key…") { removeKey = true }
                }
            }
        }
        .listStyle(.sidebar)
        .navigationSplitViewColumnWidth(min: 180, ideal: 210)
    }

    @ViewBuilder private var connectorList: some View {
        if !configured {
            configuration
        } else if loading && catalog.isEmpty {
            VStack(spacing: 12) {
                ProgressView()
                Text("正在加载连接器…").foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if visibleConnectors.isEmpty {
            emptyState(symbol: search.isEmpty ? "link" : "magnifyingglass", title: search.isEmpty ? "没有连接器" : "没有匹配的连接器",
                       detail: search.isEmpty ? "请刷新目录后重试。" : "试试其他名称或分类。")
        } else {
            List(visibleConnectors, selection: $selection) { connector in
                ConnectorRow(connector: connector, accounts: accounts.filter { $0.connectorSlug == connector.slug })
                    .tag(connector.id)
            }
            .navigationSplitViewColumnWidth(min: 260, ideal: 320)
        }
    }

    private var configuration: some View {
        VStack(alignment: .leading, spacing: 18) {
            Image(systemName: "link.badge.plus").font(.system(size: 38, weight: .light)).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 6) {
                Text("设置连接器服务").font(.title2.weight(.semibold))
                Text("使用你自己的 Composio API Key 加载连接器目录。Key 只保存在此 Mac 的钥匙串中。")
                    .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            SecureField("Composio API Key", text: $apiKey)
                .textFieldStyle(.roundedBorder).frame(maxWidth: 420)
                .accessibilityLabel("Composio API Key")
            HStack {
                Button("打开 Composio 控制台") {
                    NSWorkspace.shared.open(URL(string: "https://platform.composio.dev")!)
                }
                Button("保存并验证") {
                    Task {
                        if await service.saveConnectorKey(apiKey) { apiKey = ""; await reload() }
                    }
                }
                .keyboardShortcut(.defaultAction).disabled(apiKey.isEmpty || service.connectorBusy)
            }
            if service.connectorBusy { ProgressView("正在验证…").controlSize(.small) }
            connectorFeedback
        }
        .padding(30).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder private var detail: some View {
        if let connector = selectedConnector {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    HStack(alignment: .top, spacing: 14) {
                        Image(systemName: symbol(for: connector.category)).font(.system(size: 28)).foregroundStyle(.secondary)
                            .frame(width: 42, height: 42)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(connector.name).font(.title2.weight(.semibold))
                            Text(connector.description).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Divider()
                    if service.state.connectors?.toolExecutionEnabled != true {
                        Label("账号连接和访问范围已经可用；Agent 工具执行仍在验收中，当前不会调用外部服务。",
                              systemImage: "hammer")
                            .font(.subheadline).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    let related = accounts.filter { $0.connectorSlug == connector.slug }
                    if related.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("尚未连接账号").font(.headline)
                            Text("连接后，再选择哪些 Agent 可以使用此账号。默认不会自动授权所有 Agent。")
                                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            Button("连接账号…") { Task { await connect(connector) } }
                                .disabled(service.connectorBusy || authentication.running)
                        }
                    } else {
                        ForEach(related) { account in accountDetail(account) }
                        Button("连接另一个账号…") { Task { await connect(connector) } }
                            .disabled(service.connectorBusy || authentication.running)
                    }
                    if authentication.running { ProgressView("请在系统窗口中完成认证…").controlSize(.small) }
                    connectorFeedback
                }
                .padding(28).frame(maxWidth: 620, alignment: .leading)
            }
        } else {
            emptyState(symbol: "link", title: "选择一个连接器", detail: "查看账号、Agent 权限和操作策略。")
        }
    }

    private func accountDetail(_ account: ConnectedConnectorAccount) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(account.label ?? account.connectorName).font(.headline)
                    Label(statusText(account.status), systemImage: account.status == "active" ? "checkmark.circle.fill" : "exclamationmark.circle")
                        .font(.subheadline).foregroundStyle(account.status == "active" ? Color.green : Color.secondary)
                }
                Spacer()
                Button("断开连接…", role: .destructive) { disconnecting = account }
            }
            GroupBox(service.state.connectors?.toolExecutionEnabled == true ? "可用于" : "预先授权给") {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Agent.all.filter { !$0.comingSoon }) { agent in
                        Toggle(service.displayName(agent.id), isOn: Binding(get: {
                            accountFor(account.id)?.policy.allowedAgents.contains(agent.id) == true
                        }, set: { enabled in
                            guard var current = accountFor(account.id) else { return }
                            if enabled { current.policy.allowedAgents.append(agent.id) }
                            else { current.policy.allowedAgents.removeAll { $0 == agent.id } }
                            savePolicy(current.policy)
                        }))
                    }
                }.padding(.vertical, 4)
            }
            GroupBox("操作策略") {
                Picker("操作策略", selection: Binding(get: {
                    accountFor(account.id)?.policy.mode ?? "confirm-writes"
                }, set: { mode in
                    guard var current = accountFor(account.id) else { return }
                    current.policy.mode = mode
                    savePolicy(current.policy)
                })) {
                    Text("只读").tag("read-only")
                    Text("更改前询问").tag("confirm-writes")
                    Text("允许一般更改").tag("allow-writes")
                }
                .pickerStyle(.radioGroup)
                Text(service.state.connectors?.toolExecutionEnabled == true ?
                    "删除、付款和权限变更始终需要单次确认。" :
                    "此策略会在 Agent 工具执行通过验收后生效；当前不会调用外部服务。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(16).background(.background, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(nsColor: .separatorColor).opacity(0.7)))
    }

    @ViewBuilder private var connectorFeedback: some View {
        if let error = service.connectorError {
            Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.secondary)
                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        } else if let notice = service.connectorNotice {
            Label(notice, systemImage: "checkmark.circle").foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func emptyState(symbol: String, title: String, detail: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: symbol).font(.system(size: 34, weight: .light)).foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(detail).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }.padding(28).frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func symbol(for category: String) -> String {
        let value = category.lowercased()
        if value.contains("dev") || value.contains("开发") { return "chevron.left.forwardslash.chevron.right" }
        if value.contains("communication") || value.contains("沟通") { return "bubble.left.and.bubble.right" }
        if value.contains("productivity") || value.contains("效率") { return "checklist" }
        if value.contains("data") || value.contains("数据") { return "cylinder" }
        if value.contains("finance") || value.contains("财务") { return "creditcard" }
        return "link"
    }
    private func statusText(_ status: String) -> String {
        switch status {
        case "active": return "已连接"
        case "connecting": return "正在连接"
        case "expired": return "需要重新认证"
        case "revoked": return "授权已撤销"
        default: return "连接需要检查"
        }
    }
    private func accountFor(_ id: String) -> ConnectedConnectorAccount? { accounts.first { $0.id == id } }
    private func savePolicy(_ policy: ConnectorPolicy) {
        if let index = accounts.firstIndex(where: { $0.id == policy.accountId }) { accounts[index].policy = policy }
        Task {
            if let saved = await service.updateConnectorPolicy(policy),
               let index = accounts.firstIndex(where: { $0.id == saved.accountId }) { accounts[index].policy = saved }
        }
    }
    private func connect(_ connector: ConnectorDefinition) async {
        guard let link = await service.beginConnectorLink(connector.slug) else { return }
        do {
            let callback = try await authentication.authenticate(at: link.redirectURL)
            guard callback.scheme == "chatbridge-connectors", callback.host == "complete" else {
                service.connectorError = "认证返回地址无法核对，账号尚未启用。"; return
            }
            if let refreshed = await service.completeConnectorLink() { accounts = refreshed }
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            service.connectorError = "已取消连接，未保存账号。"
        } catch { service.connectorError = error.localizedDescription }
    }
    private func reloadAccounts() async {
        if let refreshed = await service.connectorAccounts() { accounts = refreshed }
    }
    private func reload() async {
        guard !loading else { return }
        loading = true; defer { loading = false; loaded = true }
        _ = await service.connectorProvider()
        guard service.state.connectors?.provider.configured == true else { return }
        var values: [ConnectorDefinition] = [], cursor: String?
        repeat {
            guard let page = await service.connectorCatalog(cursor: cursor) else { break }
            values.append(contentsOf: page.items)
            cursor = page.nextCursor
        } while cursor != nil && values.count < 1000
        catalog = Array(Dictionary(grouping: values, by: \.id).compactMap { $0.value.first })
        await reloadAccounts()
        if selection == nil { selection = visibleConnectors.first?.id }
    }
}

private struct ConnectorRow: View {
    let connector: ConnectorDefinition
    let accounts: [ConnectedConnectorAccount]
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "link").foregroundStyle(.secondary).frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(connector.name).font(.headline)
                Text(connector.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 6)
            if accounts.contains(where: { $0.status == "active" }) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).accessibilityLabel("已连接")
            } else if !accounts.isEmpty {
                Image(systemName: "exclamationmark.circle").foregroundStyle(.secondary).accessibilityLabel("需要处理")
            }
        }.padding(.vertical, 4)
    }
}
