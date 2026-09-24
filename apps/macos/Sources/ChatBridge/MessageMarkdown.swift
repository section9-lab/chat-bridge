import SwiftUI
import MarkdownUI

struct MessageMarkdown: View, Equatable {
    var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Markdown(text)
                .markdownTheme(Self.theme)
                .markdownImageProvider(MessageImageProvider())
                .markdownInlineImageProvider(MessageInlineImageProvider())
                .markdownSoftBreakMode(.lineBreak)
                .textSelection(.enabled)
            ForEach(MessageMedia.links(in: text)) { media in
                MessageMediaView(media: media)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private static let theme = Theme.basic
        .text {
            FontSize(13)
            ForegroundColor(.primary)
            BackgroundColor(nil)
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(.em(0.9))
            BackgroundColor(.primary.opacity(0.06))
        }
        .link { ForegroundColor(.accentColor) }
        .paragraph { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(4)
                .markdownMargin(top: 0, bottom: 10)
        }
        .blockquote { configuration in
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 2).fill(.secondary.opacity(0.35)).frame(width: 3)
                configuration.label.foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
            .markdownMargin(top: 0, bottom: 10)
        }
        .codeBlock { configuration in
            ScrollView(.horizontal) {
                configuration.label
                    .markdownTextStyle {
                        FontFamilyVariant(.monospaced)
                        FontSize(12)
                        BackgroundColor(nil)
                    }
                    .fixedSize(horizontal: true, vertical: true)
                    .lineSpacing(3).padding(10)
            }
            .scrollIndicators(.visible)
            .background(.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
            .markdownMargin(top: 0, bottom: 10)
        }
        .table { configuration in
            ScrollView(.horizontal) {
                configuration.label
                    .fixedSize(horizontal: true, vertical: true)
                    .markdownTableBorderStyle(.init(color: .primary.opacity(0.15)))
                    .markdownTableBackgroundStyle(.alternatingRows(.clear, .primary.opacity(0.035)))
            }
            .scrollIndicators(.visible)
            .markdownMargin(top: 0, bottom: 10)
        }
}
