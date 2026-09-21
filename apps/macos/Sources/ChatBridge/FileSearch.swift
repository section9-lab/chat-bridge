import Foundation

struct FileMention: Equatable {
    let range: NSRange
    let query: String

    static func find(in text: String, selection: NSRange) -> FileMention? {
        guard selection.length == 0, let caret = Range(selection, in: text)?.lowerBound else { return nil }
        let prefix = text[..<caret]
        guard let at = prefix.lastIndex(of: "@"),
              at == text.startIndex || text[text.index(before: at)].isWhitespace || "([（【".contains(text[text.index(before: at)]) else { return nil }
        let query = String(text[text.index(after: at)..<caret])
        guard !query.contains(where: \.isNewline), query.count <= 200 else { return nil }
        return FileMention(range: NSRange(at..<caret, in: text), query: query)
    }
}

struct FileSuggestion: Identifiable, Equatable {
    let url: URL
    let size: Int
    let modified: Date
    var id: String { url.path }
    var name: String { url.lastPathComponent }
    var location: String { (url.deletingLastPathComponent().path as NSString).abbreviatingWithTildeInPath }
}

struct FileSearchResult {
    var files: [FileSuggestion] = []
    var incomplete = false
}

enum FileSearch {
    static func search(_ query: String, roots: [URL]) async -> FileSearchResult {
        let worker = Task.detached(priority: .userInitiated) { scan(query, roots: roots) }
        return await withTaskCancellationHandler(operation: { await worker.value }, onCancel: { worker.cancel() })
    }

    private static func scan(_ query: String, roots: [URL]) -> FileSearchResult {
        let terms = query.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: .current)
            .split(whereSeparator: \.isWhitespace).map(String.init)
        let excluded: Set<String> = ["node_modules", "Pods", "vendor", "DerivedData"]
        let keys: [URLResourceKey] = [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .isPackageKey, .fileSizeKey, .contentModificationDateKey]
        var found: [(FileSuggestion, Int, Int)] = [], visited: Set<String> = []
        var result = FileSearchResult()
        for (priority, root) in roots.enumerated() {
            if Task.isCancelled { return FileSearchResult() }
            let start = Date()
            var count = 0, cursor = 0
            var directories = [root.resolvingSymlinksInPath()]
            guard FileManager.default.fileExists(atPath: root.path) else { continue }
            // Scan each directory's files before descending, so a large subtree cannot hide its siblings.
            scanRoot: while cursor < directories.count {
                if Task.isCancelled { return FileSearchResult() }
                if count > 30_000 || Date().timeIntervalSince(start) > 1.5 { result.incomplete = true; break }
                let directory = directories[cursor].resolvingSymlinksInPath()
                cursor += 1
                guard visited.insert(directory.path).inserted else { continue }
                guard let entries = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else {
                    result.incomplete = true; continue
                }
                for url in entries {
                    if Task.isCancelled { return FileSearchResult() }
                    count += 1
                    if count > 30_000 { result.incomplete = true; break scanRoot }
                    guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isSymbolicLink != true else { continue }
                    if values.isDirectory == true {
                        if values.isPackage != true && !excluded.contains(url.lastPathComponent) { directories.append(url) }
                        continue
                    }
                    guard values.isRegularFile == true, let size = values.fileSize, size <= 50 * 1024 * 1024 else { continue }
                    let name = url.lastPathComponent.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: .current)
                    guard terms.allSatisfy({ name.contains($0) }) else { continue }
                    let query = terms.joined(separator: " ")
                    let rank = name == query ? 0 : name.hasPrefix(query) ? 1 : 2
                    found.append((FileSuggestion(url: url, size: size, modified: values.contentModificationDate ?? .distantPast), priority, rank))
                }
            }
        }
        result.files = found.sorted {
            if $0.1 != $1.1 { return $0.1 < $1.1 }
            if $0.2 != $1.2 { return $0.2 < $1.2 }
            if $0.0.modified != $1.0.modified { return $0.0.modified > $1.0.modified }
            return $0.0.url.path < $1.0.url.path
        }.prefix(8).map(\.0)
        return result
    }
}
