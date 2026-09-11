"""Low-latency temporal filtering and prediction for live pose streams.

Streamed AR poses carry two kinds of error that both look like "inaccuracy":

* Per-sample jitter (noise). Removed with an adaptive 1-euro low-pass whose
  cutoff grows with measured velocity, so genuine motion is never blurred.
* Transport + scheduler latency. The pose shown at time t was captured at
  t - L. A constant-velocity model extrapolates the last filtered pose forward
  so the rendered target is where the subject is *now*.

Everything here is timestamp driven (no fixed-rate assumption): filters adapt
to whatever sample rate each device actually streams at.
"""
from __future__ import annotations

import math
import time
from collections import deque

import numpy as np

from .models import Pose
from .transforms import (
    quaternion_conjugate,
    quaternion_multiply,
    quaternion_nlerp,
    quaternion_normalize,
    quaternion_power,
)


def _alpha(cutoff: float, dt: float) -> float:
    tau = 1.0 / (2.0 * math.pi * cutoff)
    return 1.0 / (1.0 + tau / dt)


class OneEuroFilter:
    """Adaptive low-pass filter: cutoff rises with signal speed (1-euro filter).

    Parameters are frequency-domain (Hz): higher ``min_cutoff`` removes more
    noise but lags more; higher ``beta`` reduces lag on fast motion.
    """

    def __init__(
        self,
        min_cutoff: float = 1.0,
        beta: float = 0.05,
        derivative_cutoff: float = 1.5,
        initial: np.ndarray | None = None,
    ) -> None:
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.derivative_cutoff = derivative_cutoff
        self._x_prev: np.ndarray | None = None
        self._dx_prev: np.ndarray | None = None
        self._t_prev: float | None = None
        if initial is not None:
            self._seed(initial, None)

    def _seed(self, x: np.ndarray, t: float | None) -> None:
        a = np.asarray(x, dtype=float)
        self._x_prev = a.copy()
        self._dx_prev = np.zeros_like(a)
        self._t_prev = t

    def filter(self, x: np.ndarray, t: float | None = None) -> np.ndarray:
        x = np.asarray(x, dtype=float)
        if t is None:
            t = time.monotonic()
        if self._x_prev is None or self._t_prev is None or t <= self._t_prev:
            self._seed(x, t)
            return x.copy()
        dt = max(1e-6, t - self._t_prev)
        dx = (x - self._x_prev) / dt
        dx_hat = _alpha(self.derivative_cutoff, dt) * dx + (1.0 - _alpha(self.derivative_cutoff, dt)) * self._dx_prev
        cutoff = self.min_cutoff + self.beta * float(np.linalg.norm(dx_hat))
        a = _alpha(cutoff, dt)
        x_hat = a * x + (1.0 - a) * self._x_prev
        self._x_prev = x_hat.copy()
        self._dx_prev = dx_hat.copy()
        self._t_prev = t
        return x_hat.copy()

    def reset(self, x: np.ndarray | None = None, t: float | None = None) -> None:
        if x is None:
            self.__init__(self.min_cutoff, self.beta, self.derivative_cutoff)
        else:
            self._seed(x, t)


class PoseFilter:
    """Filters a pose stream: 1-euro on position, adaptive nlerp on orientation."""

    def __init__(
        self,
        min_cutoff: float = 1.2,
        beta: float = 0.04,
        derivative_cutoff: float = 1.5,
        rotation_cutoff: float = 1.6,
    ) -> None:
        self._pos = OneEuroFilter(min_cutoff, beta, derivative_cutoff)
        self.rotation_cutoff = rotation_cutoff
        self._q_prev: np.ndarray | None = None
        self._t_prev: float | None = None

    def reset(self) -> None:
        self._pos.reset()
        self._q_prev = None
        self._t_prev = None

    def filter(self, pose: Pose, t_s: float | None = None) -> Pose:
        if t_s is None:
            t_s = pose.timestamp_ns * 1e-9
        pos = self._pos.filter(pose.position, t=t_s)
        q = np.asarray(pose.quaternion_xyzw, dtype=float)
        if self._q_prev is None or self._t_prev is None or t_s <= self._t_prev:
            self._q_prev = quaternion_normalize(q).copy()
            self._t_prev = t_s
        else:
            # Angular velocity adaptively raises the cutoff so quick turns
            # are tracked while slow drift is still smoothed.
            dt = max(1e-6, t_s - self._t_prev)
            signed = q if float(np.dot(q, self._q_prev)) >= 0.0 else -q
            angle_map = 2.0 * sum(s * p for s, p in zip(signed, self._q_prev))
            angle = math.acos(min(1.0, max(-1.0, angle_map)))
            ang_speed = angle / dt
            cutoff = self.rotation_cutoff + 0.08 * ang_speed
            alpha = _alpha(cutoff, dt)
            self._q_prev = quaternion_nlerp(self._q_prev, q, alpha)
            self._t_prev = t_s
        return Pose(pos, self._q_prev, pose.timestamp_ns)


class PosePredictor:
    """Constant-velocity model over a short rolling window for latency compensation."""

    def __init__(self, max_horizon_s: float = 0.5, window: int = 8) -> None:
        self.max_horizon_s = max_horizon_s
        self._samples: deque[tuple[float, np.ndarray, np.ndarray]] = deque(maxlen=window)

    def reset(self) -> None:
        self._samples.clear()

    def add(self, pose: Pose, t_s: float | None = None) -> None:
        if t_s is None:
            t_s = pose.timestamp_ns * 1e-9
        self._samples.append((t_s, np.asarray(pose.position, dtype=float).copy(), quaternion_normalize(pose.quaternion_xyzw).copy()))

    def predict(self, horizon_s: float, now_s: float | None = None) -> Pose | None:
        if len(self._samples) == 0:
            return None
        if len(self._samples) == 1:
            _, p, q = self._samples[0]
            return Pose(p.copy(), q.copy())
        horizon_s = max(0.0, min(self.max_horizon_s, horizon_s))
        t_prev, p_prev, q_prev = self._samples[-2]
        t_now, p_now, q_now = self._samples[-1]
        if now_s is None:
            now_s = t_now
        dt = t_now - t_prev
        ahead = (now_s + horizon_s) - t_now
        if dt <= 0.0 or ahead <= 0.0:
            return Pose(p_now.copy(), q_now.copy())
        vel = (p_now - p_prev) / dt
        p_pred = p_now + vel * ahead
        if ahead > 1e-6 and dt > 1e-6:
            dq = quaternion_multiply(q_now, quaternion_conjugate(q_prev))
            q_pred = quaternion_multiply(quaternion_power(dq, ahead / dt), q_now)
        else:
            q_pred = q_now.copy()
        return Pose(p_pred, quaternion_normalize(q_pred))