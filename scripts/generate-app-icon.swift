import Foundation

// Usage: swift scripts/generate-app-icon.swift /tmp/AppIcon.iconset
// Export the current brand master; never redraw an older logo during packaging.
let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let source = root.appendingPathComponent("docs/assets/brand/chat-bridge-app-icon.png")
let directory = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = String(points * scale)
        let suffix = scale == 2 ? "@2x" : ""
        let output = directory.appendingPathComponent("icon_\(points)x\(points)\(suffix).png")
        let resize = Process()
        resize.executableURL = URL(fileURLWithPath: "/usr/bin/sips")
        resize.arguments = ["-z", pixels, pixels, source.path, "--out", output.path]
        resize.standardOutput = FileHandle.nullDevice
        try resize.run()
        resize.waitUntilExit()
        guard resize.terminationStatus == 0 else { exit(resize.terminationStatus) }
    }
}
