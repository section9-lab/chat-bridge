import XCTest
@testable import ChatBridge

final class MessageMediaTests: XCTestCase {
    func testMediaLinksSupportLocalPathsReferencesAndRemoteQueryStrings() {
        let media = MessageMedia.links(in: """
            [试玩视频][clip]
            [图片](file:///tmp/photo%20one.PNG)
            [远程视频](https://example.com/demo.mp4?token=fixture#preview)

            [clip]: </tmp/视频 演示(1).mp4>
            """)
        XCTAssertEqual(media.map(\.kind), [.video, .image, .video])
        XCTAssertEqual(media[0].url, URL(fileURLWithPath: "/tmp/视频 演示(1).mp4"))
        XCTAssertEqual(media[0].title, "试玩视频")
        XCTAssertEqual(media[1].url.path, "/tmp/photo one.PNG")
        XCTAssertEqual(media[2].url.query, "token=fixture")
    }

    func testMediaInCodeAndNonMediaLinksAreNotLoaded() {
        XCTAssertTrue(MessageMedia.links(in: """
            `[示例](/tmp/code.mp4)`

            ```markdown
            [示例](/tmp/code.png)
            ```

            [文档](https://example.com/readme)
            [源码](/tmp/main.swift:12)
            [远程文件](file://server/share/photo.png)
            [相对路径](images/photo.png)
            [其他协议](ftp://example.com/photo.png)
            """).isEmpty)
    }

    func testDuplicateLinksAndMarkdownImagesDoNotAddRepeatedCards() {
        let media = MessageMedia.links(in: """
            ![图片](/tmp/photo.png)
            [原图](file:///tmp/photo.png)
            [**视频**](/tmp/movie.mp4)
            [再看一次](file:///tmp/movie.mp4)
            """)
        XCTAssertEqual(media.count, 1)
        XCTAssertEqual(media.first?.title, "视频")
        XCTAssertEqual(media.first?.kind, .video)
    }

    func testLocalImageAndVideoProduceRealThumbnails() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        for file in ["docs/assets/chat-bridge-demo-poster.png", "docs/assets/chat-bridge-demo.mp4"] {
            let url = root.appendingPathComponent(file)
            let media = try XCTUnwrap(MessageMedia(url: url, title: "演示"))
            let image = try await media.thumbnail()
            XCTAssertGreaterThan(image.width, 100)
            XCTAssertGreaterThan(image.height, 100)
            XCTAssertLessThanOrEqual(max(image.width, image.height), 1280)
        }
    }

    func testMissingMediaFailsWithoutRemovingTheOriginalLink() async throws {
        let text = "[已移动的视频](/tmp/\(UUID().uuidString).mp4)"
        let media = try XCTUnwrap(MessageMedia.links(in: text).first)
        do {
            _ = try await media.thumbnail()
            XCTFail("Missing files must report a preview failure")
        } catch {
            XCTAssertEqual(media.title, "已移动的视频")
            XCTAssertTrue(media.url.isFileURL)
        }
    }
}
