import Foundation

public struct FrameDecoder {
    public enum Failure: Error { case invalidFrame, tooLarge }
    private var buffer = Data()
    private let maximum = 1_048_576
    public init() {}
    public mutating func append(_ data: Data) throws -> [[String: Any]] {
        buffer.append(data)
        var frames: [[String: Any]] = []
        while let newline = buffer.firstIndex(of: 10) {
            let line = buffer.prefix(upTo: newline)
            guard line.count <= maximum else { throw Failure.tooLarge }
            guard let object = try JSONSerialization.jsonObject(with: line) as? [String: Any],
                  object["protocolVersion"] as? Int == 1 else { throw Failure.invalidFrame }
            frames.append(object)
            buffer.removeSubrange(...newline)
        }
        guard buffer.count <= maximum else { throw Failure.tooLarge }
        return frames
    }
}
