import AppKit

enum AppLogo {
    static func statusImage() -> NSImage {
        let image = NSImage(size: NSSize(width: 22, height: 18), flipped: true) { _ in
            let shape = NSBezierPath()
            shape.move(to: NSPoint(x: 1, y: 13.4))
            shape.curve(to: NSPoint(x: 3.2, y: 6.2), controlPoint1: NSPoint(x: 0.8, y: 10.2), controlPoint2: NSPoint(x: 2, y: 7.8))
            shape.curve(to: NSPoint(x: 6.2, y: 1.35), controlPoint1: NSPoint(x: 3.6, y: 4), controlPoint2: NSPoint(x: 4.9, y: 1.5))
            shape.curve(to: NSPoint(x: 8.8, y: 2.8), controlPoint1: NSPoint(x: 7.9, y: 1.1), controlPoint2: NSPoint(x: 7, y: 3))
            shape.curve(to: NSPoint(x: 14.7, y: 3), controlPoint1: NSPoint(x: 12, y: 2.3), controlPoint2: NSPoint(x: 13.5, y: 2.8))
            shape.curve(to: NSPoint(x: 16.1, y: 1.7), controlPoint1: NSPoint(x: 16, y: 3.45), controlPoint2: NSPoint(x: 14.5, y: 1.5))
            shape.curve(to: NSPoint(x: 19.6, y: 7.6), controlPoint1: NSPoint(x: 18.3, y: 1.75), controlPoint2: NSPoint(x: 19.2, y: 5.9))
            shape.curve(to: NSPoint(x: 20.4, y: 12.4), controlPoint1: NSPoint(x: 20.1, y: 9), controlPoint2: NSPoint(x: 20.7, y: 10.8))
            shape.curve(to: NSPoint(x: 20.8, y: 15.3), controlPoint1: NSPoint(x: 20.4, y: 13.4), controlPoint2: NSPoint(x: 20, y: 14))
            shape.curve(to: NSPoint(x: 19.2, y: 16.1), controlPoint1: NSPoint(x: 21.7, y: 16.6), controlPoint2: NSPoint(x: 19.8, y: 16))
            shape.curve(to: NSPoint(x: 13.8, y: 14.7), controlPoint1: NSPoint(x: 16.5, y: 17.5), controlPoint2: NSPoint(x: 15.1, y: 15.9))
            shape.curve(to: NSPoint(x: 6.3, y: 15), controlPoint1: NSPoint(x: 11.6, y: 12.5), controlPoint2: NSPoint(x: 8.5, y: 12.7))
            shape.curve(to: NSPoint(x: 1, y: 13.4), controlPoint1: NSPoint(x: 4.7, y: 16.8), controlPoint2: NSPoint(x: 1, y: 17.2))
            shape.close()
            for x in [6.5, 13.0] {
                shape.appendRoundedRect(NSRect(x: x, y: 7, width: 2.5, height: 4.7), xRadius: 1.25, yRadius: 1.25)
            }
            shape.windingRule = .evenOdd
            NSColor.black.setFill()
            shape.fill()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Chat Bridge"
        return image
    }
}
