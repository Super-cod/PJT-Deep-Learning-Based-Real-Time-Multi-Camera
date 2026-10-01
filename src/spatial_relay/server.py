from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from .models import Pose
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .calibration import Device, SharedFrameCalibration
from .protocol import point_json, pose_from_packet, pose_json, transform_from_packet
from .transforms import Transform, quaternion_to_yaw, yaw_to_quaternion
from .camera_calibration import load_intrinsics

log = logging.getLogger("spatial_relay")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


class RelayHub:
    def __init__(self) -> None:
        self.viewers: set[WebSocket] = set()
        self.last_packet: dict | None = None
        self.observer_connected = False
        self.started = time.monotonic()
        self.calibration = SharedFrameCalibration()
        # The laptop camera defines the world origin, so it needs no setup.
        # The phone deliberately starts UNcalibrated: until it sends a
        # `calibration` or `manual_pose` packet the hub has no phone-to-world
        # transform, and `calibration.ready` must report that honestly instead
        # of silently assuming a default placement.
        self.calibration.set_manual_laptop([0.0, 0.0, 0.0], 0.0)
        # Matches the observer client's initial state so there is no jump on connect.
        self.phone_local_pose = Pose([0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0])
        self.laptop_local_pose = Pose([0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0])
        # Where the pose data actually came from: ARKit gives metric
        # camera-to-world transforms, whereas the legacy path only ever had
        # step-count dead reckoning. The viewer shows this so a stale or
        # degraded source is visible instead of silently plotted.
        self.pose_source = "none"
        # ARKit tracking quality, plane discovery and anchor positions.
        self.tracking: dict | None = None
        self.planes: list[dict] = []
        self.anchors: list[dict] = []
        self.last_pose_update = 0.0
        self.last_plane_update = 0.0
        self.last_anchor_update = 0.0

    def phone_world(self) -> Transform:
        """Phone-to-world transform, or identity while the phone is uncalibrated.

        Lets the hub keep broadcasting debug poses before calibration without
        pretending it knows where the phone is.
        """
        if not self.calibration.ready:
            return Transform.identity()
        return self.calibration.world_from_phone(self.phone_local_pose)

    async def broadcast_debug_pose(self) -> None:
        phone = self.phone_world()
        laptop = self.calibration.world_from_laptop(self.laptop_local_pose)
        await self.broadcast({
            "type": "debug_pose",
            "phoneWorld": pose_json(phone),
            "laptopWorld": pose_json(laptop),
            "calibrated": self.calibration.ready,
        })

    async def broadcast(self, packet: dict) -> None:
        self.last_packet = packet
        stale: list[WebSocket] = []
        for viewer in self.viewers:
            try: await viewer.send_json(packet)
            except Exception: stale.append(viewer)
        for viewer in stale: self.viewers.discard(viewer)

    async def update_calibration(self, device: Device, local_pose: dict, start_offset: dict | None = None) -> None:
        pose = pose_from_packet(local_pose)
        if device == Device.PHONE:
            # Explicitly clear the manual placement so the calibrated
            # phone_initial_local path is the one actually exercised.
            self.calibration.manual_phone_position = None
            self.calibration.manual_phone_yaw = None
            self.calibration.calibrate_phone(pose, transform_from_packet(start_offset))
            self.phone_local_pose = pose
        else:
            self.calibration.calibrate_laptop(pose)
            self.laptop_local_pose = pose
        await self.broadcast({
            "type": "calibration",
            "ready": self.calibration.ready,
            "world": "laptop camera at calibration",
            "device": device.value,
        })
        await self.broadcast_debug_pose()

    async def set_manual_pose(self, device: Device, position: list[float], yaw_rad: float) -> None:
        if device == Device.PHONE:
            # Manual placement takes precedence over a previous calibration.
            self.calibration.phone_initial_local = None
            self.calibration.set_manual_phone(position, yaw_rad)
            self.phone_local_pose = Pose(position, yaw_to_quaternion(yaw_rad))
        else:
            self.calibration.set_manual_laptop(position, yaw_rad)
            self.laptop_local_pose = Pose(position, yaw_to_quaternion(yaw_rad))
        await self.broadcast_debug_pose()

    async def update_pose(self, device: Device, local_pose: dict, source: str | None = None) -> None:
        pose = pose_from_packet(local_pose)
        if device == Device.PHONE:
            self.phone_local_pose = pose
            self.pose_source = source or self.pose_source
            self.last_pose_update = time.monotonic()
            # Mirror the live orientation as the manual yaw so the manual path
            # still turns the phone. Leave manual_phone_position alone: the
            # observer reports [0,0,0] as its own origin and must not override
            # a manual placement or a calibration on every pose packet.
            if self.calibration.manual_phone_position is not None:
                self.calibration.manual_phone_yaw = quaternion_to_yaw(pose.quaternion_xyzw)
        else:
            self.laptop_local_pose = pose
            if self.calibration.laptop_initial_local is None:
                self.calibration.manual_laptop_yaw = quaternion_to_yaw(pose.quaternion_xyzw)
        await self.broadcast_debug_pose()

    async def localize_target(self, packet: dict) -> None:
        """Convert a detection into world and laptop-camera coordinates.

        `frame` decides how the incoming coordinates are interpreted, and the two
        cases need *different* transforms:

          - `'phone'` (default): phone-local camera coordinates, so the live
            device pose is required for the point to follow the phone.
          - `'arkitWorld'`: already in ARKit's room-scale world frame. That
            frame does not move, so a constant calibration-anchored transform
            applies. Passing these through the live-delta phone transform would
            re-apply the device motion and double-count it.
        """
        target_phone = packet["positionPhone"]
        frame = packet.get("frame", "phone")

        if frame == "arkitWorld":
            point_transform = self.calibration.world_from_arkit()
        else:
            point_transform = self.phone_world()

        laptop_transform = self.calibration.world_from_laptop(self.laptop_local_pose)
        laptop_inverse = laptop_transform.inverse()

        target_world = point_transform.apply(target_phone)
        target_laptop = laptop_inverse.apply(target_world)

        joints = []
        for joint in packet.get("jointsPhone", []):
            world = point_transform.apply(joint["position"])
            joints.append({
                "name": joint["name"],
                "positionWorld": point_json(world),
                "positionLaptop": point_json(laptop_inverse.apply(world)),
                "confidence": joint.get("confidence", 1.0)
            })
        await self.broadcast({
            "type": "target",
            "subjectId": packet.get("subjectId", "target_01"),
            "timestampNs": packet.get("timestampNs", time.time_ns()),
            "frame": frame,
            "positionPhone": point_json(target_phone),
            "positionWorld": point_json(target_world),
            "positionLaptop": point_json(target_laptop),
            "phoneWorld": pose_json(self.phone_world()),
            "laptopWorld": pose_json(laptop_transform),
            "joints": joints,
            "confidence": packet.get("confidence", 1.0),
            "calibrated": self.calibration.ready,
        })

    async def update_tracking(self, packet: dict) -> None:
        """Record ARKit tracking quality so `/health` and the viewer can show it."""
        self.tracking = {
            "status": packet.get("status", "unavailable"),
            "limitedReason": packet.get("limitedReason"),
            "timestampMs": packet.get("timestampMs"),
        }

    async def update_planes(self, packet: dict) -> None:
        self.planes = list(packet.get("planes", []))
        self.last_plane_update = time.monotonic()

    async def update_anchors(self, packet: dict) -> None:
        self.anchors = list(packet.get("anchors", []))
        self.last_anchor_update = time.monotonic()


hub = RelayHub()

@asynccontextmanager
async def lifespan(_: FastAPI):
    yield


app = FastAPI(title="Spatial Relay Hub", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.get("/health")
async def health() -> dict:
    now = time.monotonic()
    # ARKit streams pose at 25 Hz and a 1 Hz tracking heartbeat, so anything
    # older than a few seconds means the phone stopped reporting even though
    # the socket is still open.
    pose_age = now - hub.last_pose_update if hub.last_pose_update else None
    return {
        "ok": True,
        "observerConnected": hub.observer_connected,
        "viewers": len(hub.viewers),
        "calibrated": hub.calibration.ready,
        "uptimeS": round(now - hub.started, 2),
        "poseSource": hub.pose_source,
        "poseAgeS": round(pose_age, 2) if pose_age is not None else None,
        "phonePoseLive": pose_age is not None and pose_age < 3.0,
        "tracking": hub.tracking,
        "planes": len(hub.planes),
        "anchors": len(hub.anchors),
    }

@app.get("/latest")
async def latest() -> dict:
    return hub.last_packet or {"type": "status", "message": "No skeleton received"}

@app.get("/camera/intrinsics")
async def camera_intrinsics() -> dict:
    intrinsics = load_intrinsics()
    return {"calibrated": intrinsics is not None, "intrinsics": intrinsics}

import math

@app.websocket("/ws/observer")
async def observer(socket: WebSocket) -> None:
    await socket.accept(); hub.observer_connected = True
    log.info("phone observer connected")
    try:
        while True:
            try:
                packet = await socket.receive_json()
            except WebSocketDisconnect:
                raise
            except Exception as exc:  # malformed frame, not a disconnect
                log.warning("phone sent an unreadable frame: %s", exc)
                continue
            try:
                kind = packet.get("type")
                if kind == "calibration":
                    await hub.update_calibration(Device.PHONE, packet["localPose"], packet.get("worldFromPhoneAtStart"))
                elif kind == "manual_pose":
                    yaw_rad = packet.get("yawRad", math.radians(packet.get("yawDeg", 0.0)))
                    await hub.set_manual_pose(Device.PHONE, packet["position"], yaw_rad)
                elif kind == "pose":
                    await hub.update_pose(Device.PHONE, packet["localPose"], packet.get("source"))
                elif kind == "detection":
                    await hub.localize_target(packet)
                elif kind == "tracking":
                    await hub.update_tracking(packet)
                elif kind == "arkit_planes":
                    await hub.update_planes(packet)
                elif kind == "arkit_anchors":
                    await hub.update_anchors(packet)
                elif kind == "skeleton":
                    await hub.broadcast(packet)
                else:
                    log.warning("phone sent unknown packet type %r", kind)
                    await socket.send_json({"type": "error", "message": "Expected manual_pose, calibration, pose, detection, tracking, arkit_planes, arkit_anchors or skeleton"})
                    continue
            except Exception as exc:
                # A single bad packet must not drop the phone's connection.
                log.warning("phone packet %r rejected: %s", packet.get("type"), exc)
                try:
                    await socket.send_json({"type": "error", "message": str(exc)})
                except Exception:
                    pass
                continue
            await socket.send_json({"type": "ack", "sequence": packet.get("sequence")})
    except WebSocketDisconnect:
        pass
    finally:
        hub.observer_connected = False
        log.info("phone observer disconnected")

@app.websocket("/ws/viewer")
async def viewer(socket: WebSocket) -> None:
    await socket.accept(); hub.viewers.add(socket)
    # Send current pose state immediately
    await socket.send_json({
        "type": "debug_pose",
        "phoneWorld": pose_json(hub.phone_world()),
        "laptopWorld": pose_json(hub.calibration.world_from_laptop(hub.laptop_local_pose)),
        "calibrated": hub.calibration.ready,
    })
    if hub.last_packet and hub.last_packet.get("type") == "target":
        await socket.send_json(hub.last_packet)
    # Tell the viewer what the phone is actually doing, so an ARKit-limited or
    # disconnected tracker is visible rather than a frozen last-known position.
    await socket.send_json({
        "type": "phone_status",
        "poseSource": hub.pose_source,
        "calibrated": hub.calibration.ready,
        "tracking": hub.tracking,
        "planes": hub.planes,
        "anchors": hub.anchors,
    })
    try:
        while True:
            packet = await socket.receive_json()
            kind = packet.get("type")
            if kind == "calibration":
                await hub.update_calibration(Device.LAPTOP, packet["localPose"])
            elif kind == "laptop_pose":
                pos = packet.get("position", [0.0, 0.0, 0.0])
                yaw_rad = packet.get("yawRad", math.radians(packet.get("yawDeg", 0.0)))
                await hub.set_manual_pose(Device.LAPTOP, pos, yaw_rad)
            elif kind in ("set_phone_pose", "manual_pose"):
                pos = packet["position"]
                yaw_rad = packet.get("yawRad", math.radians(packet.get("yawDeg", 0.0)))
                await hub.set_manual_pose(Device.PHONE, pos, yaw_rad)
            elif kind == "pose":
                await hub.update_pose(Device.LAPTOP, packet["localPose"])
    except WebSocketDisconnect:
        pass
    finally:
        hub.viewers.discard(socket)



# Serve the laptop AR console from the same localhost/LAN origin as the hub.
from pathlib import Path
WEB_ROOT = Path(__file__).resolve().parents[2] / "web"
app.mount("/", StaticFiles(directory=WEB_ROOT, html=True), name="web")
