"""Persistent shared-frame calibration for independent AR tracking sessions.

Every AR device tracks in a private, arbitrary local frame. At calibration we
store each device's local pose and declare the laptop camera pose to be W=I.
Later poses are expressed as a delta from that saved pose, so the private AR
origin never leaks into the shared coordinate system.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

import numpy as np

from .models import Pose
from .transforms import Transform


class Device(str, Enum):
    PHONE = "phone"
    LAPTOP = "laptop"


@dataclass
class SharedFrameCalibration:
    """Maps a device's private tracking frame into W, the laptop-at-start frame."""
    phone_initial_local: Transform | None = None
    laptop_initial_local: Transform | None = None
    # Exact phone-to-laptop offset measured from a fiducial board. Identity is
    # valid only when the cameras were co-located and aligned at calibration.
    world_from_phone_at_start: Transform = Transform.identity()

    @property
    def ready(self) -> bool:
        return self.phone_initial_local is not None and self.laptop_initial_local is not None

    def calibrate_laptop(self, local_pose: Pose) -> None:
        self.laptop_initial_local = Transform.from_pose(local_pose)

    def calibrate_phone(self, local_pose: Pose, world_from_phone_at_start: Transform | None = None) -> None:
        self.phone_initial_local = Transform.from_pose(local_pose)
        if world_from_phone_at_start is not None:
            self.world_from_phone_at_start = world_from_phone_at_start

    def world_from_phone(self, phone_local_pose: Pose) -> Transform:
        if self.phone_initial_local is None:
            raise RuntimeError("Phone has not been calibrated")
        # T_W_P(t) = T_W_P(0) × inverse(T_Mp_P(0)) × T_Mp_P(t)
        delta = Transform.from_pose(phone_local_pose)
        return Transform(self.world_from_phone_at_start.matrix @ self.phone_initial_local.inverse().matrix @ delta.matrix)

    def world_from_laptop(self, laptop_local_pose: Pose) -> Transform:
        if self.laptop_initial_local is None:
            raise RuntimeError("Laptop has not been calibrated")
        # W is the laptop camera frame at calibration, thus T_W_L(0) = I.
        return Transform(self.laptop_initial_local.inverse().matrix @ Transform.from_pose(laptop_local_pose).matrix)

    def target_in_laptop(self, target_phone: np.ndarray, phone_local_pose: Pose, laptop_local_pose: Pose) -> tuple[np.ndarray, np.ndarray]:
        world = self.world_from_phone(phone_local_pose).apply(target_phone)
        laptop = self.world_from_laptop(laptop_local_pose).inverse().apply(world)
        return world, laptop
