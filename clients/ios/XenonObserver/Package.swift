// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "XenonObserver",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        // An xtool project contains exactly one library product: the app.
        .library(
            name: "XenonObserver",
            targets: ["XenonObserver"]
        ),
    ],
    targets: [
        .target(
            name: "XenonObserver",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
