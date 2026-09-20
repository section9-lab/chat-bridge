import Foundation

enum AppVersion {
    static var current: String { label(Bundle.main.infoDictionary ?? [:]) }

    static func label(_ info: [String: Any]) -> String {
        info["ChatBridgeReleaseVersion"] as? String ??
            info["CFBundleShortVersionString"] as? String ?? "Development"
    }
}
