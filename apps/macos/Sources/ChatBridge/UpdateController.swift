import AppKit
import CryptoKit
import Foundation

struct UpdateRelease: Equatable {
    let version: String
    let tag: String
    let pageURL: URL
    let assetName: String
    let assetURL: URL
    let checksumURL: URL?
}

enum UpdateStatus: Equatable {
    case idle
    case checking
    case upToDate(String)
    case available(UpdateRelease)
    case downloading(UpdateRelease)
    case installing(UpdateRelease)
    case failed(String)

    var isBusy: Bool {
        switch self {
        case .checking, .downloading, .installing: return true
        default: return false
        }
    }

    var release: UpdateRelease? {
        switch self {
        case .available(let release), .downloading(let release), .installing(let release): return release
        default: return nil
        }
    }

    var label: String {
        switch self {
        case .idle: return "尚未检查"
        case .checking: return "正在检查更新…"
        case .upToDate(let version): return "已是最新版本 \(version)"
        case .available(let release): return "发现新版本 \(release.version)"
        case .downloading: return "正在下载更新…"
        case .installing(let release): return "正在安装 \(release.version)…"
        case .failed(let message): return message
        }
    }
}

enum UpdateError: LocalizedError {
    case invalidRelease
    case network(String)
    case server(Int)
    case checksum(String)
    case install(String)

    var errorDescription: String? {
        switch self {
        case .invalidRelease: return "更新信息格式不正确。"
        case .network(let detail): return "检查更新失败：\(detail)"
        case .server(let status): return "检查更新失败（HTTP \(status)）。"
        case .checksum(let detail): return "更新包校验失败：\(detail)"
        case .install(let detail): return detail
        }
    }
}

struct UpdateChecker {
    let currentVersion: String
    let architecture: String
    let endpoint: URL

    init(currentVersion: String, architecture: String,
         endpoint: URL = URL(string: "https://api.github.com/repos/section9-lab/chat-bridge/releases/latest")!) {
        self.currentVersion = currentVersion
        self.architecture = architecture
        self.endpoint = endpoint
    }

    private struct Response: Decodable {
        struct Asset: Decodable {
            let name: String
            let browserDownloadURL: String
            enum CodingKeys: String, CodingKey { case name, browserDownloadURL = "browser_download_url" }
        }
        let tagName: String
        let htmlURL: String
        let assets: [Asset]
        enum CodingKeys: String, CodingKey { case tagName = "tag_name", htmlURL = "html_url", assets }
    }

    func release(from data: Data) throws -> UpdateRelease? {
        let response = try JSONDecoder().decode(Response.self, from: data)
        guard let version = Self.normalizedVersion(response.tagName),
              Self.isNewer(version, than: currentVersion) else { return nil }
        let suffix = architecture == "arm64" ? "-macos-arm64.dmg" : "-macos-x86_64.dmg"
        guard let asset = response.assets.first(where: { $0.name.hasSuffix(suffix) }),
              let assetURL = URL(string: asset.browserDownloadURL) else { return nil }
        let checksum = response.assets.first(where: { $0.name == "SHA256SUMS.txt" })
            .flatMap { URL(string: $0.browserDownloadURL) }
        return UpdateRelease(version: version, tag: response.tagName,
            pageURL: URL(string: response.htmlURL) ?? endpoint,
            assetName: asset.name, assetURL: assetURL, checksumURL: checksum)
    }

    static func isNewer(_ candidate: String, than current: String) -> Bool {
        guard let left = versionParts(candidate), let right = versionParts(current) else { return false }
        for index in 0..<3 {
            if left[index] != right[index] { return left[index] > right[index] }
        }
        return false
    }

    static func normalizedVersion(_ value: String) -> String? {
        guard versionParts(value) != nil else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed.hasPrefix("v") || trimmed.hasPrefix("V")) ? String(trimmed.dropFirst()) : trimmed
    }

    private static func versionParts(_ value: String) -> [Int]? {
        var text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("v") || text.hasPrefix("V") { text = String(text.dropFirst()) }
        if let dash = text.firstIndex(of: "-") { text = String(text[..<dash]) }
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...3).contains(parts.count) else { return nil }
        var numbers: [Int] = []
        for part in parts {
            guard let number = Int(part), number >= 0 else { return nil }
            numbers.append(number)
        }
        while numbers.count < 3 { numbers.append(0) }
        return numbers
    }
}

private func defaultUpdateFetch(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    do {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw UpdateError.network("服务器没有返回 HTTP 响应。")
        }
        return (data, http)
    } catch let error as UpdateError {
        throw error
    } catch {
        throw UpdateError.network(error.localizedDescription)
    }
}

@MainActor
final class UpdateController: ObservableObject {
    @Published private(set) var status: UpdateStatus = .idle
    var onChange: ((UpdateStatus) -> Void)?

    private let checker: UpdateChecker
    private let fetch: (URLRequest) async throws -> (Data, HTTPURLResponse)
    private let installer: UpdateInstaller
    private var timer: Timer?
    private var installing = false

    init(currentVersion: String = AppVersion.current,
         architecture: String = UpdateController.architecture,
         fetch: @escaping (URLRequest) async throws -> (Data, HTTPURLResponse) = defaultUpdateFetch,
         installer: UpdateInstaller = UpdateInstaller()) {
        self.checker = UpdateChecker(currentVersion: currentVersion, architecture: architecture)
        self.fetch = fetch
        self.installer = installer
    }

    nonisolated static var architecture: String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x86_64"
        #endif
    }

    func start() {
        guard timer == nil else { return }
        let timer = Timer(timeInterval: 60 * 60, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.check(manual: false) }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            await check(manual: false)
        }
    }

    @discardableResult
    func check(manual: Bool) async -> UpdateStatus {
        guard !status.isBusy, !installing else { return status }
        setStatus(.checking)
        do {
            var request = URLRequest(url: checker.endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            request.setValue("ChatBridge/\(AppVersion.current)", forHTTPHeaderField: "User-Agent")
            let (data, response) = try await fetch(request)
            guard response.statusCode == 200 else { throw UpdateError.server(response.statusCode) }
            if let release = try checker.release(from: data) {
                setStatus(.available(release))
            } else {
                setStatus(.upToDate(AppVersion.current))
            }
        } catch {
            setStatus(.failed(error.localizedDescription))
        }
        return status
    }

    func install(_ release: UpdateRelease) {
        guard !installing, !status.isBusy else { return }
        installing = true
        setStatus(.downloading(release))
        Task { @MainActor in
            do {
                try await installer.install(release)
                setStatus(.installing(release))
                try? await Task.sleep(nanoseconds: 500_000_000)
                NSApp.terminate(nil)
            } catch {
                installing = false
                setStatus(.failed(error.localizedDescription))
            }
        }
    }

    private func setStatus(_ next: UpdateStatus) {
        status = next
        onChange?(next)
    }
}

struct UpdateInstaller {
    let target: URL

    init(target: URL = Bundle.main.bundleURL) {
        self.target = target
    }

    func install(_ release: UpdateRelease) async throws {
        let fm = FileManager.default
        guard !target.path.contains("/AppTranslocation/") else {
            throw UpdateError.install("当前应用处于临时位置。请先把 Chat Bridge 移到“应用程序”文件夹后再升级。")
        }
        guard fm.isWritableFile(atPath: target.deletingLastPathComponent().path),
              fm.isWritableFile(atPath: target.path) else {
            throw UpdateError.install("没有权限替换当前应用。请把 Chat Bridge 放到“应用程序”文件夹，或从官网重新安装。")
        }

        let temp = fm.temporaryDirectory.appendingPathComponent("ChatBridgeUpdate-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: temp, withIntermediateDirectories: true)
        do {
            let dmg = temp.appendingPathComponent(release.assetName)
            let (download, response) = try await URLSession.shared.download(from: release.assetURL)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                throw UpdateError.server((response as? HTTPURLResponse)?.statusCode ?? 0)
            }
            try fm.moveItem(at: download, to: dmg)
            try await verifyChecksum(dmg, release: release)
            try verifyBundle(dmg: dmg, release: release, temp: temp)
            try launchInstaller(temp: temp)
        } catch {
            try? fm.removeItem(at: temp)
            throw error
        }
    }

    private func verifyChecksum(_ dmg: URL, release: UpdateRelease) async throws {
        guard let checksumURL = release.checksumURL else {
            throw UpdateError.checksum("发布缺少 SHA256SUMS.txt。")
        }
        let (data, response) = try await URLSession.shared.data(from: checksumURL)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw UpdateError.checksum("无法下载校验文件。")
        }
        let expected = String(decoding: data, as: UTF8.self).split(whereSeparator: \.isNewline)
            .first { $0.split(whereSeparator: \.isWhitespace).last == Substring(release.assetName) }
            .flatMap { $0.split(whereSeparator: \.isWhitespace).first.map(String.init) }
        let digest = SHA256.hash(data: try Data(contentsOf: dmg)).map { String(format: "%02x", $0) }.joined()
        guard let expected, expected.caseInsensitiveCompare(digest) == .orderedSame else {
            throw UpdateError.checksum("下载文件与发布校验值不一致。")
        }
    }

    private func verifyBundle(dmg: URL, release: UpdateRelease, temp: URL) throws {
        let mount = temp.appendingPathComponent("mount", isDirectory: true)
        try FileManager.default.createDirectory(at: mount, withIntermediateDirectories: true)
        try run("/usr/bin/hdiutil", ["attach", dmg.path, "-nobrowse", "-readonly", "-mountpoint", mount.path])
        defer { _ = try? run("/usr/bin/hdiutil", ["detach", mount.path, "-quiet"]) }
        let source = mount.appendingPathComponent("Chat Bridge.app")
        let infoURL = source.appendingPathComponent("Contents/Info.plist")
        guard let info = NSDictionary(contentsOf: infoURL) as? [String: Any],
              info["CFBundleIdentifier"] as? String == "com.chatbridge.app",
              let version = info["ChatBridgeReleaseVersion"] as? String,
              version == release.version else {
            throw UpdateError.install("更新包中的应用信息与发布版本不一致。")
        }
        try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", source.path])
        let staged = temp.appendingPathComponent("Chat Bridge.app")
        try run("/usr/bin/ditto", [source.path, staged.path])
    }

    private func launchInstaller(temp: URL) throws {
        let script = temp.appendingPathComponent("install.sh")
        let text = """
        #!/bin/bash
        set -euo pipefail
        parent="$1"; target="$2"; staged="$3"; temp="$4"
        while kill -0 "$parent" 2>/dev/null; do sleep 0.2; done
        backup="${target}.old"
        rm -rf "$backup"
        mv "$target" "$backup"
        ditto "$staged" "$target"
        /usr/bin/xattr -dr com.apple.quarantine "$target" || true
        /usr/bin/open "$target"
        rm -rf "$backup" "$temp"
        """
        try text.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [script.path, String(ProcessInfo.processInfo.processIdentifier),
                             target.path, temp.appendingPathComponent("Chat Bridge.app").path, temp.path]
        try process.run()
    }

    @discardableResult
    private func run(_ path: String, _ arguments: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        process.waitUntilExit()
        let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        guard process.terminationStatus == 0 else {
            throw UpdateError.install(output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?
                "系统命令执行失败：\(path)" : output.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return output
    }
}
