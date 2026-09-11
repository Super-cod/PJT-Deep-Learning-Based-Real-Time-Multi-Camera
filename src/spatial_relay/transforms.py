from __future__ import annotations

from dataclasses import dataclass
import numpy as np

from .models import Pose


def quaternion_to_rotation(q_xyzw: np.ndarray) -> np.ndarray:
    x, y, z, w = np.asarray(q_xyzw, dtype=float)
    return np.array([
        [1 - 2*(y*y + z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
        [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
        [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)],
    ])


def rotation_to_quaternion(r: np.ndarray) -> np.ndarray:
    """Return a normalized [x, y, z, w] quaternion."""
    r = np.asarray(r, dtype=float)
    trace = np.trace(r)
    if trace > 0:
        s = 2 * np.sqrt(trace + 1.0); w = .25 * s
        x = (r[2, 1] - r[1, 2]) / s; y = (r[0, 2] - r[2, 0]) / s; z = (r[1, 0] - r[0, 1]) / s
    else:
        i = int(np.argmax(np.diag(r)))
        if i == 0:
            s = 2 * np.sqrt(1 + r[0,0] - r[1,1] - r[2,2]); x=.25*s; y=(r[0,1]+r[1,0])/s; z=(r[0,2]+r[2,0])/s; w=(r[2,1]-r[1,2])/s
        elif i == 1:
            s = 2 * np.sqrt(1 + r[1,1] - r[0,0] - r[2,2]); x=(r[0,1]+r[1,0])/s; y=.25*s; z=(r[1,2]+r[2,1])/s; w=(r[0,2]-r[2,0])/s
        else:
            s = 2 * np.sqrt(1 + r[2,2] - r[0,0] - r[1,1]); x=(r[0,2]+r[2,0])/s; y=(r[1,2]+r[2,1])/s; z=.25*s; w=(r[1,0]-r[0,1])/s
    q = np.array([x, y, z, w]); return q / np.linalg.norm(q)


def quaternion_conjugate(q: np.ndarray) -> np.ndarray:
    x, y, z, w = np.asarray(q, dtype=float)
    return np.array([-x, -y, -z, w], dtype=float)


def quaternion_multiply(q1: np.ndarray, q2: np.ndarray) -> np.ndarray:
    x1, y1, z1, w1 = np.asarray(q1, dtype=float)
    x2, y2, z2, w2 = np.asarray(q2, dtype=float)
    return np.array([
        w1*x2 + x1*w2 + y1*z2 - z1*y2,
        w1*y2 - x1*z2 + y1*w2 + z1*x2,
        w1*z2 + x1*y2 - y1*x2 + z1*w2,
        w1*w2 - x1*x2 - y1*y2 - z1*z2,
    ], dtype=float)


def quaternion_normalize(q: np.ndarray) -> np.ndarray:
    q = np.asarray(q, dtype=float)
    norm = np.linalg.norm(q)
    return q / norm if norm > 1e-12 else np.array([0., 0., 0., 1.], dtype=float)


def quaternion_nlerp(q1: np.ndarray, q2: np.ndarray, t: float) -> np.ndarray:
    q1 = np.asarray(q1, dtype=float)
    q2 = np.asarray(q2, dtype=float)
    if np.dot(q1, q2) < 0:
        q2 = -q2
    res = (1.0 - t) * q1 + t * q2
    return quaternion_normalize(res)


def quaternion_power(q: np.ndarray, power: float) -> np.ndarray:
    q = quaternion_normalize(q)
    x, y, z, w = q
    w = float(np.clip(w, -1.0, 1.0))
    theta = np.arccos(w)
    sin_theta = np.sin(theta)
    if abs(sin_theta) < 1e-7:
        return np.array([0., 0., 0., 1.], dtype=float)
    v = np.array([x, y, z], dtype=float) / sin_theta
    new_theta = theta * power
    return np.array([*(v * np.sin(new_theta)), np.cos(new_theta)], dtype=float)


def quaternion_to_axis_angle(q: np.ndarray) -> tuple[np.ndarray, float]:
    """Return (unit_axis, angle_rad) for given quaternion."""
    q = quaternion_normalize(q)
    x, y, z, w = q
    w = float(np.clip(w, -1.0, 1.0))
    angle = 2.0 * float(np.arccos(w))
    s = np.sqrt(max(0.0, 1.0 - w * w))
    if s < 1e-7:
        axis = np.array([1.0, 0.0, 0.0], dtype=float)
    else:
        axis = np.array([x, y, z], dtype=float) / s
    return axis, angle



def yaw_to_quaternion(yaw_rad: float) -> np.ndarray:
    """Yaw rotation around +Y where yaw=0 is +Z forward, yaw=+pi/2 is +X right."""
    half = yaw_rad / 2.0
    return np.array([0.0, np.sin(half), 0.0, np.cos(half)], dtype=float)


def quaternion_to_yaw(q_xyzw: np.ndarray) -> float:
    """Extract yaw angle (radians) around +Y axis from [x, y, z, w] quaternion."""
    x, y, z, w = np.asarray(q_xyzw, dtype=float)
    return float(np.arctan2(2.0 * (x * z + y * w), 1.0 - 2.0 * (x * x + y * y)))


def rotation_matrix_from_yaw(yaw_rad: float) -> np.ndarray:
    """3x3 rotation matrix for yaw angle around +Y:
    yaw=0 -> forward is +Z
    yaw=+pi/2 -> forward is +X
    """
    c = np.cos(yaw_rad)
    s = np.sin(yaw_rad)
    return np.array([
        [c, 0.0, s],
        [0.0, 1.0, 0.0],
        [-s, 0.0, c]
    ], dtype=float)


def local_to_world(device_pos: np.ndarray, yaw_rad: float, local_point: np.ndarray) -> np.ndarray:
    """Transform point from device camera-local (+Z depth, +X right, +Y up) to world."""
    r = rotation_matrix_from_yaw(yaw_rad)
    dp = np.asarray(device_pos, dtype=float).reshape(3)
    lp = np.asarray(local_point, dtype=float).reshape(-1, 3)
    world = dp + (r @ lp.T).T
    return world.reshape(np.asarray(local_point).shape)


def world_to_local(device_pos: np.ndarray, yaw_rad: float, world_point: np.ndarray) -> np.ndarray:
    """Transform point from world to device camera-local (+Z depth, +X right, +Y up)."""
    r = rotation_matrix_from_yaw(yaw_rad)
    dp = np.asarray(device_pos, dtype=float).reshape(3)
    wp = np.asarray(world_point, dtype=float).reshape(-1, 3)
    local = (r.T @ (wp - dp).T).T
    return local.reshape(np.asarray(world_point).shape)


@dataclass(frozen=True)
class Transform:
    """Homogeneous transform T_target_source: source point into target frame."""
    matrix: np.ndarray

    def __post_init__(self) -> None:
        object.__setattr__(self, "matrix", np.asarray(self.matrix, dtype=float).reshape(4, 4))

    @classmethod
    def identity(cls) -> "Transform": return cls(np.eye(4))

    @classmethod
    def from_pose(cls, pose: Pose) -> "Transform":
        m = np.eye(4); m[:3, :3] = quaternion_to_rotation(pose.quaternion_xyzw); m[:3, 3] = pose.position
        return cls(m)

    @classmethod
    def from_rt(cls, rotation: np.ndarray, translation: np.ndarray) -> "Transform":
        m = np.eye(4); m[:3, :3] = rotation; m[:3, 3] = np.asarray(translation).reshape(3); return cls(m)

    @classmethod
    def from_position_and_yaw(cls, position: np.ndarray, yaw_rad: float) -> "Transform":
        m = np.eye(4)
        m[:3, :3] = rotation_matrix_from_yaw(yaw_rad)
        m[:3, 3] = np.asarray(position, dtype=float).reshape(3)
        return cls(m)

    def inverse(self) -> "Transform":
        r, t = self.matrix[:3, :3], self.matrix[:3, 3]
        return Transform.from_rt(r.T, -r.T @ t)

    def then(self, next_transform: "Transform") -> "Transform":
        """Compose self then next_transform."""
        return Transform(next_transform.matrix @ self.matrix)

    def apply(self, points: np.ndarray) -> np.ndarray:
        p = np.asarray(points, dtype=float); flat = p.reshape(-1, 3)
        out = (self.matrix @ np.c_[flat, np.ones(len(flat))].T).T[:, :3]
        return out.reshape(p.shape)

    def pose(self) -> Pose:
        return Pose(self.matrix[:3, 3], rotation_to_quaternion(self.matrix[:3, :3]))


def arkit_to_world(position: np.ndarray, quaternion_xyzw: np.ndarray) -> Transform:
    """Explicit converter hook. ARKit data must first be aligned to marker/world."""
    return Transform.from_pose(Pose(position, quaternion_xyzw))

