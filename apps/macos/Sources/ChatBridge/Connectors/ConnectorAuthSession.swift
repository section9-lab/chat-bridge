import AppKit
import AuthenticationServices
import Foundation

@MainActor
final class ConnectorAuthSession: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    @Published private(set) var running = false
    private var session: ASWebAuthenticationSession?

    enum Failure: LocalizedError {
        case unavailable
        var errorDescription: String? { "无法打开系统认证窗口。" }
    }

    func authenticate(at url: URL) async throws -> URL {
        guard !running else { throw Failure.unavailable }
        running = true
        defer { running = false; session = nil }
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "chatbridge-connectors") { callback, error in
                if let error { continuation.resume(throwing: error) }
                else if let callback { continuation.resume(returning: callback) }
                else { continuation.resume(throwing: Failure.unavailable) }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                self.session = nil
                continuation.resume(throwing: Failure.unavailable)
            }
        }
    }

    func cancel() { session?.cancel() }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApp.keyWindow ?? NSApp.windows.first(where: \.isVisible) ?? ASPresentationAnchor()
    }
}
