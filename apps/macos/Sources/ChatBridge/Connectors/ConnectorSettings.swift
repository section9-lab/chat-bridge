import AppKit
import AuthenticationServices
import SwiftUI

/// The settings pane owns its browsing state; connector data remains in the bridge service.
struct ConnectorSettings: View {
    @ObservedObject var service: BridgeService
    @StateObject private var authentication = ConnectorAuthSession()
    @State private var provider: ConnectorProviderState?
    @State private var items: [ConnectorDefinition] = []
    @State private var accounts: [ConnectedConnectorAccount] = []
    @State private var query = ""
    @State private var appliedQuery = ""
    @State private var nextCursor: String?
    @State private var loading = false
    @State private var initialLoad = true
    @State private var selected: ConnectorDefinition?
    @State private var apiKey = ""
    @State private var editingKey = false
    @State private var removingKey = false
    @State private var disconnecting: ConnectedConnectorAccount?
    @State private var savingAccounts: Set<String> = []
    @FocusState private var searchFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().opacity(0.5)
            if initialLoad {
                ProgressView("正在检查连接器服务…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !service.isRunning {
                placeholder("本地服务未就绪", detail: "请先重新启动本地服务。", symbol: "exclamationmark.circle")
            } else if provider?.configured != true {
                setup
            } else if let connector = selected {
                details(connector)
            } else {
                catalog
            }
        }
        .task { await initialize() }
        .onChange(of: service.isRunning) { running in
            if running && provider == nil { Task { await initialize() } }
        }
        .alert("移除 Composio API Key？", isPresented: $removingKey) {
            Button("取消", role: .cancel) {}
            Button("移除", role: .destructive) {
                Task {
                    if await service.removeConnectorKey() {
                        provider = service.state.connectors?.provider
                        items = []; accounts = []; selected = nil; nextCursor = nil
                    }
                }
            }
        } message: {
            Text("此 Mac 将无法访问连接器。Composio 中的账号和上游授权不会自动删除。")
        }
        .alert("断开账号？", isPresented: Binding(get: { disconnecting != nil }, set: { if !$0 { disconnecting = nil } })) {
            Button("取消", role: .cancel) { disconnecting = nil }
            Button("断开连接", role: .destructive) {
                guard let account = disconnecting else { return }
                disconnecting = nil
                Task {
                    if await service.disconnectConnectorAccount(account.id) { await refreshAccounts() }
                }
            }
        } message: {
            Text("将断开此账号并请求撤销上游授权。已经提交的外部操作不会被撤回。")
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            if selected != nil {
                Button { selected = nil; service.connectorError = nil; service.connectorNotice = nil } label: {
                    Image(systemName: "chevron.left")
                }
                .buttonStyle(.plain).help("返回连接器列表").accessibilityLabel("返回连接器列表")
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(selected?.name ?? "连接器").font(.system(size: 15, weight: .semibold))
                Text(selected == nil ? "连接外部服务，管理账号和访问范围。" : "管理此服务的账号与访问策略。")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if provider?.configured == true {
                Menu {
                    Button("刷新") { Task { await refresh() } }
                    Button("更换 API Key…") { editingKey = true; service.connectorError = nil }
                    Divider()
                    Button("移除 API Key…", role: .destructive) { removingKey = true }
                } label: {
                    Image(systemName: "ellipsis.circle").font(.system(size: 16))
                }
                .menuStyle(.borderlessButton).fixedSize()
                .help("连接器服务选项").accessibilityLabel("连接器服务选项")
                .disabled(loading || service.connectorBusy)
            }
        }
        .padding(.horizontal, 28).padding(.vertical, 18)
    }

    private var setup: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Label("设置 Composio", systemImage: "link.badge.plus")
                    .font(.system(size: 15, weight: .semibold))
                Text("使用你自己的 Composio API Key 浏览并连接外部服务。Key 保存到这台 Mac 的钥匙串；认证和服务数据由 Composio 及所选服务处理。")
                    .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                SecureField("Composio API Key", text: $apiKey)
                    .textFieldStyle(.roundedBorder).accessibilityLabel("Composio API Key")
                    .onSubmit { Task { await saveKey() } }
                HStack {
                    Link("获取 API Key", destination: URL(string: "https://platform.composio.dev")!)
                    Spacer()
                    if service.connectorBusy { ProgressView().controlSize(.small) }
                    Button("保存并验证") { Task { await saveKey() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(apiKey.isEmpty || service.connectorBusy)
                }
                feedback
                executionNotice
            }
            .padding(28).frame(maxWidth: 520, alignment: .leading)
        }
    }

    private var catalog: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("搜索连接器", text: $query)
                    .textFieldStyle(.plain).focused($searchFocused)
                    .accessibilityLabel("搜索连接器")
                    .onSubmit { Task { await search() } }
                if !query.isEmpty {
                    Button {
                        query = ""
                        Task { await search() }
                    } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("清除搜索")
                }
                Button("搜索") { Task { await search() } }
                    .disabled(loading).buttonStyle(SettingsButtonStyle())
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
            .overlay(alignment: .trailing) {
                Button("") { searchFocused = true }.keyboardShortcut("f", modifiers: .command)
                    .opacity(0).accessibilityHidden(true)
            }
            HStack {
                Text(appliedQuery.isEmpty ? "浏览服务" : "搜索结果：\(appliedQuery)")
                    .font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
                Spacer()
                Text("已连接 \(accounts.filter { $0.status == "active" }.count)")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                if loading { ProgressView().controlSize(.small) }
            }
            feedback
            if loading && items.isEmpty {
                ProgressView("正在加载连接器…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if items.isEmpty {
                placeholder(appliedQuery.isEmpty ? "暂无连接器" : "没有找到连接器",
                            detail: service.connectorError == nil ? (appliedQuery.isEmpty ? "刷新后重试。" : "试试其他服务名称。") : "请检查上方错误后重试。",
                            symbol: appliedQuery.isEmpty ? "link" : "magnifyingglass")
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(items) { item in
                            Button {
                                selected = item; service.connectorError = nil; service.connectorNotice = nil
                            } label: { row(item) }
                            .buttonStyle(.plain)
                            Divider().opacity(0.45)
                        }
                        if nextCursor != nil {
                            Button("加载更多") { Task { await loadMore() } }
                                .buttonStyle(SettingsButtonStyle()).disabled(loading).padding(.vertical, 12)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 28).padding(.top, 18).padding(.bottom, 12)
        .sheet(isPresented: $editingKey) { keySheet }
    }

    private func row(_ item: ConnectorDefinition) -> some View {
        let related = accounts.filter { $0.connectorSlug == item.slug }
        let active = related.filter { $0.status == "active" }.count
        return HStack(spacing: 12) {
            Image(systemName: "link").foregroundStyle(.secondary).frame(width: 30, height: 30)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.name).font(.system(size: 13, weight: .medium)).lineLimit(1)
                Text(item.description).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 8)
            Text(active > 0 ? "已连接 \(active)" : related.isEmpty ? "未连接" : "需要检查")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            Image(systemName: "chevron.right").font(.system(size: 10)).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 12).contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("查看账号和配置")
    }

    private func details(_ connector: ConnectorDefinition) -> some View {
        let related = accounts.filter { $0.connectorSlug == connector.slug }
        return ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text(connector.description).font(.system(size: 12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                executionNotice
                HStack {
                    Text("账号").font(.system(size: 13, weight: .semibold))
                    Spacer()
                    Button(related.isEmpty ? "连接账号…" : "连接其他账号…") {
                        Task { await connect(connector) }
                    }
                    .buttonStyle(SettingsButtonStyle())
                    .disabled(service.connectorBusy || authentication.running || !service.isRunning)
                }
                if authentication.running { ProgressView("请在系统窗口中完成认证…").controlSize(.small) }
                feedback
                if related.isEmpty {
                    Label("尚未连接账号", systemImage: "person.crop.circle.badge.plus")
                        .font(.system(size: 12)).foregroundStyle(.secondary).padding(.vertical, 10)
                } else {
                    ForEach(related) { account in accountView(account, connector: connector) }
                }
            }
            .padding(28).frame(maxWidth: .infinity, alignment: .leading)
        }
        .sheet(isPresented: $editingKey) { keySheet }
    }

    private func accountView(_ account: ConnectedConnectorAccount, connector: ConnectorDefinition) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(account.label ?? connector.name).font(.system(size: 13, weight: .medium))
                    Label(statusText(account.status), systemImage: account.status == "active" ? "checkmark.circle" : "exclamationmark.circle")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Spacer()
                if savingAccounts.contains(account.id) { ProgressView().controlSize(.small) }
                Menu {
                    if account.status != "active" {
                        Button("重新连接…") { Task { await connect(connector) } }
                    }
                    Button("断开连接…", role: .destructive) { disconnecting = account }
                } label: { Image(systemName: "ellipsis.circle") }
                .menuStyle(.borderlessButton).fixedSize().accessibilityLabel("账号选项")
                .disabled(service.connectorBusy || savingAccounts.contains(account.id))
            }
            Divider()
            Text("预先授权给").font(.system(size: 12, weight: .medium))
            Text("连接账号不会自动授权任何 Agent。以下设置将在工具执行功能开放后生效。")
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            ForEach(Agent.all.filter { !$0.comingSoon }) { agent in
                Toggle(service.displayName(agent.id), isOn: Binding(get: {
                    current(account.id)?.policy.allowedAgents.contains(agent.id) == true
                }, set: { enabled in
                    guard var policy = current(account.id)?.policy else { return }
                    policy.allowedAgents.removeAll { $0 == agent.id }
                    if enabled { policy.allowedAgents.append(agent.id) }
                    save(policy)
                }))
                .toggleStyle(.checkbox).disabled(savingAccounts.contains(account.id) || !service.isRunning)
            }
            Picker("操作策略", selection: Binding(get: {
                current(account.id)?.policy.mode ?? "confirm-writes"
            }, set: { mode in
                guard var policy = current(account.id)?.policy else { return }
                policy.mode = mode; save(policy)
            })) {
                Text("只读").tag("read-only")
                Text("更改前询问").tag("confirm-writes")
                Text("允许一般更改").tag("allow-writes")
            }
            .disabled(savingAccounts.contains(account.id) || !service.isRunning)
        }
        .padding(16)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.65), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(nsColor: .separatorColor).opacity(0.5)))
    }

    private var keySheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("更换 Composio API Key").font(.headline)
            Text("新 Key 验证通过后才会替换已保存的 Key。不同项目的连接账号可能不同。")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            SecureField("新 API Key", text: $apiKey).textFieldStyle(.roundedBorder)
            feedback
            HStack {
                Spacer()
                Button("取消") { editingKey = false; apiKey = ""; service.connectorError = nil }
                    .keyboardShortcut(.cancelAction)
                Button("保存并验证") { Task { await saveKey() } }
                    .keyboardShortcut(.defaultAction).disabled(apiKey.isEmpty || service.connectorBusy)
            }
        }.padding(24).frame(width: 440)
    }

    @ViewBuilder private var feedback: some View {
        if let error = service.connectorError {
            Label(error, systemImage: "exclamationmark.circle").font(.system(size: 11))
                .foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        } else if let notice = service.connectorNotice {
            Label(notice, systemImage: "info.circle").font(.system(size: 11))
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }
    private var executionNotice: some View {
        Label("连接器账号可配置；Agent 调用外部工具尚未开放。", systemImage: "info.circle")
            .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
    private func placeholder(_ title: String, detail: String, symbol: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 24)).foregroundStyle(.secondary)
            Text(title).font(.system(size: 13, weight: .medium))
            Text(detail).font(.system(size: 11)).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }.frame(maxWidth: .infinity, maxHeight: .infinity).padding(20)
    }
    private func current(_ id: String) -> ConnectedConnectorAccount? { accounts.first { $0.id == id } }
    private func statusText(_ status: String) -> String {
        switch status {
        case "active": return "已连接"
        case "connecting": return "等待认证"
        case "expired": return "授权已过期"
        case "revoked": return "授权已撤销"
        default: return "连接需要检查"
        }
    }
    private func initialize() async {
        guard service.isRunning else { initialLoad = false; return }
        initialLoad = true
        provider = await service.connectorProvider()
        initialLoad = false
        if provider?.configured == true { await refresh() }
    }
    private func saveKey() async {
        if await service.saveConnectorKey(apiKey) {
            apiKey = ""; editingKey = false
            provider = service.state.connectors?.provider
            await refresh()
        }
    }
    private func refresh() async {
        guard !loading else { return }
        loading = true; defer { loading = false }
        if let state = await service.connectorProvider() { provider = state }
        guard provider?.configured == true else { return }
        appliedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let page = await service.connectorCatalog(search: appliedQuery)
        let catalogError = service.connectorError
        if let page { items = page.items; nextCursor = page.nextCursor }
        await refreshAccounts()
        if let catalogError { service.connectorError = catalogError }
    }
    private func search() async { await refresh() }
    private func loadMore() async {
        guard !loading, let cursor = nextCursor else { return }
        loading = true; defer { loading = false }
        if let page = await service.connectorCatalog(search: appliedQuery, cursor: cursor) {
            let existing = Set(items.map(\.id))
            items.append(contentsOf: page.items.filter { !existing.contains($0.id) })
            nextCursor = page.nextCursor == cursor ? nil : page.nextCursor
        }
    }
    private func refreshAccounts() async {
        if let refreshed = await service.connectorAccounts() { accounts = refreshed }
    }
    private func save(_ policy: ConnectorPolicy) {
        guard !savingAccounts.contains(policy.accountId) else { return }
        savingAccounts.insert(policy.accountId)
        Task {
            defer { savingAccounts.remove(policy.accountId) }
            if let saved = await service.updateConnectorPolicy(policy),
               let index = accounts.firstIndex(where: { $0.id == saved.accountId }) { accounts[index].policy = saved }
        }
    }
    private func connect(_ connector: ConnectorDefinition) async {
        guard let link = await service.beginConnectorLink(connector.slug) else { return }
        do {
            let callback = try await authentication.authenticate(at: link.redirectURL)
            guard callback.scheme == "chatbridge-connectors", callback.host == "complete" else {
                service.connectorError = "认证返回地址无法核对，请刷新账号状态。"; return
            }
            if let refreshed = await service.completeConnectorLink() {
                accounts = refreshed
                if !refreshed.contains(where: { $0.connectorSlug == connector.slug && $0.status == "active" }) {
                    service.connectorNotice = "尚未确认账号已连接，请稍后刷新状态。"
                }
            }
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            service.connectorNotice = "已取消认证；若授权已在网页完成，请刷新状态。"
        } catch { service.connectorError = error.localizedDescription }
    }
}
