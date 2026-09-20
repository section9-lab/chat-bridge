import SwiftUI

struct RoutingSettings: View {
    @ObservedObject var service: BridgeService
    @State private var apiKeys: [String: String] = [:]
    @State private var revealedProvider: String?
    @State private var keyError: String?
    private var state: RoutingState { service.state.routing ?? RoutingState() }
    private var provider: RoutingProvider { RoutingProvider.all.first { $0.id == state.provider } ?? RoutingProvider.all[0] }
    private var apiKey: String { apiKeys[provider.id] ?? "" }
    private var keyVisible: Bool { revealedProvider == provider.id }
    private var keyBinding: Binding<String> {
        let id = provider.id
        return Binding(get: { apiKeys[id] ?? "" }, set: { apiKeys[id] = $0 })
    }
    private var unavailable: Bool { !service.isRunning || service.routingBusy }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            VStack(alignment: .leading, spacing: 12) {
                Text("路由服务").font(.system(size: 14, weight: .medium))
                SettingsSegments(label: "路由服务", options: RoutingProvider.all.map { ($0.id, $0.name) },
                    selection: Binding(get: { provider.id }, set: { value in
                        Task { _ = await service.routing("configure", params: ["provider": value]) }
                    })).disabled(unavailable)
                Text("分别保存 Key，逐个验证。切换服务会先关闭智能路由。")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(provider.name + " · Jev").font(.system(size: 14, weight: .medium))
                    Text("使用 Jev 理解意图，选择 Agent、项目和会话。")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 10)
                Link("获取 API Key ↗", destination: provider.keyURL)
                    .font(.system(size: 11))
            }
            VStack(alignment: .leading, spacing: 10) {
                Text("API Key").font(.system(size: 12, weight: .medium))
                HStack(spacing: 8) {
                    Group {
                        if keyVisible {
                            TextField("粘贴 " + provider.name + " API Key", text: keyBinding)
                        } else {
                            SecureField(state.configured ? "已保存；填写新 Key 可替换" : "粘贴 " + provider.name + " API Key",
                                text: keyBinding)
                        }
                    }
                    .textFieldStyle(.roundedBorder).font(.system(size: 13))
                    .accessibilityLabel(provider.name + " API Key")
                    .id(provider.id)
                    .disabled(unavailable)
                    .onSubmit { save() }
                    Button {
                        revealedProvider = keyVisible ? nil : provider.id
                    } label: {
                        Image(systemName: keyVisible ? "eye.slash" : "eye")
                            .frame(width: 24, height: 24)
                    }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .accessibilityLabel(keyVisible ? "隐藏 API Key" : "显示 API Key")
                    .help(keyVisible ? "隐藏 API Key" : "显示 API Key")
                    .disabled(unavailable || apiKey.isEmpty)
                }
                HStack(spacing: 10) {
                    Button("保存并验证", action: save)
                        .disabled(unavailable || apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || state.expired)
                    if state.configured {
                        Button("验证连接") { Task { _ = await service.routing("test", params: ["provider": provider.id]) } }
                            .disabled(unavailable || state.expired)
                        Button("移除 Key") {
                            let id = provider.id
                            Task { if await service.routing("key.remove", params: ["provider": id]) { apiKeys[id] = ""; revealedProvider = nil } }
                        }.disabled(unavailable)
                    }
                    if service.routingBusy { ProgressView().controlSize(.small) }
                    Spacer(minLength: 0)
                    Text(state.configured ? "已存入钥匙串" : "尚未配置")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }.buttonStyle(SettingsButtonStyle())
                Text(state.expired ? "Vercel 免费试验已暂停，请先核对新的价格方案。" : provider.note)
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true).lineSpacing(3)
                if let error = service.routingError ?? keyError {
                    Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red)
                        .font(.system(size: 11)).fixedSize(horizontal: false, vertical: true)
                } else if let message = service.routingNotice {
                    Label(message, systemImage: "checkmark.circle").foregroundStyle(.secondary)
                        .font(.system(size: 11)).fixedSize(horizontal: false, vertical: true)
                }
            }
            Divider().opacity(0.45)
            VStack(alignment: .leading, spacing: 11) {
                Text("路由方式").font(.system(size: 14, weight: .medium))
                SettingsSegments(label: "路由方式", options: [("off", "关闭"), ("confirm", "确认目标"), ("auto", "自动选择")],
                    selection: Binding(get: { state.mode }, set: { value in
                        Task { _ = await service.routing("configure", params: ["mode": value]) }
                    }))
                    .disabled(unavailable || !state.configured)
                Text("建议先确认目标，体验准确后再自动选择。连续对话保持原会话；目标不明确时会询问你。")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true).lineSpacing(3)
            }
            Divider().opacity(0.45)
            VStack(alignment: .leading, spacing: 12) {
                Text("新任务的 Agent 偏好").font(.system(size: 14, weight: .medium))
                preference("规划", key: "planning", value: state.planning)
                preference("实现", key: "implementation", value: state.implementation)
                preference("研究", key: "research", value: state.research)
                Text("仅用于新任务，已有会话保持原 Agent。Gemini Deep Research 尚未接入。")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true).lineSpacing(3)
            }
            Divider().opacity(0.45)
            VStack(alignment: .leading, spacing: 8) {
                Text("开启后，消息、近期对话片段和候选名称会发送至 " + provider.recipients + " 判断目标。各服务的 Key 分别保存在本机钥匙串。")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                Link("查看服务说明与价格 ↗", destination: provider.infoURL)
                    .font(.system(size: 11))
            }.fixedSize(horizontal: false, vertical: true).lineSpacing(3)
        }
        .task(id: provider.id) { await loadKey() }
        .onDisappear { apiKeys = [:]; revealedProvider = nil }
    }
    private func loadKey() async {
        let id = provider.id
        revealedProvider = nil; keyError = nil
        _ = await service.routing("get")
        guard !Task.isCancelled, apiKeys[id] == nil else { return }
        do {
            let key = try await Task.detached(priority: .userInitiated) { try KeychainVault.routingKey(for: id) }.value
            guard !Task.isCancelled, apiKeys[id] == nil else { return }
            apiKeys[id] = key ?? ""
        } catch {
            if !Task.isCancelled { keyError = "无法读取已保存的 Key，请检查本机钥匙串后重新打开设置。" }
        }
    }
    private func save() {
        guard !unavailable, !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let id = provider.id, key = apiKey
        keyError = nil
        Task { _ = await service.routing("key.save", params: ["provider": id, "apiKey": key]) }
    }
    private func preference(_ title: String, key: String, value: String) -> some View {
        HStack {
            Text(title).font(.system(size: 12))
            Spacer()
            Picker(title + " Agent", selection: Binding(get: { value }, set: { agent in
                Task { _ = await service.routing("configure", params: [key: agent]) }
            })) {
                Text("默认 Agent").tag("default")
                ForEach(Agent.all) { agent in Text(service.displayName(agent.id)).tag(agent.id) }
            }.labelsHidden().frame(width: 172).disabled(unavailable)
        }
    }
}
