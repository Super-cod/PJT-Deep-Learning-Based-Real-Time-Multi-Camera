# Spatial Relay iPhone Observer

On a Mac, install XcodeGen, run `xcodegen generate` in this folder, then open `SpatialRelayObserver.xcodeproj` in Xcode 15+. The implementation uses ARKit for world tracking and LiDAR depth, then Apple Vision's built-in human-body-pose detector. It has no model download or paid SDK dependency, so it builds as generated. Replace the Vision detector with MediaPipe Pose Landmarker later only if you need that model specifically.

Before running, edit `serverHost` in `ObserverController.swift` to your laptop's LAN address, for example `192.168.1.25`. Add the camera and local-network permission strings from `Info.plist` to the app target. Use a LiDAR iPhone for metric scene depth.

In the app: join the laptop's Wi-Fi, hold the iPhone beside the laptop webcam with both cameras facing forward, tap **Calibrate**, then move the phone. The app transmits `calibration`, `pose`, and depth-based `detection` packets to the Python hub.
