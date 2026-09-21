import AVKit
import MarkdownUI
import SwiftUI

struct MessageMediaView: View {
    var media: MessageMedia
    @State private var preview: CGImage?
    @State private var failed = false
    @State private var player: AVPlayer?

    private var aspectRatio: CGFloat {
        guard media.kind == .image, let preview else { return 16 / 9 }
        return max(0.85, min(2, CGFloat(preview.width) / CGFloat(preview.height)))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Group {
                if let player {
                    VideoPlayer(player: player)
                } else {
                    Button {
                        if media.kind == .video && !failed {
                            let playback = AVPlayer(url: media.url)
                            player = playback
                            playback.play()
                        } else { NSWorkspace.shared.open(media.url) }
                    } label: {
                        ZStack {
                            Rectangle().fill(Color.primary.opacity(0.05))
                            if let preview {
                                Image(decorative: preview, scale: 1).resizable().scaledToFit()
                            } else if failed {
                                Label(media.kind == .video ? "无法预览视频" : "无法预览图片",
                                      systemImage: "exclamationmark.circle")
                                    .font(.caption).foregroundStyle(.secondary)
                            } else { ProgressView().controlSize(.small) }
                            if media.kind == .video && !failed {
                                Image(systemName: "play.fill").font(.system(size: 22, weight: .semibold))
                                    .foregroundStyle(.white).frame(width: 52, height: 52)
                                    .background(.black.opacity(0.55), in: Circle())
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(media.kind == .video ? "播放视频：\(media.title)" : "查看原图：\(media.title)")
                }
            }
            .aspectRatio(aspectRatio, contentMode: .fit)
            .frame(idealWidth: 320, maxWidth: 560, maxHeight: 320)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            HStack(spacing: 8) {
                Text(media.title).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 4)
                Button { NSWorkspace.shared.open(media.url) } label: {
                    Image(systemName: "arrow.up.right.square")
                }
                .buttonStyle(.plain).help("打开原文件").accessibilityLabel("打开原文件：\(media.title)")
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .task(id: media.url) {
            player?.pause(); player = nil; preview = nil; failed = false
            do {
                let image = try await media.thumbnail()
                try Task.checkCancellation()
                preview = image
            } catch {
                if !Task.isCancelled { failed = true }
            }
        }
        .onDisappear { player?.pause() }
    }
}

struct MessageImageProvider: ImageProvider {
    func makeImage(url: URL?) -> some View {
        if let url, let media = MessageMedia(url: url, image: true) {
            MessageMediaView(media: media)
        } else {
            Label("图片地址不可用", systemImage: "photo").font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct MessageInlineImageProvider: InlineImageProvider {
    func image(with url: URL, label: String) async throws -> Image {
        guard let media = MessageMedia(url: url, image: true) else { throw URLError(.unsupportedURL) }
        let image = try await media.thumbnail()
        return Image(image, scale: max(1, CGFloat(image.width) / 240), label: Text(label))
    }
}
