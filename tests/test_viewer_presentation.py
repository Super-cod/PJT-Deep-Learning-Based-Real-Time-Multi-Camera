"""Hub snapshot and phone-status correctness.

* a newly connected viewer must not replay the hub's `last_packet`, which could
  be a stale `debug_pose` or a target from a previous session (a ghost person);
* the hub must record the phone's pose source, tracking state and liveness.
"""
from __future__ import annotations

import asyncio

import pytest

from spatial_relay.calibration import Device
from spatial_relay.server import RelayHub

def quat(yaw_deg: float = 0.0) -> list[float]:
    import math

    r = math.radians(yaw_deg)
    return [0.0, math.sin(r / 2), 0.0, math.cos(r / 2)]


def pose_packet(position: list[float], yaw_deg: float = 0.0) -> dict:
    return {"position": position, "quaternionXyzw": quat(yaw_deg), "timestampNs": 1}


class FakeViewer:
    """Stands in for a connected viewer WebSocket without patching the hub."""

    def __init__(self) -> None:
        self.packets: list[dict] = []

    async def send_json(self, packet: dict) -> None:
        self.packets.append(packet)


class TestHubSnapshotReplaysOnlyRealDetections:
    """`last_packet` is written by every broadcast, including debug_pose."""

    def _hub_with_viewer(self) -> tuple[RelayHub, FakeViewer]:
        hub = RelayHub()
        viewer = FakeViewer()
        hub.viewers.add(viewer)  # type: ignore[arg-type]
        return hub, viewer

    def test_debug_pose_alone_must_not_be_replayed_to_new_viewers(self) -> None:
        import asyncio

        hub, _ = self._hub_with_viewer()
        asyncio.run(hub.broadcast_debug_pose())
        # Only real detections are kept for the new-viewer snapshot.
        assert hub.last_target is None and hub.last_targets is None

        asyncio.run(hub.broadcast({"type": "target", "subjectId": "target_01"}))
        assert hub.last_target is not None and hub.last_target["type"] == "target"


class TestHubReportsPhoneStatus:
    def _hub_with_viewer(self) -> tuple[RelayHub, FakeViewer]:
        hub = RelayHub()
        viewer = FakeViewer()
        hub.viewers.add(viewer)  # type: ignore[arg-type]
        return hub, viewer

    def test_pose_source_is_recorded_from_the_packet(self) -> None:
        hub, _ = self._hub_with_viewer()
        asyncio.run(hub.update_calibration(Device.PHONE, pose_packet([0, 0, 0])))
        asyncio.run(hub.update_pose(Device.PHONE, pose_packet([0.0, 0.0, 1.3]), "arkit"))
        assert hub.pose_source == "arkit"

    def test_pose_source_defaults_to_unknown(self) -> None:
        hub, _ = self._hub_with_viewer()
        assert hub.pose_source == "none"

    def test_tracking_status_is_stored(self) -> None:
        hub, _ = self._hub_with_viewer()
        asyncio.run(hub.update_tracking({
            "status": "limited", "limitedReason": "insufficientFeatures",
            "timestampMs": 1234,
        }))
        assert hub.tracking is not None
        assert hub.tracking["status"] == "limited"
        assert hub.tracking["limitedReason"] == "insufficientFeatures"

    def test_planes_and_anchors_are_stored(self) -> None:
        hub, _ = self._hub_with_viewer()
        asyncio.run(hub.update_planes({
            "timestampMs": 1,
            "planes": [{"identifier": "p1", "alignment": "horizontal"}],
        }))
        asyncio.run(hub.update_anchors({
            "timestampMs": 1,
            "anchors": [{"identifier": "a1", "name": "n", "kind": "k"}],
        }))
        assert len(hub.planes) == 1
        assert len(hub.anchors) == 1

    def test_health_reports_pose_liveness(self) -> None:
        from spatial_relay import server as server_mod

        # `health()` reads the module-level hub, so swap it rather than using a
        # locally constructed instance.
        original = server_mod.hub
        hub, _ = self._hub_with_viewer()
        server_mod.hub = hub
        try:
            asyncio.run(hub.update_calibration(Device.PHONE, pose_packet([0, 0, 0])))
            asyncio.run(hub.update_pose(Device.PHONE, pose_packet([0.0, 0.0, 1.3]), "arkit"))
            health = asyncio.run(server_mod.health())
        finally:
            server_mod.hub = original
        assert health["poseSource"] == "arkit"
        assert health["phonePoseLive"] is True
        assert health["poseAgeS"] is not None

    def test_health_without_poses_is_not_live(self) -> None:
        from spatial_relay import server as server_mod

        original = server_mod.hub
        hub, _ = self._hub_with_viewer()
        server_mod.hub = hub
        try:
            health = asyncio.run(server_mod.health())
        finally:
            server_mod.hub = original
        assert health["phonePoseLive"] is False
        assert health["poseAgeS"] is None
        assert health["poseSource"] == "none"

    def test_target_is_recorded_for_replay(self) -> None:
        hub, viewer = self._hub_with_viewer()
        asyncio.run(hub.update_calibration(Device.PHONE, pose_packet([0, 0, 0])))
        asyncio.run(hub.localize_target({"positionPhone": [0.0, 0.0, -2.0]}))
        assert hub.last_packet is not None
        assert hub.last_packet["type"] == "target"

    def test_pose_stream_records_a_debug_pose_not_a_target(self) -> None:
        hub, viewer = self._hub_with_viewer()
        asyncio.run(hub.update_calibration(Device.PHONE, pose_packet([0, 0, 0])))
        asyncio.run(hub.update_pose(Device.PHONE, pose_packet([0.0, 0.0, 1.3])))
        assert hub.last_packet is not None
        assert hub.last_packet["type"] == "debug_pose"

    def test_calibration_snapshot_reports_real_state(self) -> None:
        hub, viewer = self._hub_with_viewer()
        # Only a pose stream: still uncalibrated, and must report so.
        asyncio.run(hub.update_pose(Device.PHONE, pose_packet([0.0, 0.0, 1.3])))
        assert hub.last_packet is not None
        assert hub.last_packet["calibrated"] is False
