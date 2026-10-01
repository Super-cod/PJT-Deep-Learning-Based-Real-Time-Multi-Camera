// ARKit world tracking for the SpatialRelayObserver phone observer.
//
// Reports metric camera-to-world pose (and optional plane/anchor data) in the
// ARKit world frame. The hub applies the laptop alignment transform, so this
// module deliberately does not guess a phone-local axis convention.

import ARKit
import AVFoundation
import ExpoModulesCore

private let EVENT_POSE = "ArkitTracker.onPose"
private let EVENT_TRACKING_STATE = "ArkitTracker.onTrackingState"
private let EVENT_PLANES = "ArkitTracker.onPlanes"
private let EVENT_ANCHORS = "ArkitTracker.onAnchors"
private let EVENT_INTERRUPTED = "ArkitTracker.onInterrupted"

private let DEFAULT_INTERVAL: TimeInterval = 1.0 / 30.0

public final class ArkitTrackerModule: Module {
  private let session = ARSession()

  private var isRunning = false
  private var hasListeners = false
  private var usingBodyTracking = false
  private var frameInterval: TimeInterval = DEFAULT_INTERVAL
  private var lastPoseSend: TimeInterval = 0
  private var lastPlaneSignature = ""
  private var lastAnchorSignature = ""
  private var lastFrame: ARFrame?

  public func definition() -> ModuleDefinition {
    Name("ArkitTracker")

    Events(
      EVENT_POSE,
      EVENT_TRACKING_STATE,
      EVENT_PLANES,
      EVENT_ANCHORS,
      EVENT_INTERRUPTED
    )

    OnCreate {
      self.session.delegate = self
      self.session.pause()
    }

    OnDestroy {
      self.isRunning = false
      self.session.delegate = nil
      self.session.pause()
    }

    OnStartObserving { self.hasListeners = true }
    OnStopObserving { self.hasListeners = false }

    Function("isSupported") { () -> Bool in
      return ARWorldTrackingConfiguration.isSupported
    }

    AsyncFunction("isBodyTrackingSupported") { () -> Bool in
      return ARBodyTrackingConfiguration.isSupported
    }

    AsyncFunction("isSceneReconstructionSupported") { () -> Bool in
      return Self.supportsSceneReconstruction
    }

    Function("isFrameSemanticsSupported") { (name: String) -> Bool in
      guard let semantics = Self.semantics(name) else { return false }
      return ARWorldTrackingConfiguration.supportsFrameSemantics(semantics)
    }

    AsyncFunction("getCameraAuthorizationStatus") { () -> String in
      return Self.authorizationName(AVCaptureDevice.authorizationStatus(for: .video))
    }

    AsyncFunction("requestCameraPermission") { () -> String in
      let granted = await AVCaptureDevice.requestAccess(for: .video)
      return granted ? "granted" : "denied"
    }

    AsyncFunction("start") { (options: [String: Any?]) -> [String: Any?] in
      guard ARWorldTrackingConfiguration.isSupported else {
        throw GenericException("arkit_world_tracking_unsupported")
      }
      guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
        throw GenericException("camera_permission_required")
      }

      let configuration = ARWorldTrackingConfiguration()
      configuration.worldAlignment = Self.worldAlignment(options["worldAlignment"] as? String)
      configuration.planeDetection = Self.planeDetection(options["planeDetection"] as? String)
      configuration.isLightEstimationEnabled = true

      if let fps = options["fps"] as? Double, fps > 0, fps <= 120 {
        self.frameInterval = 1.0 / fps
      } else {
        self.frameInterval = DEFAULT_INTERVAL
      }

      var appliedSemantics: [String] = []
      if let requested = options["frameSemantics"] as? [String] {
        for name in requested {
          guard let semantics = Self.semantics(name),
                configuration.supportsFrameSemantics(semantics) else { continue }
          configuration.frameSemantics.insert(semantics)
          appliedSemantics.append(name)
        }
      }

      if #available(iOS 13.4, *),
         (options["sceneReconstruction"] as? Bool) ?? false,
         configuration.supportsSceneReconstruction(.mesh) {
        configuration.sceneReconstruction = .mesh
      }

      let shouldReset = (options["reset"] as? Bool) ?? true
      let runOptions: ARSession.RunOptions = shouldReset
        ? [.resetTracking, .removeExistingAnchors]
        : []

      self.session.run(configuration, options: runOptions)
      self.usingBodyTracking = false
      self.isRunning = true
      self.lastPoseSend = 0
      self.lastPlaneSignature = ""
      self.lastAnchorSignature = ""

      return [
        "started": true,
        "worldAlignment": Self.worldAlignmentName(configuration.worldAlignment),
        "planeDetection": Self.planeDetectionName(configuration.planeDetection),
        "frameSemantics": appliedSemantics,
        "sceneReconstruction": Self.supportsSceneReconstruction
          && ((options["sceneReconstruction"] as? Bool) ?? false),
        "supportsBodyTracking": ARBodyTrackingConfiguration.isSupported
      ]
    }

    AsyncFunction("startBodyTracking") { () -> [String: Any?] in
      guard ARBodyTrackingConfiguration.isSupported else {
        throw GenericException("arkit_body_tracking_unsupported")
      }
      guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
        throw GenericException("camera_permission_required")
      }
      let configuration = ARBodyTrackingConfiguration()
      configuration.isAutoFocusEnabled = true
      self.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
      self.usingBodyTracking = true
      self.isRunning = true
      self.lastPoseSend = 0
      return ["started": true, "mode": "body"]
    }

    AsyncFunction("pause") { () -> [String: Any?] in
      self.isRunning = false
      self.session.pause()
      return ["paused": true]
    }

    AsyncFunction("reset") { () -> [String: Any?] in
      self.session.reset()
      self.lastPoseSend = 0
      self.lastPlaneSignature = ""
      self.lastAnchorSignature = ""
      self.lastFrame = nil
      return ["reset": true]
    }

    AsyncFunction("addAnchor") { (options: [String: Any?]) -> [String: Any?] in
      guard let matrix = Self.matrix16(from: options["matrix"] as? [Double]) else {
        throw GenericException("invalid_anchor_matrix")
      }
      let name = options["name"] as? String ?? "spatialrelay"
      let anchor = ARAnchor(name: name, transform: matrix)
      self.session.add(anchor: anchor)
      return ["identifier": anchor.identifier.uuidString, "name": name]
    }

    AsyncFunction("raycast") { (query: [String: Any?]) -> [String: Any?] in
      guard let frame = self.lastFrame else {
        return ["hit": false, "reason": "no_arkit_frame"]
      }

      // ARRaycastQuery itself only distinguishes plane alignment; the
      // estimated-vs-existing distinction comes from the returned result's
      // `isEstimatedPlaneHit` flag.
      let alignment: ARRaycastQuery.TargetAlignment
      switch query["alignment"] as? String {
      case "horizontal": alignment = .horizontal
      case "vertical": alignment = .vertical
      default: alignment = .any
      }

      // Normalized image coordinates in [0, 1] with origin at top-left.
      let u = (query["u"] as? Double) ?? 0.5
      let v = (query["v"] as? Double) ?? 0.5

      let camera = frame.camera
      let intrinsics = camera.intrinsics
      let resolution = camera.imageResolution
      let px = Double(resolution.width) * u
      let py = Double(resolution.height) * v

      let x = (px - Double(intrinsics.columns.2.x)) / Double(intrinsics.columns.0.x)
      let y = (py - Double(intrinsics.columns.2.y)) / Double(intrinsics.columns.1.y)

      // ARKit camera looks down its own -Z axis.
      let directionCamera = simd_normalize(
        SIMD3<Float>(Float(x), Float(y), -1.0)
      )
      let directionWorld = simd_normalize(
        camera.transform * SIMD4<Float>(directionCamera, 0.0)
      )

      let rayQuery = ARRaycastQuery(
        origin: camera.transform.translation,
        direction: directionWorld,
        allowingTargetAlignment: alignment,
        alignment: alignment
      )

      let results = self.session.raycast(rayQuery)
      guard let result = results.first else {
        return ["hit": false, "reason": "no_raycast_result"]
      }

      let hitPosition = result.worldTransform.translation
      let hitNormal = result.worldTransform.columns.2
      return [
        "hit": true,
        "position": Self.doubles(hitPosition),
        "normal": Self.doubles(hitNormal),
        "distance": Double(result.distance),
        "isEstimated": result.isEstimatedPlaneHit,
        "anchorName": result.anchor.name ?? ""
      ]
    }

    AsyncFunction("getTrackedPlanes") { () -> [[String: Any?]] in
      guard let frame = self.lastFrame else { return [] }
      return frame.anchors
        .compactMap { $0 as? ARPlaneAnchor }
        .map { Self.planePayload($0) }
    }

    AsyncFunction("getTrackedAnchors") { () -> [[String: Any?]] in
      guard let frame = self.lastFrame else { return [] }
      return frame.anchors
        .filter { !($0 is ARPlaneAnchor) }
        .map { Self.anchorPayload($0) }
    }
  }

  // MARK: - ARSessionDelegate

  public func session(_ session: ARSession, didUpdate frame: ARFrame) {
    lastFrame = frame
    guard isRunning, hasListeners else { return }
    guard frame.timestamp - lastPoseSend >= frameInterval else { return }
    lastPoseSend = frame.timestamp

    let (status, limitedReason) = Self.trackingState(frame.camera.trackingState)
    sendEvent(EVENT_TRACKING_STATE, [
      "status": status,
      "limitedReason": limitedReason ?? NSNull(),
      "timestamp": frame.timestamp * 1000.0
    ])

    let cameraTransform = frame.camera.transform
    var payload: [String: Any?] = [
      "translation": Self.doubles(cameraTransform.translation),
      "quaternion": Self.quat(simd_quaternionf(cameraTransform)),
      "rotationMatrix": Self.doubles3x3(cameraTransform),
      "trackingState": status,
      "limitedReason": limitedReason ?? NSNull(),
      "timestamp": frame.timestamp * 1000.0,
      "mode": usingBodyTracking ? "body" : "world",
      "source": "arkit",
      "intrinsics": Self.intrinsicsPayload(frame.camera)
    ]

    if usingBodyTracking,
       let body = frame.anchors.compactMap({ $0 as? ARBodyAnchor }).first {
      payload["body"] = Self.bodyPayload(body, cameraTransform: cameraTransform)
    }

    sendEvent(EVENT_POSE, payload)
    emitPlanes(frame)
    emitAnchors(frame)
  }

  public func session(
    _ session: ARSession,
    cameraDidChangeTrackingState camera: ARCamera
  ) {
    let (status, limitedReason) = Self.trackingState(camera.trackingState)
    sendEvent(EVENT_TRACKING_STATE, [
      "status": status,
      "limitedReason": limitedReason ?? NSNull(),
      "timestamp": Date().timeIntervalSince1970 * 1000.0
    ])
  }

  public func session(_ session: ARSession, didFailWithError error: Error) {
    let nsError = error as NSError
    sendEvent(EVENT_INTERRUPTED, [
      "reason": nsError.localizedDescription,
      "code": nsError.code,
      "domain": nsError.domain,
      "recoverable": nsError.code != ARSessionError.internalError.rawValue
    ])
  }

  public func sessionWasInterrupted(_ session: ARSession) {
    sendEvent(EVENT_INTERRUPTED, ["reason": "session_interrupted"])
  }

  public func sessionInterruptionEnded(_ session: ARSession) {
    sendEvent(EVENT_INTERRUPTED, ["reason": "session_resumed"])
  }

  private func emitPlanes(_ frame: ARFrame) {
    let planes = frame.anchors.compactMap { $0 as? ARPlaneAnchor }
    let signature = planes
      .map { "\($0.identifier.uuidString):\(Int($0.classification.rawValue))" }
      .joined(separator: "|")
    guard signature != lastPlaneSignature else { return }
    lastPlaneSignature = signature
    sendEvent(EVENT_PLANES, [
      "timestamp": frame.timestamp * 1000.0,
      "planes": planes.map { Self.planePayload($0) }
    ])
  }

  private func emitAnchors(_ frame: ARFrame) {
    let anchors = frame.anchors.filter { !($0 is ARPlaneAnchor) }
    let signature = anchors
      .map { "\($0.identifier.uuidString):\($0.name ?? "")" }
      .joined(separator: "|")
    guard signature != lastAnchorSignature else { return }
    lastAnchorSignature = signature
    sendEvent(EVENT_ANCHORS, [
      "timestamp": frame.timestamp * 1000.0,
      "anchors": anchors.map { Self.anchorPayload($0) }
    ])
  }

  // MARK: - Payload helpers

  private static func doubles(_ vector: SIMD3<Float>) -> [Double] {
    return [Double(vector.x), Double(vector.y), Double(vector.z)]
  }

  private static func quat(_ q: simd_quatf) -> [Double] {
    let n = simd_normalize(q)
    return [
      Double(n.imag.x), Double(n.imag.y), Double(n.imag.z), Double(n.real)
    ]
  }

  private static func doubles3x3(_ transform: simd_float4x4) -> [Double] {
    let c = transform.columns
    return [
      Double(c.0.x), Double(c.0.y), Double(c.0.z),
      Double(c.1.x), Double(c.1.y), Double(c.1.z),
      Double(c.2.x), Double(c.2.y), Double(c.2.z)
    ]
  }

  private static func intrinsicsPayload(_ camera: ARCamera) -> [String: Any?] {
    let k = camera.intrinsics
    let resolution = camera.imageResolution
    return [
      "fx": Double(k.columns.0.x),
      "fy": Double(k.columns.1.y),
      "cx": Double(k.columns.2.x),
      "cy": Double(k.columns.2.y),
      "width": Double(resolution.width),
      "height": Double(resolution.height)
    ]
  }

  private static func matrix16(from values: [Double]?) -> simd_float4x4? {
    guard let values, values.count == 16 else { return nil }
    return simd_float4x4(
      SIMD4<Float>(Float(values[0]), Float(values[1]), Float(values[2]), Float(values[3])),
      SIMD4<Float>(Float(values[4]), Float(values[5]), Float(values[6]), Float(values[7])),
      SIMD4<Float>(Float(values[8]), Float(values[9]), Float(values[10]), Float(values[11])),
      SIMD4<Float>(Float(values[12]), Float(values[13]), Float(values[14]), Float(values[15]))
    )
  }

  private static func authorizationName(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "undetermined"
    @unknown default: return "undetermined"
    }
  }

  private static var supportsSceneReconstruction: Bool {
    if #available(iOS 13.4, *) {
      return ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    }
    return false
  }

  private static func semantics(
    _ name: String
  ) -> ARConfiguration.FrameSemantics? {
    switch name {
    case "sceneDepth": return .sceneDepth
    case "smoothedSceneDepth": return .smoothedSceneDepth
    case "sceneDepthConfidence": return .sceneDepthConfidence
    case "personSegmentationWithDepth": return .personSegmentationWithDepth
    case "personSegmentation": return .personSegmentation
    default: return nil
    }
  }

  private static func planeDetection(
    _ name: String?
  ) -> ARConfiguration.PlaneDetection {
    switch name {
    case "none": return []
    case "horizontal": return [.horizontal]
    case "vertical": return [.vertical]
    default: return [.horizontal, .vertical]
    }
  }

  private static func planeDetectionName(
    _ detection: ARConfiguration.PlaneDetection
  ) -> String {
    var names: [String] = []
    if detection.contains(.horizontal) { names.append("horizontal") }
    if detection.contains(.vertical) { names.append("vertical") }
    return names.isEmpty ? "none" : names.joined(separator: ",")
  }

  private static func worldAlignment(
    _ name: String?
  ) -> ARWorldTrackingConfiguration.WorldAlignment {
    if name == "gravityAndHeading",
       ARWorldTrackingConfiguration.supportsWorldAlignment(.gravityAndHeading) {
      return .gravityAndHeading
    }
    return .gravity
  }

  private static func worldAlignmentName(
    _ alignment: ARWorldTrackingConfiguration.WorldAlignment
  ) -> String {
    return alignment == .gravityAndHeading ? "gravityAndHeading" : "gravity"
  }

  private static func trackingState(
    _ state: ARCamera.TrackingState
  ) -> (status: String, limitedReason: String?) {
    switch state {
    case .normal:
      return ("normal", nil)
    case .notAvailable:
      return ("unavailable", nil)
    case .limited(let reason):
      switch reason {
      case .initializing: return ("limited", "initializing")
      case .excessiveMotion: return ("limited", "excessiveMotion")
      case .insufficientFeatures: return ("limited", "insufficientFeatures")
      case .relocalizing: return ("limited", "relocalizing")
      @unknown default: return ("limited", "unknown")
      }
    }
  }

  private static func planePayload(_ anchor: ARPlaneAnchor) -> [String: Any?] {
    let extent = anchor.planeExtent
    return [
      "identifier": anchor.identifier.uuidString,
      "classification": Int(anchor.classification.rawValue),
      "alignment": anchor.alignment == .horizontal ? "horizontal" : "vertical",
      "center": doubles(anchor.transform.translation),
      "extentWidth": Double(extent.width),
      "extentHeight": Double(extent.height),
      "quaternion": quat(simd_quaternionf(anchor.transform))
    ]
  }

  private static func anchorPayload(_ anchor: ARAnchor) -> [String: Any?] {
    return [
      "identifier": anchor.identifier.uuidString,
      "name": anchor.name ?? "",
      "kind": String(describing: type(of: anchor)),
      "position": doubles(anchor.transform.translation),
      "quaternion": quat(simd_quaternionf(anchor.transform))
    ]
  }

  private static func bodyPayload(
    _ body: ARBodyAnchor,
    cameraTransform: simd_float4x4
  ) -> [String: Any?] {
    let trackedJoints: [ARSkeleton.JointName] = [
      .root, .hips, .spine1, .spine7, .neck1, .neck4, .head,
      .leftShoulder, .leftArm, .leftForearm, .leftHand,
      .rightShoulder, .rightArm, .rightForearm, .rightHand,
      .leftUpLeg, .leftLeg, .leftFoot,
      .rightUpLeg, .rightLeg, .rightFoot
    ]

    var joints: [[String: Any?]] = []
    joints.reserveCapacity(trackedJoints.count)
    for joint in trackedJoints {
      let world = body.skeleton.modelTransform(for: joint)
      joints.append([
        "name": joint.jointName,
        "position": doubles(world.translation),
        "quaternion": quat(simd_quaternionf(world))
      ])
    }

    return [
      "identifier": body.identifier.uuidString,
      "isTracked": body.isTracked,
      "joints": joints,
      "cameraPosition": doubles(cameraTransform.translation)
    ]
  }
}
