"""Calibration readiness and phone placement-mode transitions.

The hub must not claim it knows where the phone is before the phone reports
in, must let a `calibration` packet switch to the calibrated transform, and
must let a later `manual_pose` switch back to explicit room coordinates.
"""
from __future__ import annotations

import asyncio
import math

import numpy as np
import pytest

from spatial_relay.calibration import Device, SharedFrameCalibration
from spatial_relay.models import Pose
from spatial_relay.server import RelayHub
from spatial_relay.transforms import Transform


def phone_yaw_quat(yaw_deg: float) -> list[float]:
    rad = math.radians(yaw_deg)
    return [0.0, -math.sin(rad / 2), 0.0, math.cos(rad / 2)]


def pose_packet(position: list[float], yaw_deg: float = 0.0) -> dict:
    return {
        "position": position,
        "quaternionXyzw": phone_yaw_quat(yaw_deg),
        "timestampNs": 1,
    }


def run(coro) -> None:
    asyncio.run(coro)


class TestCalibrationReadiness:
    def test_fresh_calibration_is_not_ready(self) -> None:
        assert SharedFrameCalibration().ready is False

    def test_calibration_packet_makes_it_ready(self) -> None:
        cal = SharedFrameCalibration()
        cal.calibrate_phone(Pose([0, 0, 0], [0, 0, 0, 1]))
        assert cal.ready is True

    def test_manual_phone_position_makes_it_ready(self) -> None:
        cal = SharedFrameCalibration()
        cal.set_manual_phone([1.0, 0.0, 1.0], 0.0)
        assert cal.ready is True


class TestPhoneWorldModes:
    def test_uncalibrated_phone_raises(self) -> None:
        with pytest.raises(RuntimeError):
            SharedFrameCalibration().world_from_phone(Pose([0, 0, 0], [0, 0, 0, 1]))

    def test_manual_mode_ignores_phone_position(self) -> None:
        cal = SharedFrameCalibration()
        cal.set_manual_phone([1.0, 0.0, 1.0], 0.0)
        moved = Pose([5.0, 3.0, -7.0], [0, 0, 0, 1])
        np.testing.assert_allclose(cal.world_from_phone(moved).matrix[:3, 3], [1.0, 0.0, 1.0])

    def test_calibrated_mode_tracks_phone_delta(self) -> None:
        cal = SharedFrameCalibration()
        cal.calibrate_phone(Pose([0, 0, 0], [0, 0, 0, 1]))
        wfp = cal.world_from_phone(Pose([2.0, 0.0, 0.0], [0, 0, 0, 1]))
        np.testing.assert_allclose(wfp.matrix[:3, 3], [2.0, 0.0, 0.0], atol=1e-9)


class TestHubPhoneWorldFallback:
    def test_phone_world_is_identity_until_ready(self) -> None:
        hub = RelayHub()
        assert hub.calibration.ready is False
        np.testing.assert_allclose(hub.phone_world().matrix, np.eye(4), atol=1e-12)

    def test_initial_phone_pose_matches_client_origin(self) -> None:
        hub = RelayHub()
        np.testing.assert_allclose(hub.phone_local_pose.position, [0.0, 0.0, 0.0])


class TestHubModeTransitions:
    def test_calibration_packet_then_pose_uses_calibrated_path(self) -> None:
        hub = RelayHub()
        run(hub.update_calibration(Device.PHONE, pose_packet([0, 0, 0])))
        assert hub.calibration.ready is True
        # A later pose at a non-zero local position must actually move the phone.
        run(hub.update_pose(Device.PHONE, pose_packet([3.0, 0.0, 0.0])))
        np.testing.assert_allclose(hub.phone_world().matrix[:3, 3], [3.0, 0.0, 0.0], atol=1e-9)

    def test_calibration_does_not_leave_manual_position_behind(self) -> None:
        hub = RelayHub()
        run(hub.set_manual_pose(Device.PHONE, [1.0, 0.0, 1.0], 0.0))
        run(hub.update_calibration(Device.PHONE, pose_packet([0, 0, 0])))
        assert hub.calibration.manual_phone_position is None
        np.testing.assert_allclose(hub.phone_world().matrix[:3, 3], [0.0, 0.0, 0.0], atol=1e-9)

    def test_pose_packets_do_not_clobber_manual_placement(self) -> None:
        hub = RelayHub()
        run(hub.set_manual_pose(Device.PHONE, [1.0, 0.0, 1.0], 0.0))
        # The observer's own origin is [0,0,0]; a naive sync would teleport the phone.
        run(hub.update_pose(Device.PHONE, pose_packet([0.0, 0.0, 0.0])))
        np.testing.assert_allclose(hub.phone_world().matrix[:3, 3], [1.0, 0.0, 1.0], atol=1e-9)

    def test_manual_pose_overrides_previous_calibration(self) -> None:
        hub = RelayHub()
        run(hub.update_calibration(Device.PHONE, pose_packet([0, 0, 0])))
        run(hub.set_manual_pose(Device.PHONE, [2.0, 0.0, -1.0], 0.0))
        assert hub.calibration.phone_initial_local is None
        np.testing.assert_allclose(hub.phone_world().matrix[:3, 3], [2.0, 0.0, -1.0], atol=1e-9)

    def test_pose_still_rotates_a_manually_placed_phone(self) -> None:
        hub = RelayHub()
        run(hub.set_manual_pose(Device.PHONE, [1.0, 0.0, 1.0], 0.0))
        run(hub.update_pose(Device.PHONE, pose_packet([0.0, 0.0, 0.0], yaw_deg=90.0)))
        assert hub.calibration.manual_phone_yaw == pytest.approx(math.radians(-90.0))


class TestLocalizeTargetWhenUncalibrated:
    def test_detection_still_answers_before_calibration(self) -> None:
        hub = RelayHub()
        sent: list[dict] = []

        async def fake_send(packet: dict) -> None:
            sent.append(packet)

        hub.broadcast = fake_send  # type: ignore[method-assign]
        run(hub.localize_target({"positionPhone": [0.0, 0.0, -2.0]}))
        target = sent[-1]
        assert target["calibrated"] is False
        np.testing.assert_allclose(target["positionWorld"], [0.0, 0.0, -2.0], atol=1e-9)

    def test_calibrated_detection_reports_ready(self) -> None:
        hub = RelayHub()
        sent: list[dict] = []

        async def fake_send(packet: dict) -> None:
            sent.append(packet)

        hub.broadcast = fake_send  # type: ignore[method-assign]
        run(hub.update_calibration(Device.PHONE, pose_packet([0, 0, 0])))
        run(hub.localize_target({"positionPhone": [0.0, 0.0, -2.0]}))
        assert sent[-1]["calibrated"] is True


class TestLaptopStaysAtOrigin:
    def test_laptop_pose_updates_only_yaw_without_calibration(self) -> None:
        hub = RelayHub()
        run(hub.update_pose(Device.LAPTOP, pose_packet([0.0, 0.0, 0.0], yaw_deg=90.0)))
        wfl = hub.calibration.world_from_laptop(hub.laptop_local_pose)
        np.testing.assert_allclose(wfl.matrix[:3, 3], [0.0, 0.0, 0.0], atol=1e-12)
        assert isinstance(wfl, Transform)
