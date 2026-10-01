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

export interface PosePacket {
  type: 'pose';
  sequence: number;
  localPose: LocalPose;
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

export interface DetectionPacket {
  type: 'detection';
  sequence: number;
  subjectId: string;
  timestampNs: number;
  positionPhone: [number, number, number];
  jointsPhone: PhoneJoint[];
  confidence: number;
}

export type OutboundPacket =
  | CalibrationPacket
  | PosePacket
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
