import ARKit
import Combine
import simd
import Vision

struct LocalPose: Codable { let position: [Float]; let quaternionXyzw: [Float]; let timestampNs: UInt64 }
struct CalibrationMessage: Codable { let type = "calibration"; let localPose: LocalPose }
struct PoseMessage: Codable { let type = "pose"; let sequence: Int; let localPose: LocalPose }
struct PhoneJoint: Codable { let name: String; let position: [Float]; let confidence: Float }
struct DetectionMessage: Codable {
    let type = "detection"; let sequence: Int; let subjectId = "person_01"; let timestampNs: UInt64
    let positionPhone: [Float]; let jointsPhone: [PhoneJoint]; let confidence: Float
}

final class ObserverController: NSObject, ObservableObject, ARSessionDelegate {
    @Published var status = "Starting ARKit"
    @Published var poseText = "Pose: —"
    @Published var ready = false
    @Published var calibrated = false
    private let session = ARSession(), relay = WebSocketRelay(), poseRequest = VNDetectHumanBodyPoseRequest()
    private var sequence = 0, lastSent: TimeInterval = 0

    func start() {
        relay.connect(); session.delegate = self
        let config = ARWorldTrackingConfiguration()
        guard ARWorldTrackingConfiguration.isSupported else { status = "AR world tracking is unavailable"; return }
        let semantics: ARConfiguration.FrameSemantics = [.sceneDepth, .smoothedSceneDepth]
        guard ARWorldTrackingConfiguration.supportsFrameSemantics(semantics) else { status = "LiDAR scene depth is required"; return }
        config.frameSemantics = semantics
        session.run(config, options: [.resetTracking, .removeExistingAnchors])
        status = "Point rear camera at scene, then align with laptop"
        ready = true
    }

    func calibrate() {
        guard let frame = session.currentFrame else { return }
        relay.send(CalibrationMessage(localPose: pose(for: frame)))
        calibrated = true; status = "Calibrated: streaming phone pose and depth joints"
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard calibrated, case .normal = frame.camera.trackingState else { return }
        // Limit network and body-pose work to 25 Hz.
        guard frame.timestamp - lastSent >= 0.04 else { return }; lastSent = frame.timestamp
        let phonePose = pose(for: frame); sequence += 1
        relay.send(PoseMessage(sequence: sequence, localPose: phonePose))
        poseText = String(format: "Phone: %+.2f  %+.2f  %+.2f m", phonePose.position[0], phonePose.position[1], phonePose.position[2])
        detectPerson(in: frame, sequence: sequence)
    }

    private func pose(for frame: ARFrame) -> LocalPose {
        let t = frame.camera.transform, q = simd_quatf(t)
        return LocalPose(position: [t.columns.3.x, t.columns.3.y, t.columns.3.z], quaternionXyzw: [q.imag.x, q.imag.y, q.imag.z, q.real], timestampNs: UInt64(frame.timestamp * 1_000_000_000))
    }

    private func detectPerson(in frame: ARFrame, sequence: Int) {
        let request = VNImageRequestHandler(cvPixelBuffer: frame.capturedImage, orientation: .right, options: [:])
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                try request.perform([self.poseRequest])
                guard let body = self.poseRequest.results?.first, let depth = frame.smoothedSceneDepth else { return }
                let joints = self.depthJoints(body: body, depthMap: depth.depthMap, intrinsics: frame.camera.intrinsics, imageSize: frame.camera.imageResolution)
                guard let root = joints.first(where: { $0.name == "root" }) ?? joints.first else { return }
                self.relay.send(DetectionMessage(sequence: sequence, timestampNs: UInt64(frame.timestamp * 1_000_000_000), positionPhone: root.position, jointsPhone: joints, confidence: root.confidence))
            } catch { DispatchQueue.main.async { self.status = "Pose detector error: \(error.localizedDescription)" } }
        }
    }

    private func depthJoints(body: VNHumanBodyPoseObservation, depthMap: CVPixelBuffer, intrinsics: simd_float3x3, imageSize: CGSize) -> [PhoneJoint] {
        let names: [(String, VNHumanBodyPoseObservation.JointName)] = [
            ("nose", .nose), ("left_shoulder", .leftShoulder), ("right_shoulder", .rightShoulder),
            ("left_hip", .leftHip), ("right_hip", .rightHip), ("left_ankle", .leftAnkle), ("right_ankle", .rightAnkle)
        ]
        let width = CVPixelBufferGetWidth(depthMap), height = CVPixelBufferGetHeight(depthMap)
        var result: [PhoneJoint] = []
        for (name, jointName) in names {
            guard let point = try? body.recognizedPoint(jointName), point.confidence > 0.35 else { continue }
            // Vision uses a normalized lower-left origin. Map it to the depth map.
            let x = min(width - 1, max(0, Int(point.location.x * CGFloat(width))))
            let y = min(height - 1, max(0, Int((1 - point.location.y) * CGFloat(height))))
            guard let z = medianDepth(depthMap, x, y), z > 0.1 else { continue }
            // Depth image and camera image share normalized coordinates. Convert to
            // ARKit's canonical camera axes: +X right, +Y up, -Z forward.
            let u = Float(x) / Float(width) * Float(imageSize.width)
            let v = Float(y) / Float(height) * Float(imageSize.height)
            let fx = intrinsics.columns.0.x, fy = intrinsics.columns.1.y
            let cx = intrinsics.columns.2.x, cy = intrinsics.columns.2.y
            // OpenCV-style back-projection is [X right, Y down, Z forward].
            // Convert immediately into this project's ARKit canonical axes.
            result.append(PhoneJoint(name: name, position: [(u-cx)*z/fx, -(v-cy)*z/fy, -z], confidence: point.confidence))
        }
        if result.count >= 2 {
            let hips = result.filter { $0.name.contains("hip") }
            if !hips.isEmpty { let p = hips.reduce(SIMD3<Float>(repeating: 0)) { $0 + SIMD3($1.position[0], $1.position[1], $1.position[2]) } / Float(hips.count); result.append(PhoneJoint(name:"root", position:[p.x,p.y,p.z], confidence: hips.map(\.confidence).reduce(0,+)/Float(hips.count))) }
        }
        return result
    }

    private func medianDepth(_ map: CVPixelBuffer, _ x: Int, _ y: Int) -> Float? {
        CVPixelBufferLockBaseAddress(map, .readOnly); defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(map) else { return nil }
        let width = CVPixelBufferGetWidth(map), height = CVPixelBufferGetHeight(map), stride = CVPixelBufferGetBytesPerRow(map) / MemoryLayout<Float32>.size
        var values: [Float] = []
        let ptr = base.assumingMemoryBound(to: Float32.self)
        for yy in max(0,y-2)...min(height-1,y+2) { for xx in max(0,x-2)...min(width-1,x+2) { let d=ptr[yy*stride+xx]; if d > .1 && d < 12 { values.append(d) } } }
        return values.sorted().dropFirst(values.count / 2).first
    }
}
