from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
import time

import numpy as np


@dataclass(frozen=True)
class CameraIntrinsics:
    """Pinhole intrinsics in pixels."""
    fx: float
    fy: float
    cx: float
    cy: float


@dataclass
class Pose:
    """Rigid pose in the canonical right-handed marker/world frame."""
    position: np.ndarray
    quaternion_xyzw: np.ndarray
    timestamp_ns: int = field(default_factory=time.time_ns)

    def __post_init__(self) -> None:
        self.position = np.asarray(self.position, dtype=float).reshape(3)
        q = np.asarray(self.quaternion_xyzw, dtype=float).reshape(4)
        norm = np.linalg.norm(q)
        if norm < 1e-9:
            raise ValueError("Quaternion cannot have zero length")
        self.quaternion_xyzw = q / norm


@dataclass
class Joint:
    name: str
    point_m: np.ndarray
    confidence: float

    def __post_init__(self) -> None:
        self.point_m = np.asarray(self.point_m, dtype=float).reshape(3)


@dataclass
class SkeletonPacket:
    """Transport object sent from the hub to the AR client."""
    subject_id: str
    timestamp_ns: int
    joints_world: list[Joint]
    observer_pose_world: Pose
    anchor_age_s: float
    sequence: int

    def as_json(self) -> dict[str, Any]:
        return {
            "type": "skeleton",
            "subjectId": self.subject_id,
            "timestampNs": self.timestamp_ns,
            "sequence": self.sequence,
            "anchorAgeS": round(self.anchor_age_s, 3),
            "observerPoseWorld": {
                "position": self.observer_pose_world.position.round(5).tolist(),
                "quaternionXyzw": self.observer_pose_world.quaternion_xyzw.round(6).tolist(),
            },
            "jointsWorld": [
                {"name": j.name, "position": j.point_m.round(5).tolist(), "confidence": round(j.confidence, 3)}
                for j in self.joints_world
            ],
        }
