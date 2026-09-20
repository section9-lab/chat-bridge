import AppKit
import SwiftUI

final class ChatPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let service = BridgeService()
    private var statusItem: NSStatusItem!
    private var panel: ChatPanel?
    private var mainWindow: NSWindow?
    private var settingsWindow: NSWindow?
    private var localMonitor: Any?
    private var globalMonitor: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        let mainItem = NSMenuItem(title: "打开 Chat Bridge", action: #selector(openMain), keyEquivalent: "0")
        mainItem.target = self
        appMenu.addItem(mainItem)
        let settingsItem = NSMenuItem(title: "设置…", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        appMenu.addItem(settingsItem)
        appMenu.addItem(.separator())
        let quitItem = NSMenuItem(title: "退出 Chat Bridge", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        appMenu.addItem(quitItem)
        appItem.submenu = appMenu; menu.addItem(appItem)
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu; menu.addItem(editItem)
        NSApp.mainMenu = menu
        statusItem = NSStatusBar.system.statusItem(withLength: 32)
        guard let button = statusItem.button else { return }
        button.title = ""
        button.image = AppLogo.statusImage()
        button.toolTip = "Chat Bridge · 打开上次会话"
        button.setAccessibilityLabel("Chat Bridge")
        button.target = self
        button.action = #selector(toggleConversation)
        button.sendAction(on: .leftMouseUp)
        service.start()
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .keyDown]) { [weak self] event in
            guard let self else { return event }
            if event.type == .keyDown && event.keyCode == 53 && self.panel?.isVisible == true {
                self.hidePanel(); return nil
            }
            if event.type != .keyDown && event.window !== self.panel && event.window !== self.statusItem.button?.window {
                self.hidePanel()
            }
            return event
        }
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.hidePanel()
        }
        NotificationCenter.default.addObserver(self, selector: #selector(repositionPanel),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(repositionPanel),
            name: NSWorkspace.didWakeNotification, object: nil)
        showMainWindow()
    }
    @objc private func toggleConversation() { toggleAgent() }
    private func toggleAgent(_ id: String? = nil) {
        closeSettings()
        mainWindow?.orderOut(nil)
        NSApp.setActivationPolicy(.accessory)
        if panel?.isVisible == true && (id == nil || service.viewedAgent == id) { hidePanel(); return }
        if let id { service.openAgent(id) }
        if panel == nil {
            let window = ChatPanel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 530),
                                   styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            window.title = "Chat Bridge 会话"
            window.isOpaque = false
            window.backgroundColor = .clear
            window.hasShadow = false
            window.level = .floating
            window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
            window.hidesOnDeactivate = false
            window.isReleasedWhenClosed = false
            window.isMovableByWindowBackground = false
            window.contentView = NSHostingView(rootView: ChatView(service: service,
                settings: { [weak self] in self?.showSettings() }, close: { [weak self] in self?.hidePanel() },
                openDashboard: { [weak self] in self?.showMainWindow() }))
            panel = window
        }
        repositionPanel()
        panel?.makeKeyAndOrderFront(nil)
    }
    @objc private func repositionPanel() {
        guard let button = statusItem.button, let window = button.window, let panel else { return }
        let anchor = window.convertToScreen(button.convert(button.bounds, to: nil))
        let screen = window.screen ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        let width = min(380, visible.width - 20)
        let height = min(560, visible.height * 0.7)
        let x = max(visible.minX + 10, min(anchor.maxX - width, visible.maxX - width - 10))
        let y = max(visible.minY + 10, anchor.minY - height - 8)
        panel.setFrame(NSRect(x: x, y: y, width: width, height: height), display: true)
    }
    private func hidePanel() { panel?.orderOut(nil) }
    func showMainWindow() {
        hidePanel()
        NSApp.setActivationPolicy(.regular)
        if mainWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 720),
                styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
            window.title = "Chat Bridge"
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.titlebarSeparatorStyle = .none
            window.isOpaque = false
            window.backgroundColor = .clear
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.contentMinSize = NSSize(width: 800, height: 580)
            window.contentView = NSHostingView(rootView: MainView(service: service,
                settings: { [weak self] in self?.showSettings() }).ignoresSafeArea())
            window.center()
            mainWindow = window
        }
        if mainWindow?.isMiniaturized == true { mainWindow?.deminiaturize(nil) }
        mainWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    func showSettings() {
        hidePanel()
        if mainWindow?.isVisible != true { showMainWindow() }
        if settingsWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 680),
                styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
            window.title = "Chat Bridge 设置"
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.titlebarSeparatorStyle = .none
            window.isOpaque = false
            window.backgroundColor = .clear
            window.isMovableByWindowBackground = true
            window.contentMinSize = NSSize(width: 560, height: 580)
            for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
                window.standardWindowButton(button)?.isHidden = true
            }
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: SettingsView(service: service,
                openAgent: { [weak self] id in self?.toggleAgent(id) },
                close: { [weak self] in self?.closeSettings() }).ignoresSafeArea())
            settingsWindow = window
        }
        if let settingsWindow, settingsWindow.sheetParent == nil {
            mainWindow?.beginSheet(settingsWindow)
        }
        NSApp.activate(ignoringOtherApps: true)
    }
    private func closeSettings() {
        guard let settingsWindow else { return }
        settingsWindow.sheetParent?.endSheet(settingsWindow)
        settingsWindow.orderOut(nil)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, window === mainWindow else { return }
        closeSettings()
        NSApp.setActivationPolicy(.accessory)
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showMainWindow()
        return true
    }
    @objc private func openSettings() { showSettings() }
    @objc private func openMain() { showMainWindow() }
    @objc private func quitApp() {
        closeSettings()
        NSApp.terminate(nil)
    }
    func applicationWillTerminate(_ notification: Notification) {
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        NotificationCenter.default.removeObserver(self)
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
        service.stop()
    }
}
