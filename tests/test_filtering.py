import math
import numpy as np
import pytest

from spatial_relay.filtering import OneEuroFilter, PoseFilter, PosePredictor
from spatial_relay.models import Pose
from spatial_relay.transforms import quaternion_to_axis_angle


class TestOneEuroFilter:
    def test_constant_signal_passes_through(self) -> None:
        f = OneEuroFilter(min_cutoff=1.0, beta=0.0)
        pts = np.array([1.0, 2.0, 3.0])
        for _ in range(50):
            pts = f.filter(pts, t=_ * 0.01)
        np.testing.assert_allclose(f.filter(pts, t=0.5), pts, atol=0.01)

    def test_noise_reduced(self) -> None:
        rng = np.random.RandomState(42)
        f = OneEuroFilter(min_cutoff=1.0, beta=0.0, initial=np.array([0.0]))
        signal = np.array([1.0])
        raw_vals = []
        filt_vals = []
        for i in range(200):
            t = i * 0.02
            raw = signal + rng.normal(0, 0.2)
            raw_vals.append(float(raw[0]))
            filt_vals.append(float(f.filter(raw, t)[0]))
        raw_var = float(np.var(raw_vals[50:]))
        filt_var = float(np.var(filt_vals[50:]))
        assert filt_var < raw_var * 0.3, f"Filtered variance {filt_var:.4f} should be much less than raw {raw_var:.4f}"

    def test_step_response_reactivity(self) -> None:
        f = OneEuroFilter(min_cutoff=0.5, beta=0.8, initial=np.array([0.0]))
        for i in range(20):
            f.filter(np.array([0.0]), t=i * 0.01)
        vals = []
        for i in range(10):
            vals.append(float(f.filter(np.array([1.0]), t=0.2 + i * 0.01)[0]))
        assert vals[-1] > 0.5, "With beta=0.8 the filter should react quickly to a step"

    def test_reset_clears_state(self) -> None:
        f = OneEuroFilter(min_cutoff=1.0)
        for i in range(10):
            f.filter(np.array([5.0]), t=i * 0.01)
        f.reset(np.array([0.0]), t=0.0)
        np.testing.assert_allclose(f.filter(np.array([0.0]), t=0.01), [0.0], atol=0.01)


class TestPoseFilter:
    def test_pose_orientation_stays_normalized(self) -> None:
        pf = PoseFilter()
        q_base = np.array([0.0, 0.0, 0.0, 1.0])
        result = pf.filter(Pose([0, 0, 0], q_base), t_s=1.0)
        norm = float(np.linalg.norm(result.quaternion_xyzw))
        assert abs(norm - 1.0) < 1e-8

    def test_constant_pose_converges(self) -> None:
        pf = PoseFilter(min_cutoff=0.8, rotation_cutoff=0.8)
        q_target = np.array([0.0, 0.0, 0.7071068, 0.7071068])
        poses = [pf.filter(Pose([1, 2, 3], q_target), t_s=i * 0.01) for i in range(100)]
        final = poses[-1]
        np.testing.assert_allclose(final.position, [1, 2, 3], atol=0.01)
        np.testing.assert_allclose(final.quaternion_xyzw, q_target, atol=0.05)


class TestPosePredictor:
    def test_predict_after_single_sample_returns_pose(self) -> None:
        pred = PosePredictor()
        p = Pose([1.0, 2.0, 3.0], [0.0, 0.0, 0.0, 1.0])
        pred.add(p, t_s=0.0)
        result = pred.predict(0.1, now_s=0.0)
        assert result is not None
        np.testing.assert_allclose(result.position, [1.0, 2.0, 3.0])

    def test_predict_constant_velocity_position(self) -> None:
        pred = PosePredictor(max_horizon_s=2.0)
        q = np.array([0.0, 0.0, 0.0, 1.0])
        pred.add(Pose([0, 0, 0], q), t_s=0.0)
        pred.add(Pose([1, 0, 0], q), t_s=0.1)
        result = pred.predict(0.2, now_s=0.1)
        np.testing.assert_allclose(result.position, [3.0, 0.0, 0.0], atol=1e-6)

    def test_predict_constant_yaw_extrapolation(self) -> None:
        pred = PosePredictor(max_horizon_s=2.0)
        q0 = np.array([0.0, 0.0, 0.0, 1.0])
        q90 = np.array([0.0, 0.7071068, 0.0, 0.7071068])
        pred.add(Pose([0, 0, 0], q0), t_s=0.0)
        pred.add(Pose([0, 0, 0], q90), t_s=0.1)
        result = pred.predict(0.1, now_s=0.1)
        _, angle = quaternion_to_axis_angle(result.quaternion_xyzw)
        expected_angle = math.pi
        assert abs(angle - expected_angle) < 0.1, f"Predicted yaw angle {angle:.2f} should be ~pi"

    def test_max_horizon_clamped(self) -> None:
        pred = PosePredictor(max_horizon_s=0.3)
        q = np.array([0.0, 0.0, 0.0, 1.0])
        pred.add(Pose([0, 0, 0], q), t_s=0.0)
        pred.add(Pose([1, 0, 0], q), t_s=0.1)
        result = pred.predict(5.0, now_s=0.1)
        # vel = 10 m/s, horizon clamped to 0.3, ahead = 0.3, pos = last(1.0) + 10*0.3 = 4.0
        np.testing.assert_allclose(result.position, [4.0, 0.0, 0.0], atol=0.01)

    def test_predict_clamps_negative_horizon(self) -> None:
        pred = PosePredictor()
        q = np.array([0.0, 0.0, 0.0, 1.0])
        pred.add(Pose([0, 0, 0], q), t_s=0.0)
        pred.add(Pose([1, 0, 0], q), t_s=0.1)
        result = pred.predict(-1.0, now_s=0.1)
        np.testing.assert_allclose(result.position, [1.0, 0.0, 0.0], atol=1e-6)

    def test_reset_clears_buffer(self) -> None:
        pred = PosePredictor()
        pred.add(Pose([1, 0, 0], [0, 0, 0, 1]), t_s=0.0)
        pred.reset()
        assert pred.predict(0.1) is None
