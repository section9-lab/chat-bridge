import SwiftUI
import CoreImage.CIFilterBuiltins

struct WeixinSettings: View {
    @ObservedObject var service: BridgeService
    @State private var verificationCode = ""
    private var state: WeixinState { service.state.channels?.weixin ?? WeixinState() }
    var body: some View {
        HStack(alignment: .top, spacing: 15) {
            Image(systemName: "bubble.left.and.bubble.right").font(.system(size: 22))
                .foregroundStyle(.secondary).frame(width: 36, height: 36)
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("微信").font(.system(size: 14, weight: .medium))
                    Spacer()
                    Text(state.statusLabel).font(.system(size: 10)).foregroundStyle(.secondary)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(.primary.opacity(0.045), in: Capsule())
                }
                Text("通过腾讯 iLink 扫码绑定，凭据保存在此 Mac 的钥匙串。当前支持一对一文字消息。")
                    .font(.system(size: 12)).foregroundStyle(.secondary).lineSpacing(4)
                if let content = state.qrContent, ["wait", "scaned", "need_verifycode"].contains(state.status) {
                    if let qr = qrImage(content) {
                        Image(nsImage: qr).interpolation(.none).resizable().scaledToFit().frame(width: 180, height: 180)
                            .padding(12).background(.white, in: RoundedRectangle(cornerRadius: 12))
                            .accessibilityLabel("微信绑定二维码，请使用自己的微信扫码")
                    }
                    Text("使用自己的微信扫码，然后回到这里确认账号。")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                if state.status == "loading" { ProgressView().controlSize(.small) }
                if state.status == "need_verifycode" {
                    HStack {
                        SecureField("微信显示的验证码", text: $verificationCode).textFieldStyle(.roundedBorder)
                            .frame(maxWidth: 180).onSubmit(submitCode)
                        Button("验证", action: submitCode).disabled(verificationCode.isEmpty)
                    }
                }
                if state.status == "awaiting_confirmation" {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("仅允许这个扫码账号控制本机 Agent：").font(.system(size: 12, weight: .medium))
                        Text(state.ownerId ?? "").font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                        Text("机器人：" + (state.accountId ?? "")).font(.system(size: 10)).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    Button("确认绑定此账号") { service.weixin("confirm", params: ["attemptId": state.attemptId ?? ""]) }
                }
                if let message = state.message {
                    Text(message).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if let error = service.channelErrors["weixin"] {
                    Label(error, systemImage: "exclamationmark.circle").font(.system(size: 11)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 10) {
                    if state.bound {
                        if !state.connected { Button("重新连接") { service.weixin("reconnect") } }
                        Button("解除绑定") { service.weixin("disconnect") }
                    } else if ["wait", "scaned", "need_verifycode", "awaiting_confirmation"].contains(state.status) {
                        Button("取消扫码") { service.weixin("cancel") }
                    } else if state.status != "loading" {
                        Button(state.status == "idle" ? "连接微信" : "重新获取二维码") { service.weixin("start") }
                    }
                }
                if state.bound {
                    Text("绑定后会自动发送命令指南。若未收到，先在微信发送 /status；发送 /help 或“菜单”可随时重看。解除绑定会取消未发送任务，停止收发。")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Text("使用 /agent 查看和切换可用 Agent，使用 /projects、/sessions 选择已有会话；发送 /status 查看当前目标。")
                    .font(.system(size: 11)).foregroundStyle(.secondary).lineSpacing(3)
            }
            .buttonStyle(SettingsButtonStyle())
            .disabled(service.channelBusy || !service.isRunning)
        }
    }
    private func submitCode() {
        service.weixin("verify", params: ["code": verificationCode])
        verificationCode = ""
    }
    private func qrImage(_ text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8); filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let image = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return NSImage(cgImage: image, size: NSSize(width: output.extent.width, height: output.extent.height))
    }
}

struct TaskControls: View {
    @ObservedObject var service: BridgeService
    var job: JobSummary
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            if job.status == "awaiting_route", let options = job.routing?.options {
                ForEach(Array(options.enumerated()), id: \.element.id) { index, option in
                    Button(option.label) { service.resolveRouting(job, index: index + 1) }
                        .multilineTextAlignment(.leading)
                }
            }
            HStack(spacing: 14) {
                if job.canContinue { Button(job.status == "awaiting_route" ? "重试路由" : "继续") { service.taskAction("continue", job: job) } }
                if job.canCancel { Button("取消任务") { service.taskAction("cancel", job: job) } }
                if job.canStop { Button("停止任务") { service.taskAction("stop", job: job) } }
            }
        }
        .buttonStyle(.link).font(.system(size: 11))
        .disabled(!service.isRunning || service.taskBusy.contains(job.id))
    }
}

struct ApprovalCard: View {
    @ObservedObject var service: BridgeService
    var approval: ApprovalSummary
    private var isProjectTrust: Bool { approval.kind == "projectTrust" }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(isProjectTrust ? "添加 Codex 项目" : "需要你的单次确认", systemImage: "hand.raised").font(.system(size: 14, weight: .medium))
            if !isProjectTrust { Text(approval.jobId + " · " + approval.id).font(.caption.monospaced()).foregroundStyle(.secondary) }
            Text(approval.reason).font(.system(size: 13))
            Text("目录：" + approval.cwd).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            Text(approval.detail).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
            Text(isProjectTrust ? "10 分钟内确认；信任设置仅对这个目录保存。" : "10 分钟内有效；仅允许这一次操作。").font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 18) {
                Button(isProjectTrust ? "信任此项目" : "单次允许") { service.approvalAction("approve", approval: approval) }
                Button(isProjectTrust ? "不信任此项目" : "拒绝") { service.approvalAction("deny", approval: approval) }
            }.buttonStyle(.link).disabled(!service.isRunning || service.taskBusy.contains(approval.id))
        }
    }
}
