import AppKit
import Combine
import ChatBridgeKit

@MainActor
final class BridgeService: ObservableObject {
    @Published var state = BridgeState()
    @Published var status = "正在启动本地服务"
    @Published var lastError: String?
    @Published var notice: String?
    @Published var viewedAgent = "codex"
    @Published var probes: [String: AgentProbe] = [:]
    @Published var isRunning = false
    @Published var opening: Set<String> = []
    @Published var drafts: [String: String] = [:]
    @Published var draftAttachments: [String: [MessageAttachment]] = [:]
    @Published var importingAttachments: Set<String> = []
    @Published var sending: Set<String> = []
    var choosingFiles = false
    @Published var channelBusy = false
    @Published var channelErrors: [String: String] = [:]
    @Published var taskBusy: Set<String> = []
    @Published var routingBusy = false
    @Published var routingError: String?
    @Published var routingNotice: String?
    private var process: Process?
    private var input: Pipe?
    private var output: Pipe?
    private var diagnostics: Pipe?
    private var pending: [String: CheckedContinuation<Any, Error>] = [:]
    private var timeouts: [String: Task<Void, Never>] = [:]
    private var stopping = false
    private var failures = 0
    private var restart: Task<Void, Never>?
    private var generation = UUID()
    private let power = PowerManager()
    private var decoder = FrameDecoder()

    struct Failure: LocalizedError {
        let code: String
        let message: String
        var errorDescription: String? { message }
    }
    var draftKey: String {
        viewedAgent + ":" + (state.selection.agent == viewedAgent ? state.selection.sessionId ?? "new:" + (state.selection.projectId ?? "none") : "new:none")
    }
    var canSend: Bool {
        let canRoute = state.routing?.configured == true && state.routing?.mode != "off"
        return (probes[viewedAgent]?.ready == true || canRoute) && isRunning && !opening.contains(viewedAgent) && state.selection.agent == viewedAgent
    }
    var viewedSession: SessionSummary? {
        state.sessions.first { $0.id == state.selection.sessionId && $0.agent == viewedAgent }
    }
    func displayName(_ id: String) -> String { state.preferences.names[id] ?? Agent.find(id).name }

    func start() {
        guard process == nil, !stopping else { return }
        guard let resources = Bundle.main.resourceURL else { status = "找不到应用资源"; return }
        let executable = resources.appendingPathComponent("runtime/node")
        let service = resources.appendingPathComponent("service/dist/src/main.js")
        guard FileManager.default.isExecutableFile(atPath: executable.path),
              FileManager.default.fileExists(atPath: service.path) else {
            status = "应用包不完整"; lastError = "请使用 scripts/build-app.sh 构建包含本地服务的应用。"; return
        }
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Chat Bridge", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
        } catch { status = "无法打开本地数据目录"; return }
        let child = Process(), toChild = Pipe(), fromChild = Pipe(), stderrPipe = Pipe()
        child.executableURL = executable
        child.arguments = [service.path, "--data-dir", directory.path]
        child.currentDirectoryURL = resources.appendingPathComponent("service")
        // Do not inherit NODE_OPTIONS or environment injection into the bundled service.
        child.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": NSHomeDirectory(), "LANG": "en_US.UTF-8"]
        child.standardInput = toChild
        child.standardOutput = fromChild
        child.standardError = stderrPipe
        let currentGeneration = UUID()
        generation = currentGeneration
        decoder = FrameDecoder()
        fromChild.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.generation == currentGeneration else { return }
                do {
                    let frames = try self.decoder.append(data)
                    for frame in frames { self.handle(frame) }
                } catch {
                    self.lastError = "本地服务返回了无效数据，连接已停止。"
                    self.process?.terminate()
                }
            }
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { handle in
            // Drain diagnostic output; do not copy message text or credentials into logs.
            if handle.availableData.isEmpty { handle.readabilityHandler = nil }
        }
        child.terminationHandler = { [weak self] _ in
            Task { @MainActor in
                guard let self, self.generation == currentGeneration else { return }
                self.childStopped()
            }
        }
        process = child; input = toChild; output = fromChild; diagnostics = stderrPipe
        do { try child.run() }
        catch { childStopped() }
    }

    func stop() {
        stopping = true
        isRunning = false; probes = [:]
        restart?.cancel()
        power.update(enabled: false, channelConnected: false)
        rejectPending()
        try? input?.fileHandleForWriting.close()
        if process?.isRunning == true { process?.terminate() }
    }
    func retryService() {
        guard process == nil else { return }
        failures = 0; stopping = false; restart?.cancel(); lastError = nil
        start()
    }
    private func childStopped() {
        let wasRunning = isRunning
        isRunning = false
        probes = [:]
        state.channels?.weixin.connected = false
        state.channels?.weixin.status = "error"
        state.channels?.imessage?.connected = false
        state.channels?.imessage?.status = "error"
        output?.fileHandleForReading.readabilityHandler = nil
        diagnostics?.fileHandleForReading.readabilityHandler = nil
        try? input?.fileHandleForWriting.close()
        process = nil; input = nil; output = nil; diagnostics = nil
        rejectPending()
        power.update(enabled: false, channelConnected: false)
        guard !stopping else { return }
        failures += 1
        guard failures <= 5 else { status = "本地服务已停止"; lastError = "连续启动失败，请检查应用包后重试。"; return }
        let delay = [1, 2, 4, 8, 30][failures - 1]
        status = wasRunning ? "本地服务中断，\(delay) 秒后重连" : "本地服务启动失败，\(delay) 秒后重试"
        restart = Task {
            try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000_000)
            if !Task.isCancelled { self.start() }
        }
    }
    private func rejectPending() {
        let continuations = pending.values
        pending.removeAll()
        timeouts.values.forEach { $0.cancel() }; timeouts.removeAll()
        for continuation in continuations {
            continuation.resume(throwing: Failure(code: "CLOSED", message: "本地连接中断，未自动重发操作。"))
        }
    }
    func request(_ method: String, _ params: [String: Any] = [:]) async throws -> Any {
        guard process?.isRunning == true else { throw Failure(code: "CLOSED", message: "本地服务尚未启动。") }
        let id = UUID().uuidString
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            timeouts[id] = Task {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                guard !Task.isCancelled, let continuation = self.pending.removeValue(forKey: id) else { return }
                self.timeouts.removeValue(forKey: id)
                continuation.resume(throwing: Failure(code: "TIMEOUT", message: "操作超时，结果可能不确定；未自动重发。"))
            }
            write(["protocolVersion": 1, "requestId": id, "method": method, "params": params])
        }
    }
    private func write(_ object: [String: Any]) {
        do {
            var data = try JSONSerialization.data(withJSONObject: object)
            guard data.count <= 1_048_576 else { throw Failure(code: "TOO_LARGE", message: "消息过长。") }
            data.append(10)
            try input?.fileHandleForWriting.write(contentsOf: data)
        } catch { lastError = error.localizedDescription; rejectPending(); process?.terminate() }
    }
    private func handle(_ frame: [String: Any]) {
        if frame["event"] as? Bool == true {
            switch frame["method"] as? String {
            case "service.ready":
                isRunning = true; status = "本地服务运行中"
                Task { await refresh() }
            case "state.changed": updateState(frame["params"])
            case "agent.unavailable":
                if let params = frame["params"] as? [String: Any], let agent = params["agent"] as? String {
                    probes[agent]?.ready = false
                    probes[agent]?.reason = "运行时连接中断，请刷新连接；已提交任务未自动重发。"
                }
            case "service.error": lastError = "任务状态保存失败，请检查本地服务。"
            case "history.unavailable": lastError = "暂时无法读取原会话历史，请刷新后重试。"
            default: break
            }
            return
        }
        guard let id = frame["requestId"] as? String else { process?.terminate(); return }
        if let method = frame["method"] as? String {
            let params = frame["params"] as? [String: Any] ?? [:]
            if method == "native.agent.probe", let agentID = params["agent"] as? String,
               Agent.all.contains(where: { $0.id == agentID }) {
                write(["protocolVersion": 1, "requestId": id, "result": NativeAgentHost.probe(Agent.find(agentID))])
            } else if KeychainVault.methods.contains(method) {
                let data = params["credential"].flatMap { try? JSONSerialization.data(withJSONObject: $0) }
                let currentGeneration = generation
                Task {
                    let result = await Task.detached(priority: .userInitiated) {
                        Result { try KeychainVault.perform(method, credential: data) }
                    }.value
                    guard generation == currentGeneration else { return }
                    switch result {
                    case .success(let data):
                        let value: Any = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } ?? NSNull()
                        write(["protocolVersion": 1, "requestId": id, "result": value])
                    case .failure(let error):
                        let code = (error as? KeychainVault.Failure).map { "KEYCHAIN_\($0.status)" } ?? "KEYCHAIN_FAILED"
                        write(["protocolVersion": 1, "requestId": id, "error": ["code": code, "message": "凭据钥匙串操作失败。"]])
                    }
                }
            } else {
                // No automation action is enabled until a versioned desktop driver passes G0.
                let code = ["native.agent.create", "native.agent.resume", "native.agent.send"].contains(method) ? "AGENT_UNAVAILABLE" : "METHOD_NOT_FOUND"
                write(["protocolVersion": 1, "requestId": id, "error": ["code": code, "message": "桌面会话接入尚未验证，操作未执行。"]])
            }
            return
        }
        guard let continuation = pending.removeValue(forKey: id) else { return }
        timeouts.removeValue(forKey: id)?.cancel()
        if let error = frame["error"] as? [String: Any] {
            continuation.resume(throwing: Failure(code: error["code"] as? String ?? "INTERNAL",
                message: error["message"] as? String ?? "本地操作失败。"))
        } else if let result = frame["result"] { continuation.resume(returning: result) }
        else { continuation.resume(throwing: Failure(code: "INVALID_FRAME", message: "本地响应缺少结果。")) }
    }
    func updateState(_ value: Any?) {
        guard let value, let data = try? JSONSerialization.data(withJSONObject: value),
              let decoded = try? JSONDecoder().decode(BridgeState.self, from: data) else { return }
        if viewedAgent == state.selection.agent && decoded.selection.agent != state.selection.agent {
            viewedAgent = decoded.selection.agent
            notice = nil
        }
        if let routed = decoded.jobs.first(where: { candidate in
            guard candidate.routeMessage != nil, let previous = state.jobs.first(where: { $0.id == candidate.id }) else { return false }
            return previous.routeMessage == nil
        }) {
            notice = routed.routeMessage
        }
        state = decoded
        if let detected = decoded.probes { probes = detected }
        // Bindings alone are not proof of an active transport.
        power.update(enabled: decoded.preferences.keepAlive, channelConnected: decoded.channels?.connected == true)
    }
    func refresh() async {
        do {
            updateState(try await request("state.get"))
            await withTaskGroup(of: Void.self) { group in
                for agent in Agent.all where !agent.comingSoon {
                    group.addTask { _ = try? await self.request("agent.probe", ["agent": agent.id]) }
                }
            }
            updateState(try await request("state.get"))
        } catch { lastError = error.localizedDescription }
    }
    func openAgent(_ id: String) {
        viewedAgent = id; notice = nil; lastError = nil
        guard !Agent.find(id).comingSoon else { return }
        guard !opening.contains(id) else { return }
        opening.insert(id)
        Task {
            defer { opening.remove(id) }
            do { updateState(try await request("agent.open", ["agent": id])) }
            catch { if viewedAgent == id { lastError = error.localizedDescription } }
        }
    }
    func catalog(project: String?, query: String, offset: Int = 0, refresh: Bool = false) async throws -> SessionCatalog {
        var params: [String: Any] = ["agent": viewedAgent, "query": query, "offset": offset, "refresh": refresh]
        if let project { params["projectId"] = project == "none" ? NSNull() : project as Any }
        let result = try await request("catalog.get", params)
        return try JSONDecoder().decode(SessionCatalog.self, from: JSONSerialization.data(withJSONObject: result))
    }
    func navigate(_ command: String) async -> Bool {
        do {
            _ = try await request("message.send", ["text": command, "eventId": UUID().uuidString,
                "selectionVersion": state.selection.version ?? 0])
            updateState(try await request("state.get"))
            viewedAgent = state.selection.agent
            notice = nil; lastError = nil
            return true
        } catch { lastError = error.localizedDescription; return false }
    }
    func preferences(_ patch: [String: Any]) {
        Task {
            do { updateState(try await request("preferences.update", patch)); lastError = nil }
            catch { lastError = error.localizedDescription }
        }
    }
    func routing(_ action: String, params: [String: Any] = [:]) async -> Bool {
        guard !routingBusy, ["get", "key.save", "key.remove", "test", "configure"].contains(action) else { return false }
        routingBusy = true; routingError = nil; routingNotice = nil
        defer { routingBusy = false }
        do {
            let value = try await request("routing." + action, params)
            if action == "get" {
                let data = try JSONSerialization.data(withJSONObject: value)
                state.routing = try JSONDecoder().decode(RoutingState.self, from: data)
            } else { updateState(value) }
            if action == "key.save" { routingNotice = "Key 已保存到钥匙串，Jev 连接验证通过。请选择路由方式开始试用。" }
            if action == "test" { routingNotice = "Jev 连接验证通过。" }
            if action == "key.remove" { routingNotice = "Key 已移除，智能路由已关闭。" }
            return true
        } catch { routingError = channelErrorMessage(error); return false }
    }
    func resolveRouting(_ job: JobSummary, index: Int) {
        guard !taskBusy.contains(job.id), job.status == "awaiting_route" else { return }
        taskBusy.insert(job.id)
        Task {
            defer { taskBusy.remove(job.id) }
            do {
                updateState(try await request("routing.resolve", ["jobId": job.id, "index": index]))
                lastError = nil
            } catch { lastError = error.localizedDescription }
        }
    }
    func weixin(_ action: String, params: [String: Any] = [:]) {
        guard !channelBusy, ["start", "cancel", "confirm", "verify", "reconnect", "disconnect"].contains(action) else { return }
        channelBusy = true; channelErrors.removeValue(forKey: "weixin"); lastError = nil
        Task {
            defer { channelBusy = false }
            do { updateState(try await request("channel.weixin." + action, params)); lastError = nil }
            catch { channelErrors["weixin"] = channelErrorMessage(error) }
        }
    }
    func imessage(_ action: String, params: [String: Any] = [:]) {
        guard !channelBusy, ["start", "verify", "confirm", "reconnect", "disconnect"].contains(action) else { return }
        channelBusy = true; channelErrors.removeValue(forKey: "imessage"); lastError = nil
        Task {
            defer { channelBusy = false }
            do { updateState(try await request("channel.imessage." + action, params)); lastError = nil }
            catch { channelErrors["imessage"] = channelErrorMessage(error) }
        }
    }
    private func channelErrorMessage(_ error: Error) -> String {
        guard let failure = error as? Failure else { return error.localizedDescription }
        let prefix = failure.code + ": "
        return failure.message.hasPrefix(prefix) ? String(failure.message.dropFirst(prefix.count)) : failure.message
    }
    func taskAction(_ action: String, job: JobSummary) {
        guard !taskBusy.contains(job.id), (action == "continue" && job.canContinue) || (action == "cancel" && job.canCancel) || (action == "stop" && job.canStop) else { return }
        taskBusy.insert(job.id)
        Task {
            defer { taskBusy.remove(job.id) }
            do {
                updateState(try await request("task.action", ["action": action, "jobId": job.id, "eventId": UUID().uuidString]))
                lastError = nil
            } catch { lastError = error.localizedDescription }
        }
    }
    func approvalAction(_ action: String, approval: ApprovalSummary) {
        guard !taskBusy.contains(approval.id), ["approve", "deny"].contains(action), approval.status == "pending" else { return }
        taskBusy.insert(approval.id)
        Task {
            defer { taskBusy.remove(approval.id) }
            do {
                updateState(try await request("approval.action", ["action": action, "approvalId": approval.id, "eventId": UUID().uuidString]))
                lastError = nil
            } catch { lastError = error.localizedDescription }
        }
    }
    func updateDraft(_ text: String) {
        let key = draftKey, previous = drafts[key] ?? ""
        drafts[key] = text
        guard canSend, !choosingFiles, !sending.contains(key), !importingAttachments.contains(key),
              text.count == previous.count + 1 else { return }
        var index = text.startIndex
        for (old, new) in zip(previous, text) {
            if old != new { break }
            index = text.index(after: index)
        }
        guard index < text.endIndex, text[index] == "@",
              index == text.startIndex || text[text.index(before: index)].isWhitespace else { return }
        var withoutMention = text; withoutMention.remove(at: index)
        guard withoutMention == previous else { return }
        drafts[key] = withoutMention
        chooseFiles()
    }
    func chooseFiles() {
        let key = draftKey
        guard canSend, !choosingFiles, !importingAttachments.contains(key) else { return }
        guard (draftAttachments[key]?.count ?? 0) < 10 else {
            lastError = "每条消息最多附加 10 个文件。"; return
        }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.prompt = "添加文件"
        panel.message = "最多 10 个文件，单个文件不超过 50 MiB。发送消息时会交给目标 Agent。"
        choosingFiles = true
        let parent = NSApp.keyWindow
        NSApp.activate(ignoringOtherApps: true)
        let completion: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard let self else { return }
            self.choosingFiles = false
            if response == .OK { Task { await self.addAttachments(panel.urls, to: key) } }
        }
        if let parent { panel.beginSheetModal(for: parent, completionHandler: completion) }
        else { panel.begin(completionHandler: completion) }
    }
    func addAttachments(_ urls: [URL], to key: String) async {
        guard !urls.isEmpty, !importingAttachments.contains(key) else { return }
        guard (draftAttachments[key]?.count ?? 0) + urls.count <= 10 else {
            lastError = "每条消息最多附加 10 个文件。"; return
        }
        importingAttachments.insert(key)
        let scoped = urls.filter { $0.startAccessingSecurityScopedResource() }
        defer {
            importingAttachments.remove(key)
            scoped.forEach { $0.stopAccessingSecurityScopedResource() }
        }
        do {
            let result = try await request("attachments.import", ["paths": urls.map(\.path)])
            let files = try JSONDecoder().decode([MessageAttachment].self, from: JSONSerialization.data(withJSONObject: result))
            draftAttachments[key, default: []].append(contentsOf: files)
            lastError = nil
        } catch { lastError = error.localizedDescription }
    }
    func removeAttachment(_ id: String) {
        draftAttachments[draftKey]?.removeAll { $0.id == id }
    }
    func send(_ text: String, clearDraft: Bool = false) {
        let key = draftKey
        let version = state.selection.version ?? 0
        guard !sending.contains(key), !importingAttachments.contains(key) else { return }
        let files = clearDraft ? draftAttachments[key] ?? [] : []
        sending.insert(key)
        Task {
            defer { sending.remove(key) }
            do {
                let result = try await request("message.send", ["text": text, "eventId": UUID().uuidString,
                    "attachmentIds": files.map(\.id),
                    "selectionVersion": version]) as? [String: Any]
                if clearDraft && (files.isEmpty || result?["jobId"] != nil) {
                    if drafts[key] == text { drafts[key] = "" }
                    draftAttachments[key]?.removeAll { file in files.contains { $0.id == file.id } }
                }
                notice = result?["message"] as? String
                lastError = nil
            } catch { lastError = error.localizedDescription }
        }
    }
}
