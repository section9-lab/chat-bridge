import Foundation
import XCTest
@testable import ChatBridgeKit

final class ProtocolTests: XCTestCase {
    func testSplitChineseFrame() throws {
        var decoder = FrameDecoder()
        let frame = Data("{\"protocolVersion\":1,\"requestId\":\"1\",\"result\":\"你\"}\n".utf8)
        let split = frame.firstIndex(of: 0xE4)! + 1
        XCTAssertTrue(try decoder.append(frame.prefix(split)).isEmpty)
        let values = try decoder.append(frame.suffix(from: split))
        XCTAssertEqual(values.count, 1)
        XCTAssertEqual(values.first?["result"] as? String, "你")
    }
    func testMalformedAndOversizedFramesAreRejected() {
        for data in [Data("{broken}\n".utf8), Data(repeating: 65, count: 1_048_577),
                     Data("{\"protocolVersion\":99}\n".utf8)] {
            var decoder = FrameDecoder()
            XCTAssertThrowsError(try decoder.append(data))
        }
    }
    func testMultipleFramesDoNotLosePendingTail() throws {
        var decoder = FrameDecoder()
        let first = "{\"protocolVersion\":1,\"requestId\":\"1\",\"result\":true}\n"
        XCTAssertEqual(try decoder.append(Data((first + first + "{").utf8)).count, 2)
        XCTAssertEqual(try decoder.append(Data("\"protocolVersion\":1,\"result\":false}\n".utf8)).count, 1)
    }
}
