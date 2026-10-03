import Foundation
import simd

/// The shared room frame, anchored to the phone's camera pose at calibration.
///
/// Hub convention (see `src/spatial_relay/transforms.py`):
///  +X = right of the laptop, +Y = up, +Z = forward into the room.
///  Yaw is about +Y; 0 faces +Z and positive turns right (towards +X).
///
/// ARKit (with `.gravity` alignment) is right-handed with +Y up and the camera
/// looking down its local −Z. This type converts ARKit world points into room
/// coordinates by projecting onto the horizontal forward/right axes captured at
/// calibration, so the hub never sees ARKit's arbitrary session origin.
struct RoomFrame {
    let origin: SIMD3<Float>
    /// Horizontal unit vector → room +Z.
    let forward: SIMD3<Float>
    /// Horizontal unit vector → room +X.
    let right: SIMD3<Float>

    init?(cameraTransform t: simd_float4x4) {
        guard let f = RoomFrame.horizontalForward(of: t) else { return nil }
        origin = t.translation
        forward = f
        // Looking along f with +Y up, "right" is f × up.
        right = SIMD3(-f.z, 0, f.x)
    }

    /// ARKit world point → room coordinates.
    func toRoom(_ p: SIMD3<Float>) -> SIMD3<Float> {
        let d = p - origin
        return SIMD3(simd_dot(d, right), d.y, simd_dot(d, forward))
    }

    /// Heading of the camera relative to calibration (radians, + = turned right).
    func yaw(of t: simd_float4x4) -> Float {
        guard let f = RoomFrame.horizontalForward(of: t) else { return 0 }
        return atan2(simd_dot(f, right), simd_dot(f, forward))
    }

    /// Horizontal viewing direction of the rear camera. ARKit's camera frame is
    /// the landscape-right sensor frame, so when the phone is flat (camera
    /// pointing at the floor) we fall back to the phone's top edge, which is
    /// the camera's −X axis.
    static func horizontalForward(of t: simd_float4x4) -> SIMD3<Float>? {
        let back = -SIMD3(t.columns.2.x, 0, t.columns.2.z)
        if simd_length(back) > 0.3 { return simd_normalize(back) }
        let top = -SIMD3(t.columns.0.x, 0, t.columns.0.z)
        let combined = back + top
        return simd_length(combined) > 1e-3 ? simd_normalize(combined) : nil
    }
}

/// Inverse of the hub's yaw-only phone transform: room point → phone-local
/// [x right, y up, z forward] so the hub's `world_from_phone` reproduces it
/// exactly (including camera pitch, which the hub's pose model ignores).
func phoneLocal(room point: SIMD3<Float>, phonePosition: SIMD3<Float>, yaw: Float) -> SIMD3<Float> {
    let d = point - phonePosition
    let c = cos(yaw), s = sin(yaw)
    return SIMD3(c * d.x - s * d.z, d.y, s * d.x + c * d.z)
}

func yawQuaternionXyzw(_ yaw: Float) -> [Float] {
    [0, sin(yaw / 2), 0, cos(yaw / 2)]
}

extension simd_float4x4 {
    var translation: SIMD3<Float> { SIMD3(columns.3.x, columns.3.y, columns.3.z) }
}

extension SIMD3 where Scalar == Float {
    var array: [Float] { [x, y, z] }
}
