# Spatial Relay — Native iOS Observer (Swift, ARKit + LiDAR)

Native observer for LiDAR iPhones (12 Pro and later Pro models, e.g. iPhone 15 Pro):

- ARKit visual-inertial tracking (cm-level, 6-DoF, gravity aligned)
- Apple Vision body pose, on-device and offline, up to 6 people per frame
- LiDAR depth per joint, with camera pitch fully accounted for

It streams to the hub's `/ws/observer` WebSocket; the laptop website shows the results.

It is a plain SwiftPM package built with **[xtool](https://github.com/xtool-org/xtool)** — no Mac, no Xcode, no paid developer account.

---

## One-time setup (Linux)

1. **Swift 6.3 toolchain** (what xtool 1.20.x expects). Fedora is not auto-detected by swiftly; pass the platform:
   ```bash
   curl -fsSLO "https://download.swift.org/swiftly/linux/swiftly-$(uname -m).tar.gz"
   tar zxf swiftly-$(uname -m).tar.gz
   ./swiftly init --platform fedora39
   . ~/.local/share/swiftly/env.sh
   swift --version   # Swift version 6.3.x
   sudo dnf install libcurl-devel libedit-devel libuuid-devel libstdc++-static   # toolchain deps
   ```
2. **usbmuxd** (talks to the iPhone over USB): `sudo dnf install usbmuxd libimobiledevice-utils`
3. **Xcode.xip** — download *Xcode 26* (matches xtool 1.20.x) in your browser from <https://developer.apple.com/download/all/?q=Xcode> (free Apple ID). It is only used to extract the iOS SDK.
4. **xtool**:
   ```bash
   curl -fL "https://github.com/xtool-org/xtool/releases/latest/download/xtool-$(uname -m).AppImage" -o ~/.local/bin/xtool
   chmod +x ~/.local/bin/xtool
   xtool setup        # choose "Password" login for a free Apple ID, then give the Xcode.xip path
   swift sdk list     # should print: darwin
   ```

> The *Password* login uses private Apple APIs. A throwaway Apple ID is a reasonable precaution.

## Build & install

```bash
cd clients/ios/SpatialRelayObserver
xtool dev
```

First build takes several minutes (it compiles the iOS SDK modules). Then:

1. Plug the iPhone in by USB, tap **Trust**, re-run `xtool dev` if it errors after pairing.
2. If asked, enable **Settings → Privacy & Security → Developer Mode** and reboot the phone.
3. First launch: **Settings → General → VPN & Device Management → your Apple ID → Trust**.
4. In the app, enter the laptop's IP (`ip -4 addr`), allow Camera and Local Network.

If signing fails because the bundle ID is taken, change `bundleID` in `xtool.yml`.

### Free Apple ID limits

- The app expires after **7 days** — re-run `xtool dev` to refresh it.
- At most 3 sideloaded apps per device and 10 new App IDs per week.

## Using it

1. Start the hub on the laptop: `PYTHONPATH=src python3 -m uvicorn spatial_relay.server:app --host 0.0.0.0 --port 8000` and open `http://localhost:8000`.
2. Either scan + share the rooms / **Join shared map** (see below), or hold each phone at the same agreed spot and direction and tap **Calibrate**.
3. Walk around. The phone streams its pose at 25 Hz and person detections at ~20 Hz. Filled joint dots have a depth and are sent; hollow red dots had no valid depth.

If the app is backgrounded, ARKit may restart tracking from a new origin — calibrate again.

## Shared map mode (several phones, 3D world view)

- **Scan rooms** (LiDAR only): RoomPlan captures each room on the app's own ARSession. Use
  **Finish this room**, then **Next room**, then **Save & share**. This uploads the room model
  (`POST /api/room`) and the ARWorldMap (`POST /api/worldmap`).
- **Join shared map** (any ARKit iPhone): downloads the map and relocalizes. After that, poses and
  people are sent in the shared frame (`frame: "map"`), and the laptop's world view (`http://<laptop>:8000`) shows everyone.
- Without LiDAR, each person's depth is estimated from their torso length (about 0.5 m), at roughly
  ±20–30% accuracy.
- In shared map mode each phone shows people seen by *other* phones as x-ray skeletons in AR, marked
  **BEHIND WALL** when a scanned wall is in between (`WorldOverlay.swift`).
- While scanning, captured surfaces are drawn live in AR, plus a mini floor plan.
- Name each phone in ⚙ settings. The name is the `device` id the hub and 3D view use.

## Code

```
Sources/SpatialRelayObserver/
├── SpatialRelayObserverApp.swift   SwiftUI UI, AR camera view, skeleton overlay, settings
├── ObserverController.swift        ARSession, modes (calibrated / scanning / relocalizing / shared map), Vision + depth
├── RoomScanner.swift               RoomPlan multi-room scan → compact room JSON
├── WorldOverlay.swift              SceneKit AR: remote people (x-ray), other phones, walls, live scan
├── HubAPI.swift                    Room + world-map upload / download
├── RoomFrame.swift                 ARKit world → hub room frame (+X right, +Y up, +Z forward)
├── WebSocketRelay.swift            Reconnecting WebSocket client
└── Protocol.swift                  Hub packet types
```

Joints are converted into the hub's yaw-only phone frame (`phoneLocal`) so that the hub's
`world_from_phone` transform reproduces the exact room position, including camera pitch.
