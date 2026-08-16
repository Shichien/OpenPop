from __future__ import annotations

import json
import math
import re
import sqlite3
import uuid
from typing import Iterable

from . import db
from .replay_parser import RecordedRoom


HANDLE_PATTERN = re.compile(r"[^a-z0-9_-]+")
MAX_ROOM_FRAMES = 240_000
MAX_ROOM_SECONDS = 3_600.0


def init_social_db() -> None:
    with db.connect() as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                handle TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                avatar_url TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                disabled_at TEXT
            );

            CREATE TABLE IF NOT EXISTS oauth_identities (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                provider TEXT NOT NULL,
                provider_user_id TEXT NOT NULL,
                provider_login TEXT NOT NULL,
                provider_avatar_url TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(provider, provider_user_id)
            );

            CREATE TABLE IF NOT EXISTS replay_uploads (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                original_filename TEXT NOT NULL,
                game_version TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS replay_room_runs (
                id TEXT PRIMARY KEY,
                upload_id TEXT NOT NULL REFERENCES replay_uploads(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                scene_name TEXT NOT NULL,
                entry_from_scene TEXT NOT NULL,
                exit_to_scene TEXT NOT NULL,
                total_time REAL NOT NULL,
                frame_count INTEGER NOT NULL,
                frames_json TEXT NOT NULL,
                states_json TEXT NOT NULL,
                actions_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_social_runs_scene_time
            ON replay_room_runs(scene_name, total_time, created_at);

            CREATE INDEX IF NOT EXISTS idx_social_runs_user
            ON replay_room_runs(user_id, created_at);
            """
        )


def _normalized_handle(login: str) -> str:
    normalized = HANDLE_PATTERN.sub("-", str(login or "player").strip().lower()).strip("-_")
    return normalized[:28] or "player"


def _available_handle(connection: sqlite3.Connection, login: str, provider_user_id: str) -> str:
    base = _normalized_handle(login)
    candidate = base
    suffix = str(provider_user_id)[-6:].lower()
    index = 0
    while connection.execute("SELECT 1 FROM users WHERE handle = ?", (candidate,)).fetchone():
        index += 1
        tail = suffix if index == 1 else f"{suffix}-{index}"
        candidate = f"{base[: max(1, 31 - len(tail))]}-{tail}"
    return candidate


def upsert_oauth_user(
    provider: str,
    provider_user_id: str,
    provider_login: str,
    display_name: str,
    avatar_url: str,
) -> dict[str, object]:
    with db.connect() as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        identity = connection.execute(
            """
            SELECT user_id
            FROM oauth_identities
            WHERE provider = ? AND provider_user_id = ?
            """,
            (provider, provider_user_id),
        ).fetchone()
        if identity:
            user_id = str(identity["user_id"])
            connection.execute(
                """
                UPDATE users
                SET display_name = ?, avatar_url = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (display_name, avatar_url, user_id),
            )
            connection.execute(
                """
                UPDATE oauth_identities
                SET provider_login = ?, provider_avatar_url = ?, updated_at = CURRENT_TIMESTAMP
                WHERE provider = ? AND provider_user_id = ?
                """,
                (provider_login, avatar_url, provider, provider_user_id),
            )
        else:
            user_id = uuid.uuid4().hex
            handle = _available_handle(connection, provider_login, provider_user_id)
            connection.execute(
                """
                INSERT INTO users (id, handle, display_name, avatar_url)
                VALUES (?, ?, ?, ?)
                """,
                (user_id, handle, display_name, avatar_url),
            )
            connection.execute(
                """
                INSERT INTO oauth_identities (
                    id, user_id, provider, provider_user_id, provider_login, provider_avatar_url
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (uuid.uuid4().hex, user_id, provider, provider_user_id, provider_login, avatar_url),
            )
    user = get_user(user_id)
    if user is None:
        raise RuntimeError("OAuth user was not persisted")
    return user


def get_user(user_id: str) -> dict[str, object] | None:
    with db.connect() as connection:
        row = connection.execute(
            """
            SELECT id, handle, display_name, avatar_url, created_at
            FROM users
            WHERE id = ? AND disabled_at IS NULL
            """,
            (user_id,),
        ).fetchone()
        if not row:
            return None
        identities = connection.execute(
            """
            SELECT provider, provider_login
            FROM oauth_identities
            WHERE user_id = ?
            ORDER BY created_at
            """,
            (user_id,),
        ).fetchall()
    return {
        "id": row["id"],
        "handle": row["handle"],
        "display_name": row["display_name"],
        "avatar_url": row["avatar_url"],
        "created_at": row["created_at"],
        "providers": [
            {"provider": identity["provider"], "login": identity["provider_login"]}
            for identity in identities
        ],
    }


def validate_rooms(
    rooms: Iterable[RecordedRoom],
    allowed_routes: dict[str, tuple[str, str]],
) -> list[RecordedRoom]:
    validated = list(rooms)
    if not validated:
        raise ValueError("Replay 中没有可用房间")
    if len(validated) > 8:
        raise ValueError("单次上传包含的房间数量过多")
    for room in validated:
        expected_route = allowed_routes.get(room.key.scene_name)
        actual_route = (room.key.entry_from_scene, room.key.exit_to_scene)
        if expected_route != actual_route:
            raise ValueError(f"Replay 房间路线无效：{room.key.scene_name}")
        if not math.isfinite(room.total_time) or room.total_time <= 0 or room.total_time > MAX_ROOM_SECONDS:
            raise ValueError(f"Replay 房间用时无效：{room.key.scene_name}")
        if room.frame_count < 2 or room.frame_count > MAX_ROOM_FRAMES:
            raise ValueError(f"Replay 帧数无效：{room.key.scene_name}")
        for state in room.frame_states:
            if not math.isfinite(state.x) or not math.isfinite(state.y):
                raise ValueError(f"Replay 坐标无效：{room.key.scene_name}")
    return validated


def _room_json(room: RecordedRoom) -> tuple[str, str, str]:
    frames_json = json.dumps(room.frames, separators=(",", ":"))
    states_json = json.dumps(
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
        ],
        separators=(",", ":"),
    )
    actions_json = json.dumps(
        [
            {
                "start_frame": segment.start_frame,
                "end_frame": segment.end_frame,
                "action": segment.action,
                "clip": segment.clip,
            }
            for segment in room.action_sequence
        ],
        separators=(",", ":"),
    )
    return frames_json, states_json, actions_json


def store_upload(
    user_id: str,
    original_filename: str,
    rooms: Iterable[RecordedRoom],
    game_version: str = "",
) -> dict[str, object]:
    upload_id = uuid.uuid4().hex
    run_ids: list[str] = []
    with db.connect() as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute(
            """
            INSERT INTO replay_uploads (id, user_id, original_filename, game_version)
            VALUES (?, ?, ?, ?)
            """,
            (upload_id, user_id, original_filename, game_version),
        )
        for room in rooms:
            run_id = uuid.uuid4().hex
            run_ids.append(run_id)
            frames_json, states_json, actions_json = _room_json(room)
            connection.execute(
                """
                INSERT INTO replay_room_runs (
                    id, upload_id, user_id, scene_name, entry_from_scene, exit_to_scene,
                    total_time, frame_count, frames_json, states_json, actions_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    upload_id,
                    user_id,
                    room.key.scene_name,
                    room.key.entry_from_scene,
                    room.key.exit_to_scene,
                    room.total_time,
                    room.frame_count,
                    frames_json,
                    states_json,
                    actions_json,
                ),
            )
    return {"upload_id": upload_id, "run_ids": run_ids, "room_count": len(run_ids)}


def list_leaderboard(scene_name: str, limit: int = 100) -> list[dict[str, object]]:
    with db.connect() as connection:
        rows = connection.execute(
            """
            WITH ranked AS (
                SELECT
                    runs.*,
                    ROW_NUMBER() OVER (
                        PARTITION BY runs.user_id
                        ORDER BY runs.total_time ASC, runs.created_at ASC
                    ) AS user_rank
                FROM replay_room_runs AS runs
                WHERE runs.scene_name = ?
            )
            SELECT
                ranked.id,
                ranked.total_time,
                ranked.frame_count,
                ranked.entry_from_scene,
                ranked.exit_to_scene,
                ranked.created_at,
                users.id AS user_id,
                users.handle,
                users.display_name,
                users.avatar_url,
                COALESCE((
                    SELECT provider
                    FROM oauth_identities
                    WHERE oauth_identities.user_id = users.id
                    ORDER BY created_at
                    LIMIT 1
                ), '') AS provider
            FROM ranked
            JOIN users ON users.id = ranked.user_id
            WHERE ranked.user_rank = 1 AND users.disabled_at IS NULL
            ORDER BY ranked.total_time ASC, users.handle ASC
            LIMIT ?
            """,
            (scene_name, max(1, min(limit, 100))),
        ).fetchall()
    return [
        {
            "rank": index + 1,
            "run_id": row["id"],
            "total_time": float(row["total_time"]),
            "frame_count": int(row["frame_count"]),
            "entry_from_scene": row["entry_from_scene"],
            "exit_to_scene": row["exit_to_scene"],
            "created_at": row["created_at"],
            "user": {
                "id": row["user_id"],
                "handle": row["handle"],
                "display_name": row["display_name"],
                "avatar_url": row["avatar_url"],
                "provider": row["provider"],
            },
        }
        for index, row in enumerate(rows)
    ]


def get_replay(run_id: str) -> dict[str, object] | None:
    with db.connect() as connection:
        row = connection.execute(
            """
            SELECT
                runs.*, users.handle, users.display_name, users.avatar_url
            FROM replay_room_runs AS runs
            JOIN users ON users.id = runs.user_id
            WHERE runs.id = ? AND users.disabled_at IS NULL
            """,
            (run_id,),
        ).fetchone()
    if not row:
        return None
    return {
        "run_id": row["id"],
        "scene_name": row["scene_name"],
        "entry_from_scene": row["entry_from_scene"],
        "exit_to_scene": row["exit_to_scene"],
        "total_time": float(row["total_time"]),
        "frame_count": int(row["frame_count"]),
        "frames": json.loads(row["frames_json"]),
        "frame_states": json.loads(row["states_json"]),
        "action_sequence": json.loads(row["actions_json"]),
        "player_name": row["display_name"],
        "user": {
            "id": row["user_id"],
            "handle": row["handle"],
            "display_name": row["display_name"],
            "avatar_url": row["avatar_url"],
        },
        "created_at": row["created_at"],
    }


def list_user_uploads(user_id: str) -> list[dict[str, object]]:
    with db.connect() as connection:
        rows = connection.execute(
            """
            SELECT
                uploads.id,
                uploads.original_filename,
                uploads.game_version,
                uploads.created_at,
                COUNT(runs.id) AS room_count
            FROM replay_uploads AS uploads
            LEFT JOIN replay_room_runs AS runs ON runs.upload_id = uploads.id
            WHERE uploads.user_id = ?
            GROUP BY uploads.id
            ORDER BY uploads.created_at DESC
            """,
            (user_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def delete_upload(upload_id: str, user_id: str) -> bool:
    with db.connect() as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        cursor = connection.execute(
            "DELETE FROM replay_uploads WHERE id = ? AND user_id = ?",
            (upload_id, user_id),
        )
    return cursor.rowcount > 0
