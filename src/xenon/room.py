"""Storage for the scanned room model and the shared ARWorldMap.

The LiDAR phone scans the rooms once with RoomPlan and uploads:
  * ``room.json``  — simplified walls / doors / windows / objects / floors, all in
    the ARWorldMap frame, rendered by the laptop's 3D view;
  * ``worldmap.arexperience`` — the archived ARWorldMap that every other phone
    downloads to relocalize into the same coordinate frame.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

# Override with XENON_ROOM_DIR (e.g. for demos) to keep a real scan untouched.
DEFAULT_DIR = Path(os.environ.get("XENON_ROOM_DIR") or Path(__file__).resolve().parents[2] / "data" / "room")
MAX_ROOM_BYTES = 5 * 1024 * 1024
MAX_WORLDMAP_BYTES = 100 * 1024 * 1024


class RoomStore:
    def __init__(self, directory: Path = DEFAULT_DIR) -> None:
        self.directory = Path(directory)

    @property
    def room_path(self) -> Path:
        return self.directory / "room.json"

    @property
    def worldmap_path(self) -> Path:
        return self.directory / "worldmap.arexperience"

    def version(self) -> int:
        """Changes whenever a new room is saved (ms mtime); 0 if none."""
        try:
            return int(self.room_path.stat().st_mtime * 1000)
        except FileNotFoundError:
            return 0

    def save_room(self, raw: bytes) -> dict:
        if len(raw) > MAX_ROOM_BYTES:
            raise ValueError("room model too large")
        room = json.loads(raw)
        if not isinstance(room, dict) or not isinstance(room.get("walls", []), list):
            raise ValueError("room model must be an object with a 'walls' list")
        self.directory.mkdir(parents=True, exist_ok=True)
        tmp = self.room_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(room))
        tmp.replace(self.room_path)
        return room

    def load_room(self) -> dict | None:
        try:
            return json.loads(self.room_path.read_text())
        except FileNotFoundError:
            return None

    def save_worldmap(self, raw: bytes) -> int:
        if not raw:
            raise ValueError("empty world map")
        if len(raw) > MAX_WORLDMAP_BYTES:
            raise ValueError("world map too large")
        self.directory.mkdir(parents=True, exist_ok=True)
        tmp = self.worldmap_path.with_suffix(".tmp")
        tmp.write_bytes(raw)
        tmp.replace(self.worldmap_path)
        return len(raw)

    def has_worldmap(self) -> bool:
        return self.worldmap_path.exists()
