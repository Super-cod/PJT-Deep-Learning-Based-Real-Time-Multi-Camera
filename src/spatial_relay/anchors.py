from __future__ import annotations

import numpy as np

from .transforms import Transform


def marker_pose_world(corners_px: np.ndarray, marker_size_m: float, camera_matrix: np.ndarray, distortion: np.ndarray) -> Transform | None:
    """Estimate world(marker)-from-camera from a detected ArUco quadrilateral."""
    import cv2
    half = marker_size_m / 2
    object_points = np.array([[-half,half,0],[half,half,0],[half,-half,0],[-half,-half,0]], dtype=np.float32)
    ok, rvec, tvec = cv2.solvePnP(object_points, np.asarray(corners_px, dtype=np.float32), camera_matrix, distortion)
    if not ok: return None
    rotation, _ = cv2.Rodrigues(rvec)
    return Transform.from_rt(rotation, tvec.reshape(3))
