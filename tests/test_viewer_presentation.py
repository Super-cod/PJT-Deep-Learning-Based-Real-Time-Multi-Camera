"""Viewer presentation and hub snapshot correctness.

These cover bugs that made the laptop map lie about reality:

* the viewer drew a fake PHONE marker at a hardcoded `+1, +1` even when no
  phone had ever connected, so an empty system looked like a tracked phone;
* `calibrated` was assigned but never used, so an uncalibrated phone was drawn
  exactly like a calibrated one;
* a newly connected viewer replayed the hub's `last_packet`, which could be a
  stale `debug_pose` or a target from a previous session (a ghost person).
"""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import pytest

from spatial_relay.calibration import Device
from spatial_relay.server import RelayHub

VIEWER_JS = Path(__file__).resolve().parents[1] / "web" / "viewer.js"


def quat(yaw_deg: float = 0.0) -> list[float]:
    import math

    r = math.radians(yaw_deg)
    return [0.0, math.sin(r / 2), 0.0, math.cos(r / 2)]


def pose_packet(position: list[float], yaw_deg: float = 0.0) -> dict:
    return {"position": position, "quaternionXyzw": quat(yaw_deg), "timestampNs": 1}


@pytest.fixture(scope="module")
def viewer_js() -> str:
    return VIEWER_JS.read_text(encoding="utf-8")


class TestViewerDoesNotFakeAPhone:
    def test_phone_state_does_not_start_at_a_hardcoded_offset(self, viewer_js: str) -> None:
        m = re.search(r"const phoneState = \{([^}]*)\}", viewer_js)
        assert m, "phoneState declaration not found"
        body = m.group(1)
        assert "x: 1.0" not in body, "phone still starts at a fake x of 1.0"
        assert "z: 1.0" not in body, "phone still starts at a fake z of 1.0"

    def test_requires_a_live_packet_before_drawing_the_marker(self, viewer_js: str) -> None:
        assert "function phoneIsLive()" in viewer_js
        # The marker block must be guarded by liveness, not drawn unconditionally.
        assert re.search(r"if \(phoneIsLive\(\)\) \{", viewer_js), (
            "phone marker is not guarded by phoneIsLive()"
        )

    def test_draws_an_explicit_waiting_state_when_absent(self, viewer_js: str) -> None:
        assert "WAITING FOR PHONE" in viewer_js

    def test_detects_a_phone_that_vanished_without_a_socket_close(self, viewer_js: str) -> None:
        assert "PHONE_STALE_MS" in viewer_js
        assert "lastPhonePacketMs" in viewer_js

    def test_phone_is_marked_offline_when_packets_go_stale(self, viewer_js: str) -> None:
        assert "PHONE OFFLINE" in viewer_js


class TestViewerHonoursCalibrationState:
    def test_calibration_flag_is_actually_consumed(self, viewer_js: str) -> None:
        assert viewer_js.count("calibrated") > 5, (
            "calibrated is still effectively unused in viewer.js"
        )

    def test_uncalibrated_phone_is_labelled_on_the_map(self, viewer_js: str) -> None:
        assert "UNCALIBRATED" in viewer_js

    def test_reads_calibrated_from_incoming_packets(self, viewer_js: str) -> None:
        assert "typeof p.calibrated === 'boolean'" in viewer_js


class TestViewerSocketSnapshot:
    def test_onclose_resets_phone_liveness(self, viewer_js: str) -> None:
        # A closed socket must not leave a marker frozen on the map.
        onclose = re.search(r"socket\.onclose = \(\) => \{(.*?)\n  \};", viewer_js, re.S)
        assert onclose, "socket.onclose handler not found"
        assert "phoneSeen = false" in onclose.group(1)


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
        import inspect

        from spatial_relay import server as server_mod

        src = inspect.getsource(server_mod)
        assert 'hub.last_packet.get("type") == "target"' in src, (
            "viewer snapshot still replays debug_pose from last_packet"
        )


class TestViewerShowsPoseSourceAndTracking:
    """The viewer must say where the phone pose came from.

    ARKit gives metric poses and the legacy path only ever had step-count dead
    reckoning. Showing an identical marker for both hides which one is running,
    which is exactly the confusion that made the old numbers look wrong.
    """

    def test_handles_the_phone_status_snapshot(self, viewer_js: str) -> None:
        assert "p.type === 'phone_status'" in viewer_js, (
            "viewer ignores the hub's phone_status snapshot"
        )

    def test_displays_the_pose_source(self, viewer_js: str) -> None:
        assert "poseSourceLabel" in viewer_js
        assert "'ARKit'" in viewer_js and "'SENSORS'" in viewer_js

    def test_surfaces_degraded_arkit_tracking(self, viewer_js: str) -> None:
        assert "phoneTracking" in viewer_js
        assert "limitedReason" in viewer_js


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
