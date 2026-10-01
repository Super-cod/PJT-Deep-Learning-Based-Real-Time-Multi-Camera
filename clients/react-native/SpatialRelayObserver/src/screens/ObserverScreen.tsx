import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  StyleSheet,
  View,
  TouchableOpacity,
  Text,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import { Camera } from 'expo-camera';

import { CAMERA_VIEW_HTML } from '../lib/cameraWebView';
import { quaternionToYaw, toPhonePoint } from '../lib/geometry';
import {
  DEFAULT_SETTINGS,
  buildWsUrl,
  loadSettings,
  saveSettings,
  type ServerSettings,
} from '../lib/storage';
import type { ArkitPlane, ArkitAnchor } from '../../modules/arkit-tracker';
import type { PhoneJoint } from '../lib/protocol';
import { useWebSocket } from '../hooks/useWebSocket';
import { useArkit } from '../hooks/useArkit';
import { StatusHeader } from '../components/StatusHeader';
import { DPad } from '../components/DPad';
import { SettingsModal } from '../modals/SettingsModal';

/** ARKit body-tracking joint name -> the joint name the viewer already draws. */
const ARKIT_JOINT_ALIASES: Record<string, string> = {
  head: 'nose',
  left_shoulder: 'left_shoulder',
  right_shoulder: 'right_shoulder',
  hips: 'root',
  left_up_leg: 'left_hip',
  right_up_leg: 'right_hip',
  left_foot: 'left_ankle',
  right_foot: 'right_ankle',
};

/** Hips centroid used as the ARKit subject's tracked position. */
const ARKIT_ROOT_JOINTS = ['hips', 'root'];

/** Human-readable label for the shared status header's media-pipeline slot. */
function arkitStatusLabel(arkit: {
  availability: string;
  running: boolean;
  hasPose: boolean;
  trackingStatus: string;
}): string {
  if (arkit.availability === 'no_module') return 'arkit: no native module';
  if (arkit.availability === 'unsupported') return 'arkit: unsupported';
  if (arkit.availability === 'no_permission') return 'arkit: no camera access';
  if (arkit.availability === 'checking') return 'arkit: checking…';
  if (!arkit.running) return 'arkit: stopped';
  if (arkit.trackingStatus === 'limited') return 'arkit: limited';
  return arkit.hasPose ? 'arkit: tracking' : 'arkit: searching';
}

function arkitStatusText(availability: string): string {
  switch (availability) {
    case 'available': return 'Session running';
    case 'checking': return 'Checking device support…';
    case 'no_module': return 'Native module not linked. Rebuild the app on a Mac.';
    case 'unsupported': return 'ARKit is not supported on this device.';
    case 'no_permission': return 'Camera access was denied for ARKit.';
    default: return availability;
  }
}

/**
 * Yaw around +Y in degrees. This mirrors `quaternion_to_yaw` in
 * `src/spatial_relay/transforms.py` so the on-screen heading matches the hub's.
 */
function arkitYawDeg(q: [number, number, number, number]): number {
  return Math.round((quaternionToYaw(q) * 180) / Math.PI);
}

// ── WebView message shapes ────────────────────────────────────────────────────
interface LandmarksMsg {
  type: 'landmarks';
  joints: Array<{ name: string; x: number; y: number; confidence: number }>;
  target: { x: number; y: number };
  depth: number;
}
interface TapMsg        { type: 'tap'; x: number; y: number }
interface CameraReadyMsg { type: 'camera_ready' }
interface MPLoadingMsg  { type: 'mediapipe_loading' }
interface MPReadyMsg    { type: 'mediapipe_ready' }
interface MPErrorMsg    { type: 'mediapipe_error'; message: string }
type WebViewMsg =
  | LandmarksMsg | TapMsg | CameraReadyMsg
  | MPLoadingMsg | MPReadyMsg | MPErrorMsg;

type MPStatus = 'idle' | 'loading' | 'ready' | 'error';

// ─────────────────────────────────────────────────────────────────────────────
export function ObserverScreen() {
  // ── Settings + WebSocket ──────────────────────────────────────────────────
  // `settingsLoaded` gates the socket: connecting before AsyncStorage resolves
  // would dial the placeholder IP and burn the backoff schedule.
  const [settings, setSettings] = useState<ServerSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [wsUrl, setWsUrl] = useState(() => buildWsUrl(settings));
  const { status: wsStatus, send, reconnect, setOnOpen, lastError, attempt, url: wsDialledUrl } = useWebSocket(
    settingsLoaded ? wsUrl : null,
  );

  // ── ARKit ─────────────────────────────────────────────────────────────────
  // World tracking gives metric camera-to-world pose, replacing the step-count
  // dead reckoning entirely. MediaPipe can no longer own the rear camera while
  // an ARSession runs, so the WebView is only mounted when ARKit is unavailable.
  const [useBodyTracking, setUseBodyTracking] = useState(false);
  const [arkitUsable, setArkitUsable] = useState<boolean | null>(null);
  const arkit = useArkit({
    autoStart: false,
    fps: 25,
    planeDetection: 'both',
    bodyTracking: useBodyTracking,
    sceneReconstruction: true,
    frameSemantics: ['smoothedSceneDepth', 'personSegmentationWithDepth'],
  });

  const arkitAvailable =
    arkit.availability === 'available' || arkit.availability === 'checking';

  useEffect(() => { setArkitUsable(arkitAvailable); }, [arkitAvailable]);

  // Start ARKit once availability resolves; `autoStart` is off so the hook does
  // not restart the session every time the availability object changes.
  useEffect(() => {
    if (arkit.availability === 'available' && !arkit.running) {
      arkit.start({ reset: true });
    }
  }, [arkit.availability, arkit.running, arkit]);

  // ── Phone pose (ARKit source of truth) ───────────────────────────────────
  // Mirrored into refs so the 25 Hz broadcast effect does not tear down and
  // rebuild its interval on every ARKit frame.
  const posRef = useRef<[number, number, number]>(arkit.position);
  const quatRef = useRef<[number, number, number, number]>(arkit.quaternion);
  const trackingRef = useRef({ status: arkit.trackingStatus, reason: arkit.limitedReason });
  useEffect(() => { posRef.current = arkit.position; }, [arkit.position]);
  useEffect(() => { quatRef.current = arkit.quaternion; }, [arkit.quaternion]);
  useEffect(() => {
    trackingRef.current = { status: arkit.trackingStatus, reason: arkit.limitedReason };
  }, [arkit.trackingStatus, arkit.limitedReason]);

  // ── MediaPipe status ──────────────────────────────────────────────────────
  const [mpStatus, setMpStatus] = useState<MPStatus>('idle');
  const [calibrated, setCalibrated] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [showRawCamera, setShowRawCamera] = useState(false);
  const webViewRef = useRef<WebView>(null);
  const sequenceRef = useRef(0);
  // MediaPipe needs a depth; ARKit supplies real metric depth via raycast, so
  // the slider is only used in the no-ARKit fallback.
  const depthRef = useRef(2.0);

  // ARKit owns the rear camera, so the WebView may only run when ARKit is not
  // usable. `showRawCamera` forces it off even then for debugging the AR view.
  const canUseWebView = arkitUsable === false || (showRawCamera && !arkit.running);

  // ── Camera permission ─────────────────────────────────────────────────────
  // ARKit requests camera access itself through the native module, so this is
  // only needed for the MediaPipe fallback path.
  useEffect(() => {
    if (!canUseWebView) return;
    (async () => {
      const { status } = await Camera.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Camera permission required',
          'Open Settings → Spatial Relay Observer → Camera and enable access.',
        );
      }
    })();
  }, [canUseWebView]);

  // ── Load saved settings ───────────────────────────────────────────────────
  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s);
      setWsUrl(buildWsUrl(s));
      setSettingsLoaded(true);
    });
  }, []);

  // ── Periodic pose broadcast at 25 Hz ─────────────────────────────────────
  // Depends only on `send`, so the interval survives ARKit frame updates.
  //
  // Only `pose` is streamed. Sending `manual_pose` here would pin the hub into
  // manual placement mode and discard the calibrated transform on every tick.
  useEffect(() => {
    const id = setInterval(() => {
      if (!arkit.hasPose) return;
      const seq = Date.now();
      sequenceRef.current += 1;
      const t = trackingRef.current;

      send({
        type: 'pose',
        sequence: seq,
        localPose: {
          position: posRef.current,
          quaternionXyzw: quatRef.current,
          timestampNs: seq * 1_000_000,
        },
        source: 'arkit',
        trackingStatus: t.status,
        limitedReason: t.reason,
      });
    }, 40);
    return () => clearInterval(id);
  }, [send, arkit.hasPose]);

  // ── ARKit tracking-quality heartbeat ─────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      if (!arkit.running) return;
      send({
        type: 'tracking',
        status: arkit.trackingStatus,
        limitedReason: arkit.limitedReason,
        timestampMs: Date.now(),
      });
    }, 1000);
    return () => clearInterval(id);
  }, [send, arkit.running, arkit.trackingStatus, arkit.limitedReason]);

  // ── Plane + anchor discovery ──────────────────────────────────────────────
  useEffect(() => {
    if (!arkit.planes.length && !arkit.anchors.length) return;
    const now = Date.now();
    send({
      type: 'arkit_planes',
      timestampMs: now,
      planes: arkit.planes.map((p: ArkitPlane) => ({
        identifier: p.identifier,
        alignment: p.alignment,
        classification: p.classification,
        center: p.center,
        extentWidth: p.extentWidth,
        extentHeight: p.extentHeight,
      })),
    });
    send({
      type: 'arkit_anchors',
      timestampMs: now,
      anchors: arkit.anchors.map((a: ArkitAnchor) => ({
        identifier: a.identifier,
        name: a.name,
        kind: a.kind,
        position: a.position,
      })),
    });
    // Planes/anchors are only pushed when ARKit reports a change, which the
    // hook signals by producing new arrays.
  }, [send, arkit.planes, arkit.anchors]);

  // ── ARKit body skeleton -> detection packet ───────────────────────────────
  // Body joints are already in the ARKit world frame, so the packet is marked
  // `frame: 'arkitWorld'` and the hub skips the device transform.
  useEffect(() => {
    const body = arkit.body;
    if (!arkit.running || !body || !body.isTracked) return;

    const jointsPhone: PhoneJoint[] = [];
    for (const joint of body.joints) {
      const alias = ARKIT_JOINT_ALIASES[joint.name];
      if (!alias) continue;
      jointsPhone.push({ name: alias, position: joint.position, confidence: 1.0 });
    }

    const root = body.joints.find((j) => ARKIT_ROOT_JOINTS.includes(j.name));
    const positionPhone: [number, number, number] = root
      ? root.position
      : body.cameraPosition;

    sequenceRef.current += 1;
    send({
      type: 'detection',
      sequence: sequenceRef.current,
      subjectId: 'person_01',
      timestampNs: Date.now() * 1_000_000,
      frame: 'arkitWorld',
      positionPhone,
      jointsPhone,
      confidence: 1.0,
    });
  }, [send, arkit.running, arkit.body]);

  // ── ARKit raycast: real metric depth for a tapped point ─────────────────
  // Taps go through ARKit's raycaster, so the target distance is measured
  // rather than guessed from a slider. If ARKit has no surface hit (for
  // example, pointing at the sky) nothing is reported, rather than inventing
  // a position.
  const handleRaycastTap = useCallback(
    async (x: number, y: number) => {
      const result = await arkit.raycast(x, y);
      if (!result.hit || !result.position) return;

      sequenceRef.current += 1;
      send({
        type: 'detection',
        sequence: sequenceRef.current,
        subjectId: 'target_01',
        timestampNs: Date.now() * 1_000_000,
        frame: 'arkitWorld',
        positionPhone: result.position,
        jointsPhone: [],
        confidence: result.isEstimated ? 0.6 : 0.95,
      });
    },
    [arkit, send],
  );

  // ── WebView → React Native messages ─────────────────────────────────────
  const onWebViewMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let msg: WebViewMsg;
      try { msg = JSON.parse(event.nativeEvent.data) as WebViewMsg; }
      catch { return; }

      switch (msg.type) {
        case 'camera_ready':
          setCameraReady(true);
          break;

        case 'mediapipe_loading':
          setMpStatus('loading');
          break;

        case 'mediapipe_ready':
          setMpStatus('ready');
          break;

        case 'mediapipe_error':
          setMpStatus('error');
          break;

        case 'landmarks': {
          const { joints, target } = msg;
          const p = posRef.current;
          const d = depthRef.current;
          sequenceRef.current += 1;

          const positionPhone = toPhonePoint(target.x, target.y, d);
          const jointsPhone: PhoneJoint[] = joints.map((j) => ({
            name: j.name,
            position: toPhonePoint(j.x, j.y, d),
            confidence: j.confidence,
          }));

          send({
            type: 'detection',
            sequence: sequenceRef.current,
            subjectId: 'person_01',
            timestampNs: Date.now() * 1_000_000,
            positionPhone,
            jointsPhone,
            confidence: 0.85,
          });
          break;
        }

        case 'tap': {
          // ARKit path: a tap in the viewfinder is resolved to a real metric
          // surface point instead of a slider-estimated depth.
          if (arkitUsable) {
            handleRaycastTap(msg.x, msg.y);
            break;
          }
          const d = depthRef.current;
          const positionPhone = toPhonePoint(msg.x, msg.y, d);
          sequenceRef.current += 1;
          send({
            type: 'detection',
            sequence: sequenceRef.current,
            subjectId: 'target_01',
            timestampNs: Date.now() * 1_000_000,
            positionPhone,
            jointsPhone: [],
            confidence: 0.7,
          });
          break;
        }
      }
    },
    [send, arkitUsable, handleRaycastTap],
  );

  // ── D-pad (Fine-tuning manual nudge) ─────────────────────────────────────
  // ARKit already knows the phone's metric position, so nudging it would be a
  // lie. The D-pad is kept for the no-ARKit fallback, where the pose is
  // client-side only.
  const handleMove = useCallback(
    (_axis: 'x' | 'z', _delta: number) => {
      // No-op while ARKit owns the pose.
    },
    [],
  );

  const handleReset = useCallback(() => {
    // Restart ARKit mapping so the world origin is re-established from the
    // phone's current real pose.
    arkit.resetTracking();
  }, [arkit]);

  // ── Calibrate (declare current ARKit pose as the world origin) ───────────
  // The hub stores this pose as the reference, so subsequent ARKit poses are
  // sent as deltas from it. This is what ties the ARKit world to the laptop.
  const handleCalibrate = useCallback(() => {
    const seq = Date.now();
    const pose = {
      position: posRef.current,
      quaternionXyzw: quatRef.current,
      timestampNs: seq * 1_000_000,
    };
    send({ type: 'calibration', localPose: pose });
    send({ type: 'pose', sequence: seq, localPose: pose, source: 'arkit' });
    setCalibrated(true);
  }, [send]);

  // ── Re-declare calibration whenever the hub connection comes up ──────────
  useEffect(() => {
    setOnOpen(() => {
      handleCalibrate();
    });
    return () => setOnOpen(null);
  }, [setOnOpen, handleCalibrate]);

  // ── Enable MediaPipe detection (fallback path only) ──────────────────────
  const handleEnableDetection = useCallback(() => {
    webViewRef.current?.postMessage(
      JSON.stringify({ type: 'start_detection' }),
    );
    setMpStatus('loading');
  }, []);

  // ── Save settings ─────────────────────────────────────────────────────────
  const handleSaveSettings = useCallback(async (s: ServerSettings) => {
    await saveSettings(s);
    setSettings(s);
    setSettingsLoaded(true);
    setWsUrl(buildWsUrl(s));
    setShowSettings(false);
    // Reconnect even when the URL is unchanged: the previous attempt may have
    // exhausted its backoff, so re-dial immediately after the user confirms.
    reconnect();
  }, [reconnect]);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      {/* ── Status bar ─────────────────────────────────────────────────── */}
      <StatusHeader
        wsStatus={wsStatus}
        wsError={lastError}
        wsAttempt={attempt}
        wsUrl={wsDialledUrl}
        mediaPipeStatus={arkitUsable ? arkitStatusLabel(arkit) : mpStatus}
        poseX={arkit.position[0]}
        poseZ={arkit.position[2]}
        yawDeg={arkitYawDeg(arkit.quaternion)}
        onSettingsPress={() => setShowSettings(true)}
        onReconnect={reconnect}
      />

      {/* ── Viewfinder: ARKit passthrough camera, or MediaPipe WebView ─── */}
      <View style={styles.cameraContainer}>
        {canUseWebView ? (
          <WebView
            ref={webViewRef}
            style={StyleSheet.absoluteFill}
            source={{ html: CAMERA_VIEW_HTML, baseUrl: 'https://localhost' }}
            // ── iOS camera permissions ──────────────────────────────────
            mediaCapturePermissionGrantType="grant"
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            // ── JS + storage ────────────────────────────────────────────
            javaScriptEnabled
            domStorageEnabled
            originWhitelist={['*']}
            mixedContentMode="always"
            // ── Performance ─────────────────────────────────────────────
            renderToHardwareTextureAndroid
            // ── Messages ────────────────────────────────────────────────
            onMessage={onWebViewMessage}
            // ── Scrolling off ───────────────────────────────────────────
            scrollEnabled={false}
            bounces={false}
          />
        ) : (
          // ARKit owns the camera and renders nothing to screen; show the
          // tracking state so the user knows the session is live.
          <View style={styles.arkitOverlay}>
            <Text style={styles.arkitTitle}>ARKit</Text>
            <Text style={styles.arkitLine}>
              {arkitStatusText(arkit.availability)}
            </Text>
            {arkit.error ? (
              <Text style={styles.arkitError}>{arkit.error}</Text>
            ) : null}
            <Text style={styles.arkitLine}>
              Tracking: {arkit.trackingStatus}
              {arkit.limitedReason ? ` (${arkit.limitedReason})` : ''}
            </Text>
            <Text style={styles.arkitLine}>
              Planes: {arkit.planes.length}   Anchors: {arkit.anchors.length}
            </Text>
            <Text style={styles.arkitLine}>
              Body: {arkit.body?.isTracked ? 'tracked' : 'no'}
            </Text>
          </View>
        )}
      </View>

      {/* ── Bottom controls panel ─────────────────────────────────────── */}
      <View style={styles.controls}>
        {/* Action row */}
        <View style={styles.actionRow}>
          {/* MediaPipe detection (only meaningful without ARKit) */}
          {!arkitUsable
            ? (mpStatus === 'idle' || mpStatus === 'error' ? (
              <TouchableOpacity
                style={styles.actionBtn}
                onPress={handleEnableDetection}
                activeOpacity={0.7}
              >
                <Text style={styles.actionBtnText}>
                  {mpStatus === 'error' ? '↺ Retry Detection' : '▶ Enable Detection'}
                </Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.actionBtn}>
                <Text style={[styles.actionBtnText, { color: mpStatus === 'loading' ? '#f4b942' : '#bafa59' }]}>
                  {mpStatus === 'loading' ? 'Loading…' : '✓ Detection Active'}
                </Text>
              </View>
            ))
            : (
              <TouchableOpacity
                style={styles.actionBtn}
                onPress={() => setUseBodyTracking((v) => !v)}
                activeOpacity={0.7}
              >
                <Text style={styles.actionBtnText}>
                  {useBodyTracking ? '◉ Body Tracking' : '○ Enable Body Tracking'}
                </Text>
              </TouchableOpacity>
            )}

          {/* Calibrate */}
          <TouchableOpacity
            style={[
              styles.calibrateBtn,
              calibrated && styles.calibratedBtn,
            ]}
            onPress={handleCalibrate}
            activeOpacity={0.7}
          >
            <Text style={styles.calibrateBtnText}>
              {calibrated ? '✓ Calibrated' : 'Calibrate'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* D-pad / reset */}
        <DPad onMove={handleMove} onReset={handleReset} />

        {/* Pose readout */}
        <Text style={styles.poseReadout}>
          Position  X: {arkit.position[0] >= 0 ? '+' : ''}{arkit.position[0].toFixed(2)}
          {'  '}Y: {arkit.position[1] >= 0 ? '+' : ''}{arkit.position[1].toFixed(2)}
          {'  '}Z: {arkit.position[2] >= 0 ? '+' : ''}{arkit.position[2].toFixed(2)}
          {'   '}Yaw: {arkitYawDeg(arkit.quaternion) >= 0 ? '+' : ''}{arkitYawDeg(arkit.quaternion)}°
          {'   '}Source: {arkit.hasPose ? 'ARKit' : 'none'}
        </Text>
      </View>

      {/* ── Settings modal ────────────────────────────────────────────── */}
      <SettingsModal
        visible={showSettings}
        settings={settings}
        onSave={handleSaveSettings}
        onClose={() => setShowSettings(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  cameraContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  arkitOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  arkitTitle: {
    color: '#bafa59',
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 2,
  },
  arkitLine: {
    color: '#888',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  arkitError: {
    color: '#f4b942',
    fontSize: 11,
    fontFamily: 'monospace',
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  controls: {
    backgroundColor: 'rgba(10,10,10,0.9)',
    paddingBottom: 8,
    paddingTop: 8,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: '#1e1e1e',
  },
  actionRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(186,250,89,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(186,250,89,0.3)',
    alignItems: 'center',
  },
  btnDisabled: {
    opacity: 0.4,
  },
  actionBtnText: {
    color: '#bafa59',
    fontSize: 13,
    fontWeight: '600',
  },
  calibrateBtn: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: '#333',
    alignItems: 'center',
  },
  calibratedBtn: {
    borderColor: '#bafa59',
    backgroundColor: 'rgba(186,250,89,0.1)',
  },
  calibrateBtnText: {
    color: '#ccc',
    fontSize: 13,
    fontWeight: '600',
  },
  poseReadout: {
    color: '#555',
    fontSize: 11,
    fontFamily: 'monospace',
    textAlign: 'center',
    paddingHorizontal: 12,
  },
});
