// Platform adapter contract for an ARKit / Record3D observer application.
// Populate RGB/depth through the selected SDK, run MediaPipe or forward the
// frames to the Python hub, then send the resulting skeleton envelope.
import Foundation
import simd

struct SkeletonJoint: Codable {
    let name: String
    let position: [Float]
    let confidence: Float
}

struct ObserverPose: Codable {
    let position: [Float]
    let quaternionXyzw: [Float]
}

struct ObserverSkeletonPacket: Codable {
    let type = "skeleton"
    let subjectId: String
    let timestampNs: UInt64
    let sequence: Int
    let anchorAgeS: Float
    let observerPoseWorld: ObserverPose
    let jointsWorld: [SkeletonJoint]
}

func poseFromARKit(_ transform: simd_float4x4) -> ObserverPose {
    let q = simd_quatf(transform)
    return ObserverPose(position: [transform.columns.3.x, transform.columns.3.y, transform.columns.3.z],
                        quaternionXyzw: [q.imag.x, q.imag.y, q.imag.z, q.real])
}
