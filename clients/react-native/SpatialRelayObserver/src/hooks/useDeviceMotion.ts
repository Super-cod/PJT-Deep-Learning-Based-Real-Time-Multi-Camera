import { useCallback, useEffect, useRef, useState } from 'react';
import { DeviceMotion, type DeviceMotionMeasurement } from 'expo-sensors';
import { cameraHeadingRad, wrapAngle, yawToQuaternion } from '../lib/geometry';

export interface MotionPosition {
  x: number;
  y: number;
  z: number;
}

/** Latest pose, read synchronously by the network loop (never stale, never re-renders). */
export interface MotionSnapshot {
  position: MotionPosition;
  yawRad: number;
  yawDeg: number;
  quaternionXyzw: [number, number, number, number];
}

export interface MotionState extends MotionSnapshot {
  /** True once sensors are actively delivering data. */
  ready: boolean;
  /** Whether a step was detected recently. */
  isMoving: boolean;
  /** Step count since calibration. */
  stepCount: number;
  /** Synchronous accessor for the newest pose. */
  getSnapshot: () => MotionSnapshot;
  /** Calibrate reference heading and zero position to origin (0, 0, 0). */
  calibrate: () => void;
  /** Reset position to (0, 0, 0) without changing heading. */
  resetPosition: () => void;
  /** Manual adjustment offset (e.g. from D-pad fine tuning). */
  adjustPosition: (axis: 'x' | 'y' | 'z', delta: number) => void;
}

const SENSOR_INTERVAL_MS = 20; // 50 Hz sensor input
const UI_INTERVAL_MS = 100; // 10 Hz React re-render — the 25 Hz network loop reads refs instead
const STRIDE_M = 0.65; // ~65 cm average indoor stride
const GRAVITY = 9.80665;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Pedestrian Dead-Reckoning (PDR) & Gyro-Inertial Tracker.
 *
 * Starts at the shared origin (0, 0, 0) with the laptop.
 * Fuses:
 *  - CoreMotion attitude → heading of the rear camera, relative to calibration.
 *    The heading comes from the full rotation matrix, so it stays stable while
 *    the phone is held upright (pitch ≈ 90°, where raw Euler yaw is in gimbal lock).
 *  - Human footstep impact detection via total-acceleration oscillation.
 *
 * Coordinate frame (Room Frame):
 *  +X = Right relative to laptop
 *  +Y = Up
 *  +Z = Forward into the room away from laptop
 */
export function useDeviceMotion(): MotionState {
  // Pose accumulators (metres / radians)
  const pdr = useRef({ x: 0, z: 0 });
  const manual = useRef({ x: 0, y: 0, z: 0 });
  const heading0 = useRef<number | null>(null);
  const yawRad = useRef(0);
  const ready = useRef(false);

  // Step detection state
  const stepCount = useRef(0);
  const lastStepTime = useRef(0);
  const baselineG = useRef(1.0);
  const stepArmed = useRef(true);

  const getSnapshot = useCallback((): MotionSnapshot => {
    const yaw = yawRad.current;
    return {
      position: {
        x: round2(pdr.current.x + manual.current.x),
        y: round2(manual.current.y),
        z: round2(pdr.current.z + manual.current.z),
      },
      yawRad: yaw,
      yawDeg: Math.round((yaw * 180) / Math.PI),
      quaternionXyzw: yawToQuaternion(yaw),
    };
  }, []);

  const buildState = useCallback(
    (): Omit<MotionState, 'getSnapshot' | 'calibrate' | 'resetPosition' | 'adjustPosition'> => ({
      ...getSnapshot(),
      ready: ready.current,
      isMoving: performance.now() - lastStepTime.current < 1200,
      stepCount: stepCount.current,
    }),
    [getSnapshot],
  );

  const [uiState, setUiState] = useState(buildState);
  const refreshUi = useCallback(() => setUiState(buildState()), [buildState]);

  const resetPosition = useCallback(() => {
    pdr.current = { x: 0, z: 0 };
    manual.current = { x: 0, y: 0, z: 0 };
    stepCount.current = 0;
    refreshUi();
  }, [refreshUi]);

  // Calibrate: current position becomes (0,0,0), current heading becomes 0° (+Z forward).
  const calibrate = useCallback(() => {
    heading0.current = null; // re-captured from the next sensor sample
    yawRad.current = 0;
    resetPosition();
  }, [resetPosition]);

  const adjustPosition = useCallback((axis: 'x' | 'y' | 'z', delta: number) => {
    manual.current[axis] += delta;
    refreshUi();
  }, [refreshUi]);

  useEffect(() => {
    let sub: { remove: () => void } | null = null;
    let cancelled = false;

    const onMotion = (data: DeviceMotionMeasurement) => {
      ready.current = true;

      // ── 1. Heading ────────────────────────────────────────────────────────
      if (data.rotation) {
        const { alpha, beta, gamma } = data.rotation;
        const heading = cameraHeadingRad(alpha, beta, gamma);
        if (heading0.current === null) heading0.current = heading;
        // Heading is counter-clockwise from above; turning right must be positive.
        yawRad.current = wrapAngle(-(heading - heading0.current));
      }

      // ── 2. Step detection (PDR) ───────────────────────────────────────────
      const acc = data.accelerationIncludingGravity;
      if (acc) {
        const now = performance.now();
        const g = Math.hypot(acc.x, acc.y, acc.z) / GRAVITY;
        baselineG.current = baselineG.current * 0.94 + g * 0.06;
        const deltaG = g - baselineG.current;

        // Heel strike: total G rises > ~0.14 G above baseline, then dips back.
        if (stepArmed.current && deltaG > 0.14) {
          const since = now - lastStepTime.current;
          if (since > 300 && since < 1400) {
            stepCount.current += 1;
            pdr.current.x += STRIDE_M * Math.sin(yawRad.current);
            pdr.current.z += STRIDE_M * Math.cos(yawRad.current);
            stepArmed.current = false;
          }
          // Either a valid step or the first impact of a walk: restart the timing window.
          if (since > 300) lastStepTime.current = now;
        }
        if (!stepArmed.current && deltaG < 0.02) stepArmed.current = true;
      }
    };

    (async () => {
      try {
        const perm = await DeviceMotion.requestPermissionsAsync();
        if (perm.status !== 'granted') {
          console.warn('[useDeviceMotion] Motion permission denied');
          return;
        }
        if (!(await DeviceMotion.isAvailableAsync())) {
          console.warn('[useDeviceMotion] DeviceMotion not available');
          return;
        }
        if (cancelled) return;
        DeviceMotion.setUpdateInterval(SENSOR_INTERVAL_MS);
        sub = DeviceMotion.addListener(onMotion);
      } catch (err) {
        console.warn('[useDeviceMotion] Sensor setup error:', err);
      }
    })();

    const uiTimer = setInterval(refreshUi, UI_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(uiTimer);
      sub?.remove();
    };
  }, [refreshUi]);

  return { ...uiState, getSnapshot, calibrate, resetPosition, adjustPosition };
}
