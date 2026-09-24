import SwiftUI
import AppKit

// Everything drawn inside the intro is plain SwiftUI: AppKit-backed views (visual effect views, progress
// indicators, text views) would neither follow the scene's perspective transforms nor stay inside the photo.

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB, red: Double(hex >> 16 & 0xFF) / 255, green: Double(hex >> 8 & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255, opacity: opacity)
    }
    /// A color that follows the system appearance.
    static func adaptive(_ light: UInt32, _ dark: UInt32, light lightOpacity: Double = 1, dark darkOpacity: Double = 1) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            let hex = isDark ? dark : light
            return NSColor(srgbRed: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255,
                           blue: CGFloat(hex & 0xFF) / 255, alpha: isDark ? darkOpacity : lightOpacity)
        })
    }
}

enum Brand {
    static let sky = Color(hex: 0x87AEF5)
    static let skyDeep = Color(hex: 0x6694EA)
    static let cloud = Color(hex: 0xF2B9A2)
    static let charcoal = Color(hex: 0x17191C)
    static let warm = Color(hex: 0xFFFDF8)
    static let selection = Color(hex: 0x0A7AFF)
    static let wechat = Color(hex: 0x07C160)
    static let tile = LinearGradient(colors: [sky, skyDeep], startPoint: .top, endPoint: .bottom)
    static let progress = LinearGradient(colors: [sky, skyDeep, cloud], startPoint: .leading, endPoint: .trailing)
    static let serif = Font.system(size: 36, weight: .regular, design: .serif)
}

/// The mascot outline from `AppLogo.statusImage`, drawn in its 22 × 18 pt design space.
struct MascotBody: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width / 22, rect.height / 18)
        let ox = rect.midX - 11 * s, oy = rect.midY - 9 * s
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * s, y: oy + y * s) }
        var path = Path()
        path.move(to: p(1, 13.4))
        path.addCurve(to: p(3.2, 6.2), control1: p(0.8, 10.2), control2: p(2, 7.8))
        path.addCurve(to: p(6.2, 1.35), control1: p(3.6, 4), control2: p(4.9, 1.5))
        path.addCurve(to: p(8.8, 2.8), control1: p(7.9, 1.1), control2: p(7, 3))
        path.addCurve(to: p(14.7, 3), control1: p(12, 2.3), control2: p(13.5, 2.8))
        path.addCurve(to: p(16.1, 1.7), control1: p(16, 3.45), control2: p(14.5, 1.5))
        path.addCurve(to: p(19.6, 7.6), control1: p(18.3, 1.75), control2: p(19.2, 5.9))
        path.addCurve(to: p(20.4, 12.4), control1: p(20.1, 9), control2: p(20.7, 10.8))
        path.addCurve(to: p(20.8, 15.3), control1: p(20.4, 13.4), control2: p(20, 14))
        path.addCurve(to: p(19.2, 16.1), control1: p(21.7, 16.6), control2: p(19.8, 16))
        path.addCurve(to: p(13.8, 14.7), control1: p(16.5, 17.5), control2: p(15.1, 15.9))
        path.addCurve(to: p(6.3, 15), control1: p(11.6, 12.5), control2: p(8.5, 12.7))
        path.addCurve(to: p(1, 13.4), control1: p(4.7, 16.8), control2: p(1, 17.2))
        path.closeSubpath()
        return path
    }
}

/// The black mascot with its two warm-white eyes; `eyes` 0 is closed, 1 is open.
struct Mascot: View {
    var eyes: CGFloat = 1
    var body: some View {
        GeometryReader { geometry in
            let s = min(geometry.size.width / 22, geometry.size.height / 18)
            let ox = geometry.size.width / 2 - 11 * s, oy = geometry.size.height / 2 - 9 * s
            ZStack(alignment: .topLeading) {
                MascotBody().fill(Brand.charcoal)
                eye(s: s).rotationEffect(.degrees(6)).position(x: ox + 7.75 * s, y: oy + 9.35 * s)
                eye(s: s).rotationEffect(.degrees(-5)).position(x: ox + 14.25 * s, y: oy + 9.35 * s)
            }
        }
        .aspectRatio(22 / 18, contentMode: .fit)
    }
    private func eye(s: CGFloat) -> some View {
        Capsule().fill(Brand.warm).frame(width: 2.5 * s, height: max(0.3, 4.7 * s * eyes))
    }
}

/// The app icon: the mascot on its cornflower tile.
struct AppTile: View {
    var size: CGFloat
    var eyes: CGFloat = 1
    var mascot: Double = 1
    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.25, style: .continuous)
            .fill(Brand.tile)
            .overlay {
                RoundedRectangle(cornerRadius: size * 0.25, style: .continuous)
                    .strokeBorder(.white.opacity(0.28), lineWidth: max(0.5, size / 180))
                    .blendMode(.plusLighter)
            }
            .overlay {
                Mascot(eyes: eyes).frame(width: size * 0.72)
                    .opacity(mascot).blur(radius: (1 - mascot) * size / 23)
            }
            .frame(width: size, height: size)
    }
}

/// A small spinner that works inside transformed scenes, unlike `ProgressView`.
struct Spinner: View {
    var size: CGFloat = 12
    var color: Color = .secondary
    @State private var turning = false
    var body: some View {
        Circle().trim(from: 0.15, to: 1)
            .stroke(color, style: StrokeStyle(lineWidth: max(1.2, size / 8), lineCap: .round))
            .frame(width: size, height: size)
            .rotationEffect(.degrees(turning ? 360 : 0))
            .onAppear { withAnimation(.linear(duration: 0.85).repeatForever(autoreverses: false)) { turning = true } }
    }
}

/// Characters that rise in one after another, as the title of each onboarding step does.
struct StaggeredText: View {
    var text: String
    var font: Font
    var color: Color = .primary
    var delay: Double = 0
    var step: Double = 0.026
    var shown = true
    @State private var visible = false
    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(text.enumerated()), id: \.offset) { index, character in
                Text(String(character)).font(font).foregroundStyle(color)
                    .opacity(visible && shown ? 1 : 0)
                    .offset(y: visible && shown ? 0 : 6)
                    .blur(radius: visible && shown ? 0 : 3)
                    .animation(.easeOut(duration: 0.55).delay(delay + Double(index) * step), value: visible && shown)
            }
        }
        .accessibilityElement(children: .ignore).accessibilityLabel(text)
        .onAppear { visible = true }
    }
}

// MARK: - Perspective

/// A projective transform that maps a rectangle onto four corners (top-left, top-right, bottom-right, bottom-left).
struct Homography {
    var a: CGFloat, b: CGFloat, c: CGFloat, d: CGFloat, e: CGFloat, f: CGFloat, g: CGFloat, h: CGFloat
    init(from rect: CGRect, to q: [CGPoint]) {
        let dx1 = q[1].x - q[2].x, dx2 = q[3].x - q[2].x, dx3 = q[0].x - q[1].x + q[2].x - q[3].x
        let dy1 = q[1].y - q[2].y, dy2 = q[3].y - q[2].y, dy3 = q[0].y - q[1].y + q[2].y - q[3].y
        let den = dx1 * dy2 - dx2 * dy1
        let gg = (dx3 * dy2 - dx2 * dy3) / den, hh = (dx1 * dy3 - dx3 * dy1) / den
        let aa = q[1].x - q[0].x + gg * q[1].x, bb = q[3].x - q[0].x + hh * q[3].x, cc = q[0].x
        let dd = q[1].y - q[0].y + gg * q[1].y, ee = q[3].y - q[0].y + hh * q[3].y, ff = q[0].y
        // Compose with the rectangle → unit square step, then normalise the constant term to 1.
        let w = rect.width, ht = rect.height, x0 = rect.minX, y0 = rect.minY
        let k = 1 - gg * x0 / w - hh * y0 / ht
        a = aa / w / k; b = bb / ht / k; c = (cc - aa * x0 / w - bb * y0 / ht) / k
        d = dd / w / k; e = ee / ht / k; f = (ff - dd * x0 / w - ee * y0 / ht) / k
        g = gg / w / k; h = hh / ht / k
    }
    func apply(_ p: CGPoint) -> CGPoint {
        let w = g * p.x + h * p.y + 1
        return CGPoint(x: (a * p.x + b * p.y + c) / w, y: (d * p.x + e * p.y + f) / w)
    }
    var projection: ProjectionTransform {
        var t = ProjectionTransform()
        t.m11 = a; t.m12 = d; t.m13 = g
        t.m21 = b; t.m22 = e; t.m23 = h
        t.m31 = c; t.m32 = f; t.m33 = 1
        return t
    }
}

/// The intro's camera over `phone-scene.jpg` (1536 × 1024 px): the desktop sits on the MacBook's glass and the
/// phone scene on the iPhone's, using the same screen corners as `scripts/render-product-demo.swift`.
/// `t` runs 0 (the desktop fills the screen) → 1 (the whole desk) → 2 (the phone in hand).
struct CameraRig {
    struct Cam { var s: CGFloat; var cx: CGFloat; var cy: CGFloat }
    static let photo = CGSize(width: 1536, height: 1024)
    static let mac = [CGPoint(x: 181, y: 120), CGPoint(x: 1004, y: 118), CGPoint(x: 1004, y: 630), CGPoint(x: 165, y: 630)]
    static let iPhone = [CGPoint(x: 1062, y: 146), CGPoint(x: 1352, y: 142), CGPoint(x: 1354, y: 778), CGPoint(x: 1060, y: 776)]
    static let phoneSize = CGSize(width: 393, height: 852)
    let size: CGSize
    /// The part of the desktop that lands on the glass; the laptop's screen is a little wider than most displays.
    let visible: CGRect
    let onGlass: [CGPoint]
    let flat: [CGPoint]
    let k0: Cam, k1: Cam, k2: Cam
    let phone: ProjectionTransform

    init(size: CGSize) {
        self.size = size
        let w = size.width, h = size.height, glass: CGFloat = 1.622
        visible = w / h < glass ? CGRect(x: 0, y: 0, width: w, height: w / glass)
            : CGRect(x: (w - h * glass) / 2, y: 0, width: h * glass, height: h)
        let map = Homography(from: visible, to: Self.mac)
        onGlass = [CGPoint(x: 0, y: 0), CGPoint(x: w, y: 0), CGPoint(x: w, y: h), CGPoint(x: 0, y: h)].map(map.apply)
        let s0 = visible.width / (Self.mac[1].x - Self.mac[0].x)
        let fx = Self.mac[0].x - visible.minX / s0, fy = Self.mac[0].y
        flat = [CGPoint(x: fx, y: fy), CGPoint(x: fx + w / s0, y: fy), CGPoint(x: fx + w / s0, y: fy + h / s0), CGPoint(x: fx, y: fy + h / s0)]
        k0 = Cam(s: s0, cx: fx + w / s0 / 2, cy: fy + h / s0 / 2)
        let s1 = max(w / Self.photo.width, h / Self.photo.height) * 1.002
        k1 = Cam(s: s1, cx: Self.photo.width / 2, cy: Self.photo.height / 2)
        let s2 = 0.78 * h / 633
        let tx = min(0, max(w - Self.photo.width * s2, 0.72 * w - 1207 * s2))
        let ty = min(0, max(h - Self.photo.height * s2, h / 2 - 460 * s2))
        k2 = Cam(s: s2, cx: (w / 2 - tx) / s2, cy: (h / 2 - ty) / s2)
        phone = Homography(from: CGRect(origin: .zero, size: Self.phoneSize), to: Self.iPhone).projection
    }
    func camera(_ t: Double) -> ProjectionTransform {
        let (from, to, p) = t <= 1 ? (k0, k1, t) : (k1, k2, t - 1)
        let q = CGFloat(min(max(p, 0), 1))
        let s = from.s * pow(to.s / from.s, q), cx = from.cx + (to.cx - from.cx) * q, cy = from.cy + (to.cy - from.cy) * q
        return ProjectionTransform(CGAffineTransform(a: s, b: 0, c: 0, d: s, tx: size.width / 2 - cx * s, ty: size.height / 2 - cy * s))
    }
    /// How far the desktop has settled onto the glass, eased so it lands during the first stretch of the pull-back.
    func settled(_ t: Double) -> CGFloat {
        let x = CGFloat(min(max(t / 0.4, 0), 1))
        return x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2
    }
    func photoOpacity(_ t: Double) -> Double { min(max(t / 0.3, 0), 1) }
    func desk(_ t: Double) -> ProjectionTransform {
        let u = settled(t)
        let q = zip(flat, onGlass).map { CGPoint(x: $0.x + ($1.x - $0.x) * u, y: $0.y + ($1.y - $0.y) * u) }
        return Homography(from: CGRect(origin: .zero, size: size), to: q).projection
    }
}

struct CameraEffect: GeometryEffect {
    var t: Double
    let rig: CameraRig
    var animatableData: Double { get { t } set { t = newValue } }
    func effectValue(size: CGSize) -> ProjectionTransform { rig.camera(t) }
}

struct DeskEffect: GeometryEffect {
    var t: Double
    let rig: CameraRig
    var animatableData: Double { get { t } set { t = newValue } }
    func effectValue(size: CGSize) -> ProjectionTransform { rig.desk(t) }
}

struct FixedProjection: GeometryEffect {
    let transform: ProjectionTransform
    func effectValue(size: CGSize) -> ProjectionTransform { transform }
}

/// Crops the desktop to the laptop's glass as it settles, with the glass's rounded top corners.
struct DeskClip: Shape {
    var t: Double
    let rig: CameraRig
    var animatableData: Double { get { t } set { t = newValue } }
    func path(in rect: CGRect) -> Path {
        let u = rig.settled(t), v = rig.visible
        let r = CGRect(x: rect.minX + (v.minX - rect.minX) * u, y: rect.minY,
                       width: rect.width + (v.width - rect.width) * u, height: rect.height + (v.height - rect.height) * u)
        return UnevenRoundedRectangle(topLeadingRadius: 14 * u, topTrailingRadius: 14 * u, style: .continuous).path(in: r)
    }
}

struct PhotoFade: ViewModifier, Animatable {
    var t: Double
    let rig: CameraRig
    var animatableData: Double { get { t } set { t = newValue } }
    func body(content: Content) -> some View { content.opacity(rig.photoOpacity(t)) }
}
