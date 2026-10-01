// ─── Geometry helpers matching the Python hub's coordinate conventions ────────
//
// World frame: right-handed, +Y up, origin at the laptop camera at calibration.
//
// ARKit reports the phone camera pose in its own gravity-aligned world frame
// (metres, +Y up). The pose is already a camera-to-world transform, so it is
// forwarded to the hub unchanged; the hub anchors that frame with the
// calibration pose. Nothing on the phone converts ARKit axes.
//
// Phone-camera frame (used only by the MediaPipe fallback, which has no metric
// tracking): +X right, +Y up, +Z towards the viewer.

/**
 * Back-project a normalised screen point (0–1 range) at depth `d` metres
 * into the phone-local camera frame.
 *
 * Only the MediaPipe fallback path needs this: it has no depth sensor, so
 * `depth` comes from a user guess. ARKit replaces it with a real raycast, so
 * production code never calls this.
 */
export function toPhonePoint(
  normX: number,
  normY: number,
  depth: number,
  fovRad = Math.PI / 3, // 60° default
): [number, number, number] {
  const halfTan = Math.tan(fovRad / 2);
  const x = (normX - 0.5) * 2 * depth * halfTan;
  const y = -(normY - 0.5) * 2 * depth * halfTan; // flip Y: screen-down → world-up
  return [x, y, depth];
}

/**
 * Rotate a phone-local vector [lx, ly, lz] by the given yaw (radians, +Y axis)
 * and translate to the phone world position.
 * Matches the localToWorld() logic in web/phone.js.
 */
export function localToWorld(
  phoneX: number,
  phoneY: number,
  phoneZ: number,
  yawRad: number,
  lx: number,
  ly: number,
  lz: number,
): [number, number, number] {
  const c = Math.cos(yawRad);
  const s = Math.sin(yawRad);
  return [
    phoneX + (lx * c + lz * s),
    phoneY + ly,
    phoneZ + (-lx * s + lz * c),
  ];
}

/**
 * Extract the yaw angle (rotation around +Y axis) from a quaternion [x, y, z, w].
 * Returns radians in the range -π to +π.
 *
 * Identical to `quaternion_to_yaw` in `src/spatial_relay/transforms.py`, so a
 * yaw shown here matches what the hub computes for the same pose.
 */
export function quaternionToYaw(q: [number, number, number, number]): number {
  const [x, y, z, w] = q;
  return Math.atan2(2 * (x * z + y * w), 1 - 2 * (x * x + y * y));
}

/**
 * Build a yaw-only quaternion [x, y, z, w] from a yaw angle in radians.
 * Matches the posePacket() function in web/phone.js.
 */
export function yawToQuaternion(
  yawRad: number,
): [number, number, number, number] {
  return [0, Math.sin(yawRad / 2), 0, Math.cos(yawRad / 2)];
}

/** Convert degrees to radians. */
export function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Convert radians to degrees. */
export function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Clamp `value` into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
