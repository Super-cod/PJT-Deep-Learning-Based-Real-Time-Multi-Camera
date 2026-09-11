"""Laptop-webcam checkerboard calibration and saved-intrinsics loading."""
from __future__ import annotations

import json
from pathlib import Path
import cv2
import numpy as np

from .models import CameraIntrinsics

DEFAULT_PATH = Path("data/laptop_camera.json")


def save_intrinsics(k: CameraIntrinsics, image_size: tuple[int, int], path: Path = DEFAULT_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"fx": k.fx, "fy": k.fy, "cx": k.cx, "cy": k.cy, "width": image_size[0], "height": image_size[1]}, indent=2))


def load_intrinsics(path: Path = DEFAULT_PATH) -> dict | None:
    if not path.exists(): return None
    return json.loads(path.read_text())


def calibrate_webcam(camera_index: int = 0, board: tuple[int, int] = (9, 6), required_frames: int = 20) -> None:
    """Interactive calibration. Press space to accept a detected board, q to quit."""
    cap = cv2.VideoCapture(camera_index)
    if not cap.isOpened(): raise RuntimeError("Cannot open laptop webcam")
    obj = np.zeros((board[0] * board[1], 3), np.float32); obj[:, :2] = np.mgrid[0:board[0], 0:board[1]].T.reshape(-1, 2)
    objects, images = [], []
    try:
        while len(images) < required_frames:
            ok, frame = cap.read()
            if not ok: continue
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            found, corners = cv2.findChessboardCorners(gray, board)
            shown = frame.copy()
            if found:
                corners = cv2.cornerSubPix(gray, corners, (11,11), (-1,-1), (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, .001))
                cv2.drawChessboardCorners(shown, board, corners, found)
            cv2.putText(shown, f"{len(images)}/{required_frames}: space capture, q quit", (12, 30), cv2.FONT_HERSHEY_SIMPLEX, .65, (0,255,0), 2)
            cv2.imshow("Spatial Relay camera calibration", shown)
            key = cv2.waitKey(1) & 0xff
            if key == ord("q"): return
            if key == ord(" ") and found: objects.append(obj); images.append(corners)
        rms, matrix, _, _, _ = cv2.calibrateCamera(objects, images, gray.shape[::-1], None, None)
        if rms > 1.0: raise RuntimeError(f"Calibration RMS error too high: {rms:.2f}px. Capture more varied views.")
        save_intrinsics(CameraIntrinsics(matrix[0,0], matrix[1,1], matrix[0,2], matrix[1,2]), gray.shape[::-1])
        print(f"Saved data/laptop_camera.json, RMS={rms:.3f}px")
    finally:
        cap.release(); cv2.destroyAllWindows()


if __name__ == "__main__": calibrate_webcam()
