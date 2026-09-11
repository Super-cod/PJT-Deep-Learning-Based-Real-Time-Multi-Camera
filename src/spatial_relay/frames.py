"""Explicit camera-coordinate conversions at platform boundaries.

Canonical coordinates follow ARKit: right-handed, +X right, +Y up, camera
looks along -Z. OpenCV depth images use +X right, +Y down, +Z forward.
"""
from __future__ import annotations

import numpy as np

OPENCV_TO_CANONICAL = np.diag([1.0, -1.0, -1.0])


def opencv_point_to_canonical(point: np.ndarray) -> np.ndarray:
    return OPENCV_TO_CANONICAL @ np.asarray(point, dtype=float).reshape(3)


def canonical_point_to_opencv(point: np.ndarray) -> np.ndarray:
    # The axis swap is its own inverse.
    return OPENCV_TO_CANONICAL @ np.asarray(point, dtype=float).reshape(3)
