import numpy as np

from xenon.skeleton import SkeletonFilter

BODY = {
    "left_hip": [0.12, 0.95, 2.0], "left_knee": [0.13, 0.52, 2.0], "left_ankle": [0.13, 0.10, 2.0],
    "left_shoulder": [0.2, 1.42, 2.0], "left_elbow": [0.28, 1.13, 2.0], "left_wrist": [0.3, 0.88, 2.0],
}
ROOT = np.array([0.0, 0.95, 2.0])


def frame(noise: float, rng: np.random.Generator, drop: tuple[str, ...] = ()) -> dict:
    return {
        name: (np.array(p) + rng.normal(0, noise, 3), 0.9)
        for name, p in BODY.items() if name not in drop
    }


def test_jitter_is_reduced() -> None:
    rng = np.random.default_rng(0)
    sk = SkeletonFilter()
    errors_raw, errors_filtered = [], []
    for i in range(120):
        raw = frame(0.03, rng)
        out = sk.update(raw, ROOT, t=i / 20)
        if i > 20:
            errors_raw.append(np.linalg.norm(raw["left_wrist"][0] - BODY["left_wrist"]))
            errors_filtered.append(np.linalg.norm(out["left_wrist"][0] - BODY["left_wrist"]))
    assert np.mean(errors_filtered) < 0.6 * np.mean(errors_raw)


def test_dropped_joint_is_held_with_the_body_then_released() -> None:
    rng = np.random.default_rng(1)
    sk = SkeletonFilter()
    for i in range(20):
        sk.update(frame(0.0, rng), ROOT, t=i / 20)
    moved_root = ROOT + np.array([0.1, 0.0, 0.0])
    held = sk.update(frame(0.0, rng, drop=("left_wrist",)), moved_root, t=1.05)
    assert "left_wrist" in held
    assert held["left_wrist"][0][0] > BODY["left_wrist"][0] + 0.05  # moved with the body
    gone = sk.update(frame(0.0, rng, drop=("left_wrist",)), moved_root, t=2.0)
    assert "left_wrist" not in gone


def test_limb_length_spike_is_corrected() -> None:
    rng = np.random.default_rng(2)
    sk = SkeletonFilter(min_cutoff=50.0, beta=0.0)  # near pass-through: isolate the limb rule
    for i in range(40):
        sk.update(frame(0.0, rng), ROOT, t=i / 20)
    shin = np.linalg.norm(np.array(BODY["left_ankle"]) - BODY["left_knee"])
    spiked = frame(0.0, rng)
    spiked["left_ankle"] = (np.array([0.13, -0.6, 2.0]), 0.9)  # depth/2D glitch: 1.1 m shin
    out = sk.update(spiked, ROOT, t=2.05)
    length = np.linalg.norm(out["left_ankle"][0] - out["left_knee"][0])
    assert abs(length - shin) < 0.03


def test_low_confidence_joints_are_ignored() -> None:
    sk = SkeletonFilter()
    out = sk.update({"left_hip": (np.array(BODY["left_hip"]), 0.05)}, ROOT, t=0.0)
    assert out == {}
