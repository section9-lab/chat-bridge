// Records the first-launch intro for the README from the production SwiftUI views.
// The intro plays in its own window and only that window is captured: no cursor, no other app, no real account.
import AppKit
import ScreenCaptureKit
import SwiftUI

@main @MainActor
enum RecordIntro {
    static func main() {
        let output = URL(fileURLWithPath: CommandLine.arguments[1])
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.appearance = NSAppearance(named: .aqua)
        // A 14-inch MacBook Pro screen, notch included, with the status item where a menu bar icon would sit.
        let size = CGSize(width: 1512, height: 982)
        let director = IntroDirector(layout: IntroLayout(size: size, menuBar: 37, notch: 661...851, statusItem: CGPoint(x: 1296, y: 18.5)))
        let photo = Agent.resourceBundle.url(forResource: "phone-scene", withExtension: "jpg", subdirectory: "Onboarding")
            .flatMap(NSImage.init(contentsOf:))
        let screen = NSScreen.main?.frame ?? .zero
        let window = NSWindow(contentRect: NSRect(x: screen.midX - size.width / 2, y: screen.midY - size.height / 2,
                                                  width: size.width, height: size.height),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        // The last act fades the scene out; over black it loops back into the dimmed opening.
        window.backgroundColor = .black
        window.hasShadow = false
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: IntroView(director: director, rig: CameraRig(size: size), photo: photo))
        window.orderFrontRegardless()
        Task {
            do {
                try await record(window, to: output) { await director.play() }
                exit(0)
            } catch {
                FileHandle.standardError.write(Data("Recording failed: \(error)\n".utf8))
                exit(1)
            }
        }
        app.run()
    }

    private static func record(_ window: NSWindow, to url: URL, _ play: () async -> Void) async throws {
        try await Task.sleep(nanoseconds: 500_000_000)
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let target = content.windows.first(where: { $0.windowID == CGWindowID(window.windowNumber) }) else {
            throw CocoaError(.featureUnsupported, userInfo: [NSLocalizedDescriptionKey: "The intro window is not capturable."])
        }
        let configuration = SCStreamConfiguration()
        configuration.width = Int(window.frame.width) * 2
        configuration.height = Int(window.frame.height) * 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        configuration.showsCursor = false
        let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: target), configuration: configuration, delegate: nil)
        let settings = SCRecordingOutputConfiguration()
        settings.outputURL = url
        settings.outputFileType = .mov
        settings.videoCodecType = .h264
        let finished = RecordingFinished()
        try stream.addRecordingOutput(SCRecordingOutput(configuration: settings, delegate: finished))
        try await stream.startCapture()
        try await Task.sleep(nanoseconds: 400_000_000)
        await play()
        try await Task.sleep(nanoseconds: 600_000_000)
        try await stream.stopCapture()
        try await finished.wait()
    }
}

/// Resolves once the movie file has been finalized.
private final class RecordingFinished: NSObject, SCRecordingOutputDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Error>?
    private var result: Result<Void, Error>?

    func wait() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            lock.lock()
            if let result { lock.unlock(); continuation.resume(with: result) } else { self.continuation = continuation; lock.unlock() }
        }
    }
    private func finish(_ result: Result<Void, Error>) {
        lock.lock()
        if let continuation { self.continuation = nil; lock.unlock(); continuation.resume(with: result) } else { self.result = result; lock.unlock() }
    }
    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) { finish(.success(())) }
    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) { finish(.failure(error)) }
}
