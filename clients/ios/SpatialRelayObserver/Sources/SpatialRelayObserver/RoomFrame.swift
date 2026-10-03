import Foundation
import simd

/// Calibrated-room mode: the world frame defined by the phone's pose at Calibrate.
///
/// The origin is the camera position at calibration, +Y is up (gravity) and the
/// camera's horizontal viewing direction at calibration is −Z: right-handed, the
/// same convention as ARKit, the shared ARWorldMap and the three.js website.
/// Phones calibrated at the same spot, facing the same way, share this frame.
struct RoomFrame {
    let origin: SIMD3<Float>
    /// Horizontal unit vector: the camera's viewing direction at calibration (world −Z).
    let forward: SIMD3<Float>
    /// Horizontal unit vector to the camera's right at calibration (world +X).
    let right: SIMD3<Float>

    init?(cameraTransform t: simd_float4x4) {
        guard let f = RoomFrame.horizontalForward(of: t) else { return nil }
        origin = t.translation
        forward = f
        // Looking along f with +Y up, "right" is f × up.
        right = SIMD3(-f.z, 0, f.x)
    }

    /// World ← ARKit transform used for streaming.
    var worldFromARKit: simd_float4x4 {
        let back = -forward
        let arkitFromWorld = simd_float4x4(columns: (
            SIMD4(right.x, right.y, right.z, 0),
            SIMD4(0, 1, 0, 0),
            SIMD4(back.x, back.y, back.z, 0),
            SIMD4(origin.x, origin.y, origin.z, 1)
        ))
        return arkitFromWorld.inverse
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

extension simd_float4x4 {
    var translation: SIMD3<Float> { SIMD3(columns.3.x, columns.3.y, columns.3.z) }
}

extension SIMD3 where Scalar == Float {
    var array: [Float] { [x, y, z] }
}
