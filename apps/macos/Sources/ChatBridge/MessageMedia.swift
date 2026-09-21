import AVFoundation
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct MessageMedia: Identifiable, Equatable {
    enum Kind { case image, video }
    let url: URL
    let kind: Kind
    let title: String
    var id: URL { url }

    init?(url: URL, title: String = "", image: Bool = false) {
        guard let resolved = Self.resolve(url) else { return nil }
        let type = UTType(filenameExtension: resolved.pathExtension)
        if image || type?.conforms(to: .image) == true {
            kind = .image
        } else if type?.conforms(to: .movie) == true {
            kind = .video
        } else { return nil }
        self.url = resolved
        self.title = title.isEmpty ? resolved.lastPathComponent : title
    }

    static func links(in text: String) -> [MessageMedia] {
        guard let content = try? AttributedString(markdown: text) else { return [] }
        let images = Set(content.runs.compactMap { $0.imageURL.flatMap(resolve) })
        var seen = images
        return content.runs.compactMap { run in
            guard let url = run.link,
                  let media = MessageMedia(url: url, title: String(content[run.range].characters)),
                  seen.insert(media.url).inserted else { return nil }
            return media
        }
    }

    private static func resolve(_ url: URL) -> URL? {
        if url.isFileURL {
            guard url.host == nil || url.host == "" || url.host == "localhost" else { return nil }
            return url.standardizedFileURL
        }
        if url.scheme == nil && url.relativeString.hasPrefix("/") && !url.relativeString.hasPrefix("//") {
            return URL(fileURLWithPath: url.path).standardizedFileURL
        }
        guard ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else { return nil }
        return url
    }

    func thumbnail() async throws -> CGImage {
        if kind == .video {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 1280, height: 1280)
            return try await generator.image(at: .zero).image
        }
        let data: Data?
        if url.isFileURL {
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard values.isRegularFile == true, (values.fileSize ?? Int.max) <= 50 * 1024 * 1024 else {
                throw CocoaError(.fileReadTooLarge)
            }
            data = nil
        } else {
            let (bytes, response) = try await URLSession.shared.data(from: url)
            guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
                  bytes.count <= 50 * 1024 * 1024 else { throw URLError(.badServerResponse) }
            data = bytes
        }
        return try await Task.detached(priority: .userInitiated) {
            let source = data.flatMap { CGImageSourceCreateWithData($0 as CFData, nil) }
                ?? (url.isFileURL ? CGImageSourceCreateWithURL(url as CFURL, nil) : nil)
            guard let source, let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1280,
                kCGImageSourceShouldCacheImmediately: true,
            ] as CFDictionary) else { throw CocoaError(.fileReadCorruptFile) }
            return image
        }.value
    }
}
