// ─── Packet types matching the Python hub's WebSocket protocol ───────────────

export interface LocalPose {
  position: [number, number, number];
  quaternionXyzw: [number, number, number, number];
  timestampNs: number;
}

export interface CalibrationPacket {
  type: 'calibration';
  localPose: LocalPose;
}

export type PoseSource = 'arkit' | 'sensors';

export type TrackingStatus = 'normal' | 'limited' | 'unavailable';

export type TrackingLimitedReason =
  | 'initializing'
  | 'excessiveMotion'
  | 'insufficientFeatures'
  | 'relocalizing'
  | 'unknown';

/**
 * Live device pose. When `source` is `'arkit'` the pose is ARKit's metric
 * camera-to-world transform, so the hub can use it directly instead of a
 * step-count dead-reckoned estimate.
 */
export interface PosePacket {
  type: 'pose';
  sequence: number;
  localPose: LocalPose;
  source?: PoseSource;
  trackingStatus?: TrackingStatus;
  limitedReason?: TrackingLimitedReason | null;
}

/** ARKit tracking-quality heartbeat, used for UI status and diagnostics. */
export interface TrackingPacket {
  type: 'tracking';
  status: TrackingStatus;
  limitedReason: TrackingLimitedReason | null;
  /** ARKit session timestamp in milliseconds. */
  timestampMs: number;
}

export interface IntrinsicsPayload {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export interface ArkitPlanePayload {
  identifier: string;
  alignment: 'horizontal' | 'vertical';
  classification: number;
  center: [number, number, number];
  extentWidth: number;
  extentHeight: number;
}

export interface ArkitAnchorPayload {
  identifier: string;
  name: string;
  kind: string;
  position: [number, number, number];
}

export interface ArkitPlanesPacket {
  type: 'arkit_planes';
  timestampMs: number;
  planes: ArkitPlanePayload[];
}

export interface ArkitAnchorsPacket {
  type: 'arkit_anchors';
  timestampMs: number;
  anchors: ArkitAnchorPayload[];
}

export interface ManualPosePacket {
  type: 'manual_pose';
  sequence: number;
  position: [number, number, number];
  yawRad: number;
  yawDeg: number;
}

export interface PhoneJoint {
  name: string;
  position: [number, number, number];
  confidence: number;
}

export interface WorldJoint {
  name: string;
  position: [number, number, number];
  confidence: number;
}

/**
 * Target localization.
 *
 * `frame` selects how `positionPhone`/`jointsPhone` are interpreted:
 *  - `'phone'` (default): phone-local camera coordinates, the hub applies the
 *    phone-to-world transform.
 *  - `'arkitWorld'`: already in the ARKit world frame, so the hub skips the
 *    device transform. ARKit body tracking reports joints this way.
 */
export interface DetectionPacket {
  type: 'detection';
  sequence: number;
  subjectId: string;
  timestampNs: number;
  frame?: 'phone' | 'arkitWorld';
  positionPhone: [number, number, number];
  jointsPhone: PhoneJoint[];
  confidence: number;
}

export type OutboundPacket =
  | CalibrationPacket
  | PosePacket
  | TrackingPacket
  | ArkitPlanesPacket
  | ArkitAnchorsPacket
  | ManualPosePacket
  | DetectionPacket;

// Joint names matching the Python hub and web phone.js
export const JOINT_NAMES = [
  'nose',
  'left_shoulder',
  'right_shoulder',
  'left_hip',
  'right_hip',
  'left_ankle',
  'right_ankle',
] as const;
