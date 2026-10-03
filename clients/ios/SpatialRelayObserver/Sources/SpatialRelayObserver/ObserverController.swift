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

/// Runs ARKit world tracking, detects people with Apple Vision, localizes them
/// (LiDAR depth, or a body-size estimate on phones without LiDAR) and streams
/// them to the hub.
///
/// Two coordinate modes:
///  * **Shared map** — the rooms were scanned (RoomPlan) and every phone has
///    relocalized into the same ARWorldMap. Poses and joints are sent as-is in
///    that world frame; the hub fuses all phones.
///  * **Calibrated room** (no map) — the original single-phone mode: the pose
///    at Calibrate becomes the origin (see RoomFrame).
final class ObserverController: NSObject, ObservableObject, ARSessionDelegate {
    enum Mode: Equatable { case calibratedRoom, scanning, relocalizing, sharedMap }

    // ── UI state ──────────────────────────────────────────────────────────────
    @Published var status = "Starting ARKit…"
    @Published var trackingText = "Initializing"
    @Published var poseText = "X —  Z —  yaw —"
    @Published var targetText = "No person"
    @Published var calibrated = false
    @Published var hasLiDAR = false
    @Published private(set) var mode: Mode = .calibratedRoom
    @Published var busy = false
    /// One skeleton per detected person (2D, this phone's own detections).
    @Published var overlayJoints: [[OverlayJoint]] = []
    @Published var hubHost: String
    @Published var hubPort: Int
    @Published var deviceName: String
    /// X-ray summary: people seen only by other phones.
    @Published var remoteText = ""
    @Published var showRoomWalls = true {
        didSet { overlay.showRoomWalls = showRoomWalls }
    }
    /// Phone position + heading on the scan's top-down plan (x, z, yaw).
    @Published var planPose: SIMD3<Float>?

    let session = ARSession()
    let relay = WebSocketRelay()
    let scanner = RoomScanner()
    let overlay = WorldOverlay()

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
    private var cancellables: Set<AnyCancellable> = []
    private var roomVersionShown = -1
    private var roomLoading = false
    private let worldDecoder = JSONDecoder()
    private let visionQueue = DispatchQueue(label: "spatialrelay.vision", qos: .userInitiated)

    private static let poseInterval: TimeInterval = 1.0 / 25
    private static let detectionInterval: TimeInterval = 1.0 / 15
    /// Adult shoulder-centre → hip-centre length, for depth without LiDAR.
    private static let torsoLengthM: Float = 0.50

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
        if let saved = defaults.string(forKey: "deviceName"), !saved.isEmpty {
            deviceName = saved
        } else {
            let generated = "Phone-" + String(UUID().uuidString.prefix(4))
            defaults.set(generated, forKey: "deviceName")
            deviceName = generated
        }
        super.init()
        // Re-publish child state changes so SwiftUI views observing us refresh.
        relay.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }.store(in: &cancellables)
        scanner.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }.store(in: &cancellables)
        relay.onMessage = { [weak self] msg in
            switch msg.type {
            // Laptop console pressed "Reset origin" (meaningless in a shared map).
            case "calibrate": if self?.mode == .calibratedRoom { self?.calibrate() }
            case "error": print("[hub] \(msg.message ?? "")")
            default: break
            }
        }
        relay.onRawMessage = { [weak self] type, data in
            guard type == "world", let self, self.mode == .sharedMap,
                  let world = try? self.worldDecoder.decode(WorldPacket.self, from: data) else { return }
            self.apply(world)
        }
        scanner.onRoomUpdate = { [weak self] room in
            guard let self else { return }
            self.overlay.showScan(room)
            // RoomPlan may own the session delegate while scanning, so also refresh
            // the plan marker from here.
            if let m = self.session.currentFrame?.camera.transform { self.updatePlanPose(m) }
        }
        relay.onConnected = { [weak self] in
            guard let self else { return }
            self.announcedToHub = false
            self.relay.send(HelloPacket(name: self.deviceName, hasLidar: self.hasLiDAR))
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    func start() {
        guard ARWorldTrackingConfiguration.isSupported else {
            status = "ARKit world tracking is not supported on this device"
            return
        }
        hasLiDAR = ARWorldTrackingConfiguration.supportsFrameSemantics([.sceneDepth, .smoothedSceneDepth])
        session.delegate = self
        session.run(trackingConfiguration(), options: [.resetTracking, .removeExistingAnchors])
        status = "Join the shared map, scan rooms, or hold beside the laptop and Calibrate"
        connectToHub()
    }

    private func trackingConfiguration(worldMap: ARWorldMap? = nil) -> ARWorldTrackingConfiguration {
        let config = ARWorldTrackingConfiguration()
        config.worldAlignment = .gravity
        if hasLiDAR { config.frameSemantics = [.sceneDepth, .smoothedSceneDepth] }
        config.initialWorldMap = worldMap
        return config
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
        var components = URLComponents()
        components.scheme = "ws"
        components.host = host
        components.port = hubPort
        components.path = "/ws/observer"
        components.queryItems = [URLQueryItem(name: "device", value: deviceName)]
        return components.url
    }

    private var api: HubAPI { HubAPI(host: hubHost.trimmingCharacters(in: .whitespaces), port: hubPort) }

    func saveSettings(host: String, port: Int, name: String) {
        hubHost = host.trimmingCharacters(in: .whitespaces)
        hubPort = port
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty { deviceName = trimmed }
        UserDefaults.standard.set(hubHost, forKey: "hubHost")
        UserDefaults.standard.set(hubPort, forKey: "hubPort")
        UserDefaults.standard.set(deviceName, forKey: "deviceName")
        connectToHub()
    }

    /// Calibrated-room mode: the current camera pose becomes the origin, facing +Z.
    /// Hold the phone beside the laptop webcam, pointing the same way.
    func calibrate() {
        guard mode == .calibratedRoom else { return }
        guard let frame = session.currentFrame,
              let newRoom = RoomFrame(cameraTransform: frame.camera.transform) else {
            status = "Cannot calibrate: point the camera at the room"
            return
        }
        room = newRoom
        announcedToHub = true
        relay.send(CalibrationPacket(localPose: LocalPose(position: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1], timestampNs: nowNs())))
        sendPose(frame.camera.transform, tracking: "normal")
        calibrated = true
        status = "Calibrated — streaming to hub"
    }

    // ── Room scan → shared map (LiDAR phone) ─────────────────────────────────
    func startScan() {
        guard RoomScanner.isSupported else {
            status = "Room scanning needs a LiDAR iPhone"
            return
        }
        self.overlay.clearWorld()
        remoteText = ""
        overlayJoints = []
        mode = .scanning
        if scanner.state == .idle || scanner.state == .roomReady {
            scanner.startRoom(on: session)
        }
        status = "Scanning room \(scanner.roomsCaptured + 1): walk slowly, point at every wall"
    }

    func finishRoom() { scanner.finishRoom() }

    func nextRoom() {
        scanner.startRoom(on: session)
        status = "Scanning room \(scanner.roomsCaptured + 1) — walk through the doorway slowly"
    }

    func cancelScan() {
        scanner.reset()
        overlay.clearScan()
        planPose = nil
        resumeTracking()
        mode = .calibratedRoom
        status = "Scan cancelled"
    }

    /// Merge the rooms, upload the model + ARWorldMap, and switch to shared-map mode.
    func uploadScan() {
        busy = true
        status = "Building the room model…"
        Task { @MainActor in
            defer { busy = false }
            do {
                let model = try await scanner.exportModel()
                status = "Saving the shared world map…"
                let map = try await currentWorldMap()
                let mapData = try NSKeyedArchiver.archivedData(withRootObject: map, requiringSecureCoding: true)
                status = String(format: "Uploading room + map (%.1f MB)…", Double(mapData.count) / 1e6)
                try await api.upload(model, to: "api/room", contentType: "application/json")
                try await api.upload(mapData, to: "api/worldmap", contentType: "application/octet-stream")
                scanner.reset()
                overlay.clearScan()
                planPose = nil
                roomVersionShown = -1 // reload the uploaded room from the hub
                resumeTracking()
                mode = .sharedMap
                status = "Shared map live — other phones can now Join"
            } catch {
                status = "Upload failed: \(error.localizedDescription)"
            }
        }
    }

    private func currentWorldMap() async throws -> ARWorldMap {
        try await withCheckedThrowingContinuation { continuation in
            session.getCurrentWorldMap { map, error in
                if let map { continuation.resume(returning: map) }
                else { continuation.resume(throwing: error ?? NSError(domain: "ARKit", code: 0)) }
            }
        }
    }

    /// RoomPlan replaced the session configuration; restore ours (depth, our delegate)
    /// *without* resetting tracking, so the world frame is unchanged.
    private func resumeTracking() {
        session.delegate = self
        session.run(trackingConfiguration(), options: [])
    }

    // ── Join an existing shared map (any ARKit iPhone) ───────────────────────
    func joinSharedMap() {
        busy = true
        status = "Downloading the shared map…"
        Task { @MainActor in
            defer { busy = false }
            do {
                let data = try await api.downloadWorldMap()
                guard let map = try NSKeyedUnarchiver.unarchivedObject(ofClass: ARWorldMap.self, from: data) else {
                    throw NSError(domain: "ARKit", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid world map"])
                }
                room = nil
                calibrated = false
                leaveSharedMap()
                roomVersionShown = -1
                mode = .relocalizing
                session.delegate = self
                session.run(trackingConfiguration(worldMap: map), options: [.resetTracking, .removeExistingAnchors])
                status = "Relocalizing — look around an area that was scanned"
            } catch {
                status = "Join failed: \(error.localizedDescription)"
            }
        }
    }

    // ── X-ray: people the other phones see ───────────────────────────────────
    private func apply(_ world: WorldPacket) {
        if world.roomVersion != roomVersionShown { loadRoom(version: world.roomVersion) }
        guard let camera = session.currentFrame?.camera.transform.translation else { return }
        let (shown, hidden) = overlay.update(world: world, myDeviceId: deviceName, cameraPosition: camera)
        let text: String
        if shown == 0 {
            text = world.devices.filter { $0.online && $0.id != deviceName }.isEmpty
                ? "No other phones in the shared map" : "Other phones see nobody else"
        } else {
            text = "👁 \(shown) seen by other phones" + (hidden > 0 ? " · \(hidden) behind a wall" : "")
        }
        if text != remoteText { remoteText = text }
    }

    private func loadRoom(version: Int) {
        guard !roomLoading else { return }
        roomLoading = true
        Task { @MainActor in
            defer { roomLoading = false }
            if version == 0 {
                roomVersionShown = 0
                return
            }
            if let response = try? await api.fetchRoom() {
                overlay.setRoom(response.room)
                roomVersionShown = version
            }
        }
    }

    /// Phone position and heading on the scan plan (x, z, yaw; the plan draws +Z downward).
    private func updatePlanPose(_ m: simd_float4x4) {
        let forward = -SIMD2(m.columns.2.x, m.columns.2.z)
        planPose = SIMD3(m.columns.3.x, m.columns.3.z, atan2(forward.x, -forward.y))
    }

    private func leaveSharedMap() {
        overlay.clearWorld()
        remoteText = ""
    }

    // ── ARSessionDelegate ─────────────────────────────────────────────────────
    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let t = frame.timestamp
        updateTrackingText(frame.camera.trackingState)
        if mode == .scanning {
            if t - lastUiUpdate > 0.1 {
                lastUiUpdate = t
                updatePlanPose(frame.camera.transform)
            }
            return
        }
        guard case .normal = frame.camera.trackingState else { return }

        if mode == .relocalizing {
            // With an initial world map ARKit reports `.limited(.relocalizing)`
            // until it recognises the scene; `.normal` means we're in the map frame.
            mode = .sharedMap
            status = "Relocalized — sharing the scanned map"
        }
        // Calibrated-room mode streams immediately, using the first tracked pose as
        // a provisional origin until the user calibrates.
        if mode == .calibratedRoom, room == nil { room = RoomFrame(cameraTransform: frame.camera.transform) }

        if t - lastPoseSent >= Self.poseInterval {
            lastPoseSent = t
            sendPose(frame.camera.transform, tracking: "normal")
        }
        if !detecting, t - lastDetection >= Self.detectionInterval {
            lastDetection = t
            detectPeople(in: frame)
        }
    }

    func sessionWasInterrupted(_ session: ARSession) {
        status = "AR session interrupted"
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        switch mode {
        case .sharedMap, .relocalizing:
            // ARKit relocalizes into the same map after an interruption.
            mode = .relocalizing
            status = "Resumed — relocalizing into the shared map"
        default:
            // Tracking may have restarted from a new origin; the old calibration is invalid.
            calibrated = false
            room = nil
            status = "Resumed — hold beside the laptop and Calibrate again"
        }
    }

    func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool { true }

    func session(_ session: ARSession, didFailWithError error: Error) {
        status = "AR error: \(error.localizedDescription)"
    }

    // ── Pose ──────────────────────────────────────────────────────────────────
    private func sendPose(_ transform: simd_float4x4, tracking: String) {
        sequence += 1
        let now = CACurrentMediaTime()
        let updateUi = now - lastUiUpdate > 0.1
        if updateUi { lastUiUpdate = now }

        if mode == .sharedMap {
            let p = transform.translation
            let q = simd_quatf(transform)
            relay.send(MapPosePacket(
                sequence: sequence,
                localPose: LocalPose(position: p.array, quaternionXyzw: [q.imag.x, q.imag.y, q.imag.z, q.real], timestampNs: nowNs()),
                tracking: tracking
            ))
            if updateUi { poseText = String(format: "MAP  X %+.2f  Y %+.2f  Z %+.2f", p.x, p.y, p.z) }
            return
        }

        guard let room else { return }
        // The hub ignores calibrated-room poses until it has a calibration. Our poses
        // are already in the room frame, so announce identity once per connection.
        if relay.state != .connected {
            announcedToHub = false
        } else if !announcedToHub {
            announcedToHub = true
            relay.send(CalibrationPacket(localPose: LocalPose(position: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1], timestampNs: nowNs())))
        }
        let p = room.toRoom(transform.translation)
        let yaw = room.yaw(of: transform)
        relay.send(PosePacket(
            sequence: sequence,
            localPose: LocalPose(position: p.array, quaternionXyzw: yawQuaternionXyzw(yaw), timestampNs: nowNs())
        ))
        if updateUi { poseText = String(format: "X %+.2f  Y %+.2f  Z %+.2f  yaw %+.0f°", p.x, p.y, p.z, yaw * 180 / .pi) }
    }

    private func updateTrackingText(_ state: ARCamera.TrackingState) {
        let text: String
        switch state {
        case .normal: text = "Tracking"
        case .notAvailable: text = "Tracking unavailable"
        case .limited(.initializing): text = "Initializing — move the phone slowly"
        case .limited(.excessiveMotion): text = "Slow down"
        case .limited(.insufficientFeatures): text = "Low detail — point at a textured area"
        case .limited(.relocalizing): text = "Relocalizing — show a scanned area"
        case .limited: text = "Limited tracking"
        }
        if text != trackingText { trackingText = text }
    }

    // ── People detection (Vision 2D pose + LiDAR depth or body-size depth) ───
    private func detectPeople(in frame: ARFrame) {
        let depthMap = (frame.smoothedSceneDepth ?? frame.sceneDepth)?.depthMap
        // Copy what we need: holding on to ARFrame stalls ARKit's buffer pool.
        let pixelBuffer = frame.capturedImage
        let intrinsics = frame.camera.intrinsics
        let imageSize = frame.camera.imageResolution
        let cameraTransform = frame.camera.transform
        let viewport = viewportSize
        let displayTransform = frame.displayTransform(for: .portrait, viewportSize: viewport)
        let currentMode = mode
        let room = self.room
        let seq = sequence + 1
        sequence = seq
        detecting = true

        visionQueue.async { [weak self] in
            let people = Self.locatePeople(
                pixelBuffer: pixelBuffer, depthMap: depthMap, intrinsics: intrinsics,
                imageSize: imageSize, cameraTransform: cameraTransform,
                displayTransform: displayTransform, viewport: viewport
            )
            DispatchQueue.main.async {
                guard let self else { return }
                self.detecting = false
                self.overlayJoints = people.map(\.overlay)
                let located = people.filter { $0.rootWorld != nil }
                let phonePos = cameraTransform.translation

                // Always send, even when empty, so the hub drops people immediately.
                switch currentMode {
                case .sharedMap:
                    self.relay.send(MapDetectionsPacket(
                        sequence: seq,
                        timestampNs: nowNs(),
                        people: located.map { person in
                            WorldPerson(
                                positionWorld: person.rootWorld!.array,
                                jointsWorld: person.joints.map { WorldJoint(name: $0.name, position: $0.world.array, confidence: $0.confidence) },
                                confidence: person.confidence
                            )
                        }
                    ))
                case .calibratedRoom:
                    guard let room else { break }
                    // Express joints in the hub's yaw-only phone frame (see phoneLocal()).
                    let phoneRoom = room.toRoom(phonePos)
                    let yaw = room.yaw(of: cameraTransform)
                    let local = { (p: SIMD3<Float>) in phoneLocal(room: room.toRoom(p), phonePosition: phoneRoom, yaw: yaw).array }
                    self.relay.send(DetectionsPacket(
                        sequence: seq,
                        timestampNs: nowNs(),
                        people: located.map { person in
                            DetectedPerson(
                                positionPhone: local(person.rootWorld!),
                                jointsPhone: person.joints.map { PhoneJoint(name: $0.name, position: local($0.world), confidence: $0.confidence) },
                                confidence: person.confidence
                            )
                        }
                    ))
                default:
                    break
                }

                if let nearest = located.min(by: { simd_length($0.rootWorld! - phonePos) < simd_length($1.rootWorld! - phonePos) }) {
                    let range = simd_length(nearest.rootWorld! - phonePos)
                    self.targetText = String(format: "%d %@  ·  nearest %.1f m%@",
                                             located.count, located.count == 1 ? "person" : "people",
                                             range, depthMap == nil ? " (estimated)" : "")
                } else {
                    self.targetText = "No person"
                }
            }
        }
    }

    private struct LocatedJoint { let name: String; let world: SIMD3<Float>; let confidence: Float }
    private struct Located {
        let joints: [LocatedJoint]
        let rootWorld: SIMD3<Float>?
        let confidence: Float
        let overlay: [OverlayJoint]
    }

    private static let maxPeople = 6

    /// Every person Vision finds in the frame, in ARKit world coordinates. Runs off the main thread.
    private static func locatePeople(
        pixelBuffer: CVPixelBuffer, depthMap: CVPixelBuffer?, intrinsics: simd_float3x3,
        imageSize: CGSize, cameraTransform: simd_float4x4,
        displayTransform: CGAffineTransform, viewport: CGSize
    ) -> [Located] {
        // The captured image is landscape; `.right` presents it upright in portrait.
        let request = VNDetectHumanBodyPoseRequest()
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .right, options: [:])
        guard (try? handler.perform([request])) != nil, let bodies = request.results else { return [] }

        if let depthMap { CVPixelBufferLockBaseAddress(depthMap, .readOnly) }
        defer { if let depthMap { CVPixelBufferUnlockBaseAddress(depthMap, .readOnly) } }

        return bodies.prefix(maxPeople).compactMap { body in
            guard let points = try? body.recognizedPoints(.all) else { return nil }
            return locate(points: points, depthMap: depthMap, intrinsics: intrinsics, imageSize: imageSize,
                          cameraTransform: cameraTransform, displayTransform: displayTransform, viewport: viewport)
        }
    }

    private static func locate(
        points: [VNHumanBodyPoseObservation.JointName: VNRecognizedPoint],
        depthMap: CVPixelBuffer?, intrinsics: simd_float3x3, imageSize: CGSize,
        cameraTransform: simd_float4x4,
        displayTransform: CGAffineTransform, viewport: CGSize
    ) -> Located? {
        let fx = intrinsics.columns.0.x, fy = intrinsics.columns.1.y
        let cx = intrinsics.columns.2.x, cy = intrinsics.columns.2.y

        // Vision: normalized, lower-left origin, in the `.right`-oriented (portrait) image.
        // → normalized top-left coordinates of the landscape sensor image.
        func sensor(_ p: VNRecognizedPoint) -> CGPoint { CGPoint(x: 1 - p.location.y, y: 1 - p.location.x) }
        func pixel(_ n: CGPoint) -> SIMD2<Float> { SIMD2(Float(n.x) * Float(imageSize.width), Float(n.y) * Float(imageSize.height)) }

        // Without LiDAR, one depth for the whole body from its torso length in pixels.
        var estimatedDepth: Float?
        if depthMap == nil {
            let names: [VNHumanBodyPoseObservation.JointName] = [.leftShoulder, .rightShoulder, .leftHip, .rightHip]
            let pts = names.compactMap { points[$0] }.filter { $0.confidence > 0.3 }
            if pts.count == 4 {
                let px = pts.map { pixel(sensor($0)) }
                let torsoPx = simd_distance((px[0] + px[1]) / 2, (px[2] + px[3]) / 2)
                if torsoPx > 8 { estimatedDepth = min(12, max(0.5, (fx + fy) / 2 * torsoLengthM / torsoPx)) }
            }
        }

        var joints: [LocatedJoint] = []
        var overlay: [OverlayJoint] = []
        for (name, jointName) in trackedJoints {
            guard let p = points[jointName], p.confidence > 0.3 else { continue }
            let n = sensor(p)
            let view = n.applying(displayTransform)
            let depth = depthMap.flatMap { medianDepth($0, nu: n.x, nv: n.y) } ?? estimatedDepth
            overlay.append(OverlayJoint(name: name,
                                        point: CGPoint(x: view.x * viewport.width, y: view.y * viewport.height),
                                        hasDepth: depth != nil))
            guard let z = depth else { continue }

            // Pinhole back-projection (OpenCV axes), then into ARKit camera axes
            // (+X right, +Y up, −Z forward), then into ARKit world.
            let uv = pixel(n)
            let camera = SIMD4<Float>((uv.x - cx) * z / fx, -(uv.y - cy) * z / fy, -z, 1)
            let world = cameraTransform * camera
            joints.append(LocatedJoint(name: name, world: SIMD3(world.x, world.y, world.z), confidence: Float(p.confidence)))
        }
        guard !overlay.isEmpty else { return nil }
        guard !joints.isEmpty else { return Located(joints: [], rootWorld: nil, confidence: 0, overlay: overlay) }

        let hips = joints.filter { $0.name.hasSuffix("_hip") }
        let rootSource = hips.isEmpty ? joints : hips
        let root = rootSource.reduce(SIMD3<Float>(repeating: 0)) { $0 + $1.world } / Float(rootSource.count)
        let confidence = joints.map(\.confidence).reduce(0, +) / Float(joints.count) * (depthMap == nil ? 0.6 : 1)
        return Located(joints: joints, rootWorld: root, confidence: confidence, overlay: overlay)
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
