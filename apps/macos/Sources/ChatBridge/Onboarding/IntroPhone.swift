import SwiftUI

/// The iPhone in the photo: its home screen, Messages, WeChat and the pinyin keyboard, in iOS's light look.
struct IntroPhone: View {
    @ObservedObject var director: IntroDirector
    var body: some View {
        let p = director.phone
        let onHome = p.app == .home || !p.launched
        ZStack(alignment: .topLeading) {
            PhoneHome()
            if p.app == .messages { launched(MessagesApp(state: p), from: PhoneLayout.messagesIcon, state: p) }
            if p.app == .wechat { launched(WeChatApp(state: p), from: PhoneLayout.wechatIcon, state: p) }
            PhoneKeyboard(state: p)
                .offset(y: p.keyboard ? PhoneLayout.size.height - PhoneLayout.keyboard : PhoneLayout.size.height)
            PhoneStatusBar(light: onHome)
            Capsule().fill(onHome ? Color.white : Color.black).frame(width: 136, height: 5)
                .position(x: PhoneLayout.size.width / 2, y: PhoneLayout.size.height - 10.5)
            if p.touches > 0 { TouchDot().position(p.touch).id(p.touches) }
        }
        .frame(width: PhoneLayout.size.width, height: PhoneLayout.size.height, alignment: .topLeading)
        .background(.black)
        .clipShape(RoundedRectangle(cornerRadius: 50, style: .continuous))
        .environment(\.colorScheme, .light)
    }
    /// The app zooms open from its icon on the home screen, and shrinks back into it.
    private func launched<Content: View>(_ app: Content, from icon: CGPoint, state: PhoneState) -> some View {
        app
            .frame(width: PhoneLayout.size.width, height: PhoneLayout.size.height)
            .clipShape(RoundedRectangle(cornerRadius: state.launched ? 50 : 140, style: .continuous))
            .scaleEffect(state.launched ? 1 : 64 / PhoneLayout.size.width,
                         anchor: UnitPoint(x: icon.x / PhoneLayout.size.width, y: icon.y / PhoneLayout.size.height))
            .opacity(state.launched ? 1 : 0)
    }
}

struct PhoneStatusBar: View {
    var light: Bool
    var body: some View {
        ZStack {
            HStack {
                Text("9:41").font(.system(size: 17, weight: .semibold))
                Spacer()
                HStack(spacing: 6) {
                    Image(systemName: "cellularbars"); Image(systemName: "wifi"); Image(systemName: "battery.100percent")
                }.font(.system(size: 15, weight: .semibold))
            }
            .padding(.leading, 50).padding(.trailing, 30).padding(.top, 6)
            Capsule().fill(.black).frame(width: 124, height: 36).offset(y: -2)
        }
        .foregroundStyle(light ? Color.white : Color.black)
        .frame(width: PhoneLayout.size.width, height: 54)
        .animation(.easeOut(duration: 0.25), value: light)
    }
}

struct TouchDot: View {
    @State private var stage = 0
    var body: some View {
        Circle().fill(Color(white: 0.5, opacity: 0.42))
            .overlay(Circle().strokeBorder(.white.opacity(0.75), lineWidth: 2))
            .frame(width: 46, height: 46)
            .shadow(color: .black.opacity(0.25), radius: 5, y: 2)
            .scaleEffect(stage == 0 ? 0.6 : stage == 1 ? 1 : 1.12)
            .opacity(stage == 1 ? 1 : 0)
            .task {
                withAnimation(.easeOut(duration: 0.15)) { stage = 1 }
                try? await Task.sleep(nanoseconds: 200_000_000)
                withAnimation(.easeIn(duration: 0.25)) { stage = 2 }
            }
    }
}

// MARK: - Home screen

struct PhoneHome: View {
    var body: some View {
        ZStack(alignment: .top) {
            ZStack {
                LinearGradient(colors: [Color(hex: 0x2B4DA6), Color(hex: 0x5A73C9), Color(hex: 0xC58FAE), Color(hex: 0xEAB79B)],
                               startPoint: .top, endPoint: .bottom)
                RadialGradient(colors: [Color(hex: 0x7FA9F4), .clear], center: UnitPoint(x: 0.15, y: 0.18), startRadius: 0, endRadius: 300)
                RadialGradient(colors: [Color(hex: 0xF3AE92), .clear], center: UnitPoint(x: 0.95, y: 0.72), startRadius: 0, endRadius: 280)
            }
            VStack(spacing: 24) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("上海").font(.system(size: 15, weight: .semibold))
                        Text("24°").font(.system(size: 46, weight: .light))
                        Spacer()
                        Text("晴\n最高 27° 最低 19°").font(.system(size: 12.5)).lineSpacing(2).opacity(0.92)
                    }
                    .foregroundStyle(.white).padding(.horizontal, 16).padding(.vertical, 14)
                    .frame(width: 158, height: 164, alignment: .leading)
                    .background(.white.opacity(0.2), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    Spacer()
                    VStack(spacing: 24) {
                        HStack(spacing: 23) { PhoneIcon(kind: .calendar, label: "日历"); PhoneIcon(kind: .clock, label: "时钟") }
                        HStack(spacing: 23) { PhoneIcon(kind: .photos, label: "照片"); PhoneIcon(kind: .camera, label: "相机") }
                    }
                }
                HStack {
                    PhoneIcon(kind: .settings, label: "设置"); Spacer(); PhoneIcon(kind: .notes, label: "备忘录"); Spacer()
                    PhoneIcon(kind: .maps, label: "地图"); Spacer(); PhoneIcon(kind: .reminders, label: "提醒事项")
                }
            }
            .padding(.horizontal, 24).padding(.top, 70)
            HStack(spacing: 6) { Image(systemName: "magnifyingglass").font(.system(size: 11)); Text("搜索") }
                .font(.system(size: 13)).foregroundStyle(.white).padding(.horizontal, 14).padding(.vertical, 6)
                .background(.white.opacity(0.22), in: Capsule())
                .position(x: PhoneLayout.size.width / 2, y: PhoneLayout.size.height - 142)
            HStack {
                ForEach([PhoneIcon.Kind.phone, .safari, .messages, .wechat], id: \.self) { kind in
                    PhoneIcon(kind: kind).frame(maxWidth: .infinity)
                }
            }
            .frame(width: PhoneLayout.size.width - 24, height: 98)
            .background(.white.opacity(0.26), in: RoundedRectangle(cornerRadius: 34, style: .continuous))
            .position(x: PhoneLayout.size.width / 2, y: PhoneLayout.size.height - 63)
        }
        .frame(width: PhoneLayout.size.width, height: PhoneLayout.size.height)
    }
}

struct PhoneIcon: View {
    enum Kind: Hashable { case calendar, clock, photos, camera, settings, notes, maps, reminders, phone, safari, messages, wechat }
    var kind: Kind
    var label: String?
    var body: some View {
        VStack(spacing: 5) {
            art.frame(width: 64, height: 64)
                .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
                .shadow(color: .black.opacity(0.14), radius: 1.5, y: 1)
            if let label {
                Text(label).font(.system(size: 11.5)).foregroundStyle(.white).shadow(color: .black.opacity(0.25), radius: 1, y: 1)
            }
        }
    }
    @ViewBuilder private var art: some View {
        switch kind {
        case .calendar:
            VStack(spacing: 0) {
                Text("周三").font(.system(size: 11, weight: .semibold)).foregroundStyle(Color(hex: 0xFF3B30))
                Text("23").font(.system(size: 33, weight: .light)).foregroundStyle(.black)
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).padding(.top, 6).background(.white)
        case .clock:
            ZStack {
                Color(hex: 0x1C1C1E)
                Circle().fill(.white).padding(5)
                Path { $0.move(to: CGPoint(x: 32, y: 32)); $0.addLine(to: CGPoint(x: 32, y: 15)) }.stroke(Color(hex: 0x1C1C1E), style: StrokeStyle(lineWidth: 2.4, lineCap: .round))
                Path { $0.move(to: CGPoint(x: 32, y: 32)); $0.addLine(to: CGPoint(x: 43, y: 38)) }.stroke(Color(hex: 0x1C1C1E), style: StrokeStyle(lineWidth: 2.4, lineCap: .round))
                Path { $0.move(to: CGPoint(x: 32, y: 32)); $0.addLine(to: CGPoint(x: 19, y: 40)) }.stroke(Color(hex: 0xFF9500), style: StrokeStyle(lineWidth: 1.2, lineCap: .round))
            }
        case .photos:
            ZStack {
                Color.white
                ForEach(0..<8, id: \.self) { index in
                    Ellipse().fill([0xFFB700, 0xFF8A00, 0xFF3B6B, 0xC644FC, 0x5E5CE6, 0x0A84FF, 0x34C759, 0xA6D600].map { Color(hex: $0) }[index])
                        .frame(width: 16, height: 27).offset(y: -14).rotationEffect(.degrees(Double(index) * 45))
                        .blendMode(.multiply)
                }
            }
        case .camera:
            LinearGradient(colors: [Color(hex: 0xE4E6E9), Color(hex: 0xA9AEB5)], startPoint: .top, endPoint: .bottom)
                .overlay(Image(systemName: "camera.fill").font(.system(size: 30)).foregroundStyle(Color(hex: 0x3A3A3C)))
        case .settings:
            LinearGradient(colors: [Color(hex: 0xB6BBC2), Color(hex: 0x7E838B)], startPoint: .top, endPoint: .bottom)
                .overlay(Image(systemName: "gearshape.fill").font(.system(size: 38)).foregroundStyle(.white.opacity(0.95)))
        case .notes:
            VStack(spacing: 0) {
                Color(hex: 0xFFD84D).frame(height: 17)
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(0..<3, id: \.self) { index in Rectangle().fill(Color(hex: 0xC7C7CC)).frame(width: index == 2 ? 26 : 50, height: 1.2) }
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).padding(.leading, 7).padding(.top, 10).background(.white)
            }
        case .maps:
            ZStack {
                LinearGradient(colors: [Color(hex: 0xA2E28F), Color(hex: 0x5CC6F2)], startPoint: .topLeading, endPoint: .bottomTrailing)
                Path { $0.move(to: CGPoint(x: 0, y: 50)); $0.addLine(to: CGPoint(x: 64, y: 21)) }.stroke(.white, lineWidth: 7)
                Path { $0.move(to: CGPoint(x: 27, y: 0)); $0.addLine(to: CGPoint(x: 27, y: 64)) }.stroke(Color(hex: 0xFFD60A), lineWidth: 6)
                Circle().fill(Color(hex: 0x0A84FF)).overlay(Circle().strokeBorder(.white, lineWidth: 2.5)).frame(width: 16, height: 16).offset(x: 11, y: -13)
            }
        case .reminders:
            VStack(alignment: .leading, spacing: 7) {
                ForEach([0x0A84FF, 0xFF3B30, 0xFF9500], id: \.self) { color in
                    HStack(spacing: 6) { Circle().fill(Color(hex: UInt32(color))).frame(width: 9, height: 9); Rectangle().fill(Color(hex: 0xD1D1D6)).frame(height: 1.4) }
                }
            }.padding(.horizontal, 9).frame(maxWidth: .infinity, maxHeight: .infinity).background(.white)
        case .phone:
            LinearGradient(colors: [Color(hex: 0x6FE27B), Color(hex: 0x29BD46)], startPoint: .top, endPoint: .bottom)
                .overlay(Image(systemName: "phone.fill").font(.system(size: 32)).foregroundStyle(.white))
        case .safari:
            ZStack {
                Color.white
                Circle().fill(LinearGradient(colors: [Color(hex: 0x3FA9FF), Color(hex: 0x0A6CFF)], startPoint: .top, endPoint: .bottom)).padding(5)
                Image(systemName: "location.north.fill").font(.system(size: 26)).foregroundStyle(.white).rotationEffect(.degrees(45))
            }
        case .messages:
            LinearGradient(colors: [Color(hex: 0x6FE27B), Color(hex: 0x1FB53A)], startPoint: .top, endPoint: .bottom)
                .overlay(Image(systemName: "message.fill").font(.system(size: 36)).foregroundStyle(.white))
        case .wechat:
            Brand.wechat.overlay(WeChatGlyph().frame(width: 46, height: 40))
        }
    }
}

/// Two speech bubbles with eyes, drawn for the simulated home screen.
struct WeChatGlyph: View {
    var body: some View {
        ZStack(alignment: .topLeading) {
            Ellipse().fill(.white).frame(width: 30, height: 25)
            Circle().fill(Brand.wechat).frame(width: 4, height: 4).offset(x: 9, y: 8)
            Circle().fill(Brand.wechat).frame(width: 4, height: 4).offset(x: 18, y: 8)
            Ellipse().fill(.white).overlay(Ellipse().strokeBorder(Brand.wechat, lineWidth: 1.2)).frame(width: 25, height: 21).offset(x: 19, y: 16)
            Circle().fill(Brand.wechat).frame(width: 3.2, height: 3.2).offset(x: 26, y: 23)
            Circle().fill(Brand.wechat).frame(width: 3.2, height: 3.2).offset(x: 34, y: 23)
        }.frame(width: 46, height: 40, alignment: .topLeading)
    }
}

// MARK: - Messages

struct MessagesApp: View {
    var state: PhoneState
    var body: some View {
        ZStack(alignment: .topLeading) {
            list.offset(x: state.chatOpen ? -118 : 0)
            chat.offset(x: state.chatOpen ? 0 : PhoneLayout.size.width)
                .shadow(color: .black.opacity(state.chatOpen ? 0 : 0.15), radius: 10)
        }
        .frame(width: PhoneLayout.size.width, height: PhoneLayout.size.height, alignment: .topLeading)
        .background(.white).foregroundStyle(.black)
    }
    private var list: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack { Text("编辑"); Spacer(); Image(systemName: "square.and.pencil").font(.system(size: 21)) }
                .font(.system(size: 17)).foregroundStyle(Color(hex: 0x0A84FF)).padding(.horizontal, 18).frame(height: 44)
            Text("信息").font(.system(size: 34, weight: .bold)).padding(.horizontal, 18).padding(.bottom, 8)
            HStack(spacing: 6) { Image(systemName: "magnifyingglass"); Text("搜索"); Spacer(); Image(systemName: "mic.fill") }
                .font(.system(size: 17)).foregroundStyle(Color(hex: 0x8A8A8E)).padding(.horizontal, 10).frame(height: 36)
                .background(Color(hex: 0xEEEEF0), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .padding(.horizontal, 16).padding(.bottom, 6)
            row(avatar: AnyView(mascotAvatar), name: "Chat Bridge", time: "昨天", preview: "你好，我在 Mac 上待命。直接说你要做什么。", unread: true)
                .background(state.rowPressed ? Color(hex: 0xE5E5EA) : .clear)
            row(avatar: AnyView(initials("妈")), name: "妈妈", time: "星期一", preview: "周末回来吃饭吗？给你炖了汤。")
            row(avatar: AnyView(initials("林")), name: "林一", time: "星期日", preview: "那家咖啡店周末开门吗？")
            row(avatar: AnyView(initials("递")), name: "快递通知", time: "9月19日", preview: "您的包裹已放入小区快递柜，请凭取件码取件。")
            Spacer()
        }
        .padding(.top, 54)
    }
    private var mascotAvatar: some View { AppTile(size: 50).clipShape(Circle()) }
    private func initials(_ text: String) -> some View {
        Circle().fill(LinearGradient(colors: [Color(hex: 0xA9ADB6), Color(hex: 0x868B94)], startPoint: .top, endPoint: .bottom))
            .overlay(Text(text).font(.system(size: 20, weight: .medium)).foregroundStyle(.white))
    }
    private func row(avatar: AnyView, name: String, time: String, preview: String, unread: Bool = false) -> some View {
        HStack(spacing: 12) {
            Circle().fill(Color(hex: 0x0A84FF)).frame(width: 10, height: 10).opacity(unread ? 1 : 0)
            avatar.frame(width: 50, height: 50)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(name).font(.system(size: 17, weight: .semibold))
                    Spacer()
                    Text(time).font(.system(size: 15)).foregroundStyle(Color(hex: 0x8A8A8E))
                    Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Color(hex: 0xC4C4C7))
                }
                Text(preview).font(.system(size: 15)).foregroundStyle(Color(hex: 0x8A8A8E)).lineLimit(2)
            }
            .padding(.trailing, 16).padding(.bottom, 10)
            .overlay(alignment: .bottom) { Rectangle().fill(Color(hex: 0xD8D8DC)).frame(height: 0.5) }
        }
        .padding(.leading, 6).padding(.top, 10)
    }
    private var chat: some View {
        VStack(spacing: 0) {
            ZStack {
                VStack(spacing: 5) {
                    AppTile(size: 52).clipShape(Circle())
                    HStack(spacing: 2) { Text("Chat Bridge"); Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)) }
                        .font(.system(size: 11.5))
                }
                HStack {
                    Image(systemName: "chevron.left").font(.system(size: 22, weight: .medium))
                    Spacer()
                    Image(systemName: "video").font(.system(size: 20))
                }.foregroundStyle(Color(hex: 0x0A84FF)).padding(.horizontal, 16).offset(y: -10)
            }
            .frame(height: 94).frame(maxWidth: .infinity)
            .background(Color(hex: 0xF8F8FA, opacity: 0.96))
            .overlay(alignment: .bottom) { Rectangle().fill(Color(hex: 0xD6D6DB)).frame(height: 0.5) }
            VStack(spacing: 5) {
                let lastOut = state.messages.lastIndex { $0.outgoing }
                ForEach(Array(state.messages.enumerated()), id: \.element.id) { index, message in
                    if let stamp = message.stamp {
                        Text(stamp.replacingOccurrences(of: " · ", with: "\n")).multilineTextAlignment(.center)
                            .font(.system(size: 11)).foregroundStyle(Color(hex: 0x8A8A8E)).padding(.vertical, 6)
                    }
                    Text(message.text).font(.system(size: 17)).lineSpacing(1)
                        .foregroundStyle(message.outgoing ? .white : .black)
                        .padding(.horizontal, 13).padding(.vertical, 8)
                        .background(TailBubble(outgoing: message.outgoing).fill(message.outgoing ? Color(hex: 0x0A84FF) : Color(hex: 0xE9E9EB)))
                        .frame(maxWidth: 272, alignment: message.outgoing ? .trailing : .leading)
                        .frame(maxWidth: .infinity, alignment: message.outgoing ? .trailing : .leading)
                        .transition(.asymmetric(insertion: .offset(y: 14).combined(with: .opacity).combined(with: .scale(scale: 0.94, anchor: message.outgoing ? .bottomTrailing : .bottomLeading)), removal: .identity))
                    if index == lastOut {
                        Text("已送达").font(.system(size: 11)).foregroundStyle(Color(hex: 0x8A8A8E)).frame(maxWidth: .infinity, alignment: .trailing)
                    }
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .bottom).clipped()
            HStack(alignment: .bottom, spacing: 10) {
                Image(systemName: "plus").font(.system(size: 18, weight: .medium)).foregroundStyle(Color(hex: 0x7C7C82))
                    .frame(width: 34, height: 34).background(Color(hex: 0xE9E9EB), in: Circle())
                ZStack(alignment: .bottomTrailing) {
                    Group {
                        if state.typed.isEmpty && state.marked.isEmpty { Text("iMessage").foregroundStyle(Color(hex: 0xB1B1B6)) }
                        else { Text(state.typed) + Text(state.marked).foregroundColor(Color(hex: 0x0A84FF)).underline() }
                    }
                    .font(.system(size: 17)).frame(maxWidth: .infinity, minHeight: 23, alignment: .leading)
                    .padding(.leading, 14).padding(.trailing, 42).padding(.vertical, 6)
                    if state.typed.isEmpty {
                        Image(systemName: "mic.fill").font(.system(size: 15)).foregroundStyle(Color(hex: 0xB1B1B6)).padding(.trailing, 12).padding(.bottom, 8)
                    } else {
                        Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                            .frame(width: 29, height: 29).background(Color(hex: 0x0A84FF), in: Circle()).padding(3)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color(hex: 0xC7C7CC), lineWidth: 1))
            }
            .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, state.keyboard ? 8 : 42)
        }
        .padding(.top, 54).padding(.bottom, state.keyboard ? PhoneLayout.keyboard : 0)
        .background(.white)
    }
}

/// An iMessage bubble with its tail at the bottom corner.
struct TailBubble: Shape {
    var outgoing: Bool
    func path(in rect: CGRect) -> Path {
        var path = Path(roundedRect: rect, cornerRadius: 18, style: .continuous)
        let x = outgoing ? rect.maxX : rect.minX, d: CGFloat = outgoing ? 1 : -1, y = rect.maxY
        var tail = Path()
        tail.move(to: CGPoint(x: x - d * 12, y: y - 16))
        tail.addQuadCurve(to: CGPoint(x: x + d * 5, y: y), control: CGPoint(x: x - d * 1, y: y - 1))
        tail.addQuadCurve(to: CGPoint(x: x - d * 16, y: y - 3), control: CGPoint(x: x - d * 7, y: y + 1))
        tail.closeSubpath()
        path.addPath(tail)
        return path
    }
}

// MARK: - WeChat

struct WeChatApp: View {
    var state: PhoneState
    private let gray = Color(hex: 0xB2B2B2)
    var body: some View {
        ZStack(alignment: .topLeading) {
            list.offset(x: state.chatOpen ? -118 : 0)
            chat.offset(x: state.chatOpen ? 0 : PhoneLayout.size.width)
                .shadow(color: .black.opacity(state.chatOpen ? 0 : 0.15), radius: 10)
        }
        .frame(width: PhoneLayout.size.width, height: PhoneLayout.size.height, alignment: .topLeading)
        .background(Color(hex: 0xEDEDED)).foregroundStyle(Color(hex: 0x191919))
    }
    private var list: some View {
        VStack(spacing: 0) {
            ZStack {
                Text("微信").font(.system(size: 17, weight: .semibold))
                Image(systemName: "plus.circle").font(.system(size: 22)).frame(maxWidth: .infinity, alignment: .trailing).padding(.trailing, 16)
            }.frame(height: 44)
            HStack(spacing: 6) { Image(systemName: "magnifyingglass"); Text("搜索") }
                .font(.system(size: 16)).foregroundStyle(gray).frame(maxWidth: .infinity).frame(height: 36)
                .background(.white, in: RoundedRectangle(cornerRadius: 6, style: .continuous)).padding(.horizontal, 10).padding(.vertical, 6)
            VStack(spacing: 0) {
                row(AnyView(AppTile(size: 48).clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))), "Chat Bridge", "昨天", "你好，我在 Mac 上待命。直接说你要做什么。")
                    .background(state.rowPressed ? Color(hex: 0xE5E5E5) : .white)
                row(AnyView(tile(Brand.wechat, Image(systemName: "folder.fill"))), "文件传输助手", "昨天", "[文件] 周报-0919.pdf")
                row(AnyView(tile(Color(hex: 0xF2A65A), Text("家"))), "相亲相爱一家人", "星期二", "妈妈：[图片]")
                row(AnyView(tile(Color(hex: 0x7C9EF0), Text("设"))), "设计小组", "星期一", "小周：新版图标我放群文件了")
                Spacer()
            }.background(.white)
            HStack {
                tab("message.fill", "微信", on: true); tab("person.2", "通讯录"); tab("safari", "发现"); tab("person", "我")
            }
            .padding(.top, 7).frame(height: 84, alignment: .top).background(Color(hex: 0xF7F7F7))
            .overlay(alignment: .top) { Rectangle().fill(Color(hex: 0xDADADA)).frame(height: 0.5) }
        }
        .padding(.top, 54)
    }
    private func tile<Content: View>(_ color: Color, _ content: Content) -> some View {
        RoundedRectangle(cornerRadius: 6, style: .continuous).fill(color).overlay(content.font(.system(size: 20, weight: .medium)).foregroundStyle(.white))
    }
    private func row(_ avatar: AnyView, _ name: String, _ time: String, _ preview: String) -> some View {
        HStack(spacing: 12) {
            avatar.frame(width: 48, height: 48)
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline) {
                    Text(name).font(.system(size: 17)); Spacer(); Text(time).font(.system(size: 12)).foregroundStyle(gray)
                }
                Text(preview).font(.system(size: 14)).foregroundStyle(gray).lineLimit(1)
            }
            .padding(.trailing, 16).padding(.bottom, 12)
            .overlay(alignment: .bottom) { Rectangle().fill(Color(hex: 0xE5E5E5)).frame(height: 0.5) }
        }
        .padding(.leading, 16).padding(.top, 12)
    }
    private func tab(_ symbol: String, _ title: String, on: Bool = false) -> some View {
        VStack(spacing: 3) { Image(systemName: symbol).font(.system(size: 22)); Text(title).font(.system(size: 10.5)) }
            .foregroundStyle(on ? Brand.wechat : Color(hex: 0x191919)).frame(maxWidth: .infinity)
    }
    private var chat: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "chevron.left").font(.system(size: 20, weight: .medium))
                Spacer(); Text("Chat Bridge").font(.system(size: 17, weight: .semibold)); Spacer()
                Image(systemName: "ellipsis").font(.system(size: 18, weight: .semibold))
            }
            .padding(.horizontal, 16).frame(height: 46)
            .overlay(alignment: .bottom) { Rectangle().fill(Color(hex: 0xD9D9D9)).frame(height: 0.5) }
            VStack(spacing: 16) {
                ForEach(state.wechat) { message in
                    if let stamp = message.stamp { Text(stamp).font(.system(size: 12)).foregroundStyle(gray) }
                    bubble(message)
                        .transition(.asymmetric(insertion: .offset(y: 14).combined(with: .opacity), removal: .identity))
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 14)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .bottom).clipped()
            HStack(alignment: .bottom, spacing: 10) {
                Image(systemName: "waveform.circle").font(.system(size: 30, weight: .light)).padding(.bottom, 4)
                Group { Text(state.typed) + Text(state.marked).foregroundColor(Color(hex: 0x0A84FF)).underline() }
                    .font(.system(size: 16.5)).frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
                    .padding(.horizontal, 10).padding(.vertical, 8).background(.white, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                Image(systemName: "face.smiling").font(.system(size: 29, weight: .light)).padding(.bottom, 4)
                Image(systemName: "plus.circle").font(.system(size: 29, weight: .light)).padding(.bottom, 4)
            }
            .foregroundStyle(Color(hex: 0x1D1D1D))
            .padding(.horizontal, 10).padding(.top, 8).padding(.bottom, state.keyboard ? 8 : 42)
            .background(Color(hex: 0xF7F7F7))
            .overlay(alignment: .top) { Rectangle().fill(Color(hex: 0xD9D9D9)).frame(height: 0.5) }
        }
        .padding(.top, 54).padding(.bottom, state.keyboard ? PhoneLayout.keyboard : 0)
        .background(Color(hex: 0xEDEDED))
    }
    private func bubble(_ message: PhoneMessage) -> some View {
        HStack(alignment: .top, spacing: 10) {
            if message.outgoing { Spacer(minLength: 40) }
            if !message.outgoing { AppTile(size: 40).clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous)) }
            Text(message.text).font(.system(size: 16.5)).lineSpacing(2)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(alignment: message.outgoing ? .topTrailing : .topLeading) {
                    ZStack(alignment: message.outgoing ? .topTrailing : .topLeading) {
                        RoundedRectangle(cornerRadius: 5, style: .continuous).fill(message.outgoing ? Color(hex: 0x95EC69) : .white)
                        Rectangle().fill(message.outgoing ? Color(hex: 0x95EC69) : .white).frame(width: 9, height: 9)
                            .rotationEffect(.degrees(45)).offset(x: message.outgoing ? 4 : -4, y: 13)
                    }
                }
                .frame(maxWidth: 246, alignment: message.outgoing ? .trailing : .leading)
            if message.outgoing {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(LinearGradient(colors: [Color(hex: 0xF3C2AE), Color(hex: 0xDD8E77)], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .overlay(Image(systemName: "person.fill").font(.system(size: 22)).foregroundStyle(.white))
                    .frame(width: 40, height: 40)
            }
            if !message.outgoing { Spacer(minLength: 40) }
        }
    }
}

// MARK: - The keyboard

struct PhoneKeyboard: View {
    var state: PhoneState
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 24) {
                if !state.marked.isEmpty { Text(state.marked).font(.system(size: 15)).foregroundStyle(Color(hex: 0x555555)) }
                ForEach(Array(state.candidates.enumerated()), id: \.offset) { index, candidate in
                    Text(candidate).font(.system(size: 18, weight: index == 0 ? .medium : .regular))
                }
                Spacer()
            }
            .padding(.horizontal, 12).frame(height: 42)
            VStack(spacing: 11) {
                HStack(spacing: 6) { ForEach(Array("qwertyuiop"), id: \.self) { key(String($0)) } }
                HStack(spacing: 6) { ForEach(Array("asdfghjkl"), id: \.self) { key(String($0)) } }
                HStack(spacing: 0) {
                    function(Image(systemName: "shift"), width: 43)
                    Spacer()
                    HStack(spacing: 6) { ForEach(Array("zxcvbnm"), id: \.self) { key(String($0)) } }
                    Spacer()
                    function(Image(systemName: "delete.left"), width: 43)
                }.padding(.horizontal, 3)
                HStack(spacing: 6) {
                    function(Text("123"), width: 43)
                    function(Image(systemName: "face.smiling"), width: 43)
                    Text("空格").font(.system(size: 16)).frame(maxWidth: .infinity).frame(height: 43)
                        .background(state.pressed == " " ? Color(hex: 0xABB0BA) : .white, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                        .shadow(color: .black.opacity(0.3), radius: 0, y: 1)
                    Text(state.returnKey).font(.system(size: 16)).foregroundStyle(state.returnActive ? .white : .black)
                        .frame(width: 88, height: 43)
                        .background(state.pressed == "return" ? Color(hex: 0x0060D6) : state.returnActive ? Color(hex: 0x0A84FF) : Color(hex: 0xABB0BA),
                                    in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                        .shadow(color: .black.opacity(0.3), radius: 0, y: 1)
                }.padding(.horizontal, 3)
            }
            .padding(.top, 6)
            HStack {
                Image(systemName: "globe"); Spacer(); Image(systemName: "mic")
            }
            .font(.system(size: 24)).foregroundStyle(Color(hex: 0x50555C)).padding(.horizontal, 22).padding(.top, 12)
        }
        .frame(width: PhoneLayout.size.width, height: PhoneLayout.keyboard, alignment: .top)
        .background(Color(hex: 0xD1D3D9))
        .foregroundStyle(.black)
    }
    private func key(_ letter: String) -> some View {
        let down = state.pressed == letter
        return Text(letter).font(.system(size: 22)).frame(width: 33, height: 43)
            .background(down ? Color(hex: 0xABB0BA) : .white, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
            .shadow(color: .black.opacity(0.3), radius: 0, y: 1)
            .overlay(alignment: .bottom) {
                if down {
                    Text(letter).font(.system(size: 34)).frame(width: 52, height: 94, alignment: .top).padding(.top, 10)
                        .background(.white, in: UnevenRoundedRectangle(topLeadingRadius: 10, bottomLeadingRadius: 8, bottomTrailingRadius: 8, topTrailingRadius: 10, style: .continuous))
                        .shadow(color: .black.opacity(0.28), radius: 3, y: 2)
                }
            }
            .zIndex(down ? 1 : 0)
    }
    private func function<Label: View>(_ label: Label, width: CGFloat) -> some View {
        label.font(.system(size: 16)).frame(width: width, height: 43)
            .background(Color(hex: 0xABB0BA), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
            .shadow(color: .black.opacity(0.3), radius: 0, y: 1)
    }
}
