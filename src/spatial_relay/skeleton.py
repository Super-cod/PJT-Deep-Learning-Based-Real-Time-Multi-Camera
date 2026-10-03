"""Temporal model of one tracked person's skeleton.

Raw per-frame joints from a phone are noisy: depth spikes, one-frame dropouts
and limbs that stretch or shrink as the 2D detector and depth sampling
disagree. ``SkeletonFilter`` turns them into a stable body:

* **1-euro smoothing per joint**: removes jitter, yet follows fast motion.
* **Hold**: a joint missing for a moment stays where it was relative to the
  body instead of blinking out.
* **Rigid limbs**: each person's upper-arm, forearm, thigh and shin lengths
  are learned over time (within human ranges) and enforced, so limbs keep a
  constant length while still pointing where the detector saw them.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .filtering import OneEuroFilter

HOLD_S = 0.5
MIN_CONFIDENCE = 0.2
# Limb bones, parent → child, ordered so corrected parents feed their children.
LIMBS: list[tuple[str, str, float, float]] = [
    ("left_shoulder", "left_elbow", 0.22, 0.40),
    ("left_elbow", "left_wrist", 0.20, 0.35),
    ("right_shoulder", "right_elbow", 0.22, 0.40),
    ("right_elbow", "right_wrist", 0.20, 0.35),
    ("left_hip", "left_knee", 0.32, 0.55),
    ("left_knee", "left_ankle", 0.30, 0.55),
    ("right_hip", "right_knee", 0.32, 0.55),
    ("right_knee", "right_ankle", 0.30, 0.55),
]
# Bone-length learning rate once a length is established.
LENGTH_RATE = 0.05
# Ignore length mismatches smaller than this (no need to nudge).
LENGTH_TOLERANCE_M = 0.02


@dataclass
class _JointState:
    filter: OneEuroFilter
    relative: np.ndarray = field(default_factory=lambda: np.zeros(3))  # to the root, at last sighting
    confidence: float = 0.0
    last_seen: float = -1e9


class SkeletonFilter:
    def __init__(self, min_cutoff: float = 1.5, beta: float = 0.6) -> None:
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.joints: dict[str, _JointState] = {}
        self.bone_lengths: dict[tuple[str, str], float] = {}
        self.last_update = -1e9

    def update(
        self,
        joints: dict[str, tuple[np.ndarray, float]],
        root: np.ndarray,
        t: float,
    ) -> dict[str, tuple[np.ndarray, float]]:
        """Filter one frame of joints (world metres) for this person at time ``t``.

        ``root`` is the person's (already smoothed) root; held joints move with it.
        Returns ``{name: (position, confidence)}``.
        """
        root = np.asarray(root, dtype=float)
        out: dict[str, tuple[np.ndarray, float]] = {}

        for name, (pos, conf) in joints.items():
            if conf < MIN_CONFIDENCE:
                continue
            state = self.joints.get(name)
            if state is None:
                state = self.joints[name] = _JointState(OneEuroFilter(self.min_cutoff, self.beta))
            elif t - state.last_seen > HOLD_S:
                state.filter.reset()  # it re-appeared after a long gap: don't drag from the old spot
            p = state.filter.filter(np.asarray(pos, dtype=float), t)
            state.relative = p - root
            state.confidence = conf
            state.last_seen = t
            out[name] = (p, conf)

        # Briefly keep joints that dropped out this frame, carried along with the body.
        for name, state in self.joints.items():
            if name not in out and 0 < t - state.last_seen <= HOLD_S:
                out[name] = (root + state.relative, state.confidence * 0.5)

        self._enforce_limb_lengths(out)
        self.last_update = t
        return out

    def _enforce_limb_lengths(self, out: dict[str, tuple[np.ndarray, float]]) -> None:
        for parent, child, lo, hi in LIMBS:
            if parent not in out or child not in out:
                continue
            p, _ = out[parent]
            c, conf = out[child]
            vec = c - p
            length = float(np.linalg.norm(vec))
            if length < 1e-4:
                continue
            key = (parent, child)
            if lo <= length <= hi:
                known = self.bone_lengths.get(key)
                self.bone_lengths[key] = length if known is None else known + LENGTH_RATE * (length - known)
            target = self.bone_lengths.get(key)
            if target is None:
                target = float(np.clip(length, lo, hi))
            if abs(length - target) > LENGTH_TOLERANCE_M:
                out[child] = (p + vec / length * target, conf)
