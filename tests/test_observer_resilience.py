"""A malformed packet from the phone must not drop its WebSocket.

Previously any exception in the observer handler escaped the `except
WebSocketDisconnect`, so a single bad frame killed the phone's connection and
the app then sat retrying against a hub that had given up on it.
"""
from __future__ import annotations

import asyncio
import json
import math
import subprocess
import sys

import pytest

from xenon.calibration import Device
from xenon.server import RelayHub

websockets = pytest.importorskip("websockets")


class FakeSocket:
    """Minimal async WebSocket stand-in that can be fed packets."""

    def __init__(self, packets, disconnect_after=False):
        self._packets = list(packets)
        self.sent: list[dict] = []
        self._disconnect_after = disconnect_after

    async def accept(self):
        pass

    async def receive_json(self):
        if not self._packets:
            if self._disconnect_after:
                from fastapi import WebSocketDisconnect

                raise WebSocketDisconnect()
            await asyncio.Event().wait()  # block forever, like an idle socket
        return self._packets.pop(0)

    async def send_json(self, packet):
        self.sent.append(packet)


def quat(yaw_deg: float = 0.0) -> list[float]:
    r = math.radians(yaw_deg)
    return [0.0, math.sin(r / 2), 0.0, math.cos(r / 2)]


def pose_packet(position, yaw_deg: float = 0.0) -> dict:
    return {"position": position, "quaternionXyzw": quat(yaw_deg), "timestampNs": 1}


def drive_observer(packets: list[dict]) -> FakeSocket:
    """Run the real observer handler over a scripted packet sequence."""
    from xenon import server as server_mod

    socket = FakeSocket(packets, disconnect_after=True)
    server_mod.hub = RelayHub()
    asyncio.run(asyncio.wait_for(server_mod.observer(socket), timeout=5))
    return socket


def test_bad_packet_is_reported_but_connection_survives() -> None:
    socket = drive_observer([
        {"type": "calibration", "localPose": pose_packet([0, 0, 0])},
        {"type": "pose"},                                     # missing localPose
        {"type": "pose", "localPose": pose_packet([0, 0, 2.6])},  # must still work
    ])
    kinds = [p.get("type") for p in socket.sent]
    assert "error" in kinds, "bad packet should produce an error reply"
    acks = [p for p in socket.sent if p.get("type") == "ack"]
    assert len(acks) == 2, f"expected 2 acks (loop must survive), got {len(acks)}"


def test_unknown_type_does_not_close_the_socket() -> None:
    socket = drive_observer([
        {"type": "nonsense"},
        {"type": "pose", "localPose": pose_packet([0.0, 0.0, 1.0])},
    ])
    acks = [p for p in socket.sent if p.get("type") == "ack"]
    assert len(acks) == 1, "socket should still accept work after an unknown type"


def test_disconnect_flag_is_cleared() -> None:
    from xenon import server as server_mod

    async def scenario():
        server_mod.hub = RelayHub()
        socket = FakeSocket([], disconnect_after=True)
        await server_mod.observer(socket)
        return server_mod.hub.observer_connected

    assert asyncio.run(scenario()) is False


# ── End-to-end over a real WebSocket ───────────────────────────────────────────

PORT = 8021


def _subprocess_env() -> dict:
    """Env for the spawned server.

    `pythonpath = ["src"]` in pyproject.toml only patches the pytest process's
    `sys.path`; a subprocess does not inherit that, so `xenon` would be
    unimportable and the server would silently fail to start.
    """
    import os
    import pathlib

    src = pathlib.Path(__file__).resolve().parents[1] / "src"
    env = dict(os.environ)
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = f"{src}{os.pathsep}{existing}" if existing else str(src)
    return env


def test_live_socket_rejects_a_bad_packet_without_dying() -> None:
    server = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "xenon.server:app",
         "--host", "127.0.0.1", "--port", str(PORT), "--log-level", "warning"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env=_subprocess_env(),
    )

    async def scenario():
        async with websockets.connect(f"ws://127.0.0.1:{PORT}/ws/observer") as ws:
            await ws.send(json.dumps({
                "type": "calibration", "sequence": 1,
                "localPose": pose_packet([0, 0, 0]),
            }))
            ack = json.loads(await asyncio.wait_for(ws.recv(), 5))
            assert ack["type"] == "ack", f"calibration rejected: {ack}"

            # Broken frame: no localPose at all.
            await ws.send(json.dumps({"type": "pose", "sequence": 2}))
            reply = json.loads(await asyncio.wait_for(ws.recv(), 5))
            assert reply["type"] == "error", f"expected error, got {reply}"

            # The connection must still work.
            await ws.send(json.dumps({
                "type": "pose", "sequence": 3,
                "localPose": pose_packet([0.0, 0.0, 2.6]),
            }))
            reply = json.loads(await asyncio.wait_for(ws.recv(), 5))
            assert reply["type"] == "ack", f"connection died after bad packet: {reply}"

    try:
        async def wait_until_up():
            for _ in range(50):
                try:
                    async with websockets.connect(f"ws://127.0.0.1:{PORT}/ws/observer"):
                        return True
                except Exception:
                    await asyncio.sleep(0.2)
            return False

        assert asyncio.run(wait_until_up()), "server did not start"
        asyncio.run(scenario())
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except Exception:
            server.kill()
