# Running Spatial Relay with ARKit on your iPhone

ARKit is now the phone's position source. This replaces the old step-count
dead reckoning, so the phone's reported position is metric, in metres, and
correct in all three axes.

**ARKit cannot run in Expo Go.** You need a native development build, which
requires a Mac with Xcode. Windows can build via EAS cloud, but you still need a
Mac (or EAS) to produce the app binary.

---

## Quick start

On the Mac, from `clients/react-native/SpatialRelayObserver`:

```bash
./scripts/build_ios_dev.sh          # prebuild, pod install, run on iPhone
```

Then start the two servers (two terminals):

```bash
# terminal 1 — the hub
cd <repo root>
python -m uvicorn spatial_relay.server:app --host 0.0.0.0 --port 8000

# terminal 2 — Metro, serving the JS to the dev client
cd clients/react-native/SpatialRelayObserver
npx expo start --dev-client
```

---

## What you need

| Thing | Value |
|---|---|
| Laptop Wi-Fi IP | `172.20.10.2` (Wi-Fi adapter) |
| Phone | Same Wi-Fi network as the laptop |
| Phone app | The dev client built by the script, **not** Expo Go |
| Xcode | 16+ with an iOS 15+ simulator runtime installed |
| iPhone | Developer Mode on: Settings → Privacy & Security → Developer Mode |
| Hub port | `8000` |
| Metro port | `8081` |

The phone must be a physical device. ARKit world tracking does not work in the
iOS simulator.

---

## The two ports

| Purpose | Address on the phone | Protocol | Fails when |
|---|---|---|---|
| **Load the app code** (Metro) | `exp://172.20.10.2:8081` | HTTP | Phone cannot load the bundle |
| **Send pose data** (Python hub) | `ws://172.20.10.2:8000/ws/observer` | WebSocket | App shows `OFFLINE` |

Same IP, different ports. The hub IP is what you type into the app's Settings
(⚙); Metro's address comes from the dev-client QR code, so never edit it.

Turn off any VPN on the laptop while testing. A VPN adapter adds routing and
firewall rules that can block device-to-device traffic.

---

## Calibrating the two devices

ARKit establishes its own world origin wherever the phone happened to be when
the session started, so that frame has to be tied to the laptop.

1. On the laptop, open the viewer at `http://localhost:8000`. It defines the
   shared world origin.
2. Hold the phone at a known spot in the room.
3. Tap **Calibrate** on the phone.

That records the phone's current ARKit pose as the world anchor. After that,
every pose is sent as a delta from it, so the private ARKit origin never leaks
into the shared frame.

The phone re-calibrates automatically on every hub reconnect, so you do not need
to tap it again after a dropout.

---

## Reading the phone overlay

| Overlay text | Meaning |
|---|---|
| `ARKit ● tracking` | Pose is live and metric. This is the good state. |
| `ARKit limited` | Tracking is degraded. Move the phone to let ARKit map more features. |
| `ARKit limited (insufficientFeatures)` | Not enough texture. Walk around; plain walls give ARKit nothing to track. |
| `ARKit limited (excessiveMotion)` | Moving too fast. Slow down. |
| `ARKit limited (relocalizing)` | ARKit is re-finding the room after a big move. Wait a moment. |
| `ARKit searching…` | No pose yet. Point at something with texture. |
| `ARKit unsupported` | Device or OS lacks ARKit world tracking. |
| `ARKit no camera access` | Camera permission was denied. Re-enable in Settings. |
| `ARKit not linked` | The native module is missing from the build. Re-run the build script. |

---

## Localizing a person

Two modes, because ARKit and the MediaPipe WebView cannot share the rear camera.

**Body tracking (metric, preferred).** Tap `Enable Body Tracking`. ARKit uses
`ARBodyTrackingConfiguration` and reports a real 3D skeleton. Joints arrive
already in the ARKit world frame, so they are not re-transformed by the hub.
This needs A12 or newer.

**Tap to place.** Tap a point in the viewfinder. ARKit raycasts onto the
detected planes and reports the true metric distance, replacing the old manual
depth slider.

**Fallback (no ARKit).** Only mounted when ARKit is unavailable, the WebView
falls back to MediaPipe with the slider-estimated depth. This path is not
metric and should not be used for measurement.

---

## Diagnosing a wrong position

If the phone marker is in the wrong place:

```bash
curl http://localhost:8000/health
```

Look at these fields:

| Field | Reading |
|---|---|
| `poseSource` | Should be `arkit`. `sensors` means the old path is still running. |
| `phonePoseLive` | `true` when poses arrived in the last 3 s. |
| `tracking.status` | Should be `normal`. |
| `planes` | `0` means ARKit has not mapped anything yet. |
| `calibrated` | Must be `true`, or the hub has no phone-to-world transform. |

If `calibrated` is `false`, the phone has never sent a `calibration` packet.
Check that the WebSocket shows `HUB` in the header, not `OFFLINE`.

---

## Building

```bash
./scripts/build_ios_dev.sh          # local Xcode build onto a connected iPhone
./scripts/build_ios_dev.sh eas      # EAS cloud development build
./scripts/build_ios_dev.sh clean    # wipe ios/ and rebuild
```

Verify the native module was linked after a build:

```bash
grep ArkitTracker ios/Podfile.lock
```

If that prints nothing, check that
`modules/arkit-tracker/expo-module.config.json` is present and lists the module.

---

## Tests

```bash
# from the repo root
python -m pytest tests -q

# from clients/react-native/SpatialRelayObserver
npx tsc --noEmit
```

The Python suite covers the ARKit frame conversions in
`tests/test_arkit_integration.py`, in particular that world-frame body joints are
not double-transformed by the live phone pose.