from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from contextlib import asynccontextmanager
from pathlib import Path

from .models import Pose
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .calibration import Device, SharedFrameCalibration
from .protocol import point_json, pose_from_packet, pose_json, transform_from_packet
from .transforms import quaternion_to_yaw, yaw_to_quaternion
from .camera_calibration import load_intrinsics
from .tracking import PersonTracker

log = logging.getLogger("spatial_relay")
SEND_TIMEOUT_S = 0.5


class RelayHub:
    def __init__(self) -> None:
        self.viewers: set[WebSocket] = set()
        self.last_packet: dict | None = None
        self.last_target: dict | None = None
        self.last_targets: dict | None = None
        self.tracker = PersonTracker()
        self.observer: WebSocket | None = None
        self.started = time.monotonic()
        self.calibration = SharedFrameCalibration()
        # Default manual poses: laptop at origin facing +Z, phone at (1, 0, 1) facing +Z
        self.calibration.set_manual_laptop([0.0, 0.0, 0.0], 0.0)
        self.calibration.set_manual_phone([1.0, 0.0, 1.0], 0.0)
        self.phone_local_pose = Pose([1.0, 0.0, 1.0], [0.0, 0.0, 0.0, 1.0])
        self.laptop_local_pose = Pose([0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0])

    @property
    def observer_connected(self) -> bool:
        return self.observer is not None

    async def broadcast(self, packet: dict) -> None:
        self.last_packet = packet
        if packet.get("type") == "target":
            self.last_target = packet
        elif packet.get("type") == "targets":
            self.last_targets = packet
        if not self.viewers:
            return
        text = json.dumps(packet)
        viewers = list(self.viewers)

        async def send(viewer: WebSocket) -> bool:
            try:
                await asyncio.wait_for(viewer.send_text(text), SEND_TIMEOUT_S)
                return True
            except Exception:
                return False

        # Send concurrently so one slow browser tab cannot stall the phone stream.
        results = await asyncio.gather(*(send(v) for v in viewers))
        for viewer, ok in zip(viewers, results):
            if not ok:
                self.viewers.discard(viewer)

    def status_packet(self) -> dict:
        return {"type": "observer_status", "connected": self.observer_connected}

    def pose_packet(self) -> dict:
        phone = self.calibration.world_from_phone(self.phone_local_pose)
        laptop = self.calibration.world_from_laptop(self.laptop_local_pose)
        return {"type": "debug_pose", "phoneWorld": pose_json(phone), "laptopWorld": pose_json(laptop), "calibrated": True}

    async def send_to_observer(self, packet: dict) -> bool:
        if self.observer is None:
            return False
        try:
            await asyncio.wait_for(self.observer.send_json(packet), SEND_TIMEOUT_S)
            return True
        except Exception:
            return False

    async def update_calibration(self, device: Device, local_pose: dict, start_offset: dict | None = None) -> None:
        pose = pose_from_packet(local_pose)
        self.tracker.reset()  # the world frame just moved; old tracks are meaningless
        if device == Device.PHONE:
            self.calibration.calibrate_phone(pose, transform_from_packet(start_offset))
            yaw = quaternion_to_yaw(pose.quaternion_xyzw)
            self.calibration.set_manual_phone(pose.position, yaw)
            self.phone_local_pose = pose
        else:
            self.calibration.calibrate_laptop(pose); self.laptop_local_pose = pose
        await self.broadcast({"type":"calibration", "ready":self.calibration.ready, "world":"laptop camera at calibration", "device":device.value})
        await self.broadcast(self.pose_packet())

    async def set_manual_pose(self, device: Device, position: list[float], yaw_rad: float) -> None:
        if device == Device.PHONE:
            self.calibration.set_manual_phone(position, yaw_rad)
            self.phone_local_pose = Pose(position, yaw_to_quaternion(yaw_rad))
        else:
            self.calibration.set_manual_laptop(position, yaw_rad)
            self.laptop_local_pose = Pose(position, yaw_to_quaternion(yaw_rad))
        await self.broadcast(self.pose_packet())

    async def update_pose(self, device: Device, local_pose: dict) -> None:
        pose = pose_from_packet(local_pose)
        if device == Device.PHONE:
            self.phone_local_pose = pose
            # Also sync manual phone position if phone streams explicit coordinates
            self.calibration.manual_phone_position = pose.position
            self.calibration.manual_phone_yaw = quaternion_to_yaw(pose.quaternion_xyzw)
        else:
            self.laptop_local_pose = pose
            self.calibration.manual_laptop_yaw = quaternion_to_yaw(pose.quaternion_xyzw)
        await self.broadcast(self.pose_packet())

    async def localize_target(self, packet: dict) -> None:
        target_phone = packet["positionPhone"]
        target_world, target_laptop = self.calibration.target_in_laptop(
            target_phone, self.phone_local_pose, self.laptop_local_pose
        )
        phone_transform = self.calibration.world_from_phone(self.phone_local_pose)
        laptop_transform = self.calibration.world_from_laptop(self.laptop_local_pose)
        laptop_inverse = laptop_transform.inverse()
        joints = []
        for joint in packet.get("jointsPhone", []):
            world = phone_transform.apply(joint["position"])
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
            "positionPhone": point_json(target_phone),
            "positionWorld": point_json(target_world),
            "positionLaptop": point_json(target_laptop),
            "phoneWorld": pose_json(phone_transform),
            "laptopWorld": pose_json(laptop_transform),
            "joints": joints,
            "confidence": packet.get("confidence", 1.0)
        })


    async def localize_people(self, packet: dict) -> None:
        """Batch of every person one observer frame saw → tracked ``targets`` broadcast."""
        phone_transform = self.calibration.world_from_phone(self.phone_local_pose)
        laptop_transform = self.calibration.world_from_laptop(self.laptop_local_pose)
        laptop_inverse = laptop_transform.inverse()

        people = packet.get("people", [])
        raw_world = [phone_transform.apply(person["positionPhone"]) for person in people]
        tracked = self.tracker.update(raw_world)

        targets = []
        for person, raw, (subject_id, smoothed) in zip(people, raw_world, tracked):
            # Shift the skeleton with the smoothed root so joints stay attached to it.
            offset = smoothed - raw
            joints = []
            for joint in person.get("jointsPhone", []):
                world = phone_transform.apply(joint["position"]) + offset
                joints.append({
                    "name": joint["name"],
                    "positionWorld": point_json(world),
                    "positionLaptop": point_json(laptop_inverse.apply(world)),
                    "confidence": joint.get("confidence", 1.0),
                })
            targets.append({
                "subjectId": subject_id,
                "positionPhone": point_json(person["positionPhone"]),
                "positionWorld": point_json(smoothed),
                "positionLaptop": point_json(laptop_inverse.apply(smoothed)),
                "joints": joints,
                "confidence": person.get("confidence", 1.0),
            })

        await self.broadcast({
            "type": "targets",
            "timestampNs": packet.get("timestampNs", time.time_ns()),
            "phoneWorld": pose_json(phone_transform),
            "laptopWorld": pose_json(laptop_transform),
            "targets": targets,
        })


hub = RelayHub()

@asynccontextmanager
async def lifespan(_: FastAPI):
    yield


app = FastAPI(title="Spatial Relay Hub", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.get("/health")
async def health() -> dict:
    return {"ok": True, "observerConnected": hub.observer_connected, "viewers": len(hub.viewers), "calibrated": hub.calibration.ready, "uptimeS": round(time.monotonic()-hub.started, 2)}

@app.get("/latest")
async def latest() -> dict:
    return hub.last_packet or {"type": "status", "message": "No skeleton received"}

@app.get("/camera/intrinsics")
async def camera_intrinsics() -> dict:
    intrinsics = load_intrinsics()
    return {"calibrated": intrinsics is not None, "intrinsics": intrinsics}

OBSERVER_HANDLERS = {
    "calibration": lambda p: hub.update_calibration(Device.PHONE, p["localPose"], p.get("worldFromPhoneAtStart")),
    "manual_pose": lambda p: hub.set_manual_pose(Device.PHONE, p["position"], _yaw_from_packet(p)),
    "pose": lambda p: hub.update_pose(Device.PHONE, p["localPose"]),
    "detection": lambda p: hub.localize_target(p),  # single target (legacy / tap-to-mark)
    "detections": lambda p: hub.localize_people(p),  # every person in one frame
    "skeleton": lambda p: hub.broadcast(p),
}


def _yaw_from_packet(packet: dict) -> float:
    if "yawRad" in packet:
        return float(packet["yawRad"])
    return math.radians(float(packet.get("yawDeg", 0.0)))


@app.websocket("/ws/observer")
async def observer(socket: WebSocket) -> None:
    await socket.accept()
    previous = hub.observer
    hub.observer = socket
    if previous is not None:
        # A reconnecting phone replaces its stale half-open socket.
        try: await previous.close()
        except Exception: pass
    log.info("observer connected from %s", socket.client)
    await hub.broadcast(hub.status_packet())
    try:
        while True:
            text = await socket.receive_text()
            try:
                packet = json.loads(text)
                handler = OBSERVER_HANDLERS.get(packet.get("type"))
                if handler is None:
                    await socket.send_json({"type": "error", "message": f"Unknown packet type {packet.get('type')!r}"})
                    continue
                await handler(packet)
            except (ValueError, KeyError, TypeError, IndexError) as exc:
                # One malformed packet must not drop the live stream.
                await socket.send_json({"type": "error", "message": f"Bad packet: {exc!r}"})
    except WebSocketDisconnect:
        pass
    finally:
        if hub.observer is socket:
            hub.observer = None
            log.info("observer disconnected")
            await hub.broadcast(hub.status_packet())


@app.websocket("/ws/viewer")
async def viewer(socket: WebSocket) -> None:
    await socket.accept(); hub.viewers.add(socket)
    # Send current state immediately
    await socket.send_json(hub.pose_packet())
    await socket.send_json(hub.status_packet())
    if hub.last_target:
        await socket.send_json(hub.last_target)
    if hub.last_targets:
        await socket.send_json(hub.last_targets)
    try:
        while True:
            try:
                packet = json.loads(await socket.receive_text())
                kind = packet.get("type")
                if kind == "calibration":
                    await hub.update_calibration(Device.LAPTOP, packet["localPose"])
                elif kind == "laptop_pose":
                    await hub.set_manual_pose(Device.LAPTOP, packet.get("position", [0.0, 0.0, 0.0]), _yaw_from_packet(packet))
                elif kind in ("set_phone_pose", "manual_pose"):
                    await hub.set_manual_pose(Device.PHONE, packet["position"], _yaw_from_packet(packet))
                elif kind == "pose":
                    await hub.update_pose(Device.LAPTOP, packet["localPose"])
                elif kind == "request_phone_calibration":
                    # Laptop console "Reset origin": ask the phone to zero itself so the
                    # next pose stream starts at (0,0,0) facing +Z.
                    if not await hub.send_to_observer({"type": "calibrate"}):
                        await hub.set_manual_pose(Device.PHONE, [0.0, 0.0, 0.0], 0.0)
            except (ValueError, KeyError, TypeError, IndexError) as exc:
                await socket.send_json({"type": "error", "message": f"Bad packet: {exc!r}"})
    except WebSocketDisconnect:
        pass
    finally:
        hub.viewers.discard(socket)


# Serve the laptop AR console from the same localhost/LAN origin as the hub.
WEB_ROOT = Path(__file__).resolve().parents[2] / "web"
app.mount("/", StaticFiles(directory=WEB_ROOT, html=True), name="web")
