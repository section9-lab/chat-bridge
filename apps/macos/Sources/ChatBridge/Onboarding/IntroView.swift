import SwiftUI

/// The full-screen intro: the photo scene under one camera, with act one's icon over it.
struct IntroView: View {
    @ObservedObject var director: IntroDirector
    let rig: CameraRig
    let photo: NSImage?
    /// Without a skip action (the README recording) the button is left out.
    var skip: (() -> Void)?
    var body: some View {
        let size = director.layout.size
        ZStack(alignment: .topLeading) {
            world
            RadialGradient(colors: [Color(hex: 0x0A0C14, opacity: 0.72), Color(hex: 0x040509, opacity: 0.9)],
                           center: UnitPoint(x: 0.5, y: 0.45), startRadius: 0, endRadius: max(size.width, size.height) * 0.7)
                .opacity(director.scrim).allowsHitTesting(false)
            actOne
            if let skip {
                Button(action: skip) {
                    Text("跳过介绍").font(.system(size: 12.5)).foregroundStyle(Brand.warm.opacity(0.8))
                        .padding(.horizontal, 11).padding(.vertical, 6)
                        .background(.black.opacity(0.3), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain).keyboardShortcut(.cancelAction)
                .position(x: size.width - 70, y: size.height - 34)
                .opacity(director.scene < 1 ? 0 : 1)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .opacity(director.scene)
    }

    private var world: some View {
        ZStack(alignment: .topLeading) {
            if let photo {
                Image(nsImage: photo).resizable()
                    .frame(width: CameraRig.photo.width, height: CameraRig.photo.height)
                    .modifier(PhotoFade(t: director.cam, rig: rig))
            }
            IntroDesk(director: director)
                .clipShape(DeskClip(t: director.cam, rig: rig))
                .modifier(DeskEffect(t: director.cam, rig: rig))
            IntroPhone(director: director)
                .modifier(FixedProjection(transform: rig.phone))
                .modifier(PhotoFade(t: director.cam, rig: rig))
        }
        .frame(width: CameraRig.photo.width, height: CameraRig.photo.height, alignment: .topLeading)
        .modifier(CameraEffect(t: director.cam, rig: rig))
        .blur(radius: director.scrim * 22)
        .allowsHitTesting(false)
    }

    /// The icon loads in from a soft blur, opens its eyes, and later flies home to the status item.
    private var actOne: some View {
        let d = director, size = d.layout.size
        let center = CGPoint(x: size.width / 2, y: size.height / 2 - 30)
        return ZStack(alignment: .topLeading) {
            AppTile(size: 184, eyes: d.eyes, mascot: d.mascotLoad)
                .shadow(color: Brand.skyDeep.opacity(d.flewHome ? 0 : 0.45 * d.tileLoad), radius: 45, y: 16)
                .scaleEffect(d.flewHome ? 22 / 184 : 0.8 + 0.2 * d.tileLoad)
                .blur(radius: d.flewHome ? 0 : (1 - d.tileLoad) * 24)
                .opacity(d.tileHidden ? 0 : min(1, d.tileLoad * 2))
                .position(d.flewHome ? d.layout.statusItem : center)
            StaggeredText(text: "Chat Bridge", font: Brand.serif, color: Brand.warm, step: 0.045, shown: d.titleShown)
                .position(x: center.x, y: center.y + 138)
            Text("人在远方，会话在手边。")
                .font(.system(size: 16, weight: .medium, design: .serif)).tracking(2.6)
                .foregroundStyle(Brand.warm.opacity(0.62))
                .opacity(d.titleShown ? 1 : 0).blur(radius: d.titleShown ? 0 : 4)
                .animation(.easeOut(duration: 0.8).delay(d.titleShown ? 0.55 : 0), value: d.titleShown)
                .position(x: center.x, y: center.y + 188)
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .allowsHitTesting(false)
    }
}
