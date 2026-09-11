import numpy as np

from spatial_relay.localization import (
    back_project,
    localize_landmarks,
    median_depth_m,
    robust_depth_m,
)
from spatial_relay.models import CameraIntrinsics


class TestMedianDepth:
    def test_basic(self) -> None:
        depth = np.full((7, 7), 2.0)
        assert median_depth_m(depth, 3, 3) == 2.0

    def test_rejects_bad_depth(self) -> None:
        depth = np.full((7, 7), 2.0); depth[3, 3] = 0; depth[2, 2] = np.nan
        assert median_depth_m(depth, 3, 3) == 2.0

    def test_all_bad_returns_none(self) -> None:
        depth = np.full((5, 5), np.nan)
        assert median_depth_m(depth, 2, 2) is None


class TestRobustDepth:
    def test_uniform_patch_gives_low_spread(self) -> None:
        depth = np.full((7, 7), 2.5)
        d, mad = robust_depth_m(depth, 3, 3, radius=2)
        assert d is not None
        np.testing.assert_allclose(d, 2.5, atol=0.01)
        assert mad < 0.01

    def test_all_invalid_returns_none(self) -> None:
        depth = np.zeros((7, 7))
        d, mad = robust_depth_m(depth, 3, 3, radius=2)
        assert d is None and mad is None

    def test_resists_outlier_at_edge(self) -> None:
        depth = np.full((9, 9), 2.0)
        depth[0, 0] = 10.0
        depth[0, 8] = 10.0
        d, mad = robust_depth_m(depth, 4, 4, radius=2)
        assert d is not None
        np.testing.assert_allclose(d, 2.0, atol=0.1)


class TestBackProject:
    def test_principal_point(self) -> None:
        k = CameraIntrinsics(500, 500, 320, 240)
        np.testing.assert_allclose(back_project(320, 240, 2.0, k), [0, 0, 2])

    def test_offset(self) -> None:
        k = CameraIntrinsics(600, 600, 300, 200)
        p = back_project(330, 230, 1.0, k)
        np.testing.assert_allclose(p, [0.05, 0.05, 1.0], atol=1e-6)

    def test_distortion_none_noop(self) -> None:
        k = CameraIntrinsics(500, 500, 320, 240)
        d = back_project(320, 240, 2.0, k, distortion=None)
        np.testing.assert_allclose(d, [0, 0, 2])


class TestLocalizeLandmarks:
    def test_gates_edge_of_image(self) -> None:
        k = CameraIntrinsics(500, 500, 320, 240)
        depth = np.full((480, 640), 2.0)
        landmarks = {"nose": (2.0, 2.0, 0.9)}
        joints = localize_landmarks(landmarks, depth, k, edge_margin=4)
        assert len(joints) == 0

    def test_accepts_valid_landmark(self) -> None:
        k = CameraIntrinsics(500, 500, 320, 240)
        depth = np.full((480, 640), 2.0)
        landmarks = {"nose": (320.0, 240.0, 0.9)}
        joints = localize_landmarks(landmarks, depth, k, edge_margin=4)
        assert len(joints) == 1
        np.testing.assert_allclose(joints[0].point_m, [0, 0, 2], atol=1e-6)

    def test_rejects_low_confidence(self) -> None:
        k = CameraIntrinsics(500, 500, 320, 240)
        depth = np.full((480, 640), 2.0)
        landmarks = {"nose": (320.0, 240.0, 0.1)}
        joints = localize_landmarks(landmarks, depth, k, edge_margin=4)
        assert len(joints) == 0
