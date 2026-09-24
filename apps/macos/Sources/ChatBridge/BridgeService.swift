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
    @Published var draftSelections: [String: NSRange] = [:]
    @Published var fileMention: FileMention?
    @Published var fileSuggestions: [FileSuggestion] = []
    @Published var highlightedFile = 0
    @Published var searchingFiles = false
    @Published var fileSearchIncomplete = false
    private var fileSearchTask: Task<Void, Never>?
    private var fileSearchID = UUID()
    private var dismissedMention: FileMention?
    private var fileSearchDraft: String?
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
            guard candidate.routeMessage != nil, candidate.status == "completed",
                  let previous = state.jobs.first(where: { $0.id == candidate.id }) else { return false }
            return previous.routeMessage == nil
        }) {
            // Only a result that is itself the reply (status, a list, a switch) becomes a notice. A
            // dispatched task's "received" receipt is for the phone; here its bubble and status card show it.
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
            if action == "key.remove" { routingNotice = "Key 已移除，请重新保存 Key 后再使用智能路由。" }
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
    var fileSearchRoots: [URL] {
        var paths = (state.projects ?? []).filter { $0.agent == viewedAgent && $0.id == state.selection.projectId }.flatMap(\.roots)
        if let cwd = viewedSession?.cwd { paths.insert(cwd, at: 0) }
        let home = FileManager.default.homeDirectoryForCurrentUser
        paths += ["Desktop", "Downloads", "Documents"].map { home.appendingPathComponent($0).path }
        var seen: Set<String> = []
        return paths.filter { $0.hasPrefix("/") && seen.insert($0).inserted }.map { URL(fileURLWithPath: $0) }
    }
    func updateDraft(_ text: String, selection: NSRange? = nil, composing: Bool = false) {
        let key = draftKey
        drafts[key] = text
        let caret = selection ?? NSRange(location: (text as NSString).length, length: 0)
        draftSelections[key] = caret
        let mention = FileMention.find(in: text, selection: caret)
        if fileSearchDraft != key || mention != dismissedMention { dismissedMention = nil }
        guard canSend, !composing, !sending.contains(key), !importingAttachments.contains(key),
              let mention, mention != dismissedMention else { dismissFileSearch(remember: false); return }
        if fileMention == mention && fileSearchDraft == key { return }
        dismissedMention = nil
        fileSearchTask?.cancel()
        let id = UUID(), roots = fileSearchRoots
        fileSearchID = id; fileSearchDraft = key
        fileMention = mention; fileSuggestions = []; highlightedFile = 0; searchingFiles = true
        fileSearchIncomplete = false
        fileSearchTask = Task {
            do { try await Task.sleep(nanoseconds: 180_000_000) } catch { return }
            let result = await FileSearch.search(mention.query, roots: roots)
            guard !Task.isCancelled, fileSearchID == id, draftKey == key else { return }
            fileSuggestions = result.files; fileSearchIncomplete = result.incomplete; searchingFiles = false
        }
    }
    func beginFileSearch() {
        let key = draftKey
        guard canSend, !sending.contains(key), !importingAttachments.contains(key) else { return }
        guard (draftAttachments[key]?.count ?? 0) < 10 else {
            lastError = "每条消息最多附加 10 个文件。"; return
        }
        let text = drafts[key] ?? ""
        let end = NSRange(location: (text as NSString).length, length: 0)
        let saved = draftSelections[key] ?? end
        let selection = Range(saved, in: text) == nil ? end : saved
        dismissedMention = nil
        if FileMention.find(in: text, selection: selection) != nil { updateDraft(text, selection: selection); return }
        guard let range = Range(selection, in: text) else { return }
        let prefix = text[..<range.lowerBound]
        let token = (prefix.isEmpty || prefix.last?.isWhitespace == true ? "" : " ") + "@"
        updateDraft(text.replacingCharacters(in: range, with: token), selection: NSRange(location: selection.location + (token as NSString).length, length: 0))
    }
    func dismissFileSearch(remember: Bool = true) {
        if remember { dismissedMention = fileMention }
        fileSearchTask?.cancel(); fileSearchID = UUID()
        fileMention = nil; fileSuggestions = []; searchingFiles = false; highlightedFile = 0
    }
    func moveFileHighlight(_ offset: Int) {
        guard !fileSuggestions.isEmpty else { return }
        highlightedFile = (highlightedFile + offset + fileSuggestions.count) % fileSuggestions.count
    }
    func attachSuggestedFile(_ file: FileSuggestion) {
        guard let mention = fileMention, fileSearchDraft == draftKey else { return }
        let key = draftKey, original = drafts[key] ?? ""
        Task {
            guard await addAttachments([file.url], to: key) else { return }
            if drafts[key] == original {
                drafts[key] = (original as NSString).replacingCharacters(in: mention.range, with: "")
                draftSelections[key] = NSRange(location: mention.range.location, length: 0)
            }
            if fileSearchDraft == key { dismissFileSearch() }
        }
    }
    @discardableResult
    func addAttachments(_ urls: [URL], to key: String) async -> Bool {
        guard !urls.isEmpty, !importingAttachments.contains(key) else { return false }
        guard (draftAttachments[key]?.count ?? 0) + urls.count <= 10 else {
            lastError = "每条消息最多附加 10 个文件。"; return false
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
            return true
        } catch { lastError = error.localizedDescription; return false }
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
