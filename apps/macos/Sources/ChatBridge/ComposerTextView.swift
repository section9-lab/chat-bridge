import AppKit
import SwiftUI

struct ComposerTextView: NSViewRepresentable {
    var text: String
    var selection: NSRange
    var enabled: Bool
    var fontSize: CGFloat
    var minimumHeight: CGFloat
    var focusRequest: Int
    var change: (String, NSRange, Bool) -> Void
    var command: (Selector) -> Bool

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        let editor = NSTextView()
        editor.drawsBackground = false
        editor.isRichText = false
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.isAutomaticTextReplacementEnabled = false
        editor.isAutomaticTextCompletionEnabled = false
        editor.isAutomaticDataDetectionEnabled = false
        editor.isAutomaticLinkDetectionEnabled = false
        editor.textContainerInset = .zero
        editor.textContainer?.lineFragmentPadding = 0
        editor.isHorizontallyResizable = false
        editor.isVerticallyResizable = true
        editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = true
        editor.setAccessibilityLabel("会话消息")
        editor.delegate = context.coordinator
        scroll.documentView = editor
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let editor = scroll.documentView as? NSTextView else { return }
        context.coordinator.parent = self
        context.coordinator.updating = true
        defer { context.coordinator.updating = false }
        if editor.isEditable != enabled { editor.isEditable = enabled }
        // Do not replace marked text while an input method is composing.
        if !editor.hasMarkedText() {
            if editor.font?.pointSize != fontSize { editor.font = .systemFont(ofSize: fontSize) }
            editor.textColor = .labelColor
            editor.insertionPointColor = .labelColor
            if editor.string != text { editor.string = text }
            if NSMaxRange(selection) <= (text as NSString).length, editor.selectedRange() != selection {
                editor.setSelectedRange(selection)
                editor.scrollRangeToVisible(selection)
            }
        }
        if context.coordinator.focusRequest != focusRequest {
            context.coordinator.focusRequest = focusRequest
            scroll.window?.makeFirstResponder(editor)
        }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView scroll: NSScrollView, context: Context) -> CGSize? {
        guard let width = proposal.width, let editor = scroll.documentView as? NSTextView,
              let container = editor.textContainer, let layout = editor.layoutManager else { return nil }
        container.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let height = layout.usedRect(for: container).height + layout.extraLineFragmentRect.height
        return CGSize(width: width, height: min(max(minimumHeight, height), ceil(fontSize * 1.5 * 5)))
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextView
        var updating = false
        var focusRequest: Int
        init(_ parent: ComposerTextView) { self.parent = parent; focusRequest = parent.focusRequest }
        func textDidChange(_ notification: Notification) { report(notification) }
        func textViewDidChangeSelection(_ notification: Notification) { report(notification) }
        private func report(_ notification: Notification) {
            guard !updating, let editor = notification.object as? NSTextView else { return }
            parent.change(editor.string, editor.selectedRange(), editor.hasMarkedText())
        }
        func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            guard !textView.hasMarkedText() else { return false }
            if commandSelector == #selector(NSResponder.insertNewline(_:)), NSApp.currentEvent?.modifierFlags.contains(.shift) == true { return false }
            return parent.command(commandSelector)
        }
    }
}
