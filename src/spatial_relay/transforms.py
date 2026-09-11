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
