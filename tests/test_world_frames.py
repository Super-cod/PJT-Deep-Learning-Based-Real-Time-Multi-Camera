"""World-frame invariance tests matching the phone web page's math.

The phone page reports a yaw where a physical right turn produces page yaw
+90 and pose quaternion [0, -sin(yaw/2), 0, cos(yaw/2)], i.e. the model
rotates about +Y by -yaw. These tests pin the shared-frame math so a detected
person stays fixed in world space as the observer turns and moves.
"""
from __future__ import annotations

import math

import numpy as np

from spatial_relay.calibration import SharedFrameCalibration
from spatial_relay.models import Pose
from spatial_relay.transforms import Transform


def phone_yaw_quat(page_yaw_deg: float) -> np.ndarray:
    """Exactly mirrors web/phone.js posePacket(): -sin / cos about Y."""
    rad = math.radians(page_yaw_deg)
    return np.array([0.0, -math.sin(rad / 2), 0.0, math.cos(rad / 2)])


def apply_override(wfp: Transform, xz_world: tuple[float, float]) -> Transform:
    """Mirrors server.RelayHub._phone_world: replace world X/Z, keep world Y."""
    m = wfp.matrix.copy()
    m[0, 3] = xz_world[0]
    m[2, 3] = xz_world[1]
    return Transform(m)


def co_location_calibration() -> SharedFrameCalibration:
    cal = SharedFrameCalibration()
    cal.calibrate_laptop(Pose([0, 0, 0], [0, 0, 0, 1]))
    cal.calibrate_phone(Pose([0, 0, 0], [0, 0, 0, 1]))
    return cal


class TestPhoneWorldPlacement:
    def test_phone_right_turn_places_target_east(self) -> None:
        cal = co_location_calibration()
        # Phone turns RIGHT 90 deg and still sees the person 2 m ahead (-Z phone frame).
        phone_now = Pose([0, 0, 0], phone_yaw_quat(90.0))
        laptop_now = Pose([0, 0, 0], [0, 0, 0, 1])
        world, laptop = cal.target_in_laptop([0, 0, -2], phone_now, laptop_now)
        # A right turn means the person is now EAST (+X) of the laptop.
        np.testing.assert_allclose(world, [2.0, 0.0, 0.0], atol=1e-6)
        np.testing.assert_allclose(laptop, [2.0, 0.0, 0.0], atol=1e-6)

    def test_phone_left_turn_places_target_west(self) -> None:
        cal = co_location_calibration()
        phone_now = Pose([0, 0, 0], phone_yaw_quat(-90.0))
        laptop_now = Pose([0, 0, 0], [0, 0, 0, 1])
        world, _ = cal.target_in_laptop([0, 0, -2], phone_now, laptop_now)
        np.testing.assert_allclose(world, [-2.0, 0.0, 0.0], atol=1e-6)


class TestManualPhoneOverride:
    def test_override_moves_world_xz_and_keeps_world_y(self) -> None:
        cal = co_location_calibration()
        wfp = apply_override(cal.world_from_phone(Pose([0, 0.5, 0], [0, 0, 0, 1])), (1.0, -1.0))
        np.testing.assert_allclose(wfp.matrix[:3, 3], [1.0, 0.5, -1.0], atol=1e-9)

    def test_override_puts_rotated_phone_target_in_front_of_laptop(self) -> None:
        # User enters phone X=1, Z=1 ("forward"). The phone turns LEFT 90 deg and
        # the person is 1 m ahead of the phone. In laptop frame the person must
        # land dead-ahead of the laptop, 1 m away — the case the manual control
        # exists for. World Z flips the entered value: forward is -Z.
        cal = co_location_calibration()
        wfp = apply_override(cal.world_from_phone(Pose([0, 0, 0], phone_yaw_quat(-90.0))), (1.0, -1.0))
        world = wfp.apply(np.array([0.0, 0.0, -1.0]))
        laptop = cal.world_from_laptop(Pose([0, 0, 0], [0, 0, 0, 1])).inverse().apply(world)
        np.testing.assert_allclose(laptop, [0.0, 0.0, -1.0], atol=1e-6)
        assert laptop[2] < -0.08

    def test_override_forward_behind_laptop_is_not_viewable(self) -> None:
        # Entering Z=+1 (the old buggy behaviour = +Z in the hub world frame)
        # places the phone 1 m behind the laptop plane; the person lands behind
        # the laptop camera and the viewer never renders it (cvZ = -z < threshold).
        cal = co_location_calibration()
        wfp = apply_override(cal.world_from_phone(Pose([0, 0, 0], phone_yaw_quat(-90.0))), (1.0, 1.0))
        world = wfp.apply(np.array([0.0, 0.0, -1.0]))
        laptop = cal.world_from_laptop(Pose([0, 0, 0], [0, 0, 0, 1])).inverse().apply(world)
        assert laptop[2] > 0.0


class TestLaptopViewGating:
    def test_laptop_sees_north_target_when_facing_north(self) -> None:
        cal = co_location_calibration()
        world, laptop = cal.target_in_laptop([0, 0, -2], Pose([0, 0, 0], [0, 0, 0, 1]), Pose([0, 0, 0], [0, 0, 0, 1]))
        np.testing.assert_allclose(world, [0, 0, -2], atol=1e-6)
        np.testing.assert_allclose(laptop, [0, 0, -2], atol=1e-6)
        # Projectable: z = 2 m in front of the laptop camera.
        assert laptop[2] < -0.08

    def test_laptop_turn_left_puts_fixed_target_on_right(self) -> None:
        cal = co_location_calibration()
        # Laptop turns LEFT 90 deg (now faces West); the fixed North target
        # must appear on the laptop's RIGHT, not follow the camera.
        laptop_now = Pose([0, 0, 0], phone_yaw_quat(-90.0))
        world, laptop = cal.target_in_laptop([0, 0, -2], Pose([0, 0, 0], [0, 0, 0, 1]), laptop_now)
        np.testing.assert_allclose(world, [0, 0, -2], atol=1e-6)
        np.testing.assert_allclose(laptop, [2.0, 0.0, 0.0], atol=1e-6)

    def test_laptop_turn_right_hides_left_target(self) -> None:
        cal = co_location_calibration()
        # Laptop turns RIGHT 90 deg (faces East); the fixed target stays North,
        # which is now 90 deg to the LEFT: z ~ 0 in laptop frame -> not viewable.
        laptop_now = Pose([0, 0, 0], phone_yaw_quat(90.0))
        world, laptop = cal.target_in_laptop([0, 0, -2], Pose([0, 0, 0], [0, 0, 0, 1]), laptop_now)
        np.testing.assert_allclose(world, [0, 0, -2], atol=1e-6)
        # In laptop frame the point is broadside (z ~ 0), i.e. never rendered ahead.
        assert abs(laptop[2]) < 1e-4

    def test_world_point_fixed_as_laptop_translates(self) -> None:
        cal = co_location_calibration()
        # Laptop walks forward (North) 2 m; a target fixed 2 m North of the
        # origin lands exactly on the laptop -> laptop-frame point is the origin.
        laptop_now = Pose([0, 0, -2], [0, 0, 0, 1])
        world, laptop = cal.target_in_laptop([0, 0, -2], Pose([0, 0, 0], [0, 0, 0, 1]), laptop_now)
        np.testing.assert_allclose(world, [0, 0, -2], atol=1e-6)
        np.testing.assert_allclose(laptop, [0, 0, 0], atol=1e-6)