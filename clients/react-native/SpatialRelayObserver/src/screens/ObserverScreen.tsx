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
  Alert,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import { Camera } from 'expo-camera';
import { DeviceMotion } from 'expo-sensors';

import { CAMERA_VIEW_HTML } from '../lib/cameraWebView';
import { toPhonePoint } from '../lib/geometry';
import {
  buildWsUrl,
  loadSettings,
  saveSettings,
  type ServerSettings,
} from '../lib/storage';
import type { PhoneJoint } from '../lib/protocol';
import { useWebSocket } from '../hooks/useWebSocket';
import { useDeviceMotion } from '../hooks/useDeviceMotion';
import { StatusHeader } from '../components/StatusHeader';
import { DPad } from '../components/DPad';
import { RangeSlider } from '../components/RangeSlider';
import { SettingsModal } from '../modals/SettingsModal';

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
  const [settings, setSettings] = useState<ServerSettings>({
    host: '172.20.10.2',
    port: 8000,
    useWss: false,
  });
  const [wsUrl, setWsUrl] = useState(() => buildWsUrl(settings));
  const { status: wsStatus, send, reconnect } = useWebSocket(wsUrl);

  // ── Sensor ────────────────────────────────────────────────────────────────
  const motion = useDeviceMotion();

  // ── Phone position & orientation (dynamic from motion sensors) ──────────
  const posRef = useRef(motion.position);
  useEffect(() => { posRef.current = motion.position; }, [motion.position]);

  // ── Depth slider ─────────────────────────────────────────────────────────
  const [depth, setDepth] = useState(2.0);
  const depthRef = useRef(depth);
  useEffect(() => { depthRef.current = depth; }, [depth]);

  // ── MediaPipe status ──────────────────────────────────────────────────────
  const [mpStatus, setMpStatus] = useState<MPStatus>('idle');
  const [calibrated, setCalibrated] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const webViewRef = useRef<WebView>(null);
  const sequenceRef = useRef(0);

  // ── Camera permission ─────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const { status } = await Camera.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Camera permission required',
          'Open Settings → Spatial Relay Observer → Camera and enable access.',
        );
      }
    })();
  }, []);

  // ── DeviceMotion permission (iOS 13+) ─────────────────────────────────────
  useEffect(() => {
    if (Platform.OS === 'ios') {
      DeviceMotion.requestPermissionsAsync().catch(() => {});
    }
  }, []);

  // ── Load saved settings ───────────────────────────────────────────────────
  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s);
      setWsUrl(buildWsUrl(s));
    });
  }, []);

  // ── Periodic pose broadcast at 25 Hz ─────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const p = posRef.current;
      const q = motion.quaternionXyzw;
      const seq = Date.now();
      sequenceRef.current += 1;

      // Send manual_pose to update server's explicit room coordinates
      send({
        type: 'manual_pose',
        sequence: seq,
        position: [p.x, p.y, p.z],
        yawRad: motion.yawRad,
        yawDeg: motion.yawDeg,
      });

      // Send pose for 6-DoF AR quaternion fusion
      send({
        type: 'pose',
        sequence: seq,
        localPose: {
          position: [p.x, p.y, p.z],
          quaternionXyzw: q,
          timestampNs: seq * 1_000_000,
        },
      });
    }, 40);
    return () => clearInterval(id);
  }, [send, motion.quaternionXyzw, motion.yawRad, motion.yawDeg]);

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
    [send],
  );

  // ── Notify WebView when depth changes ────────────────────────────────────
  const notifyDepthChange = useCallback((value: number) => {
    webViewRef.current?.postMessage(
      JSON.stringify({ type: 'set_depth', value }),
    );
  }, []);

  const handleDepthChange = useCallback(
    (value: number) => {
      setDepth(value);
      depthRef.current = value;
      notifyDepthChange(value);
    },
    [notifyDepthChange],
  );

  // ── D-pad (Fine-tuning manual nudge) ─────────────────────────────────────
  const handleMove = useCallback((axis: 'x' | 'z', delta: number) => {
    motion.adjustPosition(axis, delta);
    const p = posRef.current;
    const nx = Math.round((p.x + (axis === 'x' ? delta : 0)) * 100) / 100;
    const nz = Math.round((p.z + (axis === 'z' ? delta : 0)) * 100) / 100;
    const seq = Date.now();
    send({
      type: 'manual_pose',
      sequence: seq,
      position: [nx, p.y, nz],
      yawRad: motion.yawRad,
      yawDeg: motion.yawDeg,
    });
    send({
      type: 'pose',
      sequence: seq,
      localPose: {
        position: [nx, p.y, nz],
        quaternionXyzw: motion.quaternionXyzw,
        timestampNs: seq * 1_000_000,
      },
    });
  }, [motion.adjustPosition, motion.yawRad, motion.yawDeg, motion.quaternionXyzw, send]);

  const handleReset = useCallback(() => {
    motion.resetPosition();
    const seq = Date.now();
    send({
      type: 'manual_pose',
      sequence: seq,
      position: [0, 0, 0],
      yawRad: motion.yawRad,
      yawDeg: motion.yawDeg,
    });
    send({
      type: 'pose',
      sequence: seq,
      localPose: {
        position: [0, 0, 0],
        quaternionXyzw: motion.quaternionXyzw,
        timestampNs: seq * 1_000_000,
      },
    });
  }, [motion.resetPosition, motion.yawRad, motion.yawDeg, motion.quaternionXyzw, send]);

  // ── Calibrate (Zero origin (0,0,0) and lock heading) ─────────────────────
  const handleCalibrate = useCallback(() => {
    motion.calibrate();
    const seq = Date.now();
    send({
      type: 'calibration',
      localPose: {
        position: [0, 0, 0],
        quaternionXyzw: [0, 0, 0, 1],
        timestampNs: seq * 1_000_000,
      },
    });
    send({
      type: 'manual_pose',
      sequence: seq,
      position: [0, 0, 0],
      yawRad: 0,
      yawDeg: 0,
    });
    send({
      type: 'pose',
      sequence: seq,
      localPose: {
        position: [0, 0, 0],
        quaternionXyzw: [0, 0, 0, 1],
        timestampNs: seq * 1_000_000,
      },
    });
    setCalibrated(true);
  }, [send, motion.calibrate]);

  // ── Enable MediaPipe detection ────────────────────────────────────────────
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
    const url = buildWsUrl(s);
    setWsUrl(url);
    setShowSettings(false);
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      {/* ── Status bar ─────────────────────────────────────────────────── */}
      <StatusHeader
        wsStatus={wsStatus}
        mediaPipeStatus={mpStatus}
        poseX={motion.position.x}
        poseZ={motion.position.z}
        yawDeg={motion.yawDeg}
        onSettingsPress={() => setShowSettings(true)}
        onReconnect={reconnect}
      />

      {/* ── Full-screen camera WebView ────────────────────────────────── */}
      <View style={styles.cameraContainer}>
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
      </View>

      {/* ── Bottom controls panel ─────────────────────────────────────── */}
      <View style={styles.controls}>
        {/* Range / depth */}
        <RangeSlider value={depth} onChange={handleDepthChange} />

        {/* Action row */}
        <View style={styles.actionRow}>
          {/* Enable detection */}
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
