import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';

import { ArkitTracker } from '../../modules/arkit-tracker';
import type {
  ArkitAnchor,
  ArkitBody,
  ArkitIntrinsics,
  ArkitLimitedReason,
  ArkitPlane,
  ArkitPose,
  ArkitRaycastResult,
  ArkitStartOptions,
  ArkitTrackingStatus,
  Quat,
  Vec3,
} from '../../modules/arkit-tracker';

/** Quaternion of the "no rotation" case, used until the first ARKit frame. */
export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

export type ArkitAvailability =
  | 'checking'
  | 'available'
  | 'no_module'
  | 'unsupported'
  | 'no_permission';

export interface ArkitState {
  availability: ArkitAvailability;
  running: boolean;
  /** True once at least one ARKit frame has produced a usable pose. */
  hasPose: boolean;
  trackingStatus: ArkitTrackingStatus;
  limitedReason: ArkitLimitedReason | null;
  /** Camera position in the ARKit world frame, metres. */
  position: Vec3;
  quaternion: Quat;
  intrinsics: ArkitIntrinsics | null;
  planes: ArkitPlane[];
  anchors: ArkitAnchor[];
  body: ArkitBody | null;
  mode: 'world' | 'body';
  error: string | null;
}

const INITIAL: ArkitState = {
  availability: 'checking',
  running: false,
  hasPose: false,
  trackingStatus: 'unavailable',
  limitedReason: null,
  position: [0, 0, 0],
  quaternion: IDENTITY_QUAT,
  intrinsics: null,
  planes: [],
  anchors: [],
  body: null,
  mode: 'world',
  error: null,
};

export interface UseArkitOptions {
  autoStart?: boolean;
  fps?: number;
  planeDetection?: ArkitStartOptions['planeDetection'];
  /** Use ARBodyTrackingConfiguration (3D skeleton) instead of world tracking. */
  bodyTracking?: boolean;
  sceneReconstruction?: boolean;
  frameSemantics?: ArkitStartOptions['frameSemantics'];
}

export interface UseArkitResult extends ArkitState {
  start: (opts?: { reset?: boolean }) => Promise<void>;
  stop: () => Promise<void>;
  resetTracking: () => Promise<void>;
  /**
   * Cast a ray through the point the user tapped, in normalized image
   * coordinates, and return the world-space hit. This is the replacement for the
   * manual depth slider: ARKit supplies the real metric distance.
   */
  raycast: (
    u: number,
    v: number,
    alignment?: 'horizontal' | 'vertical' | 'any',
  ) => Promise<ArkitRaycastResult>;
}

export function useArkit(options: UseArkitOptions = {}): UseArkitResult {
  const {
    autoStart = true,
    fps = 25,
    planeDetection = 'both',
    bodyTracking = false,
    sceneReconstruction = true,
    frameSemantics,
  } = options;

  const [state, setState] = useState<ArkitState>(INITIAL);

  // `ArkitTracker` is a module-level constant, but keep it in a ref so the
  // callbacks below do not need it as a dependency.
  const nativeRef = useRef(ArkitTracker);

  const startedRef = useRef(false);
  const optionsRef = useRef({ fps, planeDetection, bodyTracking, sceneReconstruction, frameSemantics });
  optionsRef.current = { fps, planeDetection, bodyTracking, sceneReconstruction, frameSemantics };

  // ── Availability + permission ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      const native = nativeRef.current;
      if (!native) {
        if (!cancelled) setState((s) => ({ ...s, availability: 'no_module' }));
        return;
      }
      if (Platform.OS !== 'ios') {
        if (!cancelled) setState((s) => ({ ...s, availability: 'unsupported' }));
        return;
      }
      if (!native.isSupported()) {
        if (!cancelled) setState((s) => ({ ...s, availability: 'unsupported' }));
        return;
      }

      const o = optionsRef.current;
      if (o.bodyTracking && !(await native.isBodyTrackingSupported())) {
        if (!cancelled) setState((s) => ({ ...s, availability: 'unsupported' }));
        return;
      }

      let status = await native.getCameraAuthorizationStatus();
      if (status === 'undetermined') {
        status = await native.requestCameraPermission();
      }
      if (status !== 'granted') {
        if (!cancelled) setState((s) => ({ ...s, availability: 'no_permission' }));
        return;
      }

      if (!cancelled) {
        setState((s) => ({ ...s, availability: 'available', mode: o.bodyTracking ? 'body' : 'world' }));
      }
    };

    check().catch((err: unknown) => {
      if (!cancelled) {
        setState((s) => ({
          ...s,
          availability: 'unsupported',
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [bodyTracking]);

  // ── Event listeners ───────────────────────────────────────────────────────
  useEffect(() => {
    const native = nativeRef.current;
    if (!native) return;

    const poseSub = native.addListener('ArkitTracker.onPose', (pose: ArkitPose) => {
      setState((s) => ({
        ...s,
        hasPose: true,
        trackingStatus: pose.trackingState,
        limitedReason: pose.limitedReason,
        position: pose.translation,
        quaternion: pose.quaternion,
        intrinsics: pose.intrinsics,
        body: pose.body ?? s.body,
        mode: pose.mode,
      }));
    });

    const trackingSub = native.addListener(
      'ArkitTracker.onTrackingState',
      (event) => {
        setState((s) => ({
          ...s,
          trackingStatus: event.status,
          limitedReason: event.limitedReason,
        }));
      },
    );

    const planesSub = native.addListener('ArkitTracker.onPlanes', (event) => {
      setState((s) => ({ ...s, planes: event.planes }));
    });

    const anchorsSub = native.addListener('ArkitTracker.onAnchors', (event) => {
      setState((s) => ({ ...s, anchors: event.anchors }));
    });

    const interruptedSub = native.addListener('ArkitTracker.onInterrupted', (event) => {
      setState((s) => ({
        ...s,
        running: false,
        error: event.reason,
        // A failed session cannot be trusted until it is restarted.
        hasPose: false,
        planes: [],
        anchors: [],
      }));
    });

    return () => {
      poseSub.remove();
      trackingSub.remove();
      planesSub.remove();
      anchorsSub.remove();
      interruptedSub.remove();
    };
  }, []);

  const start = useCallback(async (opts?: { reset?: boolean }) => {
    const native = nativeRef.current;
    if (!native) return;
    const o = optionsRef.current;
    try {
      setState((s) => ({ ...s, error: null }));
      if (o.bodyTracking) {
        await native.startBodyTracking();
      } else {
        await native.start({
          fps: o.fps,
          planeDetection: o.planeDetection,
          worldAlignment: 'gravity',
          sceneReconstruction: o.sceneReconstruction,
          frameSemantics: o.frameSemantics,
          reset: opts?.reset ?? true,
        });
      }
      startedRef.current = true;
      setState((s) => ({ ...s, running: true, mode: o.bodyTracking ? 'body' : 'world' }));
    } catch (err: unknown) {
      startedRef.current = false;
      setState((s) => ({
        ...s,
        running: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  const stop = useCallback(async () => {
    const native = nativeRef.current;
    if (!native) return;
    startedRef.current = false;
    try {
      await native.pause();
    } catch {
      // Pausing a session that already failed is not an error worth surfacing.
    }
    setState((s) => ({ ...s, running: false }));
  }, []);

  const resetTracking = useCallback(async () => {
    const native = nativeRef.current;
    if (!native || !startedRef.current) return;
    await native.reset();
    setState((s) => ({ ...s, hasPose: false, planes: [], anchors: [] }));
  }, []);

  const raycast = useCallback(
    async (
      u: number,
      v: number,
      alignment: 'horizontal' | 'vertical' | 'any' = 'any',
    ): Promise<ArkitRaycastResult> => {
      const native = nativeRef.current;
      if (!native) return { hit: false, reason: 'arkit_unavailable' };
      try {
        return await native.raycast({ u, v, alignment });
      } catch (err: unknown) {
        return {
          hit: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },
    [],
  );

  // ── Auto start ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!autoStart) return;
    if (state.availability !== 'available' || startedRef.current) return;
    start({ reset: true });
  }, [autoStart, state.availability, start]);

  // ── Backgrounding must pause the session or ARKit kills it ────────────────
  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      if (next === 'active' && startedRef.current && !state.running) {
        start({ reset: false });
      } else if (next !== 'active' && startedRef.current) {
        stop();
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [start, stop, state.running]);

  return useMemo(
    () => ({ ...state, start, stop, resetTracking, raycast }),
    [state, start, stop, resetTracking, raycast],
  );
}
