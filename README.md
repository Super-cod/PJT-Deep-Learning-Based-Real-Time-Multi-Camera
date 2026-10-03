# Spatial Relay

Processing hub and demonstrator for **deep-learning-based real-time multi-camera human localization and AR-assisted situational awareness**. The system synchronizes multiple observer viewpoints into a single unified 3D room coordinate system: an iPhone observer supplies camera feed, real-time pose, and 3D human body skeleton detections; a Python hub transforms and tracks targets in a shared coordinate frame; and a laptop AR console visualizes augmented human overlays and a 2D floor map.

---

## Architecture Overview

```
 ┌───────────────────────────┐                 ┌───────────────────────────┐
 │   iPhone Mobile Observer  │                 │    Laptop AR Console      │
 │   (Swift · ARKit · LiDAR) │                 │      (Web / Browser)      │
 │                           │                 │                           │
 │ • ARKit 6-DoF Tracking    │                 │ • Webcam Pinhole Viewport │
 │ • Apple Vision Body Pose  │                 │ • Frustum Gating Overlays │
 │ • LiDAR Per-Joint Depth   │                 │ • Real-time 2D Floor Map  │
 │ • Multi-Person Detection  │                 │ • Interactive Calibration │
 └─────────────┬─────────────┘                 └─────────────▲─────────────┘
               │                                             │
               │  WebSocket: /ws/observer                    │  WebSocket: /ws/viewer
               ▼                                             │
      ┌──────────────────────────────────────────────────────┴─────────────┐
      │                         Python Relay Hub                           │
      │                     (FastAPI + Uvicorn + NumPy)                    │
      │                                                                    │
      │ • Shared coordinate frame calibration (T_world_from_phone)         │
      │ • Multi-person tracking with stable person_NN ids                  │
      │ • 25 Hz continuous pose broadcasting and viewer synchronization    │
      └────────────────────────────────────────────────────────────────────┘
```

---

## Modules

| Module | Description | Implementation |
|---|---|---|
| **M1 Acquisition Contract** | Timestamped pose, 3D metric joints and detection packets | `src/spatial_relay/models.py`, `clients/ios/.../Protocol.swift` |
| **M2 Deep Pose Estimation** | On-device human body pose (Apple Vision, multi-person) | `clients/ios/.../ObserverController.swift` |
| **M3 3D Metric Localization** | LiDAR depth sampling + pinhole back-projection per joint | `ObserverController.swift`, `src/spatial_relay/localization.py` |
| **M4 Shared Frame Calibration**| Rigid coordinate transforms mapping phone and laptop into world $W$ | `src/spatial_relay/calibration.py`, `RoomFrame.swift` |
| **M4b Multi-Person Tracking** | Stable `person_NN` ids across frames (nearest-neighbour + 1-euro smoothing) | `src/spatial_relay/tracking.py` |
| **M5 Real-Time Relay** | FastAPI WebSocket server broadcasting at 25 FPS | `src/spatial_relay/server.py` |
| **M6 AR Projection** | Laptop camera frustum gating, skeleton projection and floor map | `web/viewer.js`, `web/index.html` |
| **M7 Visual-Inertial Odometry** | ARKit world tracking, gravity aligned | `ObserverController.swift` |

---

## Quickstart Guide

### 1. Start the Python Hub

```bash
# From the repository root:
python3 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -r requirements.txt
pip install -e .

# Run the hub server on your LAN:
PYTHONPATH=src python3 -m uvicorn spatial_relay.server:app --host 0.0.0.0 --port 8000 --reload
```

The hub is now active on port `8000`. You can verify health at `http://localhost:8000/health`.

---

### 2. Install the iPhone Observer App

The observer is a native Swift app (ARKit + LiDAR + Apple Vision), built and installed **from Linux with a free Apple ID** using [xtool](https://github.com/xtool-org/xtool). One-time setup (Swift toolchain, Xcode.xip SDK, `xtool auth`) is in [`clients/ios/SpatialRelayObserver/README.md`](clients/ios/SpatialRelayObserver/README.md).

```bash
cd clients/ios/SpatialRelayObserver
. ~/.local/share/swiftly/env.sh
xtool dev        # builds, signs and installs over USB
```

* Requires a LiDAR iPhone (12 Pro or later Pro models) for person detection, iOS 17+.
* Free Apple ID installs expire after 7 days — re-run `xtool dev` to refresh.
* In the app, tap ⚙ and enter the laptop's IP (`ip -4 addr`) and port `8000`. Allow **Camera** and **Local Network**.
* The header shows a green `HUB` when connected; the laptop console shows `PHONE LIVE`. If not, open `http://<laptop-ip>:8000/health` in iPhone Safari to test reachability.

---

### 3. Open the Laptop AR Console

Open your browser on the laptop:
```
http://localhost:8000
```
*(Or `http://<LAPTOP_LAN_IP>:8000` from another computer on the same network)*

* Click **Start laptop camera** to activate the webcam AR overlay.
* The console will show:
  * **AR Webcam Viewport**: Augmented skeleton overlays for every person in the laptop's field of view.
  * **Top-Down Shared Room Map**: A metric grid showing the live positions of the Laptop (origin `0,0`), moving Phone, and each tracked person.

---

## Calibration & Coordinate Synchronization

1. Hold the phone right beside the laptop's webcam, rear camera facing the same direction as the webcam.
2. Tap **Calibrate** on the phone, or click **Reset origin (0,0)** on the laptop console (the hub forwards it to the phone, which re-zeros itself).
3. Both devices are now synchronized to position $(X=0, Z=0)$, heading $0^\circ$ (+Z forward).
4. Walk around: ARKit tracks the phone in metres, and every detected person is localized with LiDAR depth and streamed to the laptop with a stable `person_NN` id.

If the app is backgrounded, ARKit may restart tracking from a new origin — calibrate again.

---

## Directory Structure

```
.
├── clients/
│   ├── ios/SpatialRelayObserver/   # Native Swift ARKit + LiDAR observer (xtool, builds on Linux)
│   └── unity/                      # Unity ARCore receiver client
├── src/
│   └── spatial_relay/              # Python processing hub
│       ├── server.py               # FastAPI WebSocket server & packet relay
│       ├── calibration.py          # Shared coordinate transforms
│       ├── tracking.py             # Multi-person identity tracking
│       ├── localization.py         # Depth sampling & back-projection
│       ├── camera_calibration.py   # OpenCV checkerboard camera calibrator
│       └── models.py               # Data schemas
├── web/                            # Laptop AR Console (HTML/CSS/JS)
│   ├── index.html                  # Main AR console dashboard
│   ├── viewer.js                   # Canvas AR overlay & 2D map renderer
│   └── viewer.css                  # Dark-mode telemetry styling
└── tests/                          # Automated coordinate, tracking & hub tests
```

---

## Camera Calibration (Optional)

For pixel-perfect webcam projection, calibrate your laptop camera using an OpenCV checkerboard:
```bash
python3 -m spatial_relay.camera_calibration
```
This saves focal length and distortion parameters to `data/laptop_camera.json`, which the web viewer loads automatically.
