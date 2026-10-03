"""Demo / test driver for the 3D world view without any phones.

Uploads a synthetic two-room scan (shared wall with a doorway) and streams two
fake phones in shared-map mode. Phone A stands in room 1 and sees person_01
walking there; phone B stands in room 2 and sees person_02. Each person is
therefore "behind a wall" from the other phone.

    PYTHONPATH=src python3 -m xenon.simulate_world --hub http://localhost:8000
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import time
import urllib.request

import numpy as np

from .transforms import rotation_to_quaternion

JOINT_OFFSETS = {
    "nose": (0.0, 1.62, 0.08), "neck": (0.0, 1.47, 0.0), "root": (0.0, 0.95, 0.0),
    "left_eye": (0.035, 1.66, 0.06), "right_eye": (-0.035, 1.66, 0.06),
    "left_ear": (0.075, 1.63, -0.02), "right_ear": (-0.075, 1.63, -0.02),
    "left_shoulder": (0.2, 1.42, 0.0), "right_shoulder": (-0.2, 1.42, 0.0),
    "left_elbow": (0.28, 1.15, 0.0), "right_elbow": (-0.28, 1.15, 0.0),
    "left_wrist": (0.3, 0.9, 0.05), "right_wrist": (-0.3, 0.9, 0.05),
    "left_hip": (0.12, 0.95, 0.0), "right_hip": (-0.12, 0.95, 0.0),
    "left_knee": (0.13, 0.5, 0.02), "right_knee": (-0.13, 0.5, 0.02),
    "left_ankle": (0.13, 0.08, 0.0), "right_ankle": (-0.13, 0.08, 0.0),
}


def wall(cx: float, cz: float, length: float, yaw: float, height: float = 2.5, category: str = "wall") -> dict:
    """A RoomPlan-style surface: local X along the wall, centred at (cx, h/2, cz)."""
    c, s = math.cos(yaw), math.sin(yaw)
    m = np.array([
        [c, 0, s, cx],
        [0, 1, 0, height / 2 if category != "window" else 1.4],
        [-s, 0, c, cz],
        [0, 0, 0, 1],
    ], dtype=float)
    return {"category": category, "dimensions": [length, height, 0.0],
            "transform": m.T.ravel().tolist(), "polygon": [], "story": 0}


def synthetic_room() -> dict:
    """Two 4 m × 4 m rooms side by side along X, sharing the wall at x = 0."""
    walls = [
        wall(-2, -2, 4, 0), wall(2, -2, 4, 0),          # back walls (z = -2)
        wall(-2, 2, 4, 0), wall(2, 2, 4, 0),            # front walls (z = +2)
        wall(-4, 0, 4, math.pi / 2), wall(4, 0, 4, math.pi / 2),  # outer walls
        wall(0, -1.1, 1.8, math.pi / 2), wall(0, 1.1, 1.8, math.pi / 2),  # shared wall, gap = doorway
    ]
    floor = np.eye(4)
    floor[:3, :3] = [[1, 0, 0], [0, 0, 1], [0, -1, 0]]  # local XY plane → horizontal
    return {
        "version": 1, "rooms": 2,
        "walls": walls,
        "doors": [{**wall(0, 0, 0.4, math.pi / 2, 2.0, "door"), "isOpen": True}],
        "windows": [{**wall(-2, -2, 1.2, 0, 1.0, "window")}],
        "openings": [],
        "floors": [{"category": "floor", "dimensions": [8, 4, 0], "transform": floor.T.ravel().tolist(),
                    "polygon": [[-4, -2, 0], [4, -2, 0], [4, 2, 0], [-4, 2, 0]], "story": 0}],
        "objects": [
            {"category": "table", "dimensions": [1.2, 0.75, 0.7],
             "transform": np.array([[1, 0, 0, -2.5], [0, 1, 0, 0.375], [0, 0, 1, -1.2], [0, 0, 0, 1]]).T.ravel().tolist()},
            {"category": "sofa", "dimensions": [1.8, 0.8, 0.9],
             "transform": np.array([[1, 0, 0, 2.2], [0, 1, 0, 0.4], [0, 0, 1, 1.4], [0, 0, 0, 1]]).T.ravel().tolist()},
        ],
    }


def look_at_quaternion(eye: np.ndarray, target: np.ndarray) -> list[float]:
    """ARKit camera quaternion for a portrait-held phone at `eye` looking at `target`.

    ARKit's camera frame is the landscape sensor frame (looks down −Z, local +X
    points to the bottom of a portrait phone), so an upright view is rolled −90°.
    """
    f = target - eye
    f /= np.linalg.norm(f)
    z = -f
    x = np.cross([0.0, 1.0, 0.0], z)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    upright = np.column_stack([x, y, z])
    r = upright @ np.array([[0.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
    return rotation_to_quaternion(r).tolist()


def person_packet(x: float, z: float) -> dict:
    joints = [{"name": n, "position": [x + dx, dy, z + dz], "confidence": 0.9} for n, (dx, dy, dz) in JOINT_OFFSETS.items()]
    return {"positionWorld": [x, 0.95, z], "jointsWorld": joints, "confidence": 0.9}


def http_post(url: str, data: bytes, content_type: str) -> None:
    req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": content_type})
    with urllib.request.urlopen(req, timeout=10) as res:
        res.read()


async def phone(ws_base: str, name: str, eye: np.ndarray, walk, seconds: float) -> None:
    import websockets

    async with websockets.connect(f"{ws_base}/ws/observer?device={name}") as ws:
        await ws.send(json.dumps({"type": "hello", "name": name, "hasLidar": True}))
        start, seq = time.monotonic(), 0
        while time.monotonic() - start < seconds:
            t = time.monotonic() - start
            px, pz = walk(t)
            seq += 1
            await ws.send(json.dumps({
                "type": "pose", "frame": "map", "sequence": seq, "tracking": "normal",
                "localPose": {"position": eye.tolist(),
                              "quaternionXyzw": look_at_quaternion(eye, np.array([px, 1.2, pz])),
                              "timestampNs": time.time_ns()},
            }))
            await ws.send(json.dumps({"type": "detections", "frame": "map", "sequence": seq,
                                      "timestampNs": time.time_ns(), "people": [person_packet(px, pz)]}))
            # Drain acks and world pushes without blocking the send rate.
            deadline = time.monotonic() + 1 / 15
            while (remaining := deadline - time.monotonic()) > 0:
                try:
                    await asyncio.wait_for(ws.recv(), remaining)
                except asyncio.TimeoutError:
                    break


async def main(hub: str, seconds: float) -> None:
    http_post(f"{hub}/api/room", json.dumps(synthetic_room()).encode(), "application/json")
    ws_base = hub.replace("http", "ws", 1)
    await asyncio.gather(
        phone(ws_base, "Helmet-A", np.array([-3.5, 1.5, 1.5]),
              lambda t: (-2 + 0.8 * math.sin(t / 2), -0.5 + 0.6 * math.cos(t / 2)), seconds),
        phone(ws_base, "Helmet-B", np.array([3.5, 1.5, -1.5]),
              lambda t: (2 + 0.7 * math.cos(t / 3), 0.4 * math.sin(t / 3)), seconds),
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--hub", default="http://localhost:8000")
    parser.add_argument("--seconds", type=float, default=600)
    args = parser.parse_args()
    asyncio.run(main(args.hub.rstrip("/"), args.seconds))
