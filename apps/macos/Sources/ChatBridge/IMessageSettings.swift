import SwiftUI
import AppKit
import Carbon

struct IMessageSettings: View {
    @ObservedObject var service: BridgeService
    @AppStorage("imessage.setup.email") private var email = ""
    @AppStorage("imessage.setup.phone") private var phone = ""
    @State private var openingMessages = false
    @State private var settingsMessage: String?
    @State private var needsAccessibility = false
    private var state: IMessageState { service.state.channels?.imessage ?? IMessageState() }
    private var pairingDisabled: Bool { service.channelBusy || !service.isRunning }
    var body: some View {
        HStack(alignment: .top, spacing: 15) {
            Image(systemName: "message").font(.system(size: 22)).foregroundStyle(.secondary).frame(width: 36, height: 36)
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("iMessage").font(.system(size: 14, weight: .medium))
                    Spacer()
                    Text(state.statusLabel).font(.system(size: 10)).foregroundStyle(.secondary)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(.primary.opacity(0.045), in: Capsule())
                }
                Text("Mac 使用邮箱收发，iPhone 使用手机号收发。请先在“消息 → 设置 → iMessage”中，将“发起新对话”设为下方邮箱，并保持“消息”已打开。")
                    .font(.system(size: 12)).foregroundStyle(.secondary).lineSpacing(4)
                HStack(spacing: 10) {
                    Button("查看消息设置", action: openMessagesSettings)
                        .disabled(openingMessages)
                        .accessibilityLabel("查看消息设置")
                    Text("消息 → 设置 → iMessage").font(.system(size: 11)).foregroundStyle(.secondary)
                }
                if let settingsMessage {
                    Text(settingsMessage).font(.system(size: 11)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if needsAccessibility {
                    Button("辅助功能设置") {
                        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                }
                if !state.bound && ["idle", "error"].contains(state.status) {
                    VStack(alignment: .leading, spacing: 9) {
                        Text("Mac 的 iMessage 邮箱").foregroundStyle(.secondary)
                        TextField("例如 name@icloud.com", text: $email).accessibilityLabel("Mac 的 iMessage 邮箱")
                        Text("iPhone 手机号").foregroundStyle(.secondary)
                        TextField("含国家区号，例如 +6591234567", text: $phone).accessibilityLabel("iPhone 手机号")
                    }.textFieldStyle(.roundedBorder).font(.system(size: 12)).disabled(pairingDisabled)
                    Text("首次请手动核对邮箱和手机号；应用记住本机填写值，下次自动填入。")
                        .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Button("开始配对") { service.imessage("start", params: ["email": email, "phone": phone]) }
                            .disabled(pairingDisabled || email.isEmpty || phone.isEmpty)
                        Button("完全磁盘访问设置", action: openFullDiskAccessSettings)
                    }
                    Text("点击后向填写的手机号发送一条配对请求。请在手机核对发件邮箱，并在同一对话回复 OK，即可自动完成配对。")
                        .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).lineSpacing(3)
                    Text("读取回复需要完全磁盘访问；发送请求可能需要自动化授权。辅助功能只用于打开设置。历史消息不会执行为任务。")
                        .font(.system(size: 11)).foregroundStyle(.secondary).lineSpacing(3)
                }
                if state.status == "preparing" { ProgressView("正在检查 Messages 读取权限…").controlSize(.small) }
                if state.status == "dispatching_verification" { ProgressView("正在发送配对请求…").controlSize(.small) }
                if state.status == "awaiting_phone" {
                    Text("在手机回复 OK").font(.system(size: 12, weight: .medium))
                    Text("请在 \(state.phone ?? "") 的“消息”中查看配对请求，确认发件人是 \(state.email ?? "")，然后在同一对话回复 OK。")
                        .font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
                    Text("10 分钟内有效。回复后会自动启用通道，无需输入配对码。未收到时，请先检查 Mac“消息”里的发送状态。")
                        .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if let message = state.message {
                    Text(message).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if let error = service.channelErrors["imessage"], error != state.message {
                    Label(error, systemImage: "exclamationmark.circle").font(.system(size: 11)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if state.bound {
                    Text("\(state.email ?? "") ↔ \(state.phone ?? "")")
                        .font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
                    HStack {
                        if !state.connected {
                            Button("重新连接") { service.imessage("reconnect") }
                            Button("完全磁盘访问设置", action: openFullDiskAccessSettings)
                        }
                        Button("解除绑定") { service.imessage("disconnect") }
                    }.disabled(pairingDisabled)
                    Text("配对完成后会自动发送命令指南。发送 /help 或“菜单”可随时重看。解除绑定会取消未发送任务，停止收发。")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                } else if !["idle", "preparing"].contains(state.status) {
                    Button("取消配对") { service.imessage("disconnect") }
                        .disabled(pairingDisabled)
                }
            }
            .buttonStyle(SettingsButtonStyle())
        }
    }

    private func openFullDiskAccessSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") { NSWorkspace.shared.open(url) }
    }

    private func openMessagesSettings() {
        openingMessages = true
        settingsMessage = nil
        needsAccessibility = false
        Task { @MainActor in
            defer { openingMessages = false }
            let workspace = NSWorkspace.shared
            guard let url = workspace.urlForApplication(withBundleIdentifier: "com.apple.MobileSMS") ??
                workspace.urlForApplication(withBundleIdentifier: "com.apple.iChat") else {
                settingsMessage = "找不到「消息」应用。请从应用程序文件夹打开。"
                return
            }
            do {
                let application = try await workspace.openApplication(at: url, configuration: .init())
                let pid = application.processIdentifier
                try await Task.detached {
                    do {
                        let event = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass),
                            eventID: AEEventID(kAEShowPreferences),
                            targetDescriptor: NSAppleEventDescriptor(processIdentifier: pid),
                            returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
                        let reply = try event.sendEvent(options: [.waitForReply, .canInteract], timeout: 5)
                        if let error = reply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber)), error.int32Value != 0 {
                            throw NSError(domain: NSOSStatusErrorDomain, code: Int(error.int32Value))
                        }
                    } catch {
                        try MessagesSettingsOpener.openUsingMenu(processIdentifier: pid)
                    }
                }.value
                settingsMessage = "在设置中选择 iMessage。若未显示设置，请在「消息」中按 ⌘,。"
            } catch MessagesSettingsOpener.Failure.accessibilityRequired {
                needsAccessibility = true
                settingsMessage = "此版本的「消息」需要辅助功能权限才能一键打开设置。允许 Chat Bridge 后再试，或在「消息」中按 ⌘, 手动查看。"
            } catch {
                settingsMessage = "无法自动打开消息设置。请在「消息」中按 ⌘, 后选择 iMessage。"
            }
        }
    }
}
