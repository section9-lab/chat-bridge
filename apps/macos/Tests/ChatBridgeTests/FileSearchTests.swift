import XCTest
@testable import ChatBridge

final class FileSearchTests: XCTestCase {
    func testMentionUsesTheCaretAndPreservesTextAroundChineseFileNames() throws {
        let text = "🙂 请分析 @设计 说明 后面的文字"
        let caret = ("🙂 请分析 @设计 说明" as NSString).length
        let mention = try XCTUnwrap(FileMention.find(in: text, selection: NSRange(location: caret, length: 0)))
        XCTAssertEqual(mention.query, "设计 说明")
        XCTAssertEqual((text as NSString).replacingCharacters(in: mention.range, with: ""), "🙂 请分析  后面的文字")
        XCTAssertNil(FileMention.find(in: "me@example.com", selection: NSRange(location: 14, length: 0)))
        XCTAssertNil(FileMention.find(in: text, selection: NSRange(location: 1, length: 5)))
        XCTAssertNil(FileMention.find(in: "@旧文件\n新的内容", selection: NSRange(location: 10, length: 0)))
    }

    func testSearchRanksProjectFilesAndMatchesChineseSpacesAndCase() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let project = root.appendingPathComponent("project"), downloads = root.appendingPathComponent("downloads")
        for directory in [project, downloads, project.appendingPathComponent("nested"), project.appendingPathComponent("node_modules"), project.appendingPathComponent(".git")] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        for name in ["设计 说明.md", "nested/设计 说明.md", "node_modules/设计 说明.md", ".git/设计 说明.md", "README.md"] {
            try Data("content".utf8).write(to: project.appendingPathComponent(name))
        }
        try Data("content".utf8).write(to: downloads.appendingPathComponent("设计 说明.md"))
        try FileManager.default.createSymbolicLink(at: project.appendingPathComponent("linked.md"), withDestinationURL: downloads.appendingPathComponent("设计 说明.md"))
        let result = await FileSearch.search("设计 说", roots: [project, downloads, root])
        XCTAssertEqual(result.files.count, 3, "Overlapping roots must not duplicate files; dependencies and hidden files are excluded")
        XCTAssertEqual(Set(result.files.map(\.url)).count, 3)
        XCTAssertEqual(result.files.last?.url.deletingLastPathComponent().lastPathComponent, "downloads", "Both project matches rank before the download")
        XCTAssertFalse(result.incomplete)
        let readme = await FileSearch.search("readme", roots: [project])
        XCTAssertEqual(readme.files.map(\.name), ["README.md"])
        let symlink = await FileSearch.search("linked", roots: [project])
        XCTAssertTrue(symlink.files.isEmpty)
    }

    func testEmptyQueryRecommendsRecentFilesAndExcludesOversizedFiles() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        for index in 0..<12 {
            let url = root.appendingPathComponent("file-\(index).txt")
            try Data().write(to: url)
            try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: Double(index))], ofItemAtPath: url.path)
        }
        let large = root.appendingPathComponent("large.bin")
        try Data().write(to: large)
        let handle = try FileHandle(forWritingTo: large)
        try handle.truncate(atOffset: 50 * 1024 * 1024 + 1)
        try handle.close()
        let result = await FileSearch.search("", roots: [root])
        XCTAssertEqual(result.files.count, 8)
        XCTAssertEqual(result.files.first?.name, "file-11.txt")
        XCTAssertFalse(result.files.contains { $0.name == "large.bin" })
    }
}
