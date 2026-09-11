from __future__ import annotations

import time
import numpy as np

from .models import Pose
from .transforms import Transform


def pose_from_packet(value: dict) -> Pose:
    return Pose(value["position"], value["quaternionXyzw"], int(value.get("timestampNs", time.time_ns())))


def transform_from_packet(value: dict | None) -> Transform | None:
    if value is None: return None
    return Transform.from_pose(pose_from_packet(value))


def pose_json(transform: Transform) -> dict:
    pose = transform.pose()
    return {"position": pose.position.round(5).tolist(), "quaternionXyzw": pose.quaternion_xyzw.round(6).tolist()}


def point_json(point: np.ndarray) -> list[float]:
    return np.asarray(point, dtype=float).round(5).tolist()
