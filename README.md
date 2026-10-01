# Spatial Relay

Processing hub and demonstrator for **deep-learning-based real-time multi-camera human localization and AR-assisted situational awareness**. The system synchronizes multiple observer viewpoints into a single unified 3D room coordinate system: an iPhone observer supplies camera feed, real-time pose, and 3D human body skeleton detections; a Python hub transforms and tracks targets in a shared coordinate frame; and a laptop AR console visualizes augmented human overlays and a 2D floor map.

---

## Architecture Overview

```
 ┌───────────────────────────┐                 ┌───────────────────────────┐
 │   iPhone Mobile Observer  │                 │    Laptop AR Console      │
 │  (Expo Go / React Native) │                 │      (Web / Browser)      │
 │                           │                 │                           │
 │ • Rear Camera Stream      │                 │ • Webcam Pinhole Viewport │
 │ • MediaPipe Pose (33 pts) │                 │ • Frustum Gating Overlays │
 │ • Gyroscope Heading (Yaw) │                 │ • Real-time 2D Floor Map  │
 │ • PDR Walking Step Engine │                 │ • Interactive Calibration │
 └─────────────┬─────────────┘                 └─────────────▲─────────────┘
               │                                             │
               │  WebSocket: /ws/observer                    │  WebSocket: /ws/viewer
               ▼                                             │
      ┌──────────────────────────────────────────────────────┴─────────────┐
      │                         Python Relay Hub                           │
      │                     (FastAPI + Uvicorn + NumPy)                    │
      │                                                                    │
      │ • Shared coordinate frame calibration (T_world_from_phone)         │
      │ • 3D target pinhole back-projection and metric localization        │
      │ • 25 Hz continuous pose broadcasting and viewer synchronization    │
      └────────────────────────────────────────────────────────────────────┘
```

---

## Modules

| Module | Description | Implementation |
|---|---|---|
| **M1 Acquisition Contract** | Timestamped RGB, 3D metric joints, and 6-DoF pose schema | `src/spatial_relay/models.py`, `protocol.ts` |
| **M2 Deep Pose Estimation** | Real-time on-device human landmark detection (MediaPipe Vision) | `cameraWebView.ts`, `web/phone.js` |
| **M3 3D Metric Localization** | Pinhole back-projection with adjustable range and patch depth | `src/spatial_relay/localization.py`, `geometry.ts` |
| **M4 Shared Frame Calibration**| Rigid coordinate transforms mapping phone and laptop into world $W$ | `src/spatial_relay/calibration.py` |
| **M5 Real-Time Relay** | FastAPI WebSocket server broadcasting at 25 FPS | `src/spatial_relay/server.py` |
| **M6 AR Projection** | Laptop camera frustum gating, reticle projection, and floor map | `web/viewer.js`, `web/index.html` |
| **M7 Inertial Odometry** | Gyroscope orientation + PDR (Pedestrian Dead-Reckoning) step engine | `useDeviceMotion.ts` |

---

## Quickstart Guide

### 1. Start the Python Hub

```bash
# From the repository root:
python3 -m venv .venv
source .venv/bin/activate          # macOS / Linux
# .venv\Scripts\activate            # Windows PowerShell / cmd

pip install -r requirements.txt
pip install -e .
```

Then start the hub. `PYTHONPATH=src` is Bash syntax; use the Windows form below instead.

```bash
# macOS / Linux
PYTHONPATH=src python3 -m uvicorn spatial_relay.server:app --host 0.0.0.0 --port 8000 --reload
```

```powershell
# Windows PowerShell, from the repository root
.\.venv\Scripts\python.exe -m uvicorn spatial_relay.server:app --host 0.0.0.0 --port 8000 --reload
```

The hub is now active on port `8000`. You can verify health at `http://localhost:8000/health`.

---

### 2. Start the Mobile Observer App (iPhone)

The modern mobile observer client is built with **React Native & Expo SDK 57**, requiring no Mac or Xcode to build or test.

```bash
cd clients/react-native/SpatialRelayObserver
npm install

# Start the Expo bundler:
npx expo start --lan
```

* Open the **Expo Go** app on your iPhone (iOS 17+ / SDK 57 compatible).
* Scan the QR code displayed in the terminal.
* Grant **Camera** and **Motion & Orientation** permissions when prompted.
* Tap the **gear icon** to open Settings, then enter your laptop's Wi-Fi IP (for example `192.168.1.42`) and port `8000`. The app ships with a placeholder host, so this is required on first launch.

---

### 3. Open the Laptop AR Console

Open your browser on the laptop:
```
http://localhost:8000
```
*(Or `http://<LAPTOP_LAN_IP>:8000` from another computer on the same network)*

* Click **Start laptop camera** to activate the webcam AR overlay.
* The console will show:
  * **AR Webcam Viewport**: Displays augmented skeleton overlays when the person is in the laptop's field of view.
  * **Top-Down Shared Room Map**: A metric grid showing the live positions of the Laptop (origin `0,0`), moving Phone, and detected Person.

---

## Calibration & Coordinate Synchronization

The laptop camera defines the world origin, so it needs no setup. The phone
starts **uncalibrated** and `/health` reports `"calibrated": false` until it
reports a position.

1. Hold the phone right beside the laptop's webcam, facing forward into the room in the same direction as the laptop screen.
2. Tap **Calibrate** on the phone (or click **Reset origin (0,0)** on the laptop console).
3. Both devices will synchronize to:
   * **Position**: $(X=0.00, Z=0.00)$
   * **Heading**: $0^\circ\text{ (+Z Forward)}$
4. Now walk around the room with the phone:
   * **Heading (Yaw)**: Gyroscope tracks orientation continuously with zero translational drift.
   * **Step Tracking (PDR)**: Heel-strike impulse detection automatically steps forward $\approx 0.65\text{m}$ in your heading direction.
   * **D-Pad**: Use the on-screen arrows (`↑`, `↓`, `←`, `→`) to manually nudge position by $\pm 0.5\text{m}$.
   * **Target Detection**: Tap **▶ Enable Detection** to detect people with MediaPipe; the target and skeleton joints are localized in 3D and streamed to the laptop map!

---

## Directory Structure

```
.
├── clients/
│   ├── react-native/
│   │   └── SpatialRelayObserver/   # Modern Expo SDK 57 iOS observer client
│   │       ├── src/
│   │       │   ├── hooks/          # useDeviceMotion (PDR + Gyro), useWebSocket
│   │       │   ├── lib/            # cameraWebView, geometry, protocol, storage
│   │       │   ├── screens/        # ObserverScreen main view
│   │       │   ├── components/     # StatusHeader, DPad, RangeSlider
│   │       │   └── modals/         # SettingsModal (hub host / port)
│   │       └── package.json
│   ├── ios/                        # Native Swift ARKit / Vision observer (Xcode)
│   └── unity/                      # Unity ARCore receiver client
├── src/
│   └── spatial_relay/              # Python processing hub
│       ├── server.py               # FastAPI WebSocket server & packet relay
│       ├── calibration.py          # Shared coordinate transforms
│       ├── transforms.py           # Rigid transforms, quaternion/yaw math
│       ├── localization.py         # 3D back-projection & landmark conversion
│       ├── camera_calibration.py   # OpenCV checkerboard camera calibrator
│       ├── frames.py               # Per-device frame state
│       ├── filtering.py            # Measurement filters
│       ├── drift.py                # Drift estimation
│       ├── anchors.py              # Anchor helpers
│       ├── protocol.py             # Packet (de)serialisation
│       ├── models.py               # Pydantic data schemas
│       └── simulator.py            # Scripted observer for flow testing
├── web/                            # Laptop AR Console (HTML/CSS/JS)
│   ├── index.html                  # Main AR console dashboard
│   ├── viewer.js                   # Canvas AR overlay & 2D map renderer
│   ├── viewer.css                  # Dark-mode telemetry styling
│   ├── phone.html                  # Browser-based phone observer page
│   ├── phone.js                    # Browser MediaPipe observer
│   └── phone.css
└── tests/                          # Automated coordinate, depth & calibration tests
```

---

## Camera Calibration (Optional)

For pixel-perfect webcam projection, calibrate your laptop camera using an OpenCV checkerboard:
```bash
python3 -m spatial_relay.camera_calibration
```
```powershell
# Windows PowerShell
.\.venv\Scripts\python.exe -m spatial_relay.camera_calibration
```
This saves focal length and distortion parameters to `data/laptop_camera.json`, which the web viewer loads automatically.
