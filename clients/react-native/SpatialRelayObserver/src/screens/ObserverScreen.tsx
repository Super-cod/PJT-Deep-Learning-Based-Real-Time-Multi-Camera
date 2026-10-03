import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  StyleSheet,
  View,
  TouchableOpacity,
  Text,
  Linking,
  AppState,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import { useCameraPermissions } from 'expo-camera';
import { useKeepAwake } from 'expo-keep-awake';

import { CAMERA_VIEW_HTML } from '../lib/cameraWebView';
import { clamp, focalLength, toPhonePoint } from '../lib/geometry';
import {
  buildWsUrl,
  loadSettings,
  saveSettings,
  type ServerSettings,
} from '../lib/storage';
import type { InboundPacket, LocalPose, OutboundPacket, PhoneJoint } from '../lib/protocol';
import { useWebSocket } from '../hooks/useWebSocket';
import { useDeviceMotion } from '../hooks/useDeviceMotion';
import { StatusHeader } from '../components/StatusHeader';
import { DPad } from '../components/DPad';
import { RangeSlider } from '../components/RangeSlider';
import { SettingsModal } from '../modals/SettingsModal';
import { MONO_FONT } from '../lib/fonts';

// ── WebView message shapes ────────────────────────────────────────────────────
interface FrameSize { width: number; height: number }
interface WebPerson {
  joints: Array<{ name: string; x: number; y: number; confidence: number }>;
  target: { x: number; y: number };
  torso: { metres: number; pixels: number } | null;
}
interface PeopleMsg extends FrameSize {
  type: 'people';
  people: WebPerson[];
}
interface TapMsg extends FrameSize { type: 'tap'; x: number; y: number }
interface CameraReadyMsg extends FrameSize { type: 'camera_ready' }
interface CameraErrorMsg { type: 'camera_error'; message: string }
interface MPLoadingMsg  { type: 'mediapipe_loading' }
interface MPReadyMsg    { type: 'mediapipe_ready' }
interface MPErrorMsg    { type: 'mediapipe_error'; message: string }
interface LogMsg        { type: 'log'; message: string }
type WebViewMsg =
  | PeopleMsg | TapMsg | CameraReadyMsg | CameraErrorMsg
  | MPLoadingMsg | MPReadyMsg | MPErrorMsg | LogMsg;

type MPStatus = 'idle' | 'loading' | 'ready' | 'error';

// Stable object identity so re-renders never make the WebView reload.
const WEBVIEW_SOURCE = { html: CAMERA_VIEW_HTML, baseUrl: 'https://localhost' };
const POSE_INTERVAL_MS = 40; // 25 Hz
const IDENTITY_POSE = (timestampNs: number): LocalPose => ({
  position: [0, 0, 0],
  quaternionXyzw: [0, 0, 0, 1],
  timestampNs,
});

// ─────────────────────────────────────────────────────────────────────────────
export function ObserverScreen() {
  useKeepAwake(); // screen must stay on while streaming

  // ── Settings + WebSocket ──────────────────────────────────────────────────
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const wsUrl = settings ? buildWsUrl(settings) : null;

  // ── Sensor ────────────────────────────────────────────────────────────────
  const motion = useDeviceMotion();
  const { getSnapshot, calibrate: calibrateMotion, resetPosition, adjustPosition } = motion;

  // ── Depth ────────────────────────────────────────────────────────────────
  const [depth, setDepth] = useState(2.0);
  const [autoDepth, setAutoDepth] = useState(true);
  const depthRef = useRef(depth);
  const autoDepthRef = useRef(autoDepth);
  autoDepthRef.current = autoDepth;

  // ── UI status ─────────────────────────────────────────────────────────────
  const [mpStatus, setMpStatus] = useState<MPStatus>('idle');
  const [mpError, setMpError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [calibrated, setCalibrated] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const webViewRef = useRef<WebView>(null);
  const sequenceRef = useRef(0);
  const lastDepthUiUpdate = useRef(0);

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  // ── Packets ───────────────────────────────────────────────────────────────
  const sendRef = useRef<(p: OutboundPacket) => void>(() => {});
  const nextSeq = () => ++sequenceRef.current;

  const sendPose = useCallback(() => {
    const snap = getSnapshot();
    const now = Date.now();
    sendRef.current({
      type: 'pose',
      sequence: nextSeq(),
      localPose: {
        position: [snap.position.x, snap.position.y, snap.position.z],
        quaternionXyzw: snap.quaternionXyzw,
        timestampNs: now * 1_000_000,
      },
    });
  }, [getSnapshot]);

  // Calibrate: phone becomes the origin (0,0,0) and its heading becomes +Z.
  const calibrate = useCallback(() => {
    calibrateMotion();
    sendRef.current({ type: 'calibration', localPose: IDENTITY_POSE(Date.now() * 1_000_000) });
    sendPose();
    setCalibrated(true);
  }, [calibrateMotion, sendPose]);

  const onHubMessage = useCallback((packet: InboundPacket) => {
    if (packet.type === 'calibrate') calibrate();
    else if (packet.type === 'error') console.warn('[hub]', packet.message);
  }, [calibrate]);

  const { status: wsStatus, send, reconnect } = useWebSocket(wsUrl, onHubMessage);
  sendRef.current = send;

  // ── Load saved settings (connect only once we know the host) ──────────────
  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  // ── Camera permission (must be granted before the WebView calls getUserMedia)
  useEffect(() => {
    if (cameraPermission && !cameraPermission.granted && cameraPermission.canAskAgain) {
      requestCameraPermission();
    }
  }, [cameraPermission, requestCameraPermission]);

  // ── Restart camera when returning from background ────────────────────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        webViewRef.current?.postMessage(JSON.stringify({ type: 'restart_camera' }));
      }
    });
    return () => sub.remove();
  }, []);

  // ── Continuous pose broadcast at 25 Hz (reads refs → never re-created) ────
  useEffect(() => {
    if (wsStatus !== 'connected') return;
    const id = setInterval(sendPose, POSE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [wsStatus, sendPose]);

  // ── Depth helpers ─────────────────────────────────────────────────────────
  const applyDepth = useCallback((value: number, fromUser: boolean) => {
    depthRef.current = value;
    webViewRef.current?.postMessage(JSON.stringify({ type: 'set_depth', value }));
    // Throttle re-renders for auto depth (arrives at up to 20 Hz).
    const now = Date.now();
    if (fromUser || now - lastDepthUiUpdate.current > 250) {
      lastDepthUiUpdate.current = now;
      setDepth(value);
    }
  }, []);

  const handleDepthChange = useCallback((value: number) => {
    setAutoDepth(false);
    applyDepth(value, true);
  }, [applyDepth]);

  // ── WebView → React Native messages ─────────────────────────────────────
  const onWebViewMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let msg: WebViewMsg;
      try { msg = JSON.parse(event.nativeEvent.data) as WebViewMsg; }
      catch { return; }

      switch (msg.type) {
        case 'camera_ready':
          setCameraError(null);
          break;
        case 'camera_error':
          setCameraError(msg.message);
          break;
        case 'mediapipe_loading':
          setMpStatus('loading');
          setMpError(null);
          break;
        case 'mediapipe_ready':
          setMpStatus('ready');
          break;
        case 'mediapipe_error':
          setMpStatus('error');
          setMpError(msg.message);
          break;
        case 'log':
          console.log('[webview]', msg.message);
          break;

        case 'people': {
          const { people, width, height } = msg;
          const f = focalLength(width, height);
          // Slider/auto depth tracks the first person; others use their own torso estimate.
          if (autoDepthRef.current && people[0]?.torso) {
            const est = (f * people[0].torso.metres) / people[0].torso.pixels;
            // Low-pass filter the estimate to suppress per-frame jitter.
            applyDepth(clamp(depthRef.current * 0.7 + est * 0.3, 0.5, 12), false);
          }
          sendRef.current({
            type: 'detections',
            sequence: nextSeq(),
            timestampNs: Date.now() * 1_000_000,
            people: people.map((person, i) => {
              const d = i > 0 && autoDepthRef.current && person.torso
                ? clamp((f * person.torso.metres) / person.torso.pixels, 0.5, 12)
                : depthRef.current;
              return {
                positionPhone: toPhonePoint(person.target.x, person.target.y, d, width, height),
                jointsPhone: person.joints.map((j): PhoneJoint => ({
                  name: j.name,
                  position: toPhonePoint(j.x, j.y, d, width, height),
                  confidence: j.confidence,
                })),
                confidence: 0.85,
              };
            }),
          });
          break;
        }

        case 'tap': {
          sendRef.current({
            type: 'detection',
            sequence: nextSeq(),
            subjectId: 'target_01',
            timestampNs: Date.now() * 1_000_000,
            positionPhone: toPhonePoint(msg.x, msg.y, depthRef.current, msg.width, msg.height),
            jointsPhone: [],
            confidence: 0.7,
          });
          break;
        }
      }
    },
    [applyDepth],
  );

  // ── D-pad (fine-tuning manual nudge) ─────────────────────────────────────
  const handleMove = useCallback((axis: 'x' | 'z', delta: number) => {
    adjustPosition(axis, delta);
    sendPose();
  }, [adjustPosition, sendPose]);

  const handleReset = useCallback(() => {
    resetPosition();
    sendPose();
  }, [resetPosition, sendPose]);

  // ── Enable MediaPipe detection ────────────────────────────────────────────
  const handleEnableDetection = useCallback(() => {
    webViewRef.current?.postMessage(JSON.stringify({ type: 'start_detection' }));
    setMpStatus('loading');
  }, []);

  // ── Save settings ─────────────────────────────────────────────────────────
  const handleSaveSettings = useCallback(async (s: ServerSettings) => {
    await saveSettings(s);
    setShowSettings(false);
    // A changed URL reconnects via useWebSocket's effect; an unchanged one needs a manual kick.
    if (buildWsUrl(s) === wsUrl) reconnect();
    setSettings(s);
  }, [reconnect, wsUrl]);

  // ── Camera area ───────────────────────────────────────────────────────────
  let cameraArea: React.ReactNode;
  if (!cameraPermission) {
    cameraArea = <Text style={styles.notice}>Checking camera permission…</Text>;
  } else if (!cameraPermission.granted) {
    cameraArea = (
      <View style={styles.noticeBox}>
        <Text style={styles.notice}>Camera access is needed to detect people.</Text>
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={() => (cameraPermission.canAskAgain ? requestCameraPermission() : Linking.openSettings())}
        >
          <Text style={styles.actionBtnText}>
            {cameraPermission.canAskAgain ? 'Allow camera' : 'Open Settings'}
          </Text>
        </TouchableOpacity>
      </View>
    );
  } else {
    cameraArea = (
      <>
        <WebView
          ref={webViewRef}
          style={styles.webview}
          source={WEBVIEW_SOURCE}
          originWhitelist={['*']}
          // ── iOS camera inside WKWebView ─────────────────────────────
          mediaCapturePermissionGrantType="grant"
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          // ── JS + storage ────────────────────────────────────────────
          javaScriptEnabled
          domStorageEnabled
          mixedContentMode="always"
          // ── Messages ────────────────────────────────────────────────
          onMessage={onWebViewMessage}
          // ── Recover if iOS kills the web content process ────────────
          onContentProcessDidTerminate={() => webViewRef.current?.reload()}
          // ── Scrolling off ───────────────────────────────────────────
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
        />
        {cameraError && (
          <TouchableOpacity
            style={styles.cameraErrorBanner}
            onPress={() => webViewRef.current?.postMessage(JSON.stringify({ type: 'restart_camera' }))}
          >
            <Text style={styles.cameraErrorText}>Camera error: {cameraError} — tap to retry</Text>
          </TouchableOpacity>
        )}
      </>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      {/* ── Status bar ─────────────────────────────────────────────────── */}
      <StatusHeader
        wsStatus={wsStatus}
        wsUrl={wsUrl}
        mediaPipeStatus={mpStatus}
        poseX={motion.position.x}
        poseZ={motion.position.z}
        yawDeg={motion.yawDeg}
        onSettingsPress={() => setShowSettings(true)}
        onReconnect={reconnect}
      />

      {/* ── Full-screen camera WebView ────────────────────────────────── */}
      <View style={styles.cameraContainer}>{cameraArea}</View>

      {/* ── Bottom controls panel ─────────────────────────────────────── */}
      <View style={styles.controls}>
        {/* Range / depth */}
        <RangeSlider
          value={depth}
          onChange={handleDepthChange}
          auto={autoDepth}
          onToggleAuto={() => setAutoDepth((a) => !a)}
        />

        {/* Action row */}
        <View style={styles.actionRow}>
          {mpStatus === 'idle' || mpStatus === 'error' ? (
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
          )}

          <TouchableOpacity
            style={[styles.calibrateBtn, calibrated && styles.calibratedBtn]}
            onPress={calibrate}
            activeOpacity={0.7}
          >
            <Text style={styles.calibrateBtnText}>
              {calibrated ? '✓ Calibrated' : 'Calibrate'}
            </Text>
          </TouchableOpacity>
        </View>
        {mpError && <Text style={styles.errorText} numberOfLines={2}>{mpError}</Text>}

        {/* D-pad */}
        <DPad onMove={handleMove} onReset={handleReset} />

        {/* Pose readout */}
        <Text style={styles.poseReadout}>
          Position  X: {motion.position.x >= 0 ? '+' : ''}{motion.position.x.toFixed(2)}  Z: {motion.position.z >= 0 ? '+' : ''}{motion.position.z.toFixed(2)}
          {'   '}Yaw: {motion.yawDeg >= 0 ? '+' : ''}{motion.yawDeg}°
          {'   '}Steps: {motion.stepCount}
          {motion.isMoving ? '  ● Moving' : ''}
          {!motion.ready ? '  (sensors init...)' : ''}
        </Text>
      </View>

      {/* ── Settings modal ────────────────────────────────────────────── */}
      {settings && (
        <SettingsModal
          visible={showSettings}
          settings={settings}
          onSave={handleSaveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
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
    justifyContent: 'center',
  },
  webview: {
    flex: 1,
    backgroundColor: '#000',
  },
  noticeBox: {
    paddingHorizontal: 24,
    gap: 14,
  },
  notice: {
    color: '#aaa',
    fontSize: 14,
    textAlign: 'center',
  },
  cameraErrorBanner: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    padding: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(255,77,77,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255,77,77,0.5)',
  },
  cameraErrorText: {
    color: '#ff8080',
    fontSize: 12,
    textAlign: 'center',
  },
  errorText: {
    color: '#ff8080',
    fontSize: 11,
    textAlign: 'center',
    paddingHorizontal: 12,
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
    fontFamily: MONO_FONT,
    textAlign: 'center',
    paddingHorizontal: 12,
  },
});
