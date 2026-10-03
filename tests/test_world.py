"""Shared-map mode: several phones in one world frame, fused into one set of people."""
from __future__ import annotations

import json

import numpy as np
import pytest

from xenon.room import RoomStore
from xenon.world import ReportedPerson, WorldState, fuse


def person(x: float, z: float, conf: float = 0.9, joints: dict | None = None) -> dict:
    return {
        "positionWorld": [x, 0.9, z],
        "jointsWorld": [
            {"name": name, "position": pos, "confidence": conf}
            for name, pos in (joints or {"nose": [x, 1.6, z]}).items()
        ],
        "confidence": conf,
    }


def pose(x: float, z: float) -> dict:
    return {"localPose": {"position": [x, 1.5, z], "quaternionXyzw": [0, 0, 0, 1], "timestampNs": 1}}


def test_same_person_from_two_phones_is_fused_once() -> None:
    world = WorldState()
    world.update_people("A", {"people": [person(1.0, 2.0)]}, now=0.0)
    world.update_people("B", {"people": [person(1.2, 2.1)]}, now=0.0)
    people = world.tick(now=0.05)["people"]
    assert len(people) == 1
    assert people[0]["seenBy"] == ["A", "B"]
    assert people[0]["position"][0] == pytest.approx(1.1, abs=0.01)


def test_different_people_stay_separate() -> None:
    world = WorldState()
    world.update_people("A", {"people": [person(0.0, 2.0)]}, now=0.0)
    world.update_people("B", {"people": [person(3.0, 2.0)]}, now=0.0)
    people = world.tick(now=0.05)["people"]
    assert sorted(p["seenBy"][0] for p in people) == ["A", "B"]
    assert len({p["id"] for p in people}) == 2


def test_one_phone_never_merges_two_of_its_own_people() -> None:
    reports = [
        ("A", ReportedPerson(np.array([0.0, 0.9, 2.0]), {}, 0.9)),
        ("A", ReportedPerson(np.array([0.2, 0.9, 2.0]), {}, 0.8)),
    ]
    assert len(fuse(reports)) == 2


def test_stale_reports_are_dropped_but_ids_survive_briefly() -> None:
    world = WorldState()
    world.update_people("A", {"people": [person(1.0, 2.0)]}, now=0.0)
    first = world.tick(now=0.05)["people"][0]["id"]
    assert world.tick(now=1.0)["people"] == []  # A stopped reporting
    world.update_people("A", {"people": [person(1.05, 2.0)]}, now=1.1)
    assert world.tick(now=1.15)["people"][0]["id"] == first  # within tracker max age


def test_ids_stable_while_people_move_and_order_swaps() -> None:
    world = WorldState()
    world.update_people("A", {"people": [person(0.0, 2.0), person(2.0, 2.0)]}, now=0.0)
    ids = {round(p["position"][0]): p["id"] for p in world.tick(now=0.05)["people"]}
    world.update_people("A", {"people": [person(2.05, 2.0), person(0.05, 2.0)]}, now=0.1)
    again = {round(p["position"][0]): p["id"] for p in world.tick(now=0.15)["people"]}
    assert ids == again


def test_device_pose_and_online_state() -> None:
    world = WorldState()
    world.set_connected("A", True)
    world.update_hello("A", {"name": "Helmet A", "hasLidar": False})
    world.update_pose("A", pose(1.0, -2.0), now=0.0)
    dev = world.tick(now=0.1)["devices"][0]
    assert dev["name"] == "Helmet A" and dev["hasLidar"] is False
    assert dev["online"] and dev["position"] == [1.0, 1.5, -2.0]
    assert world.tick(now=10.0)["devices"][0]["online"] is False


def test_zero_quaternion_rejected() -> None:
    world = WorldState()
    with pytest.raises(ValueError):
        world.update_pose("A", {"localPose": {"position": [0, 0, 0], "quaternionXyzw": [0, 0, 0, 0]}})


def test_room_store_round_trip(tmp_path) -> None:
    store = RoomStore(tmp_path)
    assert store.version() == 0 and store.load_room() is None
    store.save_room(json.dumps({"walls": [{"dimensions": [4, 2.5, 0], "transform": list(range(16))}]}).encode())
    assert store.version() > 0
    assert store.load_room()["walls"][0]["dimensions"] == [4, 2.5, 0]
    with pytest.raises(ValueError):
        store.save_room(b'{"walls": 3}')
    assert store.save_worldmap(b"abc") == 3 and store.has_worldmap()


def test_hub_routes_two_phones_and_serves_room(tmp_path) -> None:
    testclient = pytest.importorskip("fastapi.testclient")
    from xenon import server as server_mod

    server_mod.hub = server_mod.RelayHub()
    server_mod.hub.rooms = RoomStore(tmp_path)
    with testclient.TestClient(server_mod.app) as client:
        assert client.get("/api/room").status_code == 404
        body = json.dumps({"walls": [{"dimensions": [3, 2.4, 0], "transform": np.eye(4).ravel().tolist()}]})
        assert client.post("/api/room", content=body).json()["ok"]
        assert client.get("/api/room").json()["room"]["walls"][0]["dimensions"] == [3, 2.4, 0]
        assert client.post("/api/worldmap", content=b"MAP").json()["bytes"] == 3
        assert client.get("/api/worldmap").content == b"MAP"

        with client.websocket_connect("/ws/observer?device=A") as a, \
                client.websocket_connect("/ws/observer?device=B") as b:
            for ws, x in ((a, 1.0), (b, 1.2)):
                ws.send_json({"type": "pose", "frame": "map", "sequence": 1, **pose(x, 0.0)})
                assert ws.receive_json()["type"] == "ack"
                ws.send_json({"type": "detections", "frame": "map", "sequence": 2, "people": [person(x, 2.0)]})
                assert ws.receive_json()["type"] == "ack"
            assert sorted(server_mod.hub.observers) == ["A", "B"]
            packet = server_mod.hub.world.tick()
            assert len(packet["people"]) == 1 and packet["people"][0]["seenBy"] == ["A", "B"]
        assert server_mod.hub.observers == {}


def test_shared_map_phone_receives_world_packets(tmp_path) -> None:
    testclient = pytest.importorskip("fastapi.testclient")
    from xenon import server as server_mod

    server_mod.hub = server_mod.RelayHub()
    server_mod.hub.rooms = RoomStore(tmp_path)
    with testclient.TestClient(server_mod.app) as client:
        with client.websocket_connect("/ws/observer?device=A") as a, \
                client.websocket_connect("/ws/observer?device=B") as b:
            b.send_json({"type": "pose", "frame": "map", "sequence": 1, **pose(3.0, 0.0)})
            b.send_json({"type": "detections", "frame": "map", "sequence": 2, "people": [person(3.0, 2.0)]})
            a.send_json({"type": "pose", "frame": "map", "sequence": 1, **pose(-3.0, 0.0)})
            # Phone A sees nobody itself but must learn about B's person from the hub.
            for _ in range(60):
                msg = a.receive_json()
                if msg["type"] == "world" and msg["people"]:
                    assert msg["people"][0]["seenBy"] == ["B"]
                    assert {d["id"] for d in msg["devices"]} == {"A", "B"}
                    break
            else:
                pytest.fail("phone A never received a world packet with B's person")
