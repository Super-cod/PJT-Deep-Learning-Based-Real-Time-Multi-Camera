# Spatial Relay — React Native Observer App

React Native replacement for the web-based `phone.html` observer. Works on **iPhone and Android** without requiring a Mac or Xcode.

## What this replaces

| Web MVP (`web/phone.html`) | React Native App |
|---|---|
| `DeviceOrientationEvent` (yaw only, needs HTTPS) | `expo-sensors` DeviceMotion — full 3D quaternion orientation at 25 Hz |
| Manual range slider for depth | Same slider, but now foundation for future LiDAR native module |
| WebSocket with no reconnect | Exponential-backoff auto-reconnect (1s→2s→4s→8s→30s) |
| Hardcoded → no server config | Settings screen: configure IP, port, wss |
| Requires HTTPS for camera | Native app — camera access without HTTPS |
| Requires HTTPS for sensors | Native sensor access regardless of network |
| MediaPipe via CDN (WASM) | Same MediaPipe in WebView (network needed once for model download) |
| D-pad position (manual) | D-pad position + PDR step tracking + real IMU orientation |
| Fixed range slider | AUTO range: depth estimated from the person's torso size |

---

## Prerequisites

- [Node.js](https://nodejs.org/) 18+  
- [Expo CLI](https://docs.expo.dev/get-started/installation/): `npm install -g expo-cli`
- **No Mac / Xcode required** — iOS builds run in the cloud via EAS

---

## Quick Start (Development)

```bash
cd clients/react-native/SpatialRelayObserver
npm install

# Start the dev server
npx expo start
```

Scan the QR code with the **Expo Go** app on your iPhone (Expo Go must support SDK 57 — update it from the App Store).
Everything used here (`react-native-webview`, `expo-camera`, `expo-sensors`) ships inside Expo Go, so no development build is needed.

The hub address defaults to the laptop that is running Metro, so if the Python hub runs on the same laptop the app connects with no configuration. Override it in ⚙ settings if the hub runs elsewhere.

### Troubleshooting on iPhone

| Symptom | Fix |
|---|---|
| Header stays `CONNECTING` / `DISCONNECTED` | iOS **Settings → Privacy & Security → Local Network → Expo Go** must be ON. Hub must run with `--host 0.0.0.0`. Open `http://<laptop-ip>:8000/health` in iPhone Safari to test reachability. |
| Works at home, not on campus/office Wi-Fi | Many managed networks block device-to-device traffic (client isolation). Turn on the iPhone **Personal Hotspot** and join the laptop to it (laptop IP is then `172.20.10.x`). |
| Black camera / "Camera error" banner | Allow camera for Expo Go in iOS Settings, then tap the banner to retry. |
| "ML error" after Enable Detection | The phone needs internet once to download MediaPipe (~5 MB) from jsDelivr / Google Storage. |
| Yaw does not change | Allow **Motion & Fitness** for Expo Go in iOS Settings. |

---

## EAS Cloud Build (No Mac needed)

```bash
# 1. Install EAS CLI
npm install -g eas-cli

# 2. Log in to your Expo account (free)
eas login

# 3. Create a project (first time only)
eas init

# 4. Build a development build for your device
eas build --platform ios --profile development

# 5. Install the .ipa on your iPhone via the EAS link
#    (no App Store, uses ad-hoc or development distribution)

# 6. Production build for App Store
eas build --platform ios --profile production
```

---

## Usage

1. **Connect phone and laptop to the same Wi-Fi**
2. Start the Python hub on the laptop:
   ```bash
   uvicorn spatial_relay.server:app --host 0.0.0.0 --port 8000
   ```
3. Find laptop IP: `ip addr` (Linux) or `ipconfig` (Windows)
4. Open the app → tap ⚙ → enter the laptop IP → **Save & Reconnect**
5. The status bar turns green: `HUB ●`
6. Hold phone beside the laptop webcam, tap **Calibrate**
7. Tap **▶ Enable Detection** to load the MediaPipe pose model
8. Point at a person — the skeleton streams to the hub

---

## Sensor Details

### Orientation (replaces web compass)

`expo-sensors` `DeviceMotion` gives the full fused IMU output from Core Motion (iOS) / SensorManager (Android). The app composes `rotation.alpha/beta/gamma` (Z-X-Y Euler) into a rotation matrix and takes the horizontal direction of the rear camera as the heading. (Raw `alpha` is unusable when the phone is held upright — pitch ≈ 90° is a gimbal-lock singularity.) The heading relative to calibration is sent as a yaw quaternion; the hub extracts it via `quaternion_to_yaw()`.

### Camera + Pose Detection (WebView)

MediaPipe PoseLandmarker runs inside a `react-native-webview` WebView using the phone's browser engine (no native ML library). The WebView sends landmark positions via `postMessage`; React Native converts them to phone-local 3D points using `toPhonePoint()` and sends them to the hub.

Internet connection is needed once to download the MediaPipe model (~5 MB). After that, the model is cached.

### Position (manual D-pad)

Without ARKit, position comes from pedestrian dead-reckoning (one 0.65 m stride per detected step, in the current heading) plus manual D-pad nudges. The laptop console's **Reset origin** button tells the phone to re-calibrate remotely.

**To add ARKit/LiDAR later**: Add a custom native module once you have Xcode access, expose `frame.camera.transform` and `smoothedSceneDepth`, and replace the D-pad with the 6-DoF pose data. The hub's WebSocket protocol is already ready for this — it accepts the exact same `pose` and `detection` packets.

---

## Project Structure

```
SpatialRelayObserver/
├── App.tsx                          Root component
├── app.json                         Expo config + permissions
├── eas.json                         EAS Build profiles
├── package.json                     Dependencies
└── src/
    ├── screens/ObserverScreen.tsx   Main camera + control screen
    ├── modals/SettingsModal.tsx     Server IP / port settings
    ├── hooks/
    │   ├── useWebSocket.ts          WS with exponential backoff
    │   └── useDeviceMotion.ts       IMU quaternion at 25 Hz
    ├── components/
    │   ├── StatusHeader.tsx         Connection + pose status bar
    │   ├── DPad.tsx                 Position control (±0.5m / ±0.1m)
    │   └── RangeSlider.tsx          Depth slider (0.5–10 m)
    └── lib/
        ├── cameraWebView.ts         WebView HTML (camera + MediaPipe)
        ├── geometry.ts              toPhonePoint, quaternion utils
        ├── protocol.ts              TypeScript types matching Python hub
        └── storage.ts              AsyncStorage server settings
```

---

## Python Hub Protocol (unchanged)

The app sends the same JSON packets as the web phone page:

```json
// Calibration (tap once when beside laptop webcam)
{ "type": "calibration", "localPose": { "position": [x,y,z], "quaternionXyzw": [x,y,z,w], "timestampNs": 1720000000000000000 } }

// Pose update (25 Hz continuous while connected)
{ "type": "pose", "sequence": 42, "localPose": { ... } }

// Detections: every person in one frame (up to 4); hub assigns stable person_NN ids
{ "type": "detections", "sequence": 44, "timestampNs": ...,
  "people": [ { "positionPhone": [x,y,z], "jointsPhone": [...], "confidence": 0.85 } ] }

// Single detection (tap-to-mark target; still accepted from older clients)
{ "type": "detection", "sequence": 43, "subjectId": "person_01", "timestampNs": ...,
  "positionPhone": [x,y,z], "jointsPhone": [{"name":"nose","position":[x,y,z],"confidence":0.94}], "confidence": 0.85 }
```

**No Python server changes needed.**
