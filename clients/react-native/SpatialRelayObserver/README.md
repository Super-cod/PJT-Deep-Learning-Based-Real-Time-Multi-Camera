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
| D-pad position (manual) | D-pad position (same) + real IMU orientation |

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

Scan the QR code with the **Expo Go** app on your iPhone.

> [!NOTE]
> `react-native-webview` requires a **development build** on iOS (not plain Expo Go).
> Run the EAS Development Build step below if the WebView camera doesn't appear.

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

`expo-sensors` `DeviceMotion` gives the full fused IMU output from Core Motion (iOS) / SensorManager (Android). The app reads `rotation.alpha/beta/gamma` (ZXY Euler) and converts to a quaternion sent to the hub.

```
rotation.alpha  → yaw   (phone turns left/right)
rotation.beta   → pitch (phone tilts forward/back)
rotation.gamma  → roll  (phone tilts sideways)
```

The hub's `calibration.py` already handles full quaternions — it extracts yaw via `quaternion_to_yaw()`.

### Camera + Pose Detection (WebView)

MediaPipe PoseLandmarker runs inside a `react-native-webview` WebView using the phone's browser engine (no native ML library). The WebView sends landmark positions via `postMessage`; React Native converts them to phone-local 3D points using `toPhonePoint()` and sends them to the hub.

Internet connection is needed once to download the MediaPipe model (~5 MB). After that, the model is cached.

### Position (manual D-pad)

Without ARKit (which requires native modules + Mac/Xcode to compile), position is still set manually. The D-pad sends `pose` packets that the hub treats as the phone's world position.

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

// Pose update (25 Hz continuous)
{ "type": "pose", "sequence": 42, "localPose": { ... } }

// Detection (on each MediaPipe detection)
{ "type": "detection", "sequence": 43, "subjectId": "person_01", "timestampNs": ...,
  "positionPhone": [x,y,z], "jointsPhone": [{"name":"nose","position":[x,y,z],"confidence":0.94}], "confidence": 0.85 }
```

**No Python server changes needed.**
