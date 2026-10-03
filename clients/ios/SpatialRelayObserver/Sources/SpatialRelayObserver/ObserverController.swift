import ARKit
import Combine
import simd
import Vision

/// A detected joint, ready to draw (view points).
struct OverlayJoint {
    let name: String
    let point: CGPoint
    let hasDepth: Bool
}

/// Runs ARKit world tracking + LiDAR depth, detects people with Apple Vision,
/// and streams `pose` / `detections` packets to the hub in the shared room frame.
final class ObserverController: NSObject, ObservableObject, ARSessionDelegate {
    // ── UI state ──────────────────────────────────────────────────────────────
    @Published var status = "Starting ARKit…"
    @Published var trackingText = "Initializing"
    @Published var poseText = "X —  Z —  yaw —"
    @Published var targetText = "No person"
    @Published var calibrated = false
    @Published var hasLiDAR = false
    /// One skeleton per detected person.
    @Published var overlay: [[OverlayJoint]] = []
    @Published var hubHost: String
    @Published var hubPort: Int

    let session = ARSession()
    let relay = WebSocketRelay()

    /// Set by the view; used to map camera-image coordinates to the screen.
    var viewportSize: CGSize = .zero

    // ── Tracking state (main thread) ─────────────────────────────────────────
    private var room: RoomFrame?
    private var sequence = 0
    private var lastPoseSent: TimeInterval = 0
    private var lastDetection: TimeInterval = 0
    private var lastUiUpdate: TimeInterval = 0
    private var detecting = false
    private var announcedToHub = false
    private var relayCancellable: AnyCancellable?
    private let visionQueue = DispatchQueue(label: "spatialrelay.vision", qos: .userInitiated)

    private static let poseInterval: TimeInterval = 1.0 / 25
    private static let detectionInterval: TimeInterval = 1.0 / 15

    private static let trackedJoints: [(String, VNHumanBodyPoseObservation.JointName)] = [
        ("nose", .nose),
        ("left_shoulder", .leftShoulder), ("right_shoulder", .rightShoulder),
        ("left_elbow", .leftElbow), ("right_elbow", .rightElbow),
        ("left_wrist", .leftWrist), ("right_wrist", .rightWrist),
        ("left_hip", .leftHip), ("right_hip", .rightHip),
        ("left_knee", .leftKnee), ("right_knee", .rightKnee),
        ("left_ankle", .leftAnkle), ("right_ankle", .rightAnkle),
    ]

    override init() {
        let defaults = UserDefaults.standard
        hubHost = defaults.string(forKey: "hubHost") ?? ""
        let port = defaults.integer(forKey: "hubPort")
        hubPort = port == 0 ? 8000 : port
        super.init()
        // Re-publish relay state changes so SwiftUI views observing us refresh.
        relayCancellable = relay.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }
        relay.onMessage = { [weak self] msg in
            switch msg.type {
            case "calibrate": self?.calibrate() // laptop console pressed "Reset origin"
            case "error": print("[hub] \(msg.message ?? "")")
            default: break
            }
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    func start() {
        guard ARWorldTrackingConfiguration.isSupported else {
            status = "ARKit world tracking is not supported on this device"
            return
        }
        let config = ARWorldTrackingConfiguration()
        config.worldAlignment = .gravity
        if ARWorldTrackingConfiguration.supportsFrameSemantics([.sceneDepth, .smoothedSceneDepth]) {
            config.frameSemantics = [.sceneDepth, .smoothedSceneDepth]
            hasLiDAR = true
        }
        session.delegate = self
        session.run(config, options: [.resetTracking, .removeExistingAnchors])
        status = hasLiDAR ? "Hold beside the laptop webcam, then Calibrate" : "No LiDAR: person depth unavailable"
        connectToHub()
    }

    func connectToHub() {
        guard let url = hubURL else {
            status = "Set the hub address in Settings"
            return
        }
        relay.connect(to: url)
    }

    var hubURL: URL? {
        let host = hubHost.trimmingCharacters(in: .whitespaces)
        guard !host.isEmpty else { return nil }
        return URL(string: "ws://\(host):\(hubPort)/ws/observer")
    }

    func saveSettings(host: String, port: Int) {
        hubHost = host.trimmingCharacters(in: .whitespaces)
        hubPort = port
        UserDefaults.standard.set(hubHost, forKey: "hubHost")
        UserDefaults.standard.set(hubPort, forKey: "hubPort")
        connectToHub()
    }

    /// The phone's current camera pose becomes the room origin, facing +Z.
    /// Hold the phone beside the laptop webcam, pointing the same way.
    func calibrate() {
        guard let frame = session.currentFrame,
              let newRoom = RoomFrame(cameraTransform: frame.camera.transform) else {
            status = "Cannot calibrate: point the camera at the room"
            return
        }
        room = newRoom
        announcedToHub = true
        relay.send(CalibrationPacket(localPose: LocalPose(position: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1], timestampNs: nowNs())))
        sendPose(frame.camera.transform)
        calibrated = true
        status = "Calibrated — streaming to hub"
    }

    // ── ARSessionDelegate ─────────────────────────────────────────────────────
    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let t = frame.timestamp
        updateTrackingText(frame.camera.trackingState)
        guard case .normal = frame.camera.trackingState else { return }

        // Stream immediately, using the first tracked pose as a provisional origin
        // until the user calibrates against the laptop.
        if room == nil { room = RoomFrame(cameraTransform: frame.camera.transform) }

        if t - lastPoseSent >= Self.poseInterval {
            lastPoseSent = t
            sendPose(frame.camera.transform)
        }
        if hasLiDAR, !detecting, t - lastDetection >= Self.detectionInterval {
            lastDetection = t
            detectPerson(in: frame)
        }
    }

    func sessionWasInterrupted(_ session: ARSession) {
        status = "AR session interrupted"
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        // Tracking may have restarted from a new origin; the old calibration is invalid.
        calibrated = false
        room = nil
        status = "Resumed — hold beside the laptop and Calibrate again"
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        status = "AR error: \(error.localizedDescription)"
    }

    // ── Pose ──────────────────────────────────────────────────────────────────
    private func sendPose(_ transform: simd_float4x4) {
        guard let room else { return }
        // The hub ignores phone poses until it has a calibration. Our poses are
        // already in the room frame, so announce identity once per connection.
        if relay.state != .connected {
            announcedToHub = false
        } else if !announcedToHub {
            announcedToHub = true
            relay.send(CalibrationPacket(localPose: LocalPose(position: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1], timestampNs: nowNs())))
        }
        let p = room.toRoom(transform.translation)
        let yaw = room.yaw(of: transform)
        sequence += 1
        relay.send(PosePacket(
            sequence: sequence,
            localPose: LocalPose(position: p.array, quaternionXyzw: yawQuaternionXyzw(yaw), timestampNs: nowNs())
        ))

        let now = CACurrentMediaTime()
        if now - lastUiUpdate > 0.1 {
            lastUiUpdate = now
            poseText = String(format: "X %+.2f  Y %+.2f  Z %+.2f  yaw %+.0f°", p.x, p.y, p.z, yaw * 180 / .pi)
        }
    }

    private func updateTrackingText(_ state: ARCamera.TrackingState) {
        let text: String
        switch state {
        case .normal: text = "Tracking"
        case .notAvailable: text = "Tracking unavailable"
        case .limited(.initializing): text = "Initializing — move the phone slowly"
        case .limited(.excessiveMotion): text = "Slow down"
        case .limited(.insufficientFeatures): text = "Low detail — point at a textured area"
        case .limited(.relocalizing): text = "Relocalizing"
        case .limited: text = "Limited tracking"
        }
        if text != trackingText { trackingText = text }
    }

    // ── People detection (Vision 2D pose + LiDAR depth) ──────────────────────
    private func detectPerson(in frame: ARFrame) {
        guard let room, let depthData = frame.smoothedSceneDepth ?? frame.sceneDepth else { return }
        // Copy what we need: holding on to ARFrame stalls ARKit's buffer pool.
        let pixelBuffer = frame.capturedImage
        let depthMap = depthData.depthMap
        let intrinsics = frame.camera.intrinsics
        let imageSize = frame.camera.imageResolution
        let cameraTransform = frame.camera.transform
        let viewport = viewportSize
        let displayTransform = frame.displayTransform(for: .portrait, viewportSize: viewport)
        let seq = sequence + 1
        sequence = seq
        detecting = true

        visionQueue.async { [weak self] in
            let people = Self.locatePeople(
                pixelBuffer: pixelBuffer, depthMap: depthMap, intrinsics: intrinsics,
                imageSize: imageSize, cameraTransform: cameraTransform, room: room,
                displayTransform: displayTransform, viewport: viewport
            )
            DispatchQueue.main.async {
                guard let self else { return }
                self.detecting = false
                self.overlay = people.map(\.overlay)

                // Express joints in the hub's yaw-only phone frame (see phoneLocal()).
                let phonePos = room.toRoom(cameraTransform.translation)
                let yaw = room.yaw(of: cameraTransform)
                let local = { (p: SIMD3<Float>) in phoneLocal(room: p, phonePosition: phonePos, yaw: yaw).array }
                let located = people.compactMap { person -> (Located, SIMD3<Float>)? in
                    guard let root = person.rootRoom else { return nil }
                    return (person, root)
                }

                // Always send, even when empty, so the hub/website drop people immediately.
                // The hub assigns stable person ids across frames.
                self.relay.send(DetectionsPacket(
                    sequence: seq,
                    timestampNs: nowNs(),
                    people: located.map { person, root in
                        DetectedPerson(
                            positionPhone: local(root),
                            jointsPhone: person.joints.map { PhoneJoint(name: $0.name, position: local($0.room), confidence: $0.confidence) },
                            confidence: person.confidence
                        )
                    }
                ))

                if let nearest = located.min(by: { simd_length($0.1 - phonePos) < simd_length($1.1 - phonePos) }) {
                    let root = nearest.1
                    self.targetText = String(format: "%d %@  ·  nearest X %+.2f  Z %+.2f  (%.1f m)",
                                             located.count, located.count == 1 ? "person" : "people",
                                             root.x, root.z, simd_length(root - phonePos))
                } else {
                    self.targetText = "No person"
                }
            }
        }
    }

    private struct LocatedJoint { let name: String; let room: SIMD3<Float>; let confidence: Float }
    private struct Located {
        let joints: [LocatedJoint]
        let rootRoom: SIMD3<Float>?
        let confidence: Float
        let overlay: [OverlayJoint]
    }

    /// Every person Vision finds in the frame, localized with LiDAR depth. Runs off the main thread.
    private static func locatePeople(
        pixelBuffer: CVPixelBuffer, depthMap: CVPixelBuffer, intrinsics: simd_float3x3,
        imageSize: CGSize, cameraTransform: simd_float4x4, room: RoomFrame,
        displayTransform: CGAffineTransform, viewport: CGSize
    ) -> [Located] {
        // The captured image is landscape; `.right` presents it upright in portrait.
        let request = VNDetectHumanBodyPoseRequest()
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .right, options: [:])
        guard (try? handler.perform([request])) != nil, let bodies = request.results else { return [] }

        CVPixelBufferLockBaseAddress(depthMap, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(depthMap, .readOnly) }

        return bodies.prefix(maxPeople).compactMap { body in
            guard let points = try? body.recognizedPoints(.all) else { return nil }
            return locate(points: points, depthMap: depthMap, intrinsics: intrinsics, imageSize: imageSize,
                          cameraTransform: cameraTransform, room: room,
                          displayTransform: displayTransform, viewport: viewport)
        }
    }

    private static let maxPeople = 6

    private static func locate(
        points: [VNHumanBodyPoseObservation.JointName: VNRecognizedPoint],
        depthMap: CVPixelBuffer, intrinsics: simd_float3x3, imageSize: CGSize,
        cameraTransform: simd_float4x4, room: RoomFrame,
        displayTransform: CGAffineTransform, viewport: CGSize
    ) -> Located? {
        let fx = intrinsics.columns.0.x, fy = intrinsics.columns.1.y
        let cx = intrinsics.columns.2.x, cy = intrinsics.columns.2.y

        var joints: [LocatedJoint] = []
        var overlay: [OverlayJoint] = []
        for (name, jointName) in trackedJoints {
            guard let p = points[jointName], p.confidence > 0.3 else { continue }
            // Vision: normalized, lower-left origin, in the `.right`-oriented (portrait) image.
            // → normalized top-left coordinates of the landscape sensor image.
            let nu = 1 - p.location.y
            let nv = 1 - p.location.x

            let view = CGPoint(x: nu, y: nv).applying(displayTransform)
            let depth = medianDepth(depthMap, nu: nu, nv: nv)
            overlay.append(OverlayJoint(name: name,
                                        point: CGPoint(x: view.x * viewport.width, y: view.y * viewport.height),
                                        hasDepth: depth != nil))
            guard let z = depth else { continue }

            // Pinhole back-projection (OpenCV axes), then into ARKit camera axes
            // (+X right, +Y up, −Z forward), then into ARKit world and the room.
            let u = Float(nu) * Float(imageSize.width), v = Float(nv) * Float(imageSize.height)
            let camera = SIMD4<Float>((u - cx) * z / fx, -(v - cy) * z / fy, -z, 1)
            let world = cameraTransform * camera
            joints.append(LocatedJoint(name: name,
                                       room: room.toRoom(SIMD3(world.x, world.y, world.z)),
                                       confidence: Float(p.confidence)))
        }
        guard !overlay.isEmpty else { return nil }
        guard !joints.isEmpty else { return Located(joints: [], rootRoom: nil, confidence: 0, overlay: overlay) }

        let hips = joints.filter { $0.name.hasSuffix("_hip") }
        let rootSource = hips.isEmpty ? joints : hips
        let root = rootSource.reduce(SIMD3<Float>(repeating: 0)) { $0 + $1.room } / Float(rootSource.count)
        let confidence = joints.map(\.confidence).reduce(0, +) / Float(joints.count)
        return Located(joints: joints, rootRoom: root, confidence: confidence, overlay: overlay)
    }

    /// Median LiDAR depth (metres) in a 5×5 window; nil if no valid samples.
    /// Caller must hold the base-address lock.
    private static func medianDepth(_ map: CVPixelBuffer, nu: CGFloat, nv: CGFloat) -> Float? {
        guard let base = CVPixelBufferGetBaseAddress(map) else { return nil }
        let width = CVPixelBufferGetWidth(map), height = CVPixelBufferGetHeight(map)
        let stride = CVPixelBufferGetBytesPerRow(map) / MemoryLayout<Float32>.size
        let x = min(width - 1, max(0, Int(nu * CGFloat(width))))
        let y = min(height - 1, max(0, Int(nv * CGFloat(height))))
        let ptr = base.assumingMemoryBound(to: Float32.self)
        var values: [Float] = []
        values.reserveCapacity(25)
        for yy in max(0, y - 2)...min(height - 1, y + 2) {
            for xx in max(0, x - 2)...min(width - 1, x + 2) {
                let d = ptr[yy * stride + xx]
                if d > 0.1 && d < 12 { values.append(d) }
            }
        }
        guard !values.isEmpty else { return nil }
        values.sort()
        return values[values.count / 2]
    }
}
