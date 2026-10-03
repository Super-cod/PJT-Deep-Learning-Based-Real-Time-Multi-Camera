"""The hub must understand the packets the ARKit phone actually sends.

The phone stopped sending step-count `manual_pose` packets once ARKit took over.
It now sends `pose` with a `source`, a `tracking` heartbeat, and
`arkit_planes`/`arkit_anchors` discovery packets. If the hub rejects any of
those as unknown, the phone gets an error reply every second and the marker on
the laptop map freezes.
"""
from __future__ import annotations

import asyncio
import json
import math

import pytest

from spatial_relay.calibration import Device
from spatial_relay.server import RelayHub

websockets = pytest.importorskip("websockets")


def quat(yaw_deg: float = 0.0) -> list[float]:
    r = math.radians(yaw_deg)
    return [0.0, math.sin(r / 2), 0.0, math.cos(r / 2)]


def pose_packet(position: list[float], yaw_deg: float = 0.0) -> dict:
    return {"position": position, "quaternionXyzw": quat(yaw_deg), "timestampNs": 1}


class FakeSocket:
    def __init__(self, packets, disconnect_after: bool = True):
        self._packets = list(packets)
        self.sent: list[dict] = []
        self._disconnect_after = disconnect_after

    async def accept(self) -> None:
        pass

    async def receive_json(self) -> dict:
        if not self._packets:
            if self._disconnect_after:
                from fastapi import WebSocketDisconnect

                raise WebSocketDisconnect()
            await asyncio.Event().wait()
        return self._packets.pop(0)

    async def send_json(self, packet: dict) -> None:
        self.sent.append(packet)


def drive(packets: list[dict]) -> FakeSocket:
    from spatial_relay import server as server_mod

    socket = FakeSocket(packets)
    server_mod.hub = RelayHub()
    asyncio.run(asyncio.wait_for(server_mod.observer(socket), timeout=5))
    return socket


class TestArkitPacketsAreAccepted:
    def test_pose_with_arkit_source_is_accepted(self) -> None:
        socket = drive([
            {"type": "calibration", "localPose": pose_packet([0, 0, 0])},
            {
                "type": "pose", "sequence": 1,
                "localPose": pose_packet([1.0, 0.0, 0.0]),
                "source": "arkit", "trackingStatus": "normal",
                "limitedReason": None,
            },
        ])
        assert "error" not in [p.get("type") for p in socket.sent]

    def test_tracking_packet_is_accepted(self) -> None:
        socket = drive([
            {
                "type": "tracking", "status": "limited",
                "limitedReason": "insufficientFeatures", "timestampMs": 1,
            },
        ])
        assert "error" not in [p.get("type") for p in socket.sent]

    def test_planes_packet_is_accepted(self) -> None:
        socket = drive([{
            "type": "arkit_planes", "timestampMs": 1,
            "planes": [{
                "identifier": "p", "alignment": "horizontal", "classification": 0,
                "center": [1.0, 0.0, 2.0], "extentWidth": 3.0, "extentHeight": 2.0,
            }],
        }])
        assert "error" not in [p.get("type") for p in socket.sent]

    def test_anchors_packet_is_accepted(self) -> None:
        socket = drive([{
            "type": "arkit_anchors", "timestampMs": 1,
            "anchors": [{
                "identifier": "a", "name": "origin", "kind": "ARAnchor",
                "position": [0.0, 0.0, 0.0],
            }],
        }])
        assert "error" not in [p.get("type") for p in socket.sent]

    def test_arkit_world_detection_is_accepted(self) -> None:
        socket = drive([
            {"type": "calibration", "localPose": pose_packet([100.0, 0.0, -9.0])},
            {
                "type": "detection", "sequence": 1, "subjectId": "person_01",
                "timestampNs": 1, "frame": "arkitWorld",
                "positionPhone": [100.0, 1.0, -9.0],
                "jointsPhone": [{"name": "head", "position": [100.0, 1.7, -9.0],
                                 "confidence": 1.0}],
                "confidence": 1.0,
            },
        ])
        assert "error" not in [p.get("type") for p in socket.sent]

    def test_unknown_packet_still_reports_an_error(self) -> None:
        socket = drive([{"type": "definitely_not_a_packet"}])
        assert "error" in [p.get("type") for p in socket.sent]


class TestWorldFrameRouting:
    """`frame` selects the transform, and picking the wrong one is silent."""

    def test_arkit_world_frame_uses_the_constant_calibration_anchor(self) -> None:
        hub = RelayHub()
        asyncio.run(hub.update_calibration(Device.PHONE, pose_packet([100.0, 0.0, -9.0])))

        # The phone then walks 2 m along +X in the ARKit world.
        asyncio.run(hub.update_pose(
            Device.PHONE, pose_packet([102.0, 0.0, -9.0]), "arkit"
        ))
        asyncio.run(hub.localize_target({
            "frame": "arkitWorld",
            "positionPhone": [102.0, 1.0, -9.0],
            "jointsPhone": [],
        }))

        target = hub.last_packet
        assert target is not None
        # Calibration mapped ARKit (100,0,-9) to the world origin, so the joint
        # at ARKit (102,1,-9) must be at world (2,1,0).
        assert target["positionWorld"] == [2.0, 1.0, 0.0]

    def test_phone_local_frame_uses_the_live_device_pose(self) -> None:
        hub = RelayHub()
        asyncio.run(hub.update_calibration(Device.PHONE, pose_packet([0.0, 0.0, 0.0])))
        asyncio.run(hub.update_pose(
            Device.PHONE, pose_packet([1.0, 0.0, 0.0]), "arkit"
        ))
        asyncio.run(hub.localize_target({
            "frame": "phone",
            "positionPhone": [0.0, 0.0, 2.0],
            "jointsPhone": [],
        }))

        target = hub.last_packet
        assert target is not None
        # The phone moved to x=1 and the point is 2 m ahead of it.
        assert target["positionWorld"] == [1.0, 0.0, 2.0]

    def test_the_two_frames_disagree_when_the_phone_moves(self) -> None:
        """Documents why the distinction matters rather than being cosmetic."""
        hub = RelayHub()
        asyncio.run(hub.update_calibration(Device.PHONE, pose_packet([0.0, 0.0, 0.0])))
        asyncio.run(hub.update_pose(
            Device.PHONE, pose_packet([5.0, 0.0, 0.0]), "arkit"
        ))

        asyncio.run(hub.localize_target({
            "frame": "arkitWorld", "positionPhone": [1.0, 0.0, 0.0],
            "jointsPhone": [],
        }))
        world_frame = hub.last_packet["positionWorld"]

        asyncio.run(hub.localize_target({
            "frame": "phone", "positionPhone": [1.0, 0.0, 0.0],
            "jointsPhone": [],
        }))
        local_frame = hub.last_packet["positionWorld"]

        assert world_frame != local_frame

    def test_target_packet_reports_the_frame_it_used(self) -> None:
        hub = RelayHub()
        asyncio.run(hub.update_calibration(Device.PHONE, pose_packet([0.0, 0.0, 0.0])))
        asyncio.run(hub.localize_target({
            "frame": "arkitWorld", "positionPhone": [0.0, 0.0, 0.0],
            "jointsPhone": [],
        }))
        assert hub.last_packet["frame"] == "arkitWorld"

    def test_frame_defaults_to_phone_for_backwards_compatibility(self) -> None:
        hub = RelayHub()
        asyncio.run(hub.update_calibration(Device.PHONE, pose_packet([0.0, 0.0, 0.0])))
        asyncio.run(hub.localize_target({
            "positionPhone": [0.0, 0.0, 1.0], "jointsPhone": [],
        }))
        assert hub.last_packet["frame"] == "phone"


class TestViewerConnectSnapshot:
    class Viewer:
        """Fake viewer socket that disconnects after the connect snapshot."""

        def __init__(self) -> None:
            self.packets: list[dict] = []

        async def accept(self) -> None:
            pass

        async def receive_json(self) -> dict:
            from fastapi import WebSocketDisconnect

            raise WebSocketDisconnect()

        async def send_json(self, packet: dict) -> None:
            self.packets.append(packet)

    def test_new_viewer_is_told_the_pose_source_and_tracking(self) -> None:
        from spatial_relay import server as server_mod

        original = server_mod.hub
        hub = RelayHub()
        server_mod.hub = hub
        asyncio.run(hub.update_calibration(Device.PHONE, pose_packet([0.0, 0.0, 0.0])))
        asyncio.run(hub.update_pose(Device.PHONE, pose_packet([1.0, 0.0, 0.0]), "arkit"))
        asyncio.run(hub.update_tracking({
            "status": "normal", "limitedReason": None, "timestampMs": 1,
        }))

        viewer = self.Viewer()
        try:
            asyncio.run(asyncio.wait_for(server_mod.viewer(viewer), timeout=2))
        finally:
            server_mod.hub = original

        snapshot = [p for p in viewer.packets if p.get("type") == "phone_status"]
        assert snapshot, "viewer did not receive a phone_status snapshot"
        assert snapshot[0]["poseSource"] == "arkit"
        assert snapshot[0]["calibrated"] is True
        assert snapshot[0]["tracking"]["status"] == "normal"