import AppKit

@main
@MainActor
struct ChatBridgeApp {
    static func main() {
        let application = NSApplication.shared
        let identifier = Bundle.main.bundleIdentifier ?? "com.chatbridge.app"
        if let existing = NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
            .first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            existing.activate(options: [])
            return
        }
        application.setActivationPolicy(.accessory)
        let delegate = AppDelegate()
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}
