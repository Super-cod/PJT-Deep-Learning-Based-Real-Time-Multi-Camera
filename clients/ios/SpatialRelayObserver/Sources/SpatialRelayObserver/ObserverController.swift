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
    /// Calibrate on the first well-tracked frame after leaving the shared map.
    private var calibrateWhenTracking = false
    private var cancellables: Set<AnyCancellable> = []
    private var roomVersionShown = -1
    private var roomLoading = false
    private let worldDecoder = JSONDecoder()
    private let visionQueue = DispatchQueue(label: "spatialrelay.vision", qos: .userInitiated)

    private static let poseInterval: TimeInterval = 1.0 / 25
    private static let detectionInterval: TimeInterval = 1.0 / 20
    /// Adult shoulder-centre → hip-centre length, for depth without LiDAR.
    private static let torsoLengthM: Float = 0.50

    private static let trackedJoints: [(String, VNHumanBodyPoseObservation.JointName)] = [
        ("nose", .nose), ("neck", .neck), ("root", .root),
        ("left_eye", .leftEye), ("right_eye", .rightEye),
        ("left_ear", .leftEar), ("right_ear", .rightEar),
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
            guard type == "world", let self, self.mode == .sharedMap || self.mode == .calibratedRoom,
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
        // LiDAR depth plus person segmentation (so depth is sampled on the person, not the
        // wall behind an arm). Fall back to whatever combination this phone supports.
        let candidates: [ARConfiguration.FrameSemantics] = hasLiDAR
            ? [[.sceneDepth, .smoothedSceneDepth, .personSegmentationWithDepth], [.sceneDepth, .smoothedSceneDepth, .personSegmentation], [.sceneDepth, .smoothedSceneDepth]]
            : [[.personSegmentationWithDepth], [.personSegmentation]]
        config.frameSemantics = candidates.first { ARWorldTrackingConfiguration.supportsFrameSemantics($0) } ?? []
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
        if mode != .calibratedRoom {
            // Calibrating defines a new origin, which can't coexist with the shared map:
            // leave it, then calibrate as soon as fresh tracking is ready.
            leaveSharedMap()
            calibrateWhenTracking = true
            status = "Left the shared map — hold still, calibrating…"
            return
        }
        guard let frame = session.currentFrame, case .normal = frame.camera.trackingState,
              let newRoom = RoomFrame(cameraTransform: frame.camera.transform) else {
            status = "Cannot calibrate: point the camera at the room"
            return
        }
        room = newRoom
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
                clearSharedMapOverlay()
                overlay.clearRoom()
                roomVersionShown = -1
                calibrateWhenTracking = false
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
        // The scanned room is in the shared-map frame; only meaningful there.
        if mode == .sharedMap, world.roomVersion != roomVersionShown { loadRoom(version: world.roomVersion) }
        guard let camera = session.currentFrame?.camera.transform.translation,
              let toWorld = worldFromARKit else { return }
        let (shown, hidden) = overlay.update(world: world, myDeviceId: deviceName, cameraPosition: camera,
                                             arkitFromWorld: toWorld.inverse)
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

    /// Drop the remote people / other phones (e.g. while re-joining).
    private func clearSharedMapOverlay() {
        overlay.clearWorld()
        remoteText = ""
    }

    /// Leave (or stop joining) the shared map and go back to calibrated-room mode
    /// with fresh tracking, without restarting the app.
    func leaveSharedMap() {
        guard mode == .sharedMap || mode == .relocalizing else { return }
        clearSharedMapOverlay()
        overlay.clearRoom() // its walls are in the old map's frame
        roomVersionShown = -1
        room = nil
        calibrated = false
        mode = .calibratedRoom
        session.delegate = self
        session.run(trackingConfiguration(), options: [.resetTracking, .removeExistingAnchors])
        status = "Left the shared map — hold beside the laptop and Calibrate, or Join again"
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
        if mode == .calibratedRoom, calibrateWhenTracking {
            calibrateWhenTracking = false
            calibrate()
        }

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
    /// Shared world frame ← this session's ARKit frame. Both modes stream in the
    /// same right-handed, +Y-up world format the hub and website use:
    ///  * shared map: the scanned ARWorldMap frame is the world (identity);
    ///  * calibrated room: the pose at Calibrate is the origin, looking down −Z.
    private var worldFromARKit: simd_float4x4? {
        switch mode {
        case .sharedMap: return matrix_identity_float4x4
        case .calibratedRoom: return room?.worldFromARKit
        default: return nil
        }
    }

    private func sendPose(_ transform: simd_float4x4, tracking: String) {
        guard let toWorld = worldFromARKit else { return }
        sequence += 1
        let pose = toWorld * transform
        let p = pose.translation
        let q = simd_quatf(pose)
        relay.send(MapPosePacket(
            sequence: sequence,
            localPose: LocalPose(position: p.array, quaternionXyzw: [q.imag.x, q.imag.y, q.imag.z, q.real], timestampNs: nowNs()),
            tracking: tracking
        ))
        let now = CACurrentMediaTime()
        if now - lastUiUpdate > 0.1 {
            lastUiUpdate = now
            poseText = String(format: "%@  X %+.2f  Y %+.2f  Z %+.2f", mode == .sharedMap ? "MAP" : "ROOM", p.x, p.y, p.z)
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
        case .limited(.relocalizing): text = "Relocalizing — show a scanned area"
        case .limited: text = "Limited tracking"
        }
        if text != trackingText { trackingText = text }
    }

    // ── People detection (Vision 2D pose + LiDAR depth or body-size depth) ───
    private func detectPeople(in frame: ARFrame) {
        let lidar = frame.smoothedSceneDepth ?? frame.sceneDepth
        let depth = DepthSources(
            lidar: lidar?.depthMap,
            lidarConfidence: lidar?.confidenceMap,
            personMask: frame.segmentationBuffer,
            personDepth: frame.estimatedDepthData
        )
        // Copy what we need: holding on to ARFrame stalls ARKit's buffer pool.
        let pixelBuffer = frame.capturedImage
        let intrinsics = frame.camera.intrinsics
        let imageSize = frame.camera.imageResolution
        let cameraTransform = frame.camera.transform
        let viewport = viewportSize
        let displayTransform = frame.displayTransform(for: .portrait, viewportSize: viewport)
        let toWorld = worldFromARKit
        let seq = sequence + 1
        sequence = seq
        detecting = true

        visionQueue.async { [weak self] in
            let people = Self.locatePeople(
                pixelBuffer: pixelBuffer, depth: depth, intrinsics: intrinsics,
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
                if let toWorld {
                    let world = { (p: SIMD3<Float>) -> [Float] in
                        let w = toWorld * SIMD4(p.x, p.y, p.z, 1)
                        return [w.x, w.y, w.z]
                    }
                    self.relay.send(MapDetectionsPacket(
                        sequence: seq,
                        timestampNs: nowNs(),
                        people: located.map { person in
                            WorldPerson(
                                positionWorld: world(person.rootWorld!),
                                jointsWorld: person.joints.map { WorldJoint(name: $0.name, position: world($0.world), confidence: $0.confidence) },
                                confidence: person.confidence
                            )
                        }
                    ))
                }

                if let nearest = located.min(by: { simd_length($0.rootWorld! - phonePos) < simd_length($1.rootWorld! - phonePos) }) {
                    let range = simd_length(nearest.rootWorld! - phonePos)
                    self.targetText = String(format: "%d %@  ·  nearest %.1f m  ·  %@",
                                             located.count, located.count == 1 ? "person" : "people",
                                             range, nearest.depthSource)
                } else {
                    self.targetText = "No person"
                }
            }
        }
    }

    /// Every depth signal ARKit gives us for one frame.
    private struct DepthSources {
        /// LiDAR metric depth (Float32), LiDAR phones only.
        let lidar: CVPixelBuffer?
        /// Per-pixel LiDAR confidence (UInt8: 0 low, 1 medium, 2 high).
        let lidarConfidence: CVPixelBuffer?
        /// Person segmentation (UInt8: 255 = person), A12+.
        let personMask: CVPixelBuffer?
        /// Neural depth of person pixels only (Float32), A12+, no LiDAR needed.
        let personDepth: CVPixelBuffer?

        var all: [CVPixelBuffer] { [lidar, lidarConfidence, personMask, personDepth].compactMap { $0 } }
    }

    /// Read access to a locked CVPixelBuffer by normalized image coordinates.
    private struct Plane {
        let base: UnsafeMutableRawPointer
        let width: Int
        let height: Int
        let bytesPerRow: Int

        init?(_ buffer: CVPixelBuffer?) {
            guard let buffer, let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
            self.base = base
            width = CVPixelBufferGetWidth(buffer)
            height = CVPixelBufferGetHeight(buffer)
            bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
        }

        func pixel(_ nu: Float, _ nv: Float) -> (Int, Int) {
            (min(width - 1, max(0, Int(nu * Float(width)))), min(height - 1, max(0, Int(nv * Float(height)))))
        }
        func float(_ x: Int, _ y: Int) -> Float {
            base.advanced(by: y * bytesPerRow).assumingMemoryBound(to: Float32.self)[x]
        }
        func byte(_ x: Int, _ y: Int) -> UInt8 {
            base.advanced(by: y * bytesPerRow).assumingMemoryBound(to: UInt8.self)[x]
        }
    }

    private struct LocatedJoint { let name: String; let world: SIMD3<Float>; let confidence: Float }
    private struct Located {
        let joints: [LocatedJoint]
        let rootWorld: SIMD3<Float>?
        let confidence: Float
        let overlay: [OverlayJoint]
        let depthSource: String
    }

    private static let maxPeople = 6
    /// A joint farther than this from the body's depth is a mis-sample (background behind a limb).
    private static let maxJointDepthDeviation: Float = 0.7
    private static let torsoJoints: Set<String> = ["left_shoulder", "right_shoulder", "left_hip", "right_hip", "neck", "root"]

    /// Every person Vision finds in the frame, in ARKit world coordinates. Runs off the main thread.
    private static func locatePeople(
        pixelBuffer: CVPixelBuffer, depth: DepthSources, intrinsics: simd_float3x3,
        imageSize: CGSize, cameraTransform: simd_float4x4,
        displayTransform: CGAffineTransform, viewport: CGSize
    ) -> [Located] {
        // The captured image is landscape; `.right` presents it upright in portrait.
        let request = VNDetectHumanBodyPoseRequest()
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .right, options: [:])
        guard (try? handler.perform([request])) != nil, let bodies = request.results else { return [] }

        let buffers = depth.all
        buffers.forEach { CVPixelBufferLockBaseAddress($0, .readOnly) }
        defer { buffers.forEach { CVPixelBufferUnlockBaseAddress($0, .readOnly) } }
        let planes = (lidar: Plane(depth.lidar), confidence: Plane(depth.lidarConfidence),
                      mask: Plane(depth.personMask), personDepth: Plane(depth.personDepth))

        return bodies.prefix(maxPeople).compactMap { body in
            guard let points = try? body.recognizedPoints(.all) else { return nil }
            return locate(points: points, planes: planes, intrinsics: intrinsics, imageSize: imageSize,
                          cameraTransform: cameraTransform, displayTransform: displayTransform, viewport: viewport)
        }
    }

    private static func locate(
        points: [VNHumanBodyPoseObservation.JointName: VNRecognizedPoint],
        planes: (lidar: Plane?, confidence: Plane?, mask: Plane?, personDepth: Plane?),
        intrinsics: simd_float3x3, imageSize: CGSize,
        cameraTransform: simd_float4x4,
        displayTransform: CGAffineTransform, viewport: CGSize
    ) -> Located? {
        let fx = intrinsics.columns.0.x, fy = intrinsics.columns.1.y
        let cx = intrinsics.columns.2.x, cy = intrinsics.columns.2.y

        // Vision: normalized, lower-left origin, in the `.right`-oriented (portrait) image.
        // → normalized top-left coordinates of the landscape sensor image.
        func sensor(_ p: VNRecognizedPoint) -> CGPoint { CGPoint(x: 1 - p.location.y, y: 1 - p.location.x) }
        func pixel(_ n: CGPoint) -> SIMD2<Float> { SIMD2(Float(n.x) * Float(imageSize.width), Float(n.y) * Float(imageSize.height)) }

        // 1. 2D joints this person has.
        var found: [(name: String, n: CGPoint, confidence: Float)] = []
        for (name, jointName) in trackedJoints {
            guard let p = points[jointName], p.confidence > 0.3 else { continue }
            found.append((name, sensor(p), Float(p.confidence)))
        }
        guard !found.isEmpty else { return nil }

        // 2. Raw depth per joint, best source first.
        var source = "no depth"
        var depths: [String: Float] = [:]
        for joint in found {
            let nu = Float(joint.n.x), nv = Float(joint.n.y)
            if let d = lidarDepth(nu, nv, planes) {
                depths[joint.name] = d; source = "LiDAR"
            } else if let d = personNetworkDepth(nu, nv, planes) {
                depths[joint.name] = d; if source != "LiDAR" { source = "neural depth" }
            }
        }
        // No per-pixel depth at all (old phone): one depth for the body from torso size.
        if depths.isEmpty {
            let names = ["left_shoulder", "right_shoulder", "left_hip", "right_hip"]
            let torso = names.compactMap { name in found.first { $0.name == name } }
            if torso.count == 4 {
                let px = torso.map { pixel($0.n) }
                let torsoPx = simd_distance((px[0] + px[1]) / 2, (px[2] + px[3]) / 2)
                if torsoPx > 8 {
                    let d = min(12, max(0.5, (fx + fy) / 2 * torsoLengthM / torsoPx))
                    found.forEach { depths[$0.name] = d }
                    source = "estimated"
                }
            }
        }

        // 3. Body consistency: a joint far from the torso's depth hit the background → use the body depth.
        let torsoDepths = depths.filter { torsoJoints.contains($0.key) }.map(\.value).sorted()
        let allDepths = depths.values.sorted()
        let bodyDepth = torsoDepths.isEmpty ? (allDepths.isEmpty ? nil : allDepths[allDepths.count / 2]) : torsoDepths[torsoDepths.count / 2]
        if let bodyDepth {
            for (name, d) in depths where abs(d - bodyDepth) > maxJointDepthDeviation { depths[name] = bodyDepth }
        }

        // 4. Back-project into the ARKit world.
        var joints: [LocatedJoint] = []
        var overlay: [OverlayJoint] = []
        for joint in found {
            let view = joint.n.applying(displayTransform)
            let z = depths[joint.name] ?? bodyDepth
            overlay.append(OverlayJoint(name: joint.name,
                                        point: CGPoint(x: view.x * viewport.width, y: view.y * viewport.height),
                                        hasDepth: z != nil))
            guard let z else { continue }
            // Pinhole back-projection (OpenCV axes), then into ARKit camera axes
            // (+X right, +Y up, −Z forward), then into ARKit world.
            let uv = pixel(joint.n)
            let camera = SIMD4<Float>((uv.x - cx) * z / fx, -(uv.y - cy) * z / fy, -z, 1)
            let world = cameraTransform * camera
            joints.append(LocatedJoint(name: joint.name, world: SIMD3(world.x, world.y, world.z), confidence: joint.confidence))
        }
        guard !joints.isEmpty else {
            return Located(joints: [], rootWorld: nil, confidence: 0, overlay: overlay, depthSource: source)
        }

        let hips = joints.filter { $0.name.hasSuffix("_hip") }
        let rootJoint = joints.first { $0.name == "root" }
        let rootSource = hips.isEmpty ? joints : hips
        let root = rootJoint?.world ?? rootSource.reduce(SIMD3<Float>(repeating: 0)) { $0 + $1.world } / Float(rootSource.count)
        let quality: Float = source == "LiDAR" ? 1 : (source == "neural depth" ? 0.8 : 0.6)
        let confidence = joints.map(\.confidence).reduce(0, +) / Float(joints.count) * quality
        return Located(joints: joints, rootWorld: root, confidence: confidence, overlay: overlay, depthSource: source)
    }

    /// Median LiDAR depth around a joint, using only pixels that are (a) on a person
    /// when segmentation is available and (b) at least medium LiDAR confidence.
    /// Searches a 5×5 window, widening to 9×9 if the joint sits on a body edge.
    private static func lidarDepth(_ nu: Float, _ nv: Float,
                                   _ planes: (lidar: Plane?, confidence: Plane?, mask: Plane?, personDepth: Plane?)) -> Float? {
        guard let depth = planes.lidar else { return nil }
        let (x, y) = depth.pixel(nu, nv)
        for radius in [2, 4] {
            var values: [Float] = []
            for yy in max(0, y - radius)...min(depth.height - 1, y + radius) {
                for xx in max(0, x - radius)...min(depth.width - 1, x + radius) {
                    let d = depth.float(xx, yy)
                    guard d > 0.1, d < 12 else { continue }
                    if let conf = planes.confidence, conf.byte(xx, yy) < 1 { continue }
                    if let mask = planes.mask {
                        // Same normalized position in the (differently sized) mask.
                        let (mx, my) = mask.pixel((Float(xx) + 0.5) / Float(depth.width), (Float(yy) + 0.5) / Float(depth.height))
                        if mask.byte(mx, my) == 0 { continue }
                    }
                    values.append(d)
                }
            }
            if values.count >= 3 {
                values.sort()
                return values[values.count / 2]
            }
        }
        return nil
    }

    /// ARKit's neural depth of person pixels (no LiDAR needed): median of a 5×5 window.
    private static func personNetworkDepth(_ nu: Float, _ nv: Float,
                                           _ planes: (lidar: Plane?, confidence: Plane?, mask: Plane?, personDepth: Plane?)) -> Float? {
        guard let depth = planes.personDepth else { return nil }
        let (x, y) = depth.pixel(nu, nv)
        var values: [Float] = []
        for yy in max(0, y - 2)...min(depth.height - 1, y + 2) {
            for xx in max(0, x - 2)...min(depth.width - 1, x + 2) {
                let d = depth.float(xx, yy)
                if d > 0.1 && d < 12 { values.append(d) }
            }
        }
        guard values.count >= 3 else { return nil }
        values.sort()
        return values[values.count / 2]
    }
}
