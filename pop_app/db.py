from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from collections.abc import Iterator
from typing import Iterable

from .config import settings
from .replay_parser import FrameState, RecordedRoom, RoomKey, build_action_sequence, refine_actions_with_motion


DEBUG_PLAYER_NAME_PREFIXES = (
    "ActionFix_",
    "Batch_",
    "CoverFix_",
    "HeroPoseFix_",
    "HeroRoute",
    "HeroSpriteDbg_",
    "Move",
    "Proof_",
    "Search",
    "Test",
    "TimelineScrub",
    "TimelineSeek",
    "Tmp",
)
DEBUG_PLAYER_NAME_EXACT = {"Diag", "Deralive"}


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(settings.db_path)
    connection.row_factory = sqlite3.Row
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def is_debug_player_name(player_name: str) -> bool:
    clean_name = str(player_name or "").strip()
    if not clean_name:
        return False
    if clean_name in DEBUG_PLAYER_NAME_EXACT:
        return True
    return any(clean_name.startswith(prefix) for prefix in DEBUG_PLAYER_NAME_PREFIXES)


def is_debug_source_label(source_label: str | None) -> bool:
    return False


def should_hide_run(player_name: str, source_label: str | None = None) -> bool:
    return is_debug_player_name(player_name) or is_debug_source_label(source_label)


def init_db() -> None:
    settings.runtime_dir.mkdir(parents=True, exist_ok=True)
    with connect() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS room_runs (
                player_name TEXT NOT NULL,
                scene_name TEXT NOT NULL,
                entry_from_scene TEXT NOT NULL,
                exit_to_scene TEXT NOT NULL,
                total_time REAL NOT NULL,
                frame_count INTEGER NOT NULL,
                frames_json TEXT NOT NULL,
                states_json TEXT NOT NULL DEFAULT '[]',
                actions_json TEXT NOT NULL DEFAULT '[]',
                source_label TEXT,
                is_hidden INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (player_name, scene_name, entry_from_scene, exit_to_scene)
            );

            CREATE INDEX IF NOT EXISTS idx_room_runs_route
            ON room_runs(scene_name, entry_from_scene, exit_to_scene, total_time);
            """
        )
        columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(room_runs)").fetchall()
        }
        if "states_json" not in columns:
            connection.execute(
                "ALTER TABLE room_runs ADD COLUMN states_json TEXT NOT NULL DEFAULT '[]'"
            )
        if "actions_json" not in columns:
            connection.execute(
                "ALTER TABLE room_runs ADD COLUMN actions_json TEXT NOT NULL DEFAULT '[]'"
            )
        if "is_hidden" not in columns:
            connection.execute(
                "ALTER TABLE room_runs ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0"
            )

        rows = connection.execute(
            """
            SELECT rowid, player_name, source_label
            FROM room_runs
            WHERE COALESCE(is_hidden, 0) = 0
            """
        ).fetchall()
        rows_to_hide = [
            (int(row["rowid"]),)
            for row in rows
            if should_hide_run(str(row["player_name"] or ""), row["source_label"])
        ]
        if rows_to_hide:
            connection.executemany(
                "UPDATE room_runs SET is_hidden = 1 WHERE rowid = ?",
                rows_to_hide,
            )
        rows_to_unhide = [
            (int(row["rowid"]),)
            for row in connection.execute(
                """
                SELECT rowid, player_name, source_label
                FROM room_runs
                WHERE COALESCE(is_hidden, 0) = 1
                """
            ).fetchall()
            if not should_hide_run(str(row["player_name"] or ""), row["source_label"])
        ]
        if rows_to_unhide:
            connection.executemany(
                "UPDATE room_runs SET is_hidden = 0 WHERE rowid = ?",
                rows_to_unhide,
            )


def upsert_personal_bests(
    player_name: str,
    rooms: Iterable[RecordedRoom],
    source_label: str,
    hidden: bool = False,
) -> dict[str, int]:
    summary = {"inserted": 0, "improved": 0, "skipped": 0}
    with connect() as connection:
        for room in rooms:
            existing = connection.execute(
                """
                SELECT total_time
                FROM room_runs
                WHERE player_name = ?
                  AND scene_name = ?
                  AND entry_from_scene = ?
                  AND exit_to_scene = ?
                """,
                (
                    player_name,
                    room.key.scene_name,
                    room.key.entry_from_scene,
                    room.key.exit_to_scene,
                ),
            ).fetchone()

            if existing is not None and float(existing["total_time"]) <= room.total_time:
                summary["skipped"] += 1
                continue

            payload = json.dumps(room.frames)
            states_payload = json.dumps(
                [
                    {
                        "x": state.x,
                        "y": state.y,
                        "facing_right": state.facing_right,
                        "anim_clip": state.anim_clip,
                        "anim_frame": state.anim_frame,
                        "action": state.action,
                    }
                    for state in room.frame_states
                ]
            )
            actions_payload = json.dumps(
                [
                    {
                        "start_frame": segment.start_frame,
                        "end_frame": segment.end_frame,
                        "action": segment.action,
                        "clip": segment.clip,
                    }
                    for segment in room.action_sequence
                ]
            )
            connection.execute(
                """
                INSERT INTO room_runs (
                    player_name,
                    scene_name,
                    entry_from_scene,
                    exit_to_scene,
                    total_time,
                    frame_count,
                    frames_json,
                    states_json,
                    actions_json,
                    source_label,
                    is_hidden,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(player_name, scene_name, entry_from_scene, exit_to_scene)
                DO UPDATE SET
                    total_time = excluded.total_time,
                    frame_count = excluded.frame_count,
                    frames_json = excluded.frames_json,
                    states_json = excluded.states_json,
                    actions_json = excluded.actions_json,
                    source_label = excluded.source_label,
                    is_hidden = excluded.is_hidden,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    player_name,
                    room.key.scene_name,
                    room.key.entry_from_scene,
                    room.key.exit_to_scene,
                    room.total_time,
                    room.frame_count,
                    payload,
                    states_payload,
                    actions_payload,
                    source_label,
                    1 if hidden else 0,
                ),
            )
            if existing is None:
                summary["inserted"] += 1
            else:
                summary["improved"] += 1
    return summary


def list_room_summaries(include_hidden: bool = False) -> dict[str, object]:
    filter_sql = "" if include_hidden else "WHERE COALESCE(is_hidden, 0) = 0"
    with connect() as connection:
        room_rows = connection.execute(
            f"""
            SELECT
                scene_name,
                entry_from_scene,
                exit_to_scene,
                COUNT(*) AS player_count,
                MIN(total_time) AS best_time,
                MAX(updated_at) AS last_updated
            FROM room_runs
            {filter_sql}
            GROUP BY scene_name, entry_from_scene, exit_to_scene
            ORDER BY scene_name, best_time, entry_from_scene, exit_to_scene
            """
        ).fetchall()

        stats = connection.execute(
            f"""
            SELECT
                COUNT(*) AS run_count,
                COUNT(DISTINCT player_name) AS player_count,
                COUNT(DISTINCT scene_name) AS scene_count,
                COUNT(DISTINCT scene_name || '|' || entry_from_scene || '|' || exit_to_scene) AS route_count
            FROM room_runs
            {filter_sql}
            """
        ).fetchone()

    return {
        "stats": {
            "run_count": int(stats["run_count"] or 0),
            "player_count": int(stats["player_count"] or 0),
            "scene_count": int(stats["scene_count"] or 0),
            "route_count": int(stats["route_count"] or 0),
        },
        "rooms": [
            {
                "scene_name": row["scene_name"],
                "entry_from_scene": row["entry_from_scene"],
                "exit_to_scene": row["exit_to_scene"],
                "player_count": int(row["player_count"]),
                "best_time": float(row["best_time"]),
                "last_updated": row["last_updated"],
            }
            for row in room_rows
        ],
    }


def get_room_runs(key: RoomKey, include_hidden: bool = False) -> list[dict[str, object]]:
    hidden_filter_sql = "" if include_hidden else "AND COALESCE(is_hidden, 0) = 0"
    with connect() as connection:
        rows = connection.execute(
            f"""
            SELECT
                player_name,
                total_time,
                frame_count,
                frames_json,
                states_json,
                actions_json,
                source_label,
                is_hidden,
                updated_at
            FROM room_runs
            WHERE scene_name = ?
              AND entry_from_scene = ?
              AND exit_to_scene = ?
              {hidden_filter_sql}
            ORDER BY total_time ASC, player_name ASC
            """,
            (key.scene_name, key.entry_from_scene, key.exit_to_scene),
        ).fetchall()

    return [
        _run_payload_from_row(row)
        for row in rows
    ]


def _run_payload_from_row(row: sqlite3.Row) -> dict[str, object]:
    frames = json.loads(row["frames_json"])
    frame_states = json.loads(row["states_json"] or "[]")
    action_sequence = json.loads(row["actions_json"] or "[]")

    if not frame_states:
        frame_states = [
            {
                "x": point[0],
                "y": point[1],
                "facing_right": True,
                "anim_clip": "",
                "anim_frame": 0,
                "action": "move",
            }
            for point in frames
        ]
    if not action_sequence and frame_states:
        action_sequence = [
            {
                "start_frame": 0,
                "end_frame": len(frame_states) - 1,
                "action": frame_states[0].get("action", "move"),
                "clip": frame_states[0].get("anim_clip", ""),
            }
        ]

    has_clip_info = any((state.get("anim_clip") or "").strip() for state in frame_states)
    needs_motion_refine = frame_states and not has_clip_info and all(
        (state.get("action") or "move") in {"move", "idle"} for state in frame_states
    )
    if needs_motion_refine:
        refined_states = refine_actions_with_motion(
            [
                FrameState(
                    x=float(state.get("x", 0.0)),
                    y=float(state.get("y", 0.0)),
                    facing_right=bool(state.get("facing_right", True)),
                    anim_clip=str(state.get("anim_clip", "")),
                    anim_frame=int(state.get("anim_frame", 0) or 0),
                    action=str(state.get("action", "move") or "move"),
                )
                for state in frame_states
            ]
        )
        frame_states = [
            {
                "x": state.x,
                "y": state.y,
                "facing_right": state.facing_right,
                "anim_clip": state.anim_clip,
                "anim_frame": state.anim_frame,
                "action": state.action,
            }
            for state in refined_states
        ]
        action_sequence = [
            {
                "start_frame": segment.start_frame,
                "end_frame": segment.end_frame,
                "action": segment.action,
                "clip": segment.clip,
            }
            for segment in build_action_sequence(refined_states)
        ]

    return {
        "player_name": row["player_name"],
        "total_time": float(row["total_time"]),
        "frame_count": int(row["frame_count"]),
        "frames": frames,
        "frame_states": frame_states,
        "action_sequence": action_sequence,
        "source_label": row["source_label"],
        "is_hidden": bool(row["is_hidden"]),
        "updated_at": row["updated_at"],
    }
