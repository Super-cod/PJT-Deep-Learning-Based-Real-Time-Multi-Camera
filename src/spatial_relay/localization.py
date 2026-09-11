from __future__ import annotations

import numpy as np

from .models import CameraIntrinsics, Joint


def median_depth_m(depth_m: np.ndarray, u: float, v: float, radius: int = 2) -> float | None:
    """Robust local depth estimate; returns None when a patch has no valid depth."""
    h, w = depth_m.shape[:2]; x, y = int(round(u)), int(round(v))
    patch = depth_m[max(0,y-radius):min(h,y+radius+1), max(0,x-radius):min(w,x+radius+1)]
    valid = patch[np.isfinite(patch) & (patch > .1) & (patch < 12.0)]
    return float(np.median(valid)) if valid.size else None


def robust_depth_m(depth_m: np.ndarray, u: float, v: float, radius: int = 2) -> tuple[float | None, float | None]:
    """Return (median_depth, median_absolute_deviation) for local depth patch."""
    h, w = depth_m.shape[:2]; x, y = int(round(u)), int(round(v))
    patch = depth_m[max(0,y-radius):min(h,y+radius+1), max(0,x-radius):min(w,x+radius+1)]
    valid = patch[np.isfinite(patch) & (patch > .1) & (patch < 12.0)]
    if not valid.size:
        return None, None
    med = float(np.median(valid))
    mad = float(np.median(np.abs(valid - med)))
    return med, mad


def back_project(u: float, v: float, depth_m: float, k: CameraIntrinsics, distortion: Any = None) -> np.ndarray:
    return np.array([(u-k.cx)*depth_m/k.fx, (v-k.cy)*depth_m/k.fy, depth_m], dtype=float)


def localize_landmarks(
    landmarks: dict[str, tuple[float, float, float]],
    depth_m: np.ndarray,
    k: CameraIntrinsics,
    edge_margin: int = 0,
) -> list[Joint]:
    """Convert pixel landmarks {name: (u, v, confidence)} to observer camera metres."""
    joints: list[Joint] = []
    h, w = depth_m.shape[:2]
    for name, (u, v, confidence) in landmarks.items():
        if edge_margin > 0:
            if u < edge_margin or u >= (w - edge_margin) or v < edge_margin or v >= (h - edge_margin):
                continue
        depth = median_depth_m(depth_m, u, v)
        if depth is not None and confidence >= .3:
            joints.append(Joint(name, back_project(u, v, depth, k), confidence))
    return joints

