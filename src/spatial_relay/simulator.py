"""Controlled movement source for validating calibration -> phone -> target flow.

It starts co-located with the laptop, moves the phone through a two-metre
trajectory and observes a world-fixed target. The hub calculates all frame conversions.
"""
from __future__ import annotations

import asyncio, json, math, time
import websockets

TARGET_WORLD = (2.15, 0.0, -3.61)

def pose_at(t: float) -> tuple[list[float], list[float]]:
    """A phone that moves away after calibration and yaws as it moves."""
    x = min(2.0, max(0.0, t * .22))
    z = -0.35 * math.sin(t * .65)
    yaw = min(math.pi / 2, max(0.0, t * .17))
    return [x, 0.0, z], [0.0, math.sin(yaw/2), 0.0, math.cos(yaw/2)]

def target_in_phone(target: tuple[float, float, float], position: list[float], q: list[float]) -> list[float]:
    """inverse(T_world_phone) times P_world for the synthetic depth detector."""
    yaw = 2 * math.atan2(q[1], q[3]); dx, dy, dz = target[0]-position[0], target[1]-position[1], target[2]-position[2]
    return [math.cos(yaw)*dx - math.sin(yaw)*dz, dy, math.sin(yaw)*dx + math.cos(yaw)*dz]

async def run(url: str = "ws://127.0.0.1:8000/ws/observer") -> None:
    async with websockets.connect(url) as socket:
        start = time.monotonic(); sequence = 0
        # Phone's private AR-session pose at the exact co-location moment.
        await socket.send(json.dumps({"type":"calibration", "localPose":{"position":[0,0,0], "quaternionXyzw":[0,0,0,1]}})); await socket.recv()
        while True:
            elapsed = time.monotonic() - start; position, quaternion = pose_at(elapsed)
            local_pose = {"position":position, "quaternionXyzw":quaternion, "timestampNs":time.time_ns()}
            await socket.send(json.dumps({"type":"pose", "sequence":sequence, "localPose":local_pose})); await socket.recv()
            await socket.send(json.dumps({"type":"detection", "sequence":sequence, "subjectId":"person_01", "timestampNs":time.time_ns(), "positionPhone":target_in_phone(TARGET_WORLD, position, quaternion), "confidence":.94})); await socket.recv()
            sequence += 1; await asyncio.sleep(.04)

if __name__ == "__main__": asyncio.run(run())
