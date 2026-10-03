// ─── Geometry helpers matching the Python hub's coordinate conventions ────────
//
// Phone-camera frame: +X right, +Y up, +Z towards viewer (OpenCV → ARKit canon)
// World frame: right-handed, +Y up, origin at laptop camera at calibration time.
// T_world_from_phone maps phone-local points into world coordinates.

/** Horizontal field of view of the iPhone main (1x) camera along the image's long side. */
export const DEFAULT_LONG_SIDE_FOV_RAD = (70 * Math.PI) / 180;

/**
 * Back-project a normalised image point (0–1 range, origin top-left) at depth
 * `d` metres into the phone-local camera frame using a pinhole model.
 *
 * `imageW`/`imageH` are the camera frame dimensions (any unit — only the aspect
 * ratio matters). The focal length is derived from the long-side FOV, so the
 * result is correct for both portrait (720×1280) and landscape frames.
 *
 * Returns [x_right, y_up, z_forward] — matches the server's convention.
 */
export function toPhonePoint(
  normX: number,
  normY: number,
  depth: number,
  imageW = 9,
  imageH = 16,
  longSideFovRad = DEFAULT_LONG_SIDE_FOV_RAD,
): [number, number, number] {
  const f = Math.max(imageW, imageH) / 2 / Math.tan(longSideFovRad / 2);
  const x = ((normX - 0.5) * imageW * depth) / f;
  const y = (-(normY - 0.5) * imageH * depth) / f; // flip Y: image-down → world-up
  return [x, y, depth];
}

/** Focal length in the same units as imageW/imageH (used for depth-from-size). */
export function focalLength(
  imageW: number,
  imageH: number,
  longSideFovRad = DEFAULT_LONG_SIDE_FOV_RAD,
): number {
  return Math.max(imageW, imageH) / 2 / Math.tan(longSideFovRad / 2);
}

/** Wrap an angle into (-π, π]. */
export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Heading (radians, counter-clockwise from the reference X axis, seen from
 * above) of the rear camera, from CoreMotion / W3C Z-X'-Y'' Euler angles
 * (alpha = yaw about Z, beta = pitch about X, gamma = roll about Y; radians).
 *
 * The raw Euler yaw (alpha) is unreliable when the phone is held upright,
 * because pitch ≈ 90° is a gimbal-lock singularity. The composed rotation
 * matrix is still exact there, so we rotate the camera's viewing direction
 * (device −Z) into the world and take its horizontal angle. When the phone
 * is nearly flat the viewing direction is vertical, so we blend in the
 * direction of the top edge (device +Y) to keep a usable heading.
 */
export function cameraHeadingRad(alpha: number, beta: number, gamma: number): number {
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  const cb = Math.cos(beta), sb = Math.sin(beta);
  const cg = Math.cos(gamma), sg = Math.sin(gamma);

  // R = Rz(alpha) · Rx(beta) · Ry(gamma) applied to device −Z (rear camera axis).
  let hx = -ca * sg - sa * sb * cg;
  let hy = -sa * sg + ca * sb * cg;

  if (Math.hypot(hx, hy) < 0.4) {
    // R applied to device +Y (top edge of the phone).
    hx += -sa * cb;
    hy += ca * cb;
  }
  return Math.atan2(hy, hx);
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
