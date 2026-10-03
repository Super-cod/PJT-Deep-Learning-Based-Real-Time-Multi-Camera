import Foundation

// Packets matching the Python hub's /ws/observer protocol
// (src/spatial_relay/server.py).

struct LocalPose: Encodable {
    let position: [Float]
    let quaternionXyzw: [Float]
    let timestampNs: UInt64
}

struct CalibrationPacket: Encodable {
    let type = "calibration"
    let localPose: LocalPose
}

struct PosePacket: Encodable {
    let type = "pose"
    let sequence: Int
    let localPose: LocalPose
}

struct PhoneJoint: Encodable {
    let name: String
    let position: [Float]
    let confidence: Float
}

struct DetectionPacket: Encodable {
    let type = "detection"
    let sequence: Int
    let subjectId: String
    let timestampNs: UInt64
    let positionPhone: [Float]
    let jointsPhone: [PhoneJoint]
    let confidence: Float
}

struct DetectedPerson: Encodable {
    let positionPhone: [Float]
    let jointsPhone: [PhoneJoint]
    let confidence: Float
}

/// Every person seen in one camera frame; the hub assigns stable ids.
struct DetectionsPacket: Encodable {
    let type = "detections"
    let sequence: Int
    let timestampNs: UInt64
    let people: [DetectedPerson]
}

/// Messages the hub sends back to the observer.
struct InboundMessage: Decodable {
    let type: String
    let message: String?
}

func nowNs() -> UInt64 { UInt64(Date().timeIntervalSince1970 * 1_000_000_000) }
