import numpy as np
from spatial_relay.frames import canonical_point_to_opencv, opencv_point_to_canonical


def test_opencv_canonical_round_trip() -> None:
    opencv = np.array([.4, -.2, 2.7])
    canonical = opencv_point_to_canonical(opencv)
    np.testing.assert_allclose(canonical, [.4, .2, -2.7])
    np.testing.assert_allclose(canonical_point_to_opencv(canonical), opencv)
