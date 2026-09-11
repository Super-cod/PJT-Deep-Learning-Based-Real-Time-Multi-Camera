import math
import numpy as np
import pytest

from spatial_relay.calibration import SharedFrameCalibration
from spatial_relay.models import Pose
from spatial_relay.transforms import (
    local_to_world,
    world_to_local,
    rotation_matrix_from_yaw,
    yaw_to_quaternion,
    quaternion_to_yaw,
    Transform,
)


class TestManualCoordinateTransform:
    def test_phone_facing_z_plus(self) -> None:
        """Phone at (1, 1) facing +Z. Target 1 unit in front.
        World position must have larger Z: (1, 0, 2).
        """
        phone_pos = np.array([1.0, 0.0, 1.0])
        yaw_rad = 0.0  # facing +Z
        local_target = np.array([0.0, 0.0, 1.0])  # 1 unit in front
        world_target = local_to_world(phone_pos, yaw_rad, local_target)
        np.testing.assert_allclose(world_target, [1.0, 0.0, 2.0], atol=1e-6)

    def test_phone_facing_x_plus(self) -> None:
        """Phone at (1, 1) rotating to face +X (+90 deg). Target 1 unit in front.
        World position must have larger X: (2, 0, 1).
        """
        phone_pos = np.array([1.0, 0.0, 1.0])
        yaw_rad = math.pi / 2.0  # +90 deg, facing +X
        local_target = np.array([0.0, 0.0, 1.0])
        world_target = local_to_world(phone_pos, yaw_rad, local_target)
        np.testing.assert_allclose(world_target, [2.0, 0.0, 1.0], atol=1e-6)

    def test_phone_facing_z_minus(self) -> None:
        """Phone at (1, 1) facing -Z (180 deg). Target 1 unit in front.
        World position must have smaller Z: (1, 0, 0).
        """
        phone_pos = np.array([1.0, 0.0, 1.0])
        yaw_rad = math.pi
        local_target = np.array([0.0, 0.0, 1.0])
        world_target = local_to_world(phone_pos, yaw_rad, local_target)
        np.testing.assert_allclose(world_target, [1.0, 0.0, 0.0], atol=1e-6)

    def test_phone_facing_x_minus(self) -> None:
        """Phone at (1, 1) facing -X (-90 deg). Target 1 unit in front.
        World position must have smaller X: (0, 0, 1).
        """
        phone_pos = np.array([1.0, 0.0, 1.0])
        yaw_rad = -math.pi / 2.0
        local_target = np.array([0.0, 0.0, 1.0])
        world_target = local_to_world(phone_pos, yaw_rad, local_target)
        np.testing.assert_allclose(world_target, [0.0, 0.0, 1.0], atol=1e-6)

    def test_local_world_round_trip(self) -> None:
        phone_pos = np.array([1.5, 0.0, 2.3])
        yaw_rad = math.radians(37.5)
        local_target = np.array([0.4, -0.2, 2.8])
        world = local_to_world(phone_pos, yaw_rad, local_target)
        local_recovered = world_to_local(phone_pos, yaw_rad, world)
        np.testing.assert_allclose(local_recovered, local_target, atol=1e-6)


class TestUserScenarios:
    def test_scenario_1_phone_behind_laptop_is_behind_observer(self) -> None:
        """User Test 1:
        Laptop is at (0, 0, 0) facing +Z.
        Phone is moved behind the laptop screen/observer camera, e.g. at (0, 0, -2).
        Phone detects a person 1m in front of phone (facing +Z).
        Target world position is (0, 0, -1).
        In the laptop observer camera frame, z_laptop is -1 < 0 (behind camera).
        The observer camera should not be able to see that position.
        """
        cal = SharedFrameCalibration()
        cal.set_manual_laptop([0.0, 0.0, 0.0], yaw_rad=0.0)
        cal.set_manual_phone([0.0, 0.0, -2.0], yaw_rad=0.0)

        local_target = np.array([0.0, 0.0, 1.0])  # 1m in front of phone
        world, laptop = cal.target_in_laptop(local_target)

        np.testing.assert_allclose(world, [0.0, 0.0, -1.0], atol=1e-6)
        np.testing.assert_allclose(laptop, [0.0, 0.0, -1.0], atol=1e-6)
        # Verify target is BEHIND laptop observer camera (z < 0)
        assert laptop[2] < 0.0

    def test_scenario_2_person_on_left_appears_on_left_and_centers_on_rotation(self) -> None:
        """User Test 2:
        Person is standing to the left of the wall/room at (-1.0, 0.0, 2.0).
        Laptop is at (0, 0, 0) facing +Z (yaw=0).
        Target in laptop frame must have x < 0 (left of observer camera).
        When the laptop camera rotates left towards the person, the object's
        screen position moves to center (x ~ 0).
        """
        cal = SharedFrameCalibration()
        # Laptop facing +Z
        cal.set_manual_laptop([0.0, 0.0, 0.0], yaw_rad=0.0)
        # Phone at (-2.0, 0.0, 2.0) facing +X (+90 deg), detecting person 1m in front
        cal.set_manual_phone([-2.0, 0.0, 2.0], yaw_rad=math.pi / 2.0)

        world, laptop_initial = cal.target_in_laptop(np.array([0.0, 0.0, 1.0]))
        # Person world position is (-1, 0, 2)
        np.testing.assert_allclose(world, [-1.0, 0.0, 2.0], atol=1e-6)
        # In laptop frame (facing +Z), person is on the LEFT: x = -1, z = 2
        np.testing.assert_allclose(laptop_initial, [-1.0, 0.0, 2.0], atol=1e-6)
        assert laptop_initial[0] < 0.0  # on the left
        assert laptop_initial[2] > 0.0  # in front

        # Now laptop camera rotates towards the person (turns left)
        # Angle to (-1, 2) is atan2(-1, 2) = -0.4636 rad (-26.56 deg)
        turn_angle = math.atan2(-1.0, 2.0)
        cal.set_manual_laptop([0.0, 0.0, 0.0], yaw_rad=turn_angle)

        world_again, laptop_rotated = cal.target_in_laptop(np.array([0.0, 0.0, 1.0]))
        # World position remains unchanged!
        np.testing.assert_allclose(world_again, [-1.0, 0.0, 2.0], atol=1e-6)
        # In rotated laptop frame, person is directly centered (x ~ 0, z > 0)
        np.testing.assert_allclose(laptop_rotated[0], 0.0, atol=1e-6)
        assert laptop_rotated[2] > 0.0
        np.testing.assert_allclose(laptop_rotated[2], math.sqrt(5.0), atol=1e-6)


class TestQuaternionYawHelpers:
    def test_yaw_to_quaternion_and_back(self) -> None:
        for deg in [0.0, 45.0, 90.0, 135.0, 180.0, -90.0, -45.0]:
            rad = math.radians(deg)
            q = yaw_to_quaternion(rad)
            recovered_rad = quaternion_to_yaw(q)
            np.testing.assert_allclose(recovered_rad, rad, atol=1e-6)
