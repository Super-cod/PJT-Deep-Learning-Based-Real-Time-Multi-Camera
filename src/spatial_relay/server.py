from __future__ import annotations

import time
from contextlib import asynccontextmanager
from .models import Pose
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .calibration import Device, SharedFrameCalibration
from .protocol import point_json, pose_from_packet, pose_json, transform_from_packet
from .transforms import Transform
from .camera_calibration import load_intrinsics


class RelayHub:
    def __init__(self) -> None:
        self.viewers: set[WebSocket] = set()
        self.last_packet: dict | None = None
        self.observer_connected = False
        self.started = time.monotonic()
        self.calibration = SharedFrameCalibration()
        # Default manual poses: laptop at origin facing +Z, phone at (1, 0, 1) facing +Z
        self.calibration.set_manual_laptop([0.0, 0.0, 0.0], 0.0)
        self.calibration.set_manual_phone([1.0, 0.0, 1.0], 0.0)
        self.phone_local_pose = Pose([1.0, 0.0, 1.0], [0.0, 0.0, 0.0, 1.0])
        self.laptop_local_pose = Pose([0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0])

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
            self.calibration.calibrate_phone(pose, transform_from_packet(start_offset))
            self.phone_local_pose = pose
        else:
            self.calibration.calibrate_laptop(pose); self.laptop_local_pose = pose
        await self.broadcast({"type":"calibration", "ready":self.calibration.ready, "world":"laptop camera at calibration", "device":device.value})

    async def set_manual_pose(self, device: Device, position: list[float], yaw_rad: float) -> None:
        if device == Device.PHONE:
            self.calibration.set_manual_phone(position, yaw_rad)
            from .transforms import yaw_to_quaternion
            self.phone_local_pose = Pose(position, yaw_to_quaternion(yaw_rad))
        else:
            self.calibration.set_manual_laptop(position, yaw_rad)
            from .transforms import yaw_to_quaternion
            self.laptop_local_pose = Pose(position, yaw_to_quaternion(yaw_rad))
        phone = self.calibration.world_from_phone(self.phone_local_pose)
        laptop = self.calibration.world_from_laptop(self.laptop_local_pose)
        await self.broadcast({"type":"debug_pose", "phoneWorld":pose_json(phone), "laptopWorld":pose_json(laptop), "calibrated":True})

    async def update_pose(self, device: Device, local_pose: dict) -> None:
        pose = pose_from_packet(local_pose)
        if device == Device.PHONE:
            self.phone_local_pose = pose
            # Also sync manual phone position if phone streams explicit coordinates
            self.calibration.manual_phone_position = pose.position
            from .transforms import quaternion_to_yaw
            self.calibration.manual_phone_yaw = quaternion_to_yaw(pose.quaternion_xyzw)
        else:
            self.laptop_local_pose = pose
            from .transforms import quaternion_to_yaw
            self.calibration.manual_laptop_yaw = quaternion_to_yaw(pose.quaternion_xyzw)
        phone = self.calibration.world_from_phone(self.phone_local_pose)
        laptop = self.calibration.world_from_laptop(self.laptop_local_pose)
        await self.broadcast({"type":"debug_pose", "phoneWorld":pose_json(phone), "laptopWorld":pose_json(laptop), "calibrated":True})

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

import math

@app.websocket("/ws/observer")
async def observer(socket: WebSocket) -> None:
    await socket.accept(); hub.observer_connected = True
    try:
        while True:
            packet = await socket.receive_json()
            kind = packet.get("type")
            if kind == "calibration":
                await hub.update_calibration(Device.PHONE, packet["localPose"], packet.get("worldFromPhoneAtStart"))
            elif kind == "manual_pose":
                yaw_rad = packet.get("yawRad", math.radians(packet.get("yawDeg", 0.0)))
                await hub.set_manual_pose(Device.PHONE, packet["position"], yaw_rad)
            elif kind == "pose":
                await hub.update_pose(Device.PHONE, packet["localPose"])
            elif kind == "detection":
                await hub.localize_target(packet)
            elif kind == "skeleton":
                await hub.broadcast(packet)
            else:
                await socket.send_json({"type": "error", "message": "Expected manual_pose, calibration, pose, detection or skeleton"})
                continue
            await socket.send_json({"type": "ack", "sequence": packet.get("sequence")})
    except WebSocketDisconnect:
        pass
    finally:
        hub.observer_connected = False

@app.websocket("/ws/viewer")
async def viewer(socket: WebSocket) -> None:
    await socket.accept(); hub.viewers.add(socket)
    # Send current pose state immediately
    phone = hub.calibration.world_from_phone(hub.phone_local_pose)
    laptop = hub.calibration.world_from_laptop(hub.laptop_local_pose)
    await socket.send_json({"type": "debug_pose", "phoneWorld": pose_json(phone), "laptopWorld": pose_json(laptop), "calibrated": True})
    if hub.last_packet:
        await socket.send_json(hub.last_packet)
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
