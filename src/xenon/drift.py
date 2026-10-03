from __future__ import annotations

from dataclasses import dataclass
import time

import numpy as np

from .transforms import Transform


@dataclass
class DriftCorrector:
    """Applies a decaying residual after every marker re-observation.

    The residual is deliberately smooth to avoid an AR skeleton jumping when a
    device re-anchors. Rotation blending is linear over short corrections.
    """
    settle_seconds: float = 1.0
    _residual: Transform = Transform.identity()
    _observed_at: float = 0.0

    def observe(self, measured_world_from_device: Transform, raw_world_from_device: Transform) -> Transform:
        self._residual = raw_world_from_device.inverse().then(measured_world_from_device)
        self._observed_at = time.monotonic()
        return self._residual

    def corrected(self, raw: Transform) -> Transform:
        if self._observed_at == 0: return raw
        alpha = max(0.0, 1.0 - (time.monotonic() - self._observed_at) / self.settle_seconds)
        if alpha == 0: return raw
        delta = np.eye(4) + alpha * (self._residual.matrix - np.eye(4))
        delta[:3, :3] = self._nearest_rotation(delta[:3, :3])
        return Transform(delta @ raw.matrix)

    @staticmethod
    def _nearest_rotation(m: np.ndarray) -> np.ndarray:
        u, _, vh = np.linalg.svd(m); return u @ vh
