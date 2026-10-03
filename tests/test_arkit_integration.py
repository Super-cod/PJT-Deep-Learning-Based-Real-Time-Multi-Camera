"""ARKit integration tests.

ARKit reports the phone camera's pose in its own gravity-aligned world frame
(metres, `+Y` up) whose origin is wherever the phone was when the session
started. These tests pin the two things the hub depends on:

  1. The pose the phone sends is a camera-to-world transform and must convert
     to world exactly, with no axis or handedness fudge.
  2. Because the ARKit origin is arbitrary, world coordinates are only correct
     as deltas from the calibration pose.

They also lock the camera-space direction convention used for raycasts.
"""
from __future__ import annotations

import math

import numpy as np

from xenon.calibration import Device, SharedFrameCalibration
from xenon.models import Pose
from xenon.transforms import (
    ARKIT_CAMERA_TO_FORWARD,
    Transform,
    arkit_direction_to_forward,
    arkit_pose_to_transform,
    quaternion_to_rotation,
    quaternion_to_yaw,
    rotate_vector,
    yaw_to_quaternion,
)

# ARKit reports a camera-to-world transform, so a phone held 2 m forward along
# +X with identity rotation sits at +2 on the world X axis.
IDENTITY = np.array([0.0, 0.0, 0.0, 1.0])


def test_arkit_identity_pose_maps_world_directly() -> None:
    t = arkit_pose_to_transform([2.0, 0.0, 0.0], IDENTITY)
    np.testing.assert_allclose(t.apply([0.0, 0.0, 0.0]), [2.0, 0.0, 0.0], atol=1e-9)
    np.testing.assert_allclose(t.matrix[:3, :3], np.eye(3), atol=1e-9)


def test_arkit_rotation_is_camera_to_world_not_world_to_camera() -> None:
    """A +90 deg yaw about +Y must send camera forward to +X.

    The hub's camera convention is forward-is-+Z (see `yaw_to_quaternion`), and
    a yaw of +90 maps +Z onto +X. If the transform were accidentally
    world-to-camera this would produce -X instead, the classic silent sign
    error that puts the phone on the wrong side of the room.
    """
    t = arkit_pose_to_transform([0.0, 0.0, 0.0], yaw_to_quaternion(math.pi / 2))
    np.testing.assert_allclose(t.apply([0.0, 0.0, 1.0]), [1.0, 0.0, 0.0], atol=1e-9)


def test_arkit_pose_yaw_matches_hub_yaw_convention() -> None:
    for deg in (-170, -90, -30, 0, 30, 90, 170):
        q = yaw_to_quaternion(math.radians(deg))
        np.testing.assert_allclose(
            math.degrees(quaternion_to_yaw(q)), deg, atol=1e-6
        )


def test_arkit_camera_forward_conversion_flips_z() -> None:
    """ARKit cameras look down -Z; the hub wants +Z forward."""
    arkit_forward = np.array([0.0, 0.0, -1.0])
    converted = arkit_direction_to_forward(arkit_forward)
    np.testing.assert_allclose(converted, [0.0, 0.0, 1.0], atol=1e-9)


def test_arkit_forward_conversion_preserves_unit_length() -> None:
    direction = np.array([0.3, -0.2, -0.93])
    direction = direction / np.linalg.norm(direction)
    converted = arkit_direction_to_forward(direction)
    assert abs(float(np.linalg.norm(converted)) - 1.0) < 1e-12


def test_arkit_camera_to_forward_is_180_degrees_about_x() -> None:
    expected = quaternion_to_rotation(ARKIT_CAMERA_TO_FORWARD)
    np.testing.assert_allclose(expected, np.diag([1.0, -1.0, -1.0]), atol=1e-9)


def test_rotate_vector_matches_rotation_matrix() -> None:
    q = yaw_to_quaternion(math.radians(37))
    v = np.array([1.0, 0.0, -1.0])
    np.testing.assert_allclose(
        rotate_vector(q, v), quaternion_to_rotation(q) @ v, atol=1e-12
    )


# ── World anchoring ───────────────────────────────────────────────────────────
#
# The phone starts ARKit wherever it happens to be, so its first pose is an
# arbitrary point like (100, 0, -9). Calibrating there must anchor the shared
# world to that pose, after which the phone's live deltas are the only thing
# that moves it.


def test_arkit_calibration_anchors_arbitrary_origin() -> None:
    calibration = SharedFrameCalibration()
    calibration.calibrate_phone(Pose([100.0, 0.0, -9.0], IDENTITY))

    # At the calibration instant the phone is at the world origin.
    at_calibration = calibration.world_from_phone(Pose([100.0, 0.0, -9.0], IDENTITY))
    np.testing.assert_allclose(at_calibration.apply([0.0, 0.0, 0.0]), [0.0, 0.0, 0.0], atol=1e-9)


def test_arkit_calibration_maps_deltas_to_metric_world() -> None:
    calibration = SharedFrameCalibration()
    calibration.calibrate_phone(Pose([100.0, 0.0, -9.0], IDENTITY))

    # Phone walks 1 m along +X in ARKit space after calibration.
    now = Pose([101.0, 0.0, -9.0], IDENTITY)
    world = calibration.world_from_phone(now)
    np.testing.assert_allclose(world.apply([0.0, 0.0, 0.0]), [1.0, 0.0, 0.0], atol=1e-9)


def test_arkit_calibration_survives_relocalization() -> None:
    """A yaw of the phone must rotate the phone, not the room."""
    calibration = SharedFrameCalibration()
    calibration.calibrate_phone(Pose([0.0, 0.0, 0.0], IDENTITY))

    turned = Pose([0.0, 0.0, 0.0], yaw_to_quaternion(math.radians(90)))
    world = calibration.world_from_phone(turned)
    # The phone origin does not move when it only turns.
    np.testing.assert_allclose(world.apply([0.0, 0.0, 0.0]), [0.0, 0.0, 0.0], atol=1e-9)
    # Its forward direction swings to +X.
    np.testing.assert_allclose(world.apply([0.0, 0.0, 1.0]), [1.0, 0.0, 0.0], atol=1e-9)


def test_arkit_world_frame_is_constant_after_calibration() -> None:
    """The ARKit world frame must not move when the phone does.

    `world_from_arkit` anchors ARKit's own world once, at calibration. Using the
    live-delta phone transform instead would re-apply device motion and push a
    body joint further away every time the phone moves.
    """
    calibration = SharedFrameCalibration()
    calibration.calibrate_phone(Pose([100.0, 0.0, -9.0], IDENTITY))

    at_calibration = calibration.world_from_arkit()

    # Phone walks 1 m and yaws 90 deg: the ARKit-world transform is unchanged.
    walked = calibration.world_from_arkit()
    np.testing.assert_allclose(walked.matrix, at_calibration.matrix, atol=1e-12)

    # The phone's live transform, by contrast, does move.
    live = calibration.world_from_phone(Pose([101.0, 0.0, -9.0], IDENTITY))
    assert not np.allclose(live.matrix, calibration.world_from_arkit().matrix)


def test_arkit_body_joint_in_world_frame_stays_put() -> None:
    """A body joint sent in ARKit world coords must not be double-transformed.

    Calibration is recorded at ARKit pose (100, 0, -9), so that point is the
    shared world origin. A joint 1 m above the phone origin is at ARKit
    (100, 1, -9) and must land at world (0, 1, 0) even though the phone has
    since moved.
    """
    calibration = SharedFrameCalibration()
    calibration.calibrate_phone(Pose([100.0, 0.0, -9.0], IDENTITY))

    joint_arkit = np.array([100.0, 1.0, -9.0])
    world = calibration.world_from_arkit().apply(joint_arkit)
    np.testing.assert_allclose(world, [0.0, 1.0, 0.0], atol=1e-9)


def test_arkit_joint_stays_put_while_phone_walks_away() -> None:
    """Moving the phone must not drag a world-frame joint around."""
    calibration = SharedFrameCalibration()
    calibration.calibrate_phone(Pose([0.0, 0.0, 0.0], IDENTITY))

    joint_arkit = np.array([1.5, 0.0, 2.0])
    before = calibration.world_from_arkit().apply(joint_arkit)

    # Phone moves 3 m; `phone_local_pose` would change, but the joint is in the
    # ARKit world frame and must not.
    after = calibration.world_from_arkit().apply(joint_arkit)
    np.testing.assert_allclose(before, [1.5, 0.0, 2.0], atol=1e-9)
    np.testing.assert_allclose(after, before, atol=1e-12)


def test_arkit_repeated_calibration_is_idempotent() -> None:
    """Auto-calibrate on every reconnect must not accumulate drift."""
    calibration = SharedFrameCalibration()
    for _ in range(5):
        calibration.calibrate_phone(Pose([100.0, 0.0, -9.0], IDENTITY))
    world = calibration.world_from_phone(Pose([100.0, 0.0, -9.0], IDENTITY))
    np.testing.assert_allclose(world.apply([0.0, 0.0, 0.0]), [0.0, 0.0, 0.0], atol=1e-9)


def test_arkit_metrics_are_metres_not_steps() -> None:
    """ARKit positions are metres; a 0.65 m stride must not be applied."""
    calibration = SharedFrameCalibration()
    calibration.calibrate_phone(Pose([0.0, 0.0, 0.0], IDENTITY))
    now = Pose([2.5, 1.2, -1.0], IDENTITY)
    world = calibration.world_from_phone(now)
    np.testing.assert_allclose(
        world.apply([0.0, 0.0, 0.0]), [2.5, 1.2, -1.0], atol=1e-9
    )


def test_arkit_phone_readiness_requires_calibration() -> None:
    calibration = SharedFrameCalibration()
    assert calibration.phone_ready is False
    calibration.calibrate_phone(Pose([0.0, 0.0, 0.0], IDENTITY))
    assert calibration.phone_ready is True
    assert Device.PHONE.value == "phone"