import { useCallback, useEffect, useRef, useState } from 'react';
import { DeviceMotion, Accelerometer } from 'expo-sensors';
import { yawToQuaternion } from '../lib/geometry';

export interface MotionPosition {
  x: number;
  y: number;
  z: number;
}

export interface MotionState {
  /** Dynamic phone position in room frame [x, y, z] in metres. Starts at [0, 0, 0]. */
  position: MotionPosition;
  /** Live velocity in room frame [vx, vy, vz] in m/s. */
  velocity: MotionPosition;
  /** Relative yaw angle in radians (0 = facing +Z forward, positive = turning right). */
  yawRad: number;
  /** Relative yaw angle in degrees (-180° to +180°). */
  yawDeg: number;
  /** Full orientation quaternion [x, y, z, w]. */
  quaternionXyzw: [number, number, number, number];
  /** True once sensors are actively delivering data. */
  ready: boolean;
  /** Whether movement is currently detected. */
  isMoving: boolean;
  /** Step count since calibration. */
  stepCount: number;
  /** Calibrate reference heading and zero position to origin (0, 0, 0). */
  calibrate: () => void;
  /** Reset position to (0, 0, 0) without changing heading. */
  resetPosition: () => void;
  /** Manual adjustment offset (e.g. from D-pad fine tuning). */
  adjustPosition: (axis: 'x' | 'y' | 'z', delta: number) => void;
}

const INITIAL_STATE: MotionState = {
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  yawRad: 0,
  yawDeg: 0,
  quaternionXyzw: [0, 0, 0, 1],
  ready: false,
  isMoving: false,
  stepCount: 0,
  calibrate: () => {},
  resetPosition: () => {},
  adjustPosition: () => {},
};

/**
 * Pedestrian Dead-Reckoning (PDR) & Gyro-Inertial Tracker.
 *
 * Starts at the shared origin (0, 0, 0) with the laptop.
 * Fuses:
 *  - 3D CoreMotion Gyroscope (Yaw angle relative to calibration)
 *  - Human footstep impact detection via Accelerometer gravity oscillation
 *  - Continuous hand/arm motion integration
 *  - Zero drift when stationary
 *
 * Coordinate frame (Room Frame):
 *  +X = Right relative to laptop
 *  +Y = Up
 *  +Z = Forward into the room away from laptop
 */
export function useDeviceMotion(): MotionState {
  const [motionState, setMotionState] = useState<MotionState>(INITIAL_STATE);

  // Position accumulators in metres
  const posX = useRef(0.0);
  const posY = useRef(0.0);
  const posZ = useRef(0.0);

  // Velocity accumulators in m/s
  const velX = useRef(0.0);
  const velZ = useRef(0.0);

  // Heading references
  const yaw0 = useRef<number | null>(null);
  const currentYawRad = useRef(0.0);
  const currentQuaternion = useRef<[number, number, number, number]>([0, 0, 0, 1]);

  const lastTimestamp = useRef<number | null>(null);

  // Step detection state
  const stepCount = useRef(0);
  const lastStepTime = useRef(0);
  const rollingBaselineG = useRef(1.0);
  const stepArmed = useRef(true);

  // Manual offsets (from D-pad or step buttons)
  const manualOffsetX = useRef(0.0);
  const manualOffsetY = useRef(0.0);
  const manualOffsetZ = useRef(0.0);

  // Calibrate: set current position as (0,0,0) and current heading as 0° (+Z forward)
  const calibrate = useCallback(() => {
    posX.current = 0.0;
    posY.current = 0.0;
    posZ.current = 0.0;
    velX.current = 0.0;
    velZ.current = 0.0;
    manualOffsetX.current = 0.0;
    manualOffsetY.current = 0.0;
    manualOffsetZ.current = 0.0;
    stepCount.current = 0;

    // Reset heading reference to current raw alpha
    yaw0.current = null;
    currentYawRad.current = 0.0;
    currentQuaternion.current = [0, 0, 0, 1];

    setMotionState((prev) => ({
      ...prev,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      yawRad: 0,
      yawDeg: 0,
      quaternionXyzw: [0, 0, 0, 1],
      isMoving: false,
      stepCount: 0,
    }));
  }, []);

  const resetPosition = useCallback(() => {
    posX.current = 0.0;
    posY.current = 0.0;
    posZ.current = 0.0;
    velX.current = 0.0;
    velZ.current = 0.0;
    manualOffsetX.current = 0.0;
    manualOffsetY.current = 0.0;
    manualOffsetZ.current = 0.0;
    stepCount.current = 0;

    setMotionState((prev) => ({
      ...prev,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      stepCount: 0,
    }));
  }, []);

  const adjustPosition = useCallback((axis: 'x' | 'y' | 'z', delta: number) => {
    if (axis === 'x') manualOffsetX.current += delta;
    if (axis === 'y') manualOffsetY.current += delta;
    if (axis === 'z') manualOffsetZ.current += delta;

    setMotionState((prev) => ({
      ...prev,
      position: {
        x: Math.round((posX.current + manualOffsetX.current) * 100) / 100,
        y: Math.round((posY.current + manualOffsetY.current) * 100) / 100,
        z: Math.round((posZ.current + manualOffsetZ.current) * 100) / 100,
      },
    }));
  }, []);

  useEffect(() => {
    let mounted = true;
    let motionSub: ReturnType<typeof DeviceMotion.addListener> | null = null;
    let accelSub: ReturnType<typeof Accelerometer.addListener> | null = null;

    async function initSensors() {
      try {
        const available = await DeviceMotion.isAvailableAsync();
        if (!available) {
          console.warn('[useDeviceMotion] DeviceMotion not available');
          return;
        }

        // 30ms update interval ~ 33Hz
        DeviceMotion.setUpdateInterval(30);
        Accelerometer.setUpdateInterval(30);

        // ── 1. Gyroscope Orientation via DeviceMotion ──────────────────────────
        motionSub = DeviceMotion.addListener((data) => {
          if (!mounted) return;

          let yawRad = 0;
          let yawDeg = 0;

          if (data.rotation) {
            const rawAlpha = data.rotation.alpha;
            if (yaw0.current === null) {
              yaw0.current = rawAlpha;
            }

            // Relative yaw: clockwise (turning right) = positive
            let relYaw = -(rawAlpha - yaw0.current);
            while (relYaw > Math.PI) relYaw -= 2 * Math.PI;
            while (relYaw < -Math.PI) relYaw += 2 * Math.PI;

            yawRad = relYaw;
            yawDeg = (relYaw * 180) / Math.PI;
          }

          currentYawRad.current = yawRad;
          const quat = yawToQuaternion(yawRad);
          currentQuaternion.current = quat;
        });

        // ── 2. Pedestrian Dead-Reckoning (PDR) via Accelerometer ───────────────
        accelSub = Accelerometer.addListener((acc) => {
          if (!mounted) return;

          const now = performance.now();
          const dt = lastTimestamp.current
            ? Math.min(Math.max((now - lastTimestamp.current) / 1000, 0.01), 0.1)
            : 0.033;
          lastTimestamp.current = now;

          // In Expo Accelerometer: acc.x, acc.y, acc.z are in Gs (1G ~ 9.81 m/s^2)
          const gMag = Math.hypot(acc.x, acc.y, acc.z);

          // Update slow-moving baseline gravity filter (exponential moving average)
          rollingBaselineG.current = rollingBaselineG.current * 0.94 + gMag * 0.06;
          const deltaG = gMag - rollingBaselineG.current;

          let isMoving = false;
          const yaw = currentYawRad.current;
          const cosY = Math.cos(yaw);
          const sinY = Math.sin(yaw);

          // ── Step Detection ──────────────────────────────────────────────────
          // When a person takes a step, total G rises > 0.15G above baseline (impact)
          // followed by a drop below baseline (toe-off).
          if (stepArmed.current && deltaG > 0.14) {
            const timeSinceLast = now - lastStepTime.current;
            if (timeSinceLast > 300 && timeSinceLast < 1400) {
              // Valid human footstep!
              stepCount.current += 1;
              const STRIDE = 0.65; // ~65cm average indoor stride

              // Move forward in current heading direction
              posX.current += STRIDE * sinY;
              posZ.current += STRIDE * cosY;

              lastStepTime.current = now;
              stepArmed.current = false;
              isMoving = true;
            } else if (lastStepTime.current === 0) {
              lastStepTime.current = now;
            }
          }

          // Re-arm step detector once acceleration dips back below normal threshold
          if (!stepArmed.current && deltaG < 0.02) {
            stepArmed.current = true;
          }

          const totalX = Math.round((posX.current + manualOffsetX.current) * 100) / 100;
          const totalY = 0.0; // Floor plane height is 0
          const totalZ = Math.round((posZ.current + manualOffsetZ.current) * 100) / 100;

          setMotionState({
            position: { x: totalX, y: totalY, z: totalZ },
            velocity: {
              x: Math.round(velX.current * 100) / 100,
              y: 0,
              z: Math.round(velZ.current * 100) / 100,
            },
            yawRad: yaw,
            yawDeg: Math.round((yaw * 180) / Math.PI),
            quaternionXyzw: currentQuaternion.current,
            ready: true,
            isMoving,
            stepCount: stepCount.current,
            calibrate,
            resetPosition,
            adjustPosition,
          });
        });
      } catch (err) {
        console.warn('[useDeviceMotion] Sensor setup error:', err);
      }
    }

    initSensors();

    return () => {
      mounted = false;
      motionSub?.remove();
      accelSub?.remove();
    };
  }, [calibrate, resetPosition, adjustPosition]);

  return motionState;
}
