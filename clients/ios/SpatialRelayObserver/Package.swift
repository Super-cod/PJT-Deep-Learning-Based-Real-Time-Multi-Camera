// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "SpatialRelayObserver",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        // An xtool project contains exactly one library product: the app.
        .library(
            name: "SpatialRelayObserver",
            targets: ["SpatialRelayObserver"]
        ),
    ],
    targets: [
        .target(
            name: "SpatialRelayObserver",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
