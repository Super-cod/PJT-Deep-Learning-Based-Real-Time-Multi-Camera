# Spatial Relay

Processing hub and demonstrator for **deep-learning-based real-time multi-camera human localization and AR-assisted situational awareness**. The design follows the supplied Review 1 scope: an iPhone observer supplies RGB, depth and 6-DoF pose; a Python hub derives metric skeleton joints in a shared marker frame; an Android/Unity viewer renders them.

## Included implementation

| Module | Implementation |
|---|---|
| M1 acquisition contract | Timestamped RGB-D, intrinsics, 6-DoF pose packet schema |
| M2 pose integration point | MediaPipe-ready landmark input contract |
| M3 3D localization | Pinhole back-projection and patch-median metric depth |
| M4 shared frame | ArUco PnP estimator plus explicit rigid transforms |
| M5 transport | FastAPI WebSocket observer/viewer relay |
| M6 AR contract | JSON skeleton packets consumable by Unity or browser visualizer |
| M7 drift | Re-anchor residual transform with gradual correction |
| M8 evaluation base | Unit-tested coordinate and depth functions |

The project also includes a thin Unity receiver at `clients/unity` and an iOS packet contract at `clients/ios`. The scripts retain hardware-specific code at the platform edge, where ARKit/Record3D and ARCore APIs belong.

## Run the laptop viewer and simulator

```powershell
cd PJT-Deep-Learning-Based-Real-Time-Multi-Camera
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
pip install -e .
uvicorn spatial_relay.server:app --host 0.0.0.0 --port 8000
```

In a second terminal, start the sensor-free observer simulation:

```powershell
python -m spatial_relay.simulator
```

Open `http://localhost:8000` in the laptop browser, allow camera access, then click **Calibrate laptop origin** while the phone is held beside the webcam. The visualizer receives the hub's world and laptop-frame packets. Run `pytest` to verify the transform and depth primitives.

For accurate laptop-webcam overlays, print or display a 9×6 inner-corner checkerboard, capture 20 varied views, and run:

```powershell
python -m spatial_relay.camera_calibration
```

This writes `data/laptop_camera.json`, which the viewer loads automatically. It is essential for correct 3D-to-webcam pixel projection.

## Mobile-client packet contract

The physical observer should send a pose update over WebSocket at 25 FPS or higher:

```json
{
  "timestamp": 1720000000,
  "observerPoseWorld": {
    "position": [1.38, 0.0, -2.2],
    "rotationQuaternion": [0.0, 0.276, 0.0, 0.961]
  },
  "jointsWorld": [{"name": "nose", "position": [2.14, 1.65, -3.61], "confidence": 0.94}]
}
```

## Coordinate convention

The hub uses a single right-handed marker/world frame, in metres, with +Y up. `T_world_from_camera` maps a point in the observer camera frame into the shared marker frame. The core equation is `p_world = T_world_from_camera × p_camera`. The viewer computes `p_viewer = inverse(T_world_from_viewer) × p_world` before rendering. Keep ARKit, OpenCV and Unity conversion code at the platform boundary and cover it with round-trip tests to prevent mirrored skeletons.

## Calibration and movement pipeline

`src/spatial_relay/calibration.py` owns the shared coordinate system. At startup, each device sends its **private** AR tracking pose in a `calibration` message. The laptop's camera at that instant becomes world `W`, so `T_world_laptop(0) = I`. The calibration object saves the phone and laptop local poses and derives all later world poses:

```text
T_world_phone(t) = T_world_phone(0) × inverse(T_phoneMap_phone(0)) × T_phoneMap_phone(t)
T_world_laptop(t) = inverse(T_laptopMap_laptop(0)) × T_laptopMap_laptop(t)
P_target_world = T_world_phone(t) × P_target_phone
P_target_laptop = inverse(T_world_laptop(t)) × P_target_world
```

For an approximate co-location, `T_world_phone(0)` is identity. A dual-fiducial measurement can supply its small translation/rotation offset as `worldFromPhoneAtStart` for a more accurate calibration. The hub broadcasts `debug_pose` and `target` packets, which the dashboard uses to show the world origin, moving phone, orientation, target world point, and laptop-relative result.

## Current implementation boundary

The laptop hub, webcam viewer, checkerboard calibration utility, and iPhone observer source are implemented. The simulator remains available for repeatable transform checks when no phone is present. The physical acceptance step still requires a LiDAR iPhone, a Mac/Xcode build, the laptop webcam, a shared LAN, and controlled tape-measured movements. The optional Unity viewer remains a separate ARCore alternative to the implemented browser-based laptop viewer.

## iPhone observer

The working observer app lives in `clients/ios/SpatialRelayObserver`. It uses ARKit world tracking for phone movement, LiDAR scene depth for metric joint range, and Apple Vision body pose detection. On a Mac, generate and open its Xcode project as described in that folder's README. Set the laptop's LAN IPv4 address in `WebSocketRelay.swift`, then run it on a LiDAR iPhone. It streams the raw phone pose and phone-relative depth joints to the hub, which remains the authority for world and laptop transforms.

## Website-only phone MVP

Open `http://LAPTOP_LAN_IP:8000/phone.html` on the phone and `http://localhost:8000` on the laptop. The phone page streams browser orientation, manual controlled translation, and automatic MediaPipe Pose Landmarker joints to the existing hub. Tap **Enable person detection** after starting the camera. The one-time WebAssembly/model download requires phone internet access; the page falls back to manual tap-to-target when it is unavailable.

For the browser to access a phone camera and motion sensors, serve the site over **trusted HTTPS**. `http://localhost:8000` works only on the laptop itself; a plain `http://192.168.x.x:8000/phone.html` page commonly cannot request phone camera or motion permission. Use a trusted HTTPS tunnel or a locally trusted certificate before using the phone page. The laptop server supports TLS through Uvicorn's `--ssl-keyfile` and `--ssl-certfile` options.

This web mode provides a demonstrator, not ARKit-level tracking: rotation comes from the phone sensor, the operator sets position using controlled movement buttons, and the operator taps the target and sets its range. It is useful for validating the WebSocket, calibration flow, transforms and laptop overlay without a Mac.
