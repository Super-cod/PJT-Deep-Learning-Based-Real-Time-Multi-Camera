"""Persistent shared-frame calibration for independent AR tracking sessions.

Every AR device tracks in a private, arbitrary local frame. At calibration we
store each device's local pose and declare the laptop camera pose to be W=I.
Later poses are expressed as a delta from that saved pose, so the private AR
origin never leaks into the shared coordinate system.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

import numpy as np

from .models import Pose
from .transforms import Transform, quaternion_to_yaw


class Device(str, Enum):
    PHONE = "phone"
    LAPTOP = "laptop"


@dataclass
class SharedFrameCalibration:
    """Maps a device's tracking/manual frame into W, the shared room coordinate system."""
    phone_initial_local: Transform | None = None
    laptop_initial_local: Transform | None = None
    # Exact phone-to-laptop offset measured from a fiducial board. Identity is
    # valid only when the cameras were co-located and aligned at calibration.
    world_from_phone_at_start: Transform = Transform.identity()
    # Explicit manual coordinates
    manual_phone_position: np.ndarray | None = None
    manual_phone_yaw: float | None = None
    manual_laptop_position: np.ndarray = field(default_factory=lambda: np.array([0.0, 0.0, 0.0], dtype=float))
    manual_laptop_yaw: float = 0.0

    @property
    def ready(self) -> bool:
        return (self.manual_phone_position is not None) or (
            self.phone_initial_local is not None and self.laptop_initial_local is not None
        )

    def set_manual_phone(self, position: list[float] | np.ndarray, yaw_rad: float = 0.0) -> None:
        self.manual_phone_position = np.asarray(position, dtype=float).reshape(3)
        self.manual_phone_yaw = float(yaw_rad)

    def set_manual_laptop(self, position: list[float] | np.ndarray = (0.0, 0.0, 0.0), yaw_rad: float = 0.0) -> None:
        self.manual_laptop_position = np.asarray(position, dtype=float).reshape(3)
        self.manual_laptop_yaw = float(yaw_rad)

    def calibrate_laptop(self, local_pose: Pose) -> None:
        self.laptop_initial_local = Transform.from_pose(local_pose)

    def calibrate_phone(self, local_pose: Pose, world_from_phone_at_start: Transform | None = None) -> None:
        self.phone_initial_local = Transform.from_pose(local_pose)
        if world_from_phone_at_start is not None:
            self.world_from_phone_at_start = world_from_phone_at_start

    def world_from_phone(self, phone_local_pose: Pose | None = None) -> Transform:
        if self.manual_phone_position is not None:
            yaw = self.manual_phone_yaw
            if yaw is None and phone_local_pose is not None:
                yaw = quaternion_to_yaw(phone_local_pose.quaternion_xyzw)
            return Transform.from_position_and_yaw(self.manual_phone_position, yaw or 0.0)

        if self.phone_initial_local is None:
            raise RuntimeError("Phone has not been calibrated")
        if phone_local_pose is None:
            return self.world_from_phone_at_start
        delta = Transform.from_pose(phone_local_pose)
        return Transform(self.world_from_phone_at_start.matrix @ self.phone_initial_local.inverse().matrix @ delta.matrix)

    def world_from_laptop(self, laptop_local_pose: Pose | None = None) -> Transform:
        if self.laptop_initial_local is not None and laptop_local_pose is not None:
            return Transform(self.laptop_initial_local.inverse().matrix @ Transform.from_pose(laptop_local_pose).matrix)
        # Default / manual laptop pose
        yaw = self.manual_laptop_yaw
        if laptop_local_pose is not None and self.laptop_initial_local is None:
            yaw = quaternion_to_yaw(laptop_local_pose.quaternion_xyzw)
        return Transform.from_position_and_yaw(self.manual_laptop_position, yaw)

    def target_in_laptop(
        self,
        target_phone: np.ndarray,
        phone_local_pose: Pose | None = None,
        laptop_local_pose: Pose | None = None,
    ) -> tuple[np.ndarray, np.ndarray]:
        world = self.world_from_phone(phone_local_pose).apply(target_phone)
        laptop = self.world_from_laptop(laptop_local_pose).inverse().apply(world)
        return world, laptop

