from __future__ import annotations

import numpy as np

from .models import CameraIntrinsics, Joint


def median_depth_m(depth_m: np.ndarray, u: float, v: float, radius: int = 2) -> float | None:
    """Robust local depth estimate; returns None when a patch has no valid depth."""
    h, w = depth_m.shape[:2]; x, y = int(round(u)), int(round(v))
    patch = depth_m[max(0,y-radius):min(h,y+radius+1), max(0,x-radius):min(w,x+radius+1)]
    valid = patch[np.isfinite(patch) & (patch > .1) & (patch < 12.0)]
    return float(np.median(valid)) if valid.size else None


def back_project(u: float, v: float, depth_m: float, k: CameraIntrinsics) -> np.ndarray:
    return np.array([(u-k.cx)*depth_m/k.fx, (v-k.cy)*depth_m/k.fy, depth_m], dtype=float)


def localize_landmarks(landmarks: dict[str, tuple[float, float, float]], depth_m: np.ndarray, k: CameraIntrinsics) -> list[Joint]:
    """Convert pixel landmarks {name: (u, v, confidence)} to observer camera metres."""
    joints: list[Joint] = []
    for name, (u, v, confidence) in landmarks.items():
        depth = median_depth_m(depth_m, u, v)
        if depth is not None and confidence >= .3:
            joints.append(Joint(name, back_project(u, v, depth, k), confidence))
    return joints
