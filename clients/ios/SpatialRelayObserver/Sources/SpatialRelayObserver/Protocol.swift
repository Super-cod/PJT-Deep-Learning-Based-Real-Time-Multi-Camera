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

// ── Shared-map mode: everything is already in the ARWorldMap (world) frame ──

/// First packet after connecting: who this phone is.
struct HelloPacket: Encodable {
    let type = "hello"
    let name: String
    let hasLidar: Bool
}

struct MapPosePacket: Encodable {
    let type = "pose"
    let frame = "map"
    let sequence: Int
    /// ARKit camera transform: the camera looks down its local −Z axis.
    let localPose: LocalPose
    let tracking: String
}

struct WorldJoint: Encodable {
    let name: String
    let position: [Float]
    let confidence: Float
}

struct WorldPerson: Encodable {
    let positionWorld: [Float]
    let jointsWorld: [WorldJoint]
    let confidence: Float
}

struct MapDetectionsPacket: Encodable {
    let type = "detections"
    let frame = "map"
    let sequence: Int
    let timestampNs: UInt64
    let people: [WorldPerson]
}

/// Messages the hub sends back to the observer.
struct InboundMessage: Decodable {
    let type: String
    let message: String?
}

func nowNs() -> UInt64 { UInt64(Date().timeIntervalSince1970 * 1_000_000_000) }

// ── Hub → phone: fused world (shared-map mode) ─────────────────────────────

struct WorldPacket: Decodable {
    struct Device: Decodable {
        let id: String
        let name: String
        let online: Bool
        let position: [Float]
        let quaternionXyzw: [Float]
    }
    struct Joint: Decodable {
        let name: String
        let position: [Float]
    }
    struct Person: Decodable {
        let id: String
        let position: [Float]
        let joints: [Joint]
        let seenBy: [String]
    }
    let roomVersion: Int
    let devices: [Device]
    let people: [Person]
}

/// Room model as served by `GET /api/room` (the RoomModel this app uploaded).
struct RoomResponse: Decodable {
    struct Surface: Decodable {
        let category: String
        let dimensions: [Float]
        let transform: [Float]
    }
    struct Room: Decodable {
        let walls: [Surface]
        let doors: [Surface]?
        let windows: [Surface]?
        let openings: [Surface]?
    }
    let version: Int
    let room: Room
}

extension Array where Element == Float {
    var vec3: SIMD3<Float> { count >= 3 ? SIMD3(self[0], self[1], self[2]) : .zero }
}
