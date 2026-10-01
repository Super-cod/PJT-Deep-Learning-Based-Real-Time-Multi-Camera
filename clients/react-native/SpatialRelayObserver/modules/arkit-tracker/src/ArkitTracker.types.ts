export type Vec3 = [number, number, number];
/** Quaternion in ARKit order: [x, y, z, w]. */
export type Quat = [number, number, number, number];

export type ArkitTrackingStatus = 'normal' | 'limited' | 'unavailable';

export type ArkitLimitedReason =
  | 'initializing'
  | 'excessiveMotion'
  | 'insufficientFeatures'
  | 'relocalizing'
  | 'unknown';

export interface ArkitIntrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export interface ArkitPose {
  /** Camera position in the ARKit world frame, metres. */
  translation: Vec3;
  /** Camera orientation in the ARKit world frame. */
  quaternion: Quat;
  /** Row-major upper-left 3x3 rotation. */
  rotationMatrix: number[];
  trackingState: ArkitTrackingStatus;
  limitedReason: ArkitLimitedReason | null;
  /** ARKit monotonic session clock, in milliseconds. */
  timestamp: number;
  mode: 'world' | 'body';
  source: 'arkit';
  intrinsics: ArkitIntrinsics;
  body?: ArkitBody;
}

export interface ArkitBodyJoint {
  name: string;
  position: Vec3;
  quaternion: Quat;
}

export interface ArkitBody {
  identifier: string;
  isTracked: boolean;
  joints: ArkitBodyJoint[];
  cameraPosition: Vec3;
}

export interface ArkitTrackingState {
  status: ArkitTrackingStatus;
  limitedReason: ArkitLimitedReason | null;
  timestamp: number;
}

export interface ArkitPlane {
  identifier: string;
  classification: number;
  alignment: 'horizontal' | 'vertical';
  center: Vec3;
  extentWidth: number;
  extentHeight: number;
  quaternion: Quat;
}

export interface ArkitAnchor {
  identifier: string;
  name: string;
  kind: string;
  position: Vec3;
  quaternion: Quat;
}

export interface ArkitRaycastResult {
  hit: boolean;
  reason?: string;
  position?: Vec3;
  normal?: Vec3;
  distance?: number;
  isEstimated?: boolean;
  anchorName?: string;
}

export interface ArkitStartOptions {
  fps?: number;
  planeDetection?: 'none' | 'horizontal' | 'vertical' | 'both';
  worldAlignment?: 'gravity' | 'gravityAndHeading';
  sceneReconstruction?: boolean;
  frameSemantics?: Array<
    | 'sceneDepth'
    | 'smoothedSceneDepth'
    | 'sceneDepthConfidence'
    | 'personSegmentationWithDepth'
    | 'personSegmentation'
  >;
  reset?: boolean;
}

export interface ArkitStartResult {
  started: boolean;
  worldAlignment: string;
  planeDetection: string;
  frameSemantics: string[];
  sceneReconstruction: boolean;
  supportsBodyTracking: boolean;
}

export interface ArkitInterruptedEvent {
  reason: string;
  code?: number;
  domain?: string;
  recoverable?: boolean;
}

export interface ArkitModule {
  isSupported(): boolean;
  isBodyTrackingSupported(): Promise<boolean>;
  isSceneReconstructionSupported(): Promise<boolean>;
  isFrameSemanticsSupported(name: string): boolean;
  getCameraAuthorizationStatus(): Promise<string>;
  requestCameraPermission(): Promise<string>;
  start(options?: ArkitStartOptions): Promise<ArkitStartResult>;
  startBodyTracking(): Promise<{ started: boolean; mode: string }>;
  pause(): Promise<{ paused: boolean }>;
  reset(): Promise<{ reset: boolean }>;
  addAnchor(options: { matrix: number[]; name?: string }): Promise<{
    identifier: string;
    name: string;
  }>;
  raycast(query: {
    u: number;
    v: number;
    alignment?: 'horizontal' | 'vertical' | 'any';
  }): Promise<ArkitRaycastResult>;
  getTrackedPlanes(): Promise<ArkitPlane[]>;
  getTrackedAnchors(): Promise<ArkitAnchor[]>;
  addListener(
    event: 'ArkitTracker.onPose',
    listener: (event: ArkitPose) => void
  ): { remove(): void };
  addListener(
    event: 'ArkitTracker.onTrackingState',
    listener: (event: ArkitTrackingState) => void
  ): { remove(): void };
  addListener(
    event: 'ArkitTracker.onPlanes',
    listener: (event: { timestamp: number; planes: ArkitPlane[] }) => void
  ): { remove(): void };
  addListener(
    event: 'ArkitTracker.onAnchors',
    listener: (event: { timestamp: number; anchors: ArkitAnchor[] }) => void
  ): { remove(): void };
  addListener(
    event: 'ArkitTracker.onInterrupted',
    listener: (event: ArkitInterruptedEvent) => void
  ): { remove(): void };
}
