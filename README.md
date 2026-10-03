# Spatial Relay

Processing hub and demonstrator for **deep-learning-based real-time multi-camera human localization and AR-assisted situational awareness**. The system synchronizes multiple observer viewpoints into a single unified 3D room coordinate system: iPhones act as helmet-mounted observers that track themselves with ARKit and localize every person they see in 3D with LiDAR; a Python hub fuses all phones in one shared frame and tracks people with stable ids; the laptop shows a live 3D world view of the scanned rooms, phones and people, including people hidden behind walls.

---

## Architecture Overview

```
 ┌───────────────────────────┐                 ┌───────────────────────────┐
 │  iPhone Helmet Observers  │                 │   Laptop 3D World View    │
 │   (Swift · ARKit · LiDAR) │                 │  (Web / Browser, three.js)│
 │                           │                 │                           │
 │ • ARKit 6-DoF Tracking    │                 │ • Scanned rooms & walls   │
 │ • Apple Vision Body Pose  │                 │ • Every phone + view cone │
 │ • LiDAR Per-Joint Depth   │                 │ • People, through walls   │
 │ • RoomPlan + Shared Map   │                 │ • Helmet (POV) views      │
 └─────────────┬─────────────┘                 └─────────────▲─────────────┘
               │                                             │
               │  WebSocket: /ws/observer                    │  WebSocket: /ws/viewer
               ▼                                             │
      ┌──────────────────────────────────────────────────────┴─────────────┐
      │                         Python Relay Hub                           │
      │                     (FastAPI + Uvicorn + NumPy)                    │
      │                                                                    │
      │ • Multi-phone fusion in one shared world frame                     │
      │ • Multi-person tracking, stable ids, smoothed rigid skeletons      │
      │ • 15 Hz world packets to the website and every phone               │
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
| **M8 Room Model & Shared Map** | RoomPlan multi-room scan + ARWorldMap relocalization | `RoomScanner.swift`, `src/spatial_relay/room.py` |
| **M9 Multi-Phone Fusion** | Cross-camera person fusion + 15 Hz world packet | `src/spatial_relay/world.py` |
| **M11 Body Model** | Person-segmented LiDAR depth, 19 joints, per-joint 1-euro smoothing, learned rigid limb lengths, mannequin rendering | `ObserverController.swift`, `src/spatial_relay/skeleton.py` |
| **M10 3D World View** | three.js god view, helmet views, through-wall sight lines | `web/index.html`, `web/world.js` |
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
* The header shows a green `HUB` when connected; the phone appears in the laptop's 3D view. If not, open `http://<laptop-ip>:8000/health` in iPhone Safari to test reachability.

---

### 3. Open the 3D World View

Open `http://localhost:8000` on the laptop (or `http://<LAPTOP_LAN_IP>:8000` from another computer).
It shows every connected phone and everyone they detect, live. Scanning the rooms adds the walls
(see below).

---

## Shared 3D World: multiple phones, see through walls

![3D world view](docs/images/world-orbit.png)

The laptop becomes a global "god view" at **`http://localhost:8000`**: a 3D model of the
rooms, every phone and its view cone, and every person any phone detects. A person seen by
phone A but hidden by a wall from phone B is drawn through the wall, with a dashed orange line
and a "behind wall from B" label.

1. **Scan the rooms (LiDAR iPhone, once).** Tap **Scan rooms**, walk each room slowly, then
   **Finish this room**. Tap **Next room** and walk through the doorway for the next one. Finally tap
   **Save & share**. RoomPlan's walls, doors, windows and furniture, plus the ARKit world map, are
   uploaded to the hub (`data/room/`).
2. **Join from every other phone.** Tap **Join shared map**, then look around a scanned area until
   it says *Relocalized*. Any ARKit iPhone works. Phones without LiDAR estimate distance from body size.
3. Give each phone its own name in ⚙ settings (e.g. `Helmet-A`, `Helmet-B`).
4. Open `http://localhost:8000` on the laptop. Use **Orbit**, **Top-down**, or **👁 Helmet-X** to see exactly what
   that phone sees, with walls see-through.

![Helmet view through a wall](docs/images/world-helmet-view.png)

**X-ray on the phones themselves.** The hub also pushes the fused world to every phone in the shared
map. Each phone draws the people that *other* phones see as glowing 3D skeletons in its own camera
view, on top of everything, so they show through real walls. Labels give distance, which phone sees
them, and **BEHIND WALL** when a scanned wall is in between. Other phones show as markers. **Walls**
toggles the faint outline of the scanned walls.

While scanning, captured walls (cyan), doors and windows (orange / blue) and furniture appear live in
AR. A mini top-down floor plan with your position shows what is still missing.

How it works:
- Every phone tracks in the same ARWorldMap frame, so no laptop calibration is needed.
- Each phone streams its 6-DoF pose and people in that frame (`frame: "map"`) over
  `/ws/observer?device=<name>`.
- The hub fuses people seen by several phones (within 0.5 m), assigns stable `person_NN` ids and
  pushes a `world` packet at 15 Hz.
- The website raycasts from each phone to each person against the scanned walls to decide
  "sees directly" or "behind a wall".

The "see-through" effect comes from sharing what *another* phone sees. Every person must be in some
phone's camera view.

**Demo without phones:**
```bash
PYTHONPATH=src python3 -m spatial_relay.simulate_world --hub http://localhost:8000
```
This uploads a synthetic 2-room scan and streams two walking helmets. Set `SPATIAL_RELAY_ROOM_DIR`
on the hub to keep a real scan untouched.

---

## Without a room scan: Calibrate

If you haven't scanned the rooms, phones can still share one frame by calibrating at the same spot.
1. Hold the phone at an agreed spot (e.g. a mark on a table), pointing in an agreed direction, and tap
   **Calibrate**. That pose becomes the origin $(0,0,0)$, looking down −Z.
2. Repeat with the other phone at the same spot and direction.
3. Walk around. ARKit tracks each phone in metres, and people are fused and shown in the 3D view.

In a shared map, **Leave map & calibrate here** switches back to this mode without restarting the app.
If the app is backgrounded, ARKit may restart tracking from a new origin, so calibrate again.

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
│       ├── world.py                # Multi-phone shared-map state & fusion
│       ├── skeleton.py             # Per-person joint smoothing, hold, rigid limbs
│       ├── room.py                 # Scanned room model + ARWorldMap storage
│       ├── simulate_world.py       # Phone-free demo of the 3D world view
│       ├── localization.py         # Depth sampling & back-projection
│       ├── camera_calibration.py   # OpenCV checkerboard camera calibrator
│       └── models.py               # Data schemas
├── web/                            # Laptop 3D world view (HTML/CSS/JS)
│   ├── index.html                  # 3D world god view (default page)
│   ├── world.js / world.css        # Scene, helmet views, panels
│   └── vendor/three/               # three.js r186 (MIT), vendored for offline use
└── tests/                          # Automated coordinate, tracking & hub tests
```
