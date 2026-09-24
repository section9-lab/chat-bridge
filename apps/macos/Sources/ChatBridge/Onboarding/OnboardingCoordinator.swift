import AppKit
import SwiftUI

/// Shows onboarding on first launch: the intro over the whole screen, then the setup card in its own window.
/// Setup stays a normal window so the person can visit System Settings or Messages while pairing.
@MainActor
final class OnboardingCoordinator {
    nonisolated static let completedKey = "onboarding.completed"
    nonisolated static var shouldShow: Bool { !UserDefaults.standard.bool(forKey: completedKey) }

    private let service: BridgeService
    private let statusItemFrame: () -> NSRect?
    private let completed: () -> Void
    private let postponed: () -> Void
    private var introWindow: IntroWindow?
    private var playback: Task<Void, Never>?
    private var setupWindow: SetupWindow?
    private let flight = OnboardingFlight()
    private var tipWindow: NSPanel?

    init(service: BridgeService, statusItemFrame: @escaping () -> NSRect?, completed: @escaping () -> Void, postponed: @escaping () -> Void) {
        self.service = service
        self.statusItemFrame = statusItemFrame
        self.completed = completed
        self.postponed = postponed
    }

    var isActive: Bool { introWindow != nil || setupWindow != nil }

    func begin() {
        if let setupWindow { setupWindow.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        guard introWindow == nil else { return }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { showSetup() } else { playIntro() }
    }

    // MARK: The intro

    private func playIntro() {
        let status = statusItemFrame()
        let screen = NSScreen.screens.first { screen in status.map { screen.frame.contains(CGPoint(x: $0.midX, y: $0.midY)) } ?? false }
            ?? NSScreen.main ?? NSScreen.screens[0]
        let frame = screen.frame
        let menuBar = max(24, frame.maxY - screen.visibleFrame.maxY)
        var notch: ClosedRange<CGFloat>?
        if screen.safeAreaInsets.top > 0, let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea,
           right.minX > left.maxX {
            notch = (left.maxX - frame.minX)...(right.minX - frame.minX)
        }
        let item = status.map { CGPoint(x: $0.midX - frame.minX, y: frame.maxY - $0.midY) }
            ?? CGPoint(x: frame.width - 200, y: menuBar / 2)
        let director = IntroDirector(layout: IntroLayout(size: frame.size, menuBar: min(menuBar, 44), notch: notch, statusItem: item))
        let photo = Agent.resourceBundle.url(forResource: "phone-scene", withExtension: "jpg", subdirectory: "Onboarding")
            .flatMap(NSImage.init(contentsOf:))

        let window = IntroWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        // Above the menu bar, so the simulated one can stand in for it while the camera moves.
        window.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        window.onEscape = { [weak self] in self?.skipIntro() }
        window.contentView = NSHostingView(rootView: IntroView(director: director, rig: CameraRig(size: frame.size), photo: photo,
                                                               skip: { [weak self] in self?.skipIntro() }))
        window.setFrame(frame, display: true)
        window.makeKeyAndOrderFront(nil)
        introWindow = window
        playback = Task { [weak self] in
            await director.play()
            guard !Task.isCancelled else { return }
            self?.endIntro()
        }
    }
    private func skipIntro() {
        playback?.cancel(); playback = nil
        endIntro()
    }
    private func endIntro() {
        guard let window = introWindow else { return }
        introWindow = nil
        showSetup()
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.35
            window.animator().alphaValue = 0
        }, completionHandler: { window.orderOut(nil) })
    }

    // MARK: Setup

    private func showSetup() {
        flight.flying = false
        let margin: CGFloat = 64
        let window = SetupWindow(contentRect: NSRect(x: 0, y: 0, width: 860 + margin * 2, height: 520 + margin * 2),
                                 styleMask: [.borderless], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.title = "设置 Chat Bridge"
        window.onCancel = { [weak self] in self?.postpone() }
        window.contentView = NSHostingView(rootView: OnboardingCard(service: service, flight: flight,
                                                                    finish: { [weak self] in self?.finish() })
            .padding(margin))
        window.center()
        window.alphaValue = 0
        window.makeKeyAndOrderFront(nil)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.45
            window.animator().alphaValue = 1
        }
        setupWindow = window
        NSApp.activate(ignoringOtherApps: true)
    }
    /// Esc puts setup off until the next launch and opens the app as usual.
    private func postpone() {
        guard let window = setupWindow else { return }
        setupWindow = nil
        window.orderOut(nil)
        postponed()
    }
    /// The card folds into the menu bar icon: it shrinks toward its top-right corner while the window moves there.
    private func finish() {
        UserDefaults.standard.set(true, forKey: Self.completedKey)
        guard let window = setupWindow else { completed(); return }
        setupWindow = nil
        let status = statusItemFrame()
        withAnimation(.timingCurve(0.55, 0, 0.25, 1, duration: 0.85)) { flight.flying = true }
        if let status {
            let margin: CGFloat = 64
            let origin = NSPoint(x: status.midX - window.frame.width + margin, y: status.midY - window.frame.height + margin)
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.85
                context.timingFunction = CAMediaTimingFunction(controlPoints: 0.55, 0, 0.25, 1)
                window.animator().setFrameOrigin(origin)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
            window.orderOut(nil)
            if let status { self?.showTip(below: status) }
            self?.completed()
        }
    }
    private func showTip(below status: NSRect) {
        let size = NSSize(width: 220, height: 50)
        let panel = NSPanel(contentRect: NSRect(x: status.midX - size.width / 2, y: status.minY - size.height - 4, width: size.width, height: size.height),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar
        panel.ignoresMouseEvents = true
        panel.isReleasedWhenClosed = false
        panel.contentView = NSHostingView(rootView: MenuBarTip())
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { $0.duration = 0.3; panel.animator().alphaValue = 1 }
        tipWindow = panel
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            NSAnimationContext.runAnimationGroup({ $0.duration = 0.4; panel.animator().alphaValue = 0 }, completionHandler: {
                MainActor.assumeIsolated {
                    panel.orderOut(nil)
                    if self?.tipWindow === panel { self?.tipWindow = nil }
                }
            })
        }
    }
}

final class IntroWindow: NSWindow {
    var onEscape: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { onEscape?() }
}

final class SetupWindow: NSWindow {
    var onCancel: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    override func cancelOperation(_ sender: Any?) { onCancel?() }
}

struct MenuBarTip: View {
    var body: some View {
        Text("Chat Bridge 在这儿，随时点开。")
            .font(.system(size: 12.5))
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(OnboardingPalette.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.primary.opacity(0.08)))
            .overlay(alignment: .top) {
                Rectangle().fill(OnboardingPalette.card).frame(width: 10, height: 10).rotationEffect(.degrees(45)).offset(y: -5)
            }
            .shadow(color: .black.opacity(0.22), radius: 10, y: 4)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .padding(.bottom, 2)
    }
}
