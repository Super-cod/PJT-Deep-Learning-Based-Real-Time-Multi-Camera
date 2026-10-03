"""Shared-map world state: many phones, one coordinate frame, fused people.

In *map mode* every phone has relocalized into the same ARWorldMap (scanned
once with RoomPlan), so poses and joints arrive already in the world frame and
need no calibration. This module keeps the latest report from each device,
fuses people seen by several phones into one, assigns stable ids with
``PersonTracker`` and produces the ``world`` packet the 3D viewer renders.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np

from .skeleton import SkeletonFilter
from .tracking import PersonTracker

# Detections older than this are not fused (a phone stopped seeing someone).
PEOPLE_MAX_AGE_S = 0.4
# A device that sent nothing for this long is shown as offline.
DEVICE_OFFLINE_S = 3.0
# People from different phones closer than this on the floor are the same person.
FUSE_RADIUS_M = 0.5


@dataclass
class ReportedPerson:
    """One person as one phone saw it, in world coordinates."""
    root: np.ndarray
    joints: dict[str, tuple[np.ndarray, float]]
    confidence: float


@dataclass
class DeviceState:
    device_id: str
    name: str = ""
    has_lidar: bool = True
    position: np.ndarray = field(default_factory=lambda: np.zeros(3))
    quaternion_xyzw: np.ndarray = field(default_factory=lambda: np.array([0.0, 0.0, 0.0, 1.0]))
    tracking: str = "unknown"
    last_pose: float = 0.0
    people: list[ReportedPerson] = field(default_factory=list)
    last_people: float = 0.0
    connected: bool = False


@dataclass
class FusedPerson:
    root: np.ndarray
    joints: dict[str, tuple[np.ndarray, float]]
    confidence: float
    seen_by: list[str]


def _floor_distance(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.hypot(a[0] - b[0], a[2] - b[2]))


def fuse(reports: list[tuple[str, ReportedPerson]], radius_m: float = FUSE_RADIUS_M) -> list[FusedPerson]:
    """Merge detections of the same person from different devices.

    Greedy, most-confident first: a report joins the nearest cluster within
    ``radius_m`` that has no report from the same device yet (one phone never
    sees the same person twice in a frame); otherwise it starts a new cluster.
    Positions are confidence-weighted averages.
    """
    clusters: list[list[tuple[str, ReportedPerson]]] = []
    for device_id, person in sorted(reports, key=lambda r: -r[1].confidence):
        best, best_dist = None, radius_m
        for cluster in clusters:
            if any(d == device_id for d, _ in cluster):
                continue
            centre = sum(p.root * p.confidence for _, p in cluster) / sum(p.confidence for _, p in cluster)
            dist = _floor_distance(centre, person.root)
            if dist <= best_dist:
                best, best_dist = cluster, dist
        if best is None:
            clusters.append([(device_id, person)])
        else:
            best.append((device_id, person))

    fused: list[FusedPerson] = []
    for cluster in clusters:
        weights = np.array([max(p.confidence, 1e-3) for _, p in cluster])
        root = sum(w * p.root for w, (_, p) in zip(weights, cluster)) / weights.sum()
        joints: dict[str, tuple[np.ndarray, float]] = {}
        for name in {n for _, p in cluster for n in p.joints}:
            samples = [p.joints[name] for _, p in cluster if name in p.joints]
            w = np.array([max(c, 1e-3) for _, c in samples])
            pos = sum(wi * s[0] for wi, s in zip(w, samples)) / w.sum()
            joints[name] = (pos, float(max(c for _, c in samples)))
        fused.append(FusedPerson(
            root=root,
            joints=joints,
            confidence=float(max(p.confidence for _, p in cluster)),
            seen_by=sorted({d for d, _ in cluster}),
        ))
    return fused


def _vec(value) -> np.ndarray:
    return np.asarray(value, dtype=float).reshape(3)


def _round(v: np.ndarray) -> list[float]:
    return np.asarray(v, dtype=float).round(4).tolist()


class WorldState:
    def __init__(self) -> None:
        self.devices: dict[str, DeviceState] = {}
        self.tracker = PersonTracker()
        self.skeletons: dict[str, SkeletonFilter] = {}
        self.room_version = 0

    def device(self, device_id: str) -> DeviceState:
        if device_id not in self.devices:
            self.devices[device_id] = DeviceState(device_id=device_id, name=device_id)
        return self.devices[device_id]

    @property
    def active(self) -> bool:
        return bool(self.devices)

    def in_map_mode(self, device_id: str, now: float | None = None) -> bool:
        """True while the phone streams shared-map poses (it can use world packets)."""
        dev = self.devices.get(device_id)
        now = time.monotonic() if now is None else now
        return bool(dev and dev.connected and now - dev.last_pose <= DEVICE_OFFLINE_S)

    def set_connected(self, device_id: str, connected: bool) -> None:
        dev = self.device(device_id)
        dev.connected = connected
        if not connected:
            dev.people = []

    def update_hello(self, device_id: str, packet: dict) -> None:
        dev = self.device(device_id)
        dev.name = str(packet.get("name") or device_id)
        dev.has_lidar = bool(packet.get("hasLidar", True))

    def update_pose(self, device_id: str, packet: dict, now: float | None = None) -> None:
        pose = packet["localPose"]
        dev = self.device(device_id)
        dev.position = _vec(pose["position"])
        q = np.asarray(pose["quaternionXyzw"], dtype=float).reshape(4)
        norm = np.linalg.norm(q)
        if norm < 1e-9:
            raise ValueError("Quaternion cannot have zero length")
        dev.quaternion_xyzw = q / norm
        dev.tracking = str(packet.get("tracking", dev.tracking))
        dev.last_pose = time.monotonic() if now is None else now

    def update_people(self, device_id: str, packet: dict, now: float | None = None) -> None:
        people = []
        for person in packet.get("people", []):
            joints = {
                j["name"]: (_vec(j["position"]), float(j.get("confidence", 1.0)))
                for j in person.get("jointsWorld", person.get("jointsPhone", []))
            }
            root = _vec(person.get("positionWorld", person.get("positionPhone")))
            people.append(ReportedPerson(root=root, joints=joints, confidence=float(person.get("confidence", 1.0))))
        dev = self.device(device_id)
        dev.people = people
        dev.last_people = time.monotonic() if now is None else now

    def tick(self, now: float | None = None) -> dict:
        """Fuse current reports, update identities and build the ``world`` packet."""
        now = time.monotonic() if now is None else now
        reports = [
            (dev.device_id, person)
            for dev in self.devices.values()
            if now - dev.last_people <= PEOPLE_MAX_AGE_S
            for person in dev.people
        ]
        fused = fuse(reports)
        tracked = self.tracker.update([p.root for p in fused], now)

        people = []
        for person, (subject_id, smoothed) in zip(fused, tracked):
            offset = smoothed - person.root  # keep the skeleton attached to the smoothed root
            skeleton = self.skeletons.get(subject_id)
            if skeleton is None:
                skeleton = self.skeletons[subject_id] = SkeletonFilter()
            joints = skeleton.update(
                {name: (pos + offset, conf) for name, (pos, conf) in person.joints.items()}, smoothed, now)
            people.append({
                "id": subject_id,
                "position": _round(smoothed),
                "joints": [
                    {"name": name, "position": _round(pos), "confidence": round(conf, 3)}
                    for name, (pos, conf) in sorted(joints.items())
                ],
                "confidence": round(person.confidence, 3),
                "seenBy": person.seen_by,
            })

        # Forget skeletons of people that are gone (their ids are never reused).
        for subject_id in [k for k, sk in self.skeletons.items() if now - sk.last_update > 5.0]:
            del self.skeletons[subject_id]

        devices = [
            {
                "id": dev.device_id,
                "name": dev.name,
                "hasLidar": dev.has_lidar,
                "online": dev.connected and now - dev.last_pose <= DEVICE_OFFLINE_S,
                "position": _round(dev.position),
                "quaternionXyzw": np.asarray(dev.quaternion_xyzw).round(5).tolist(),
                "tracking": dev.tracking,
                "peopleSeen": len(dev.people) if now - dev.last_people <= PEOPLE_MAX_AGE_S else 0,
            }
            for dev in sorted(self.devices.values(), key=lambda d: d.device_id)
        ]
        return {"type": "world", "roomVersion": self.room_version, "devices": devices, "people": people}
