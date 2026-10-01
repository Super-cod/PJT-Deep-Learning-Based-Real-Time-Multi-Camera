// ─── Geometry helpers matching the Python hub's coordinate conventions ────────
//
// Phone-camera frame: +X right, +Y up, +Z towards viewer (OpenCV → ARKit canon)
// World frame: right-handed, +Y up, origin at laptop camera at calibration time.
// T_world_from_phone maps phone-local points into world coordinates.

/**
 * Back-project a normalised screen point (0–1 range) at depth `d` metres
 * into the phone-local camera frame.
 * Assumes a 60° horizontal FOV when real intrinsics are unavailable.
 *
 * Returns [x_right, y_up, z_forward] — matches the server's convention.
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
 */
export function quaternionToYaw(q: [number, number, number, number]): number {
  const [x, y, z, w] = q;
  return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
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
