from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from contextlib import asynccontextmanager
from pathlib import Path

from .models import Pose
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .calibration import Device, SharedFrameCalibration
from .protocol import point_json, pose_from_packet, pose_json, transform_from_packet
from .transforms import Transform, quaternion_to_yaw, yaw_to_quaternion
from .camera_calibration import load_intrinsics
from .tracking import PersonTracker
from .room import RoomStore
from .world import WorldState

WORLD_TICK_HZ = 15

log = logging.getLogger("xenon")
SEND_TIMEOUT_S = 0.5
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


class RelayHub:
    def __init__(self) -> None:
        self.viewers: set[WebSocket] = set()
        self.last_packet: dict | None = None
        self.last_target: dict | None = None
        self.last_targets: dict | None = None
        self.tracker = PersonTracker()
        # One socket per phone, keyed by the `device` query parameter.
        self.observers: dict[str, WebSocket] = {}
        # Acks (observer task) and world pushes (world loop) share each phone
        # socket; a lock per socket keeps the two writers from interleaving.
        self._send_locks: dict[int, asyncio.Lock] = {}
        # Map mode: phones relocalized into the scanned ARWorldMap report in one
        # shared world frame; fused and tracked here, rendered by the 3D view.
        self.world = WorldState()
        self.rooms = RoomStore()
        self.world.room_version = self.rooms.version()
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
        await self.broadcast(self.pose_packet())

    @property
    def observer_connected(self) -> bool:
        return bool(self.observers)

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
        return {"type": "observer_status", "connected": self.observer_connected, "devices": sorted(self.observers)}

    def pose_packet(self) -> dict:
        laptop = self.calibration.world_from_laptop(self.laptop_local_pose)
        return {
            "type": "debug_pose",
            "phoneWorld": pose_json(self.phone_world()),
            "laptopWorld": pose_json(laptop),
            "calibrated": self.calibration.ready,
        }

    async def send_locked(self, socket: WebSocket, packet: dict) -> None:
        lock = self._send_locks.setdefault(id(socket), asyncio.Lock())
        async with lock:
            await asyncio.wait_for(socket.send_json(packet), SEND_TIMEOUT_S)

    def forget_socket(self, socket: WebSocket) -> None:
        self._send_locks.pop(id(socket), None)

    async def push_world_to_phones(self, packet: dict) -> None:
        """Give every shared-map phone the fused world, so each helmet can draw
        the people the *other* phones see (x-ray through walls)."""
        targets = [
            (device_id, socket) for device_id, socket in list(self.observers.items())
            if self.world.in_map_mode(device_id)
        ]
        if targets:
            await asyncio.gather(*(self._push(socket, packet) for _, socket in targets))

    async def _push(self, socket: WebSocket, packet: dict) -> None:
        try:
            await self.send_locked(socket, packet)
        except Exception:
            pass  # a slow phone just misses one frame

    async def send_to_observer(self, packet: dict, device_id: str | None = None) -> bool:
        """Send to one phone, or to every connected phone; True if any received it."""
        targets = [self.observers[device_id]] if device_id in self.observers else (
            [] if device_id else list(self.observers.values()))
        delivered = False
        for socket in targets:
            try:
                await self.send_locked(socket, packet)
                delivered = True
            except Exception:
                pass
        return delivered

    async def update_calibration(self, device: Device, local_pose: dict, start_offset: dict | None = None) -> None:
        pose = pose_from_packet(local_pose)
        self.tracker.reset()  # the world frame just moved; old tracks are meaningless
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

    async def localize_people(self, packet: dict) -> None:
        """Batch of every person one observer frame saw → tracked ``targets`` broadcast."""
        phone_transform = self.phone_world()
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
            "calibrated": self.calibration.ready,
        })


hub = RelayHub()


async def world_loop() -> None:
    """Fuse every phone's latest people at a fixed rate and push the world to viewers.

    Running on a clock (not per packet) means phone A's frame can never erase
    the people phone B is reporting.
    """
    while True:
        await asyncio.sleep(1 / WORLD_TICK_HZ)
        try:
            if hub.world.active:
                packet = hub.world.tick()
                if hub.viewers:
                    await hub.broadcast(packet)
                await hub.push_world_to_phones(packet)
        except Exception as exc:  # never let one bad tick stop the loop
            log.warning("world tick failed: %s", exc)


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(world_loop())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title="Xenon Hub", version="0.1.0", lifespan=lifespan)
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
        "devices": sorted(hub.observers),
        "roomVersion": hub.world.room_version,
        "hasWorldMap": hub.rooms.has_worldmap(),
    }


# ── Room model + shared world map (uploaded by the scanning phone) ──────────────

@app.get("/api/room")
async def get_room() -> dict:
    room = hub.rooms.load_room()
    if room is None:
        raise HTTPException(404, "No room scanned yet")
    return {"version": hub.world.room_version, "room": room}


@app.post("/api/room")
async def post_room(request: Request) -> dict:
    try:
        room = hub.rooms.save_room(await request.body())
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    hub.world.room_version = hub.rooms.version()
    log.info("room model saved: %d walls", len(room.get("walls", [])))
    return {"ok": True, "version": hub.world.room_version}


@app.get("/api/worldmap")
async def get_worldmap() -> FileResponse:
    if not hub.rooms.has_worldmap():
        raise HTTPException(404, "No world map uploaded yet")
    return FileResponse(hub.rooms.worldmap_path, media_type="application/octet-stream")


@app.post("/api/worldmap")
async def post_worldmap(request: Request) -> dict:
    try:
        size = hub.rooms.save_worldmap(await request.body())
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    log.info("world map saved: %.1f MB", size / 1e6)
    return {"ok": True, "bytes": size}

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
    "pose": lambda p: hub.update_pose(Device.PHONE, p["localPose"], p.get("source")),
    "detection": lambda p: hub.localize_target(p),  # single target (legacy / tap-to-mark)
    "detections": lambda p: hub.localize_people(p),  # every person in one frame
    "tracking": lambda p: hub.update_tracking(p),
    "arkit_planes": lambda p: hub.update_planes(p),
    "arkit_anchors": lambda p: hub.update_anchors(p),
    "skeleton": lambda p: hub.broadcast(p),
}


async def _handle_map_packet(device_id: str, packet: dict) -> bool:
    """Route shared-map packets to the world state; False if not a map packet."""
    kind = packet.get("type")
    if kind == "hello":
        hub.world.update_hello(device_id, packet)
        return True
    if packet.get("frame") != "map":
        return False
    if kind == "pose":
        hub.world.update_pose(device_id, packet)
        return True
    if kind == "detections":
        hub.world.update_people(device_id, packet)
        return True
    return False


def _yaw_from_packet(packet: dict) -> float:
    if "yawRad" in packet:
        return float(packet["yawRad"])
    return math.radians(float(packet.get("yawDeg", 0.0)))


@app.websocket("/ws/observer")
async def observer(socket: WebSocket) -> None:
    await socket.accept()
    query = getattr(socket, "query_params", None) or {}
    device_id = str(query.get("device") or "phone")[:40]
    previous = hub.observers.get(device_id)
    hub.observers[device_id] = socket
    if previous is not None:
        # A reconnecting phone replaces its own stale half-open socket.
        try:
            await previous.close()
        except Exception:
            pass
    hub.world.set_connected(device_id, True)
    log.info("phone observer %r connected", device_id)
    await hub.broadcast(hub.status_packet())
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
                if await _handle_map_packet(device_id, packet):
                    await hub.send_locked(socket, {"type": "ack", "sequence": packet.get("sequence")})
                    continue
                handler = OBSERVER_HANDLERS.get(kind)
                if handler is None:
                    log.warning("phone sent unknown packet type %r", kind)
                    await hub.send_locked(socket, {"type": "error", "message": f"Expected one of {', '.join(OBSERVER_HANDLERS)}"})
                    continue
                await handler(packet)
            except Exception as exc:
                # A single bad packet must not drop the phone's connection.
                log.warning("phone packet %r rejected: %s", packet.get("type"), exc)
                try:
                    await hub.send_locked(socket, {"type": "error", "message": str(exc)})
                except Exception:
                    pass
                continue
            await hub.send_locked(socket, {"type": "ack", "sequence": packet.get("sequence")})
    except WebSocketDisconnect:
        pass
    finally:
        hub.forget_socket(socket)
        if hub.observers.get(device_id) is socket:
            del hub.observers[device_id]
            hub.world.set_connected(device_id, False)
            log.info("phone observer %r disconnected", device_id)
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
            try:
                packet = await socket.receive_json()
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
                    # Laptop console "Reset origin": ask the phone(s) to zero themselves so
                    # the next pose stream starts at (0,0,0) facing +Z.
                    if not await hub.send_to_observer({"type": "calibrate"}, packet.get("device")):
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
