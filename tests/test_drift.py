import numpy as np
import time

from spatial_relay.drift import DriftCorrector
from spatial_relay.transforms import Transform


class TestDriftCorrector:
    def test_identity_when_no_anchor(self) -> None:
        dc = DriftCorrector()
        t = Transform.from_rt(np.eye(3), np.array([1.0, 0.0, 0.0]))
        result = dc.corrected(t)
        np.testing.assert_allclose(result.matrix, t.matrix, atol=1e-10)

    def test_anchor_reduces_residual(self) -> None:
        dc = DriftCorrector(settle_seconds=1.0)
        raw = Transform.from_rt(np.eye(3), np.array([0.0, 0.0, 0.0]))
        measured = Transform.from_rt(np.eye(3), np.array([0.1, 0.0, 0.0]))
        dc.observe(measured, raw)
        corrected = dc.corrected(raw)
        np.testing.assert_allclose(corrected.matrix[:3, 3], [0.1, 0.0, 0.0], atol=0.01)

    def test_residual_decays_over_time(self) -> None:
        dc = DriftCorrector(settle_seconds=0.01)
        raw = Transform.from_rt(np.eye(3), np.array([0.0, 0.0, 0.0]))
        measured = Transform.from_rt(np.eye(3), np.array([0.5, 0.0, 0.0]))
        dc.observe(measured, raw)
        time.sleep(0.05)
        corrected = dc.corrected(raw)
        np.testing.assert_allclose(corrected.matrix[:3, 3], [0.0, 0.0, 0.0], atol=0.01)
