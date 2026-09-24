// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ChatBridge",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "ChatBridge", targets: ["ChatBridge"])],
    dependencies: [
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", exact: "2.4.1")
    ],
    targets: [
        .target(name: "ChatBridgeKit"),
        .executableTarget(name: "ChatBridge", dependencies: ["ChatBridgeKit",
                          .product(name: "MarkdownUI", package: "swift-markdown-ui")],
                          resources: [.copy("Resources/AgentIcons"), .copy("Resources/Onboarding"),
                                      .copy("Resources/ThirdPartyLicenses")]),
        .testTarget(name: "ChatBridgeKitTests", dependencies: ["ChatBridgeKit"]),
        .testTarget(name: "ChatBridgeTests", dependencies: ["ChatBridge"])
    ],
    swiftLanguageModes: [.v5]
)
