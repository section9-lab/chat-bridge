// Photographic devices, production SwiftUI views, and animated messaging UI.
// All messages and results are offline fictional fixtures; no service is contacted.
import AppKit
import CoreImage

private let W = 1536, H = 1024, fps = 20, duration = 75
private let ink = color(0x171A20), secondary = color(0x747981)
private let blue = color(0x1683FA), green = color(0x07C160)
private let ci = CIContext(options: [.cacheIntermediates: false])
private var images: [String: NSImage] = [:]
private var nativeDirectory = URL(fileURLWithPath: "/tmp")

private func color(_ n: Int, _ a: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((n >> 16) & 255) / 255, green: CGFloat((n >> 8) & 255) / 255,
            blue: CGFloat(n & 255) / 255, alpha: a)
}
private func box(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> NSRect { NSRect(x: x, y: y, width: w, height: h) }
private func rounded(_ r: NSRect, _ radius: CGFloat, _ fill: NSColor, shadow: CGFloat = 0) {
    NSGraphicsContext.saveGraphicsState()
    if shadow > 0 {
        let s = NSShadow(); s.shadowColor = color(0x101824, 0.22); s.shadowBlurRadius = shadow
        s.shadowOffset = NSSize(width: 0, height: -4); s.set()
    }
    fill.setFill(); NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius).fill()
    NSGraphicsContext.restoreGraphicsState()
}
private func stroke(_ r: NSRect, _ radius: CGFloat, _ fill: NSColor, _ width: CGFloat = 1) {
    let p = NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius)
    p.lineWidth = width; fill.setStroke(); p.stroke()
}
private func text(_ value: String, _ r: NSRect, _ size: CGFloat = 18, _ weight: NSFont.Weight = .regular,
                  _ fill: NSColor = ink, _ alignment: NSTextAlignment = .left) {
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineSpacing = 3; paragraph.alignment = alignment; paragraph.lineBreakMode = .byWordWrapping
    NSAttributedString(string: value, attributes: [.font: NSFont.systemFont(ofSize: size, weight: weight),
        .foregroundColor: fill, .paragraphStyle: paragraph]).draw(with: r, options: [.usesLineFragmentOrigin, .usesFontLeading])
}
private func draw(_ image: NSImage, _ r: NSRect, alpha: CGFloat = 1) {
    image.draw(in: r, from: .zero, operation: .sourceOver, fraction: alpha, respectFlipped: true, hints: nil)
}
private func icon(_ name: String, _ r: NSRect, _ tint: NSColor = ink) {
    guard let original = NSImage(systemSymbolName: name, accessibilityDescription: nil) else { return }
    let key = name + tint.description
    if images[key] == nil {
        let symbol = original.withSymbolConfiguration(.init(pointSize: r.height, weight: .regular)) ?? original
        images[key] = canvas(Int(r.width * 2), Int(r.height * 2)) {
            draw(symbol, box(0, 0, r.width * 2, r.height * 2))
            tint.setFill(); box(0, 0, r.width * 2, r.height * 2).fill(using: .sourceIn)
        }
    }
    draw(images[key]!, r)
}
private func image(_ key: String, file: String? = nil) -> NSImage {
    if let cached = images[key] { return cached }
    let path = file ?? nativeDirectory.appendingPathComponent(key + ".png").path
    guard let value = NSImage(contentsOfFile: path) else { fatalError("Missing demo asset: " + path) }
    images[key] = value; return value
}
private func bitmap(_ width: Int, _ height: Int, _ body: () -> Void) -> NSBitmapImageRep {
    let b = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
                            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                            bytesPerRow: width * 4, bitsPerPixel: 32)!
    let context = NSGraphicsContext(bitmapImageRep: b)!
    NSGraphicsContext.saveGraphicsState()
    context.cgContext.translateBy(x: 0, y: CGFloat(height)); context.cgContext.scaleBy(x: 1, y: -1)
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context.cgContext, flipped: true)
    NSGraphicsContext.current?.imageInterpolation = .high
    body(); NSGraphicsContext.restoreGraphicsState(); return b
}
private func canvas(_ width: Int, _ height: Int, _ body: () -> Void) -> NSImage {
    NSImage(cgImage: bitmap(width, height, body).cgImage!, size: NSSize(width: width, height: height))
}
private func line(_ a: CGPoint, _ b: CGPoint, _ fill: NSColor, _ width: CGFloat = 1) {
    let p = NSBezierPath(); p.lineWidth = width; p.move(to: a); p.line(to: b); fill.setStroke(); p.stroke()
}
private func ease(_ t: Double) -> CGFloat { CGFloat(1 - pow(1 - min(1, max(0, t)), 3)) }
private func pointer(_ p: CGPoint, click: Double? = nil) {
    if let click, click >= 0 && click < 0.5 {
        let d = 12 + CGFloat(click * 56)
        stroke(box(p.x - d / 2, p.y - d / 2, d, d), d / 2, blue.withAlphaComponent(CGFloat(0.7 - click)), 2)
    }
    let arrow = NSBezierPath(); arrow.move(to: p)
    for offset in [(0.0, 23.0), (6, 17), (11, 27), (15, 25), (10, 16), (20, 16)] {
        arrow.line(to: CGPoint(x: p.x + offset.0, y: p.y + offset.1))
    }
    arrow.close(); arrow.lineWidth = 2.4; NSColor.white.setStroke(); arrow.stroke(); ink.setFill(); arrow.fill()
}

// Fit content into the photographed glass plane, preserving the physical bezels and hand.
private func screen(_ source: NSImage, points: [CGPoint]) {
    var bounds = NSRect(origin: .zero, size: source.size)
    let input = CIImage(cgImage: source.cgImage(forProposedRect: &bounds, context: nil, hints: nil)!)
    var params: [String: Any] = [:]
    for (key, p) in zip(["inputTopLeft", "inputTopRight", "inputBottomRight", "inputBottomLeft"], points) {
        params[key] = CIVector(x: p.x, y: CGFloat(H) - p.y)
    }
    let warped = input.applyingFilter("CIPerspectiveTransform", parameters: params), r = warped.extent.integral
    if let cg = ci.createCGImage(warped, from: r) {
        draw(NSImage(cgImage: cg, size: r.size), box(r.minX, CGFloat(H) - r.maxY, r.width, r.height))
    }
}
private func cropped(_ source: NSImage, y: CGFloat, height: CGFloat, to r: NSRect) {
    var bounds = NSRect(origin: .zero, size: source.size)
    let cg = source.cgImage(forProposedRect: &bounds, context: nil, hints: nil)!
    let scale = CGFloat(cg.width) / 760
    if let part = cg.cropping(to: box(0, y * scale, 760 * scale, height * scale)) {
        draw(NSImage(cgImage: part, size: r.size), r)
    }
}
private func settings(_ name: String, scroll: CGFloat = 0) {
    let img = image("settings-" + name), x: CGFloat = 170, y: CGFloat = 32
    rounded(box(x, y, 760, 580), 14, color(0xEAEAEA), shadow: 22)
    NSGraphicsContext.saveGraphicsState()
    NSBezierPath(roundedRect: box(x, y, 760, 580), xRadius: 14, yRadius: 14).addClip()
    cropped(img, y: 0, height: 133, to: box(x, y, 760, 133))
    cropped(img, y: 133 + scroll, height: 380, to: box(x, y + 133, 760, 380))
    cropped(img, y: 1033, height: 67, to: box(x, y + 513, 760, 67))
    NSGraphicsContext.restoreGraphicsState()
}
private func app(_ name: String) {
    rounded(box(20, 30, 1060, 580), 15, color(0xE8E8E8), shadow: 16)
    NSGraphicsContext.saveGraphicsState()
    NSBezierPath(roundedRect: box(20, 30, 1060, 580), xRadius: 15, yRadius: 15).addClip()
    draw(image(name), box(20, 30, 1060, 580)); NSGraphicsContext.restoreGraphicsState()
    for (i, c) in [0xFF5F57, 0xFEBC2E, 0x28C840].enumerated() { rounded(box(36 + CGFloat(i * 19), 48, 11, 11), 5.5, color(c)) }
}
private func desktopBase(dock: Bool) {
    NSGradient(colors: [color(0xBED5DF), color(0xDCE6E8), color(0x8DB6CA)])!.draw(in: box(0, 0, 1100, 640), angle: 30)
    let p = NSBezierPath(); p.move(to: CGPoint(x: 0, y: 500))
    p.curve(to: CGPoint(x: 1100, y: 260), controlPoint1: CGPoint(x: 300, y: 640), controlPoint2: CGPoint(x: 650, y: 120))
    p.line(to: CGPoint(x: 1100, y: 640)); p.line(to: CGPoint(x: 0, y: 640)); p.close()
    NSGradient(starting: color(0x90BAC4), ending: color(0xDAE5D9))!.draw(in: p, angle: 80)
    rounded(box(0, 0, 1100, 25), 0, color(0xEDF3F5, 0.72))
    text("", box(13, 2, 22, 23), 17, .medium); text("Chat Bridge", box(43, 5, 120, 18), 12, .semibold)
    text("File    Edit    Window    Help", box(151, 5, 230, 18), 11)
    draw(AppLogo.statusImage(), box(904, 3, 22, 18))
    icon("wifi", box(950, 6, 16, 12)); icon("battery.100percent", box(977, 6, 21, 12))
    text("Mon  09:41", box(1016, 5, 78, 18), 11)
    if dock {
        rounded(box(397, 560, 306, 64), 19, color(0xF2F4F6, 0.73), shadow: 14)
        let paths = ["/System/Library/CoreServices/Finder.app", "/System/Applications/Messages.app", "", "/System/Applications/Notes.app", "/System/Applications/Utilities/Terminal.app"]
        for (i, path) in paths.enumerated() {
            if images["dock-\(i)"] == nil { images["dock-\(i)"] = path.isEmpty ? image("brand", file: "docs/assets/brand/chat-bridge-app-icon.png") : NSWorkspace.shared.icon(forFile: path) }
            draw(images["dock-\(i)"]!, box(409 + CGFloat(i * 58), 568, 49, 49))
        }
    }
}
private func desktop(_ time: Double) -> NSImage {
    canvas(1100, 640) {
        NSBezierPath(roundedRect: box(0, 0, 1100, 640), xRadius: 8, yRadius: 8).addClip()
        desktopBase(dock: time < 2 || time >= 24 && time < 34)
        switch time {
        case 0..<2:
            rounded(box(489, 514, 122, 28), 6, color(0xF7F7F8, 0.96), shadow: 8)
            text("Chat Bridge", box(498, 519, 106, 21), 13, .medium, ink, .center)
            let e = ease(time / 1.1); pointer(CGPoint(x: 690 - 144 * e, y: 481 + 97 * e), click: time - 1.4)
        case 2..<5: app("overview"); pointer(CGPoint(x: 312, y: 253))
        case 5..<16:
            app("overview"); rounded(box(20, 30, 1060, 580), 15, color(0x111824, 0.10))
            let tab = time < 8 ? "agents" : time < 11 ? "channels" : time < 14 ? "routing" : "general"
            let scroll: CGFloat = tab == "channels" ? 170 * ease((time - 9.2) / 0.7) : tab == "routing" ? 290 * ease((time - 12.2) / 0.7) : tab == "agents" ? 110 * ease((time - 6.4) / 0.6) : 0
            settings(tab, scroll: scroll)
            let tabX: CGFloat = tab == "agents" ? 246 : tab == "channels" ? 440 : tab == "routing" ? 342 : 538
            pointer(CGPoint(x: tabX, y: 126))
        case 16..<20:
            app("overview"); rounded(box(496, 120, 362, 460), 14, color(0xF1F2F3), shadow: 18)
            draw(image(time < 18 ? "sessions" : "project-sessions"), box(496, 120, 362, 460))
            pointer(CGPoint(x: time < 18 ? 782 : 621, y: time < 18 ? 543 : 194), click: time < 18 ? time - 16.3 : time - 18.2)
        case 20..<22: app("new-session"); pointer(CGPoint(x: 318, y: 190), click: time - 20.1)
        case 22..<24: app("overview"); pointer(CGPoint(x: 36, y: 47), click: time - 23.5)
        case 24..<34:
            if time >= 24.8 {
                var key = "menu-ready"
                if time >= 26 && time < 29 {
                    let length = "Add a loading state to the submit button.".count
                    let count = min(length / 2 * 2, max(0, Int((time - 26) / 2.3 * Double(length)) / 2 * 2))
                    key = "menu-draft-\(count)"
                } else if time >= 29 && time < 31 { key = "menu-running" }
                else if time >= 31 { key = "menu-done" }
                draw(image(key), box(583, 27, 460, 565), alpha: ease((time - 24.8) / 0.25))
            }
            if time < 26 { pointer(CGPoint(x: 914, y: 13), click: time - 24.5) }
            else if time < 29.5 { pointer(CGPoint(x: 984, y: 500), click: time - 28.8) }
        default:
            let name: String
            if time < 37 { name = "wechat-idle" } else if time < 39 { name = "wechat-routing" }
            else if time < 43 { name = "wechat-running" } else if time < 47 { name = "wechat-done" }
            else if time < 50 { name = "imessage-idle" } else if time < 52 { name = "imessage-routing" }
            else if time < 56 { name = "imessage-running" } else if time < 62 { name = "imessage-done" }
            else if time < 65 { name = "fallback" } else if time < 68 { name = "fallback-running" } else { name = "final" }
            app(name)
        }
    }
}

private func bubbleHeight(_ value: String, width: CGFloat, size: CGFloat) -> CGFloat {
    let paragraph = NSMutableParagraphStyle(); paragraph.lineSpacing = 3
    let bounds = NSAttributedString(string: value, attributes: [.font: NSFont.systemFont(ofSize: size), .paragraphStyle: paragraph])
        .boundingRect(with: NSSize(width: width - 24, height: 1000), options: [.usesLineFragmentOrigin, .usesFontLeading])
    return max(43, ceil(bounds.height) + 20)
}
private func bubble(_ value: String, x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat,
                    outgoing: Bool, wechat: Bool, size: CGFloat = 20) {
    let fill = wechat ? (outgoing ? color(0x95EC69) : .white) : (outgoing ? blue : color(0xE9E9EB))
    rounded(box(x, y, width, height), wechat ? 6 : 19, fill)
    if wechat {
        let p = NSBezierPath(), edge = outgoing ? x + width : x
        p.move(to: CGPoint(x: edge, y: y + 15)); p.line(to: CGPoint(x: edge + (outgoing ? 6 : -6), y: y + 20))
        p.line(to: CGPoint(x: edge, y: y + 25)); p.close(); fill.setFill(); p.fill()
        let avatarX: CGFloat = outgoing ? 315 : 12
        rounded(box(avatarX, y, 33, 33), 5, outgoing ? color(0x6B8994) : color(0xA6C9E9))
        if outgoing { icon("person.fill", box(avatarX + 7, y + 6, 19, 22), .white) }
        else { draw(AppLogo.statusImage(), box(avatarX + 5, y + 7, 23, 19)) }
    } else {
        let p = NSBezierPath(), edge = outgoing ? x + width : x, d: CGFloat = outgoing ? 1 : -1
        p.move(to: CGPoint(x: edge - d * 14, y: y + height - 16))
        p.curve(to: CGPoint(x: edge + d * 4, y: y + height), controlPoint1: CGPoint(x: edge - d * 4, y: y + height - 7), controlPoint2: CGPoint(x: edge - d * 2, y: y + height - 1))
        p.curve(to: CGPoint(x: edge - d * 18, y: y + height - 6), controlPoint1: CGPoint(x: edge - d * 9, y: y + height + 1), controlPoint2: CGPoint(x: edge - d * 14, y: y + height - 3))
        p.close(); fill.setFill(); p.fill()
    }
    text(value, box(x + 12, y + 10, width - 24, height - 16), size, .regular, !wechat && outgoing ? .white : ink)
}
private func keyboard(_ y: CGFloat) {
    rounded(box(0, y, 360, 216), 0, color(0xD5D8DE))
    text("the               I               you", box(18, y + 5, 325, 19), 12, .regular, secondary, .center)
    let rows = [Array("QWERTYUIOP"), Array("ASDFGHJKL"), Array("ZXCVBNM")]
    for (j, keys) in rows.enumerated() {
        let start: CGFloat = j == 0 ? 4 : j == 1 ? 22 : 58
        for (i, key) in keys.enumerated() {
            let r = box(start + CGFloat(i) * 35.5, y + 28 + CGFloat(j * 41), 31, 35)
            rounded(r.offsetBy(dx: 0, dy: 1), 5, color(0x9EA3AC)); rounded(r, 5, .white)
            text(String(key), r.insetBy(dx: 4, dy: 5), 19, .regular, ink, .center)
        }
    }
    rounded(box(4, y + 151, 45, 35), 5, color(0xB5BBC5)); text("123", box(9, y + 160, 35, 25), 14)
    rounded(box(56, y + 151, 39, 35), 5, color(0xB5BBC5)); text("☺", box(59, y + 161, 36, 20), 12)
    rounded(box(103, y + 151, 146, 35), 5, .white); text("space", box(130, y + 159, 94, 25), 15, .regular, ink, .center)
    rounded(box(256, y + 151, 99, 35), 5, color(0xB5BBC5)); text("return", box(274, y + 159, 65, 25), 15, .regular, ink, .center)
}
private func composer(wechat: Bool, typed: String, typing: Bool, tap: Double?) {
    let y: CGFloat = typing ? 500 : 704
    rounded(box(0, y, 360, 76), 0, wechat ? color(0xF7F7F7) : .white)
    icon(wechat ? "waveform.circle" : "plus.circle.fill", box(9, y + 20, 27, 27), wechat ? ink : color(0xC3C6CB))
    rounded(box(45, y + 12, wechat ? 247 : 268, 54), wechat ? 6 : 23, wechat ? .white : color(0xFAFAFC))
    if !wechat { stroke(box(45, y + 12, 268, 54), 23, color(0xDDDEE1)) }
    text(typed.isEmpty ? (wechat ? "" : "iMessage") : typed, box(57, y + 21, 215, 43), typed.count > 15 ? 15 : 18,
         .regular, typed.isEmpty ? secondary : ink)
    if typing && !typed.isEmpty {
        if wechat {
            rounded(box(297, y + 20, 56, 35), 5, green); text("Send", box(303, y + 28, 44, 25), 15, .medium, .white, .center)
        } else { rounded(box(282, y + 24, 31, 31), 16, blue); icon("arrow.up", box(290, y + 31, 15, 17), .white) }
    } else {
        icon(wechat ? "face.smiling" : "mic.fill", box(wechat ? 300 : 288, y + 25, 22, 22), secondary)
        if wechat { icon("plus.circle", box(331, y + 25, 21, 21)) }
    }
    if let t = tap, t >= 0 && t < 0.6 {
        let d = 22 + CGFloat(t) * 35, x: CGFloat = wechat ? 324 : 297
        stroke(box(x - d / 2, y + 38 - d / 2, d, d), d / 2, color(0xFFFFFF, CGFloat(0.95 - t)), 3)
    }
    if typing { keyboard(576) }; rounded(box(125, 764, 110, 5), 2.5, ink)
}
private func phone(_ time: Double) -> NSImage {
    canvas(360, 780) {
        NSBezierPath(roundedRect: box(0, 0, 360, 780), xRadius: 42, yRadius: 42).addClip()
        let wechat = time < 47 || time >= 60
        rounded(box(0, 0, 360, 780), 0, wechat ? color(0xEDEDED) : .white)
        text("9:41", box(24, 19, 50, 23), 16, .semibold); rounded(box(128, 11, 104, 29), 15, color(0x08090B))
        icon("cellularbars", box(272, 23, 14, 12)); icon("wifi", box(292, 23, 15, 12))
        rounded(box(314, 23, 24, 12), 3, ink); rounded(box(339, 27, 2, 4), 1, secondary)
        if wechat {
            icon("chevron.left", box(14, 65, 11, 20)); text("Chats", box(30, 65, 55, 24), 17)
            text("Chat Bridge", box(89, 64, 182, 28), 20, .semibold, ink, .center); icon("ellipsis", box(323, 68, 23, 16))
            line(CGPoint(x: 0, y: 108), CGPoint(x: 360, y: 108), color(0xD9D9D9), 0.6)
        } else {
            icon("chevron.left", box(15, 72, 12, 21), blue)
            rounded(box(160, 53, 40, 40), 20, color(0x9FC4E5)); draw(AppLogo.statusImage(), box(167, 63, 26, 21))
            text("Chat Bridge ›", box(82, 99, 196, 26), 16, .medium, ink, .center); icon("video", box(317, 70, 25, 20), blue)
            line(CGPoint(x: 0, y: 133), CGPoint(x: 360, y: 133), color(0xE5E5E5), 0.6)
        }
        let fallback = time >= 60, start: Double = fallback ? 60 : wechat ? 34 : 47
        let sentAt: Double = fallback ? 62 : wechat ? 37 : 50
        let receivedAt: Double = fallback ? 62.6 : wechat ? 38.5 : 51.5, doneAt: Double = fallback ? 68 : wechat ? 43 : 56
        let prompt = fallback ? "Continue that project and summarize the changes." : wechat ? "Codex, continue Website and fix the mobile navigation." : "Start a Claude chat with no project. Write 3 launch lines."
        let typed = String(prompt.prefix(max(0, min(prompt.count, Int((time - start) / (sentAt - start - 0.4) * Double(prompt.count))))))
        text("Today 9:41 AM", box(97, wechat ? 119 : 146, 166, 20), 12, .regular, secondary, .center)
        if time >= sentAt {
            let y: CGFloat = wechat ? 157 : 182
            let visiblePrompt = fallback && time >= 68 ? "1" : prompt
            let promptWidth: CGFloat = visiblePrompt == "1" ? 39 : wechat ? 232 : 272
            let promptHeight = bubbleHeight(visiblePrompt, width: promptWidth, size: 20)
            bubble(visiblePrompt, x: visiblePrompt == "1" ? 263 : wechat ? 70 : 74, y: y, width: promptWidth, height: promptHeight, outgoing: true, wechat: wechat)
            if !wechat { text("Delivered", box(283, y + promptHeight + 5, 61, 21), 11, .regular, secondary, .right) }
            let receiptY = y + promptHeight + (wechat ? 24 : 39)
            let receipt = wechat ? "Codex > Website > Mobile nav\nReceived ✅" : "Claude > No project > Launch copy\nReceived ✅"
            let receiptHeight = bubbleHeight(receipt, width: wechat ? 265 : 302, size: 16)
            if time >= receivedAt {
                if fallback && time < 68 {
                    let options = "Two chats match. Choose one:\n\n01  Codex · Website\n      Mobile nav\n02  Claude · No project\n      Launch copy\n03  Cancel this message\n\nReply with a number to continue."
                    let optionsHeight = bubbleHeight(options, width: 265, size: 17)
                    bubble(options, x: 54, y: receiptY, width: 265, height: optionsHeight, outgoing: false, wechat: true, size: 17)
                    if time >= 65 { bubble("1", x: 263, y: receiptY + optionsHeight + 20, width: 39, height: 45, outgoing: true, wechat: true) }
                } else {
                    bubble(receipt, x: wechat ? 54 : 13, y: receiptY, width: wechat ? 265 : 302, height: receiptHeight, outgoing: false, wechat: wechat, size: 16)
                }
            }
            if time >= doneAt {
                let answer = fallback ? "Changelog ready.\nSubmit button loading state\nMobile navigation fixes" : wechat ? "Mobile navigation is fixed.\nMenu opens and closes on tap.\n3 checks passed." : "Send from your phone. Your Mac gets to work.\nStep away. Keep creating.\nTake your AI conversations with you."
                let answerY = receiptY + receiptHeight + 22
                let answerHeight = bubbleHeight(answer, width: wechat ? 274 : 310, size: 19)
                bubble(answer, x: wechat ? 54 : 13, y: answerY, width: wechat ? 274 : 310, height: answerHeight, outgoing: false, wechat: wechat, size: 19)
                if fallback {
                    let fileY = answerY + answerHeight + 18
                    rounded(box(54, fileY, 271, 78), 6, .white); icon("doc.text.fill", box(70, fileY + 17, 31, 39), color(0x6E90B0))
                    text("changelog.md", box(114, fileY + 14, 191, 25), 17, .medium); text("Changelog · 2 KB", box(114, fileY + 42, 192, 20), 13, .regular, secondary)
                }
            }
        }
        composer(wechat: wechat, typed: time < sentAt ? typed : "", typing: time < sentAt, tap: time - (sentAt - 0.2))
    }
}

private func caption(_ t: Double) -> (String, String, String) {
    switch t {
    case 0..<2: return ("01 / MACBOOK", "Open Chat Bridge", "Open from the Dock. Your desktop agent conversations are all here.")
    case 2..<5: return ("01 / MACBOOK", "Choose an agent. Pick up your conversation.", "Codex · Claude · Cursor · Grok · OpenCode · Hermes Agent")
    case 5..<8: return ("01 / AGENT", "Your agents, your default", "Check connections, edit display names and open conversations.")
    case 8..<11: return ("01 / CHANNELS", "Connect WeChat and iMessage", "Pair your messaging apps. Replies return to the same chat.")
    case 11..<14: return ("01 / JEV", "Say what you need. Jev finds the right target.", "Choose a routing provider, confirmation mode and preferred agents for new tasks.")
    case 14..<16: return ("01 / PREFERENCES", "Ready when you are", "Launch at login · Keep running while locked")
    case 16..<20: return ("01 / SESSIONS", "Find your project. Keep your context.", "Browse and search conversations, filter by project or start a new chat.")
    case 20..<22: return ("01 / NEW SESSION", "Just start chatting. No project required.", "Switch to Claude and start a conversation without a project.")
    case 22..<26: return ("02 / MENU BAR", "One logo. Your last conversation.", "Close the main window. Chat Bridge stays ready in the menu bar.")
    case 26..<29: return ("02 / MENU BAR", "Send a task from your menu bar", "Add a loading state to the submit button.")
    case 29..<31: return ("02 / CODEX", "Codex gets to work", "Keep the same project and conversation. View progress or stop the task.")
    case 31..<34: return ("02 / RESULT", "The result comes back to your chat", "Loading state added, duplicate submissions blocked, checks passed.")
    case 34..<37: return ("03 / WECHAT", "Pick up your phone. Send a task in WeChat.", "Codex, continue Website and fix the mobile navigation.")
    case 37..<39: return ("03 / ROUTING", "WeChat → Chat Bridge → Codex", "Chat Bridge finds the agent, project and conversation, then confirms the target.")
    case 39..<43: return ("03 / EXECUTION", "Your Mac has the task. Codex is working.", "A task from your phone continues with the same desktop context.")
    case 43..<47: return ("03 / RETURN", "Codex → Chat Bridge → WeChat", "The fix and its checks arrive in your original WeChat conversation.")
    case 47..<50: return ("04 / IMESSAGE", "Open iMessage. Start a new Claude chat.", "Start a Claude chat with no project. Write 3 launch lines.")
    case 50..<52: return ("04 / ROUTING", "iMessage → Chat Bridge → Claude", "Ask for a new chat without a project. Chat Bridge routes it to Claude.")
    case 52..<56: return ("04 / EXECUTION", "Claude takes over on your Mac", "Stay on your phone while the desktop agent handles the task.")
    case 56..<60: return ("04 / RETURN", "Claude → Chat Bridge → iMessage", "Three launch lines arrive in the same iMessage conversation.")
    case 60..<65: return ("05 / FALLBACK", "Unclear request? Choose from text options.", "Your message is kept. Reply with a number to choose the right conversation.")
    case 65..<68: return ("05 / CONTINUE", "Reply 1 to continue with Codex", "Target confirmed. Chat Bridge forwards your original request.")
    default: return ("CHAT BRIDGE", "Your phone asks. Your Mac works. Results return.", "Start or resume chats, receive replies and files, then pick up again on your Mac.")
    }
}
private func frame(_ t: Double) -> NSBitmapImageRep {
    bitmap(W, H) {
        let mobile = t >= 34
        NSGraphicsContext.saveGraphicsState()
        let zoom: CGFloat = mobile ? 1 : 1 + 0.16 * ease((t - 1.8) / 0.8)
        let cg = NSGraphicsContext.current!.cgContext
        cg.translateBy(x: 768, y: 370); cg.scaleBy(x: zoom, y: zoom); cg.translateBy(x: -768, y: -370)
        draw(image(mobile ? "plate-phone" : "plate-mac", file: mobile ? "docs/assets/demo/phone-scene.png" : "docs/assets/demo/macbook-scene.png"), box(0, 0, CGFloat(W), CGFloat(H)))
        screen(desktop(t), points: mobile ? [CGPoint(x: 181, y: 120), CGPoint(x: 1004, y: 118), CGPoint(x: 1004, y: 630), CGPoint(x: 165, y: 630)]
               : [CGPoint(x: 278, y: 114), CGPoint(x: 1258, y: 114), CGPoint(x: 1280, y: 678), CGPoint(x: 259, y: 678)])
        if mobile { screen(phone(t), points: [CGPoint(x: 1062, y: 146), CGPoint(x: 1352, y: 142), CGPoint(x: 1354, y: 778), CGPoint(x: 1060, y: 776)]) }
        NSGraphicsContext.restoreGraphicsState()
        let (chapter, headline, detail) = caption(t)
        rounded(box(36, 895, 1464, 102), 16, color(0xFAFAF7, 0.96), shadow: 12)
        draw(image("brand", file: "docs/assets/brand/chat-bridge-app-icon.png"), box(56, 915, 60, 60))
        text(chapter, box(135, 910, 420, 19), 12, .semibold, color(0x566B7A)); text(headline, box(134, 934, 1060, 32), 25, .semibold)
        text(detail, box(135, 970, 1125, 22), 15, .regular, secondary)
        text("Staged demo · Fictional tasks", box(1271, 913, 207, 20), 12, .regular, secondary, .right)
        text(String(format: "%02d / 75s", Int(t)), box(1352, 953, 124, 22), 13, .medium, secondary, .right)
        rounded(box(53, 1009, 1430, 3), 1.5, color(0xFFFFFF, 0.45)); rounded(box(53, 1009, 1430 * CGFloat(t / Double(duration)), 3), 1.5, color(0x4E7192))
        let fade = t > 74.4 ? ease((t - 74.4) / 0.6) : 0
        if fade > 0 { rounded(box(0, 0, CGFloat(W), CGFloat(H)), 0, color(0xECE8DF, fade)) }
    }
}

@main struct DemoRenderer {
    static func main() throws {
        guard CommandLine.arguments.count >= 3 else { fatalError("Usage: render native-frames output-directory [--preview]") }
        nativeDirectory = URL(fileURLWithPath: CommandLine.arguments[1])
        let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        if CommandLine.arguments.contains("--preview") {
            for t in [3.0, 7, 10.5, 13.5, 15, 19, 21, 27.5, 32, 35.5, 41, 45, 49, 58, 64, 70] {
                try autoreleasepool { try frame(t).representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(String(format: "scene-%04.1f.png", t))) }
            }
            print("Rendered 16 storyboard previews: " + output.path); return
        }
        let process = Process(), input = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgba",
            "-video_size", "\(W)x\(H)", "-framerate", "\(fps)", "-i", "pipe:0", "-an", "-c:v", "libx264", "-preset", "fast",
            "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output.appendingPathComponent("chat-bridge-demo.mp4").path]
        process.standardInput = input; try process.run()
        for i in 0..<(duration * fps) {
            try autoreleasepool {
                let b = frame(Double(i) / Double(fps))
                try input.fileHandleForWriting.write(contentsOf: Data(bytes: b.bitmapData!, count: b.bytesPerRow * H))
                if i == 45 * fps { try b.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent("chat-bridge-demo-poster.png")) }
            }
            if i % (10 * fps) == 0 { print("Rendered \(i / fps) / \(duration) seconds") }
        }
        try input.fileHandleForWriting.close(); process.waitUntilExit()
        guard process.terminationStatus == 0 else { fatalError("Video encoding failed") }
        print("Rendered \(duration)s, \(W)×\(H), \(fps)fps.")
    }
}
