"""Multi-person identity tracking in the shared world frame.

Observers report every person they see in a frame, without stable identities
(pose detectors return people in arbitrary order). The hub assigns persistent
``person_NN`` ids by matching each new detection to the nearest live track on
the floor plane (X/Z), gated by distance, and smooths each track's position
with a 1-euro filter.
"""
from __future__ import annotations

import itertools
import time
from dataclasses import dataclass, field

import numpy as np

from .filtering import OneEuroFilter


@dataclass
class Track:
    track_id: int
    position: np.ndarray
    last_seen: float
    filter: OneEuroFilter = field(default_factory=lambda: OneEuroFilter(min_cutoff=1.0, beta=0.4))

    @property
    def subject_id(self) -> str:
        return f"person_{self.track_id:02d}"


class PersonTracker:
    """Greedy nearest-neighbour tracker.

    ``gate_m``: max floor distance between a track and a detection to match.
    ``max_age_s``: a track not seen for this long is dropped.
    """

    def __init__(self, gate_m: float = 0.9, max_age_s: float = 1.5) -> None:
        self.gate_m = gate_m
        self.max_age_s = max_age_s
        self.tracks: list[Track] = []
        self._ids = itertools.count(1)

    def reset(self) -> None:
        self.tracks.clear()
        self._ids = itertools.count(1)

    def update(self, positions: list[np.ndarray], t: float | None = None) -> list[tuple[str, np.ndarray]]:
        """Assign ids to ``positions`` (world points); returns (subject_id, smoothed_position) per input."""
        now = time.monotonic() if t is None else t
        self.tracks = [tr for tr in self.tracks if now - tr.last_seen <= self.max_age_s]
        points = [np.asarray(p, dtype=float).reshape(3) for p in positions]

        # All (distance, track, detection) pairs inside the gate, closest first.
        pairs = sorted(
            (float(np.hypot(*(tr.position - p)[[0, 2]])), ti, di)
            for ti, tr in enumerate(self.tracks)
            for di, p in enumerate(points)
        )
        assigned: dict[int, Track] = {}
        used_tracks: set[int] = set()
        for dist, ti, di in pairs:
            if dist > self.gate_m:
                break
            if ti in used_tracks or di in assigned:
                continue
            used_tracks.add(ti)
            assigned[di] = self.tracks[ti]

        results: list[tuple[str, np.ndarray]] = []
        for di, p in enumerate(points):
            track = assigned.get(di)
            if track is None:
                track = Track(next(self._ids), p, now)
                self.tracks.append(track)
            track.position = track.filter.filter(p, now)
            track.last_seen = now
            results.append((track.subject_id, track.position.copy()))
        return results
