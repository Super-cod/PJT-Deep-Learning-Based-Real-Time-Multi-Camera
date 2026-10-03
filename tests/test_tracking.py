import numpy as np

from xenon.tracking import PersonTracker


def test_ids_stay_stable_when_detection_order_swaps():
    tracker = PersonTracker()
    a, b = np.array([0.0, 0.0, 2.0]), np.array([1.5, 0.0, 3.0])
    first = [sid for sid, _ in tracker.update([a, b], t=0.0)]
    # Detector returns the same two people in the opposite order, slightly moved.
    second = [sid for sid, _ in tracker.update([b + 0.05, a + 0.05], t=0.1)]
    assert first == ["person_01", "person_02"]
    assert second == ["person_02", "person_01"]


def test_new_person_beyond_gate_gets_new_id():
    tracker = PersonTracker(gate_m=0.9)
    tracker.update([np.array([0.0, 0.0, 2.0])], t=0.0)
    ids = [sid for sid, _ in tracker.update([np.array([0.0, 0.0, 2.1]), np.array([3.0, 0.0, 2.0])], t=0.1)]
    assert ids == ["person_01", "person_02"]


def test_track_expires_after_max_age():
    tracker = PersonTracker(max_age_s=1.0)
    tracker.update([np.array([0.0, 0.0, 2.0])], t=0.0)
    tracker.update([], t=2.0)
    assert tracker.tracks == []
    ids = [sid for sid, _ in tracker.update([np.array([0.0, 0.0, 2.0])], t=2.1)]
    assert ids == ["person_02"]


def test_two_detections_cannot_share_one_track():
    tracker = PersonTracker()
    tracker.update([np.array([0.0, 0.0, 2.0])], t=0.0)
    ids = [sid for sid, _ in tracker.update([np.array([0.1, 0.0, 2.0]), np.array([-0.1, 0.0, 2.0])], t=0.1)]
    assert len(set(ids)) == 2
