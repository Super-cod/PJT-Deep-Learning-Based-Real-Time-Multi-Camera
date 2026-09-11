import numpy as np

from spatial_relay.models import CameraIntrinsics, Pose
from spatial_relay.localization import back_project, median_depth_m
from spatial_relay.transforms import Transform
from spatial_relay.calibration import SharedFrameCalibration


def test_transform_round_trip() -> None:
    t = Transform.from_pose(Pose([1.5, 0, -2], [0, .3826834, 0, .9238795]))
    point = np.array([.4, 1.2, 3.0])
    np.testing.assert_allclose(t.inverse().apply(t.apply(point)), point, atol=1e-8)


def test_back_projection_at_principal_point() -> None:
    k = CameraIntrinsics(500, 500, 320, 240)
    np.testing.assert_allclose(back_project(320, 240, 2.0, k), [0, 0, 2])


def test_patch_median_rejects_bad_depth() -> None:
    depth = np.full((7, 7), 2.0); depth[3, 3] = 0; depth[2, 2] = np.nan
    assert median_depth_m(depth, 3, 3) == 2.0


def test_calibration_preserves_world_after_phone_moves() -> None:
    calibration = SharedFrameCalibration()
    calibration.calibrate_laptop(Pose([8, 0, 4], [0, 0, 0, 1]))
    calibration.calibrate_phone(Pose([100, 0, -9], [0, 0, 0, 1]))
    phone_now = Pose([102, 0, -9], [0, .70710678, 0, .70710678])
    laptop_now = Pose([8, 0, 4], [0, 0, 0, 1])
    world, laptop = calibration.target_in_laptop([0, 0, -1], phone_now, laptop_now)
    np.testing.assert_allclose(calibration.world_from_phone(phone_now).matrix[:3, 3], [2, 0, 0], atol=1e-6)
    np.testing.assert_allclose(world, [1, 0, 0], atol=1e-6)
    np.testing.assert_allclose(laptop, world, atol=1e-6)
