"""Observer flow matching what the Expo client actually sends.

The client sends ONE `calibration` packet when it connects (and on every
reconnect), then streams `pose` at 25 Hz. It must never send `manual_pose`
during that stream: `manual_pose` means "this is my absolute room position",
so sending it every tick pinned the hub into manual mode and PDR walking
stopped moving the phone on the laptop map.

These tests pin the calibrated transform end-to-end so that regression cannot
come back silently.
"""
from __future__ import annotations

import asyncio
import math

import pytest

from spatial_relay.calibration import Device
from spatial_relay.models import Pose
from spatial_relay.server import RelayHub


def quat(yaw_deg: float) -> list[float]:
    r = math.radians(yaw_deg)
    return [0.0, math.sin(r / 2), 0.0, math.cos(r / 2)]


def pose_packet(position: list[float], yaw_deg: float = 0.0) -> dict:
    return {"position": position, "quaternionXyzw": quat(yaw_deg), "timestampNs": 1}


def run(coro) -> None:
    asyncio.run(coro)


@pytest.fixture
def hub() -> RelayHub:
    h = RelayHub()
    sent: list[dict] = []

    async def capture(packet: dict) -> None:
        sent.append(packet)

    h.broadcast = capture  # type: ignore[method-assign]
    return h


class TestObserverConnectFlow:
    def test_hub_is_uncalibrated_before_the_phone_connects(self, hub: RelayHub) -> None:
        assert hub.calibration.ready is False

    def test_client_calibration_makes_hub_ready(self, hub: RelayHub) -> None:
        run(hub.update_calibration(Device.PHONE, pose_packet([0, 0, 0])))
        assert hub.calibration.ready is True


class TestPoseOnlyStreaming:
    """The regression that broke walking: pose packets must move the phone."""

    def test_forward_walk_reaches_world_z(self, hub: RelayHub) -> None:
        run(hub.update_calibration(Device.PHONE, pose_packet([0, 0, 0])))
        # Four 0.65 m strides forward.
        run(hub.update_pose(Device.PHONE, pose_packet([0.0, 0.0, 2.6])))
        assert hub.phone_world().matrix[2, 3] == pytest.approx(2.6)

    def test_turning_in_place_does_not_translate(self, hub: RelayHub) -> None:
        run(hub.update_calibration(Device.PHONE, pose_packet([0, 0, 0])))
        run(hub.update_pose(Device.PHONE, pose_packet([0.0, 0.0, 2.6])))
        run(hub.update_pose(Device.PHONE, pose_packet([0.0, 0.0, 2.6], yaw_deg=90.0)))
        wfp = hub.phone_world()
        assert wfp.matrix[0, 3] == pytest.approx(0.0, abs=1e-9)
        assert wfp.matrix[2, 3] == pytest.approx(2.6)

    def test_step_while_facing_east_moves_along_positive_x(self, hub: RelayHub) -> None:
        run(hub.update_calibration(Device.PHONE, pose_packet([0, 0, 0])))
        run(hub.update_pose(Device.PHONE, pose_packet([0.65, 0.0, 2.6], yaw_deg=90.0)))
        assert hub.phone_world().matrix[0, 3] == pytest.approx(0.65)

    def test_pose_stream_never_disables_calibration(self, hub: RelayHub) -> None:
        run(hub.update_calibration(Device.PHONE, pose_packet([0, 0, 0])))
        for i in range(10):
            run(hub.update_pose(Device.PHONE, pose_packet([0.0, 0.0, 0.65 * (i + 1)])))
        assert hub.calibration.ready is True
        assert hub.phone_world().matrix[2, 3] == pytest.approx(6.5)


class TestDetectionFollowsThePhone:
    def test_person_two_metres_ahead_of_east_facing_phone(self, hub: RelayHub) -> None:
        sent: list[dict] = []

        async def capture(packet: dict) -> None:
            sent.append(packet)

        hub.broadcast = capture  # type: ignore[method-assign]

        run(hub.update_calibration(Device.PHONE, pose_packet([0, 0, 0])))
        run(hub.update_pose(Device.PHONE, pose_packet([0.65, 0.0, 2.6], yaw_deg=90.0)))
        run(hub.localize_target({"positionPhone": [0.0, 0.0, 2.0]}))

        world = sent[-1]["positionWorld"]
        assert world[0] == pytest.approx(2.65)   # 0.65 + 2 m forward
        assert world[1] == pytest.approx(0.0)
        assert world[2] == pytest.approx(2.6)
        assert sent[-1]["calibrated"] is True

    def test_detection_reports_uncalibrated_rather_than_guessing(self, hub: RelayHub) -> None:
        sent: list[dict] = []

        async def capture(packet: dict) -> None:
            sent.append(packet)

        hub.broadcast = capture  # type: ignore[method-assign]
        run(hub.localize_target({"positionPhone": [0.0, 0.0, -2.0]}))
        assert sent[-1]["calibrated"] is False


class TestDpadDoesNotBreakCalibration:
    def test_manual_offset_stays_in_calibrated_mode(self, hub: RelayHub) -> None:
        run(hub.update_calibration(Device.PHONE, pose_packet([0, 0, 0])))
        # D-pad nudge sends `pose` with an offset local position.
        run(hub.update_pose(Device.PHONE, pose_packet([1.15, 0.0, 2.6], yaw_deg=90.0)))
        assert hub.calibration.ready is True
        assert hub.phone_world().matrix[0, 3] == pytest.approx(1.15)


class TestReconnectReCalibrates:
    def test_recalibrating_resets_the_walk_origin(self, hub: RelayHub) -> None:
        run(hub.update_calibration(Device.PHONE, pose_packet([0, 0, 0])))
        run(hub.update_pose(Device.PHONE, pose_packet([0.0, 0.0, 3.9])))
        assert hub.phone_world().matrix[2, 3] == pytest.approx(3.9)

        # App re-calibrates on reconnect: the phone is back at the origin.
        run(hub.update_calibration(Device.PHONE, pose_packet([0, 0, 0])))
        assert hub.phone_world().matrix[2, 3] == pytest.approx(0.0, abs=1e-9)
