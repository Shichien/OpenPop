import "server-only";

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import BetterSqlite3, { type Database as SqliteDatabase } from "better-sqlite3";

import { databasePath } from "@/lib/config";
import {
  buildActionSequence,
  refineActionsWithMotion,
  type ActionSegment,
  type FrameState,
  type RecordedRoom,
} from "@/lib/replay";

const HANDLE_PATTERN = /[^a-z0-9_-]+/gu;
const MAX_ROOM_FRAMES = 240_000;
const MAX_ROOM_SECONDS = 3_600;
const DEBUG_PLAYER_NAMES = new Set(["Diag", "Deralive"]);
const DEBUG_PLAYER_PREFIXES = [
  "ActionFix_", "Batch_", "CoverFix_", "HeroPoseFix_", "HeroRoute", "HeroSpriteDbg_",
  "Move", "Proof_", "Search", "Test", "TimelineScrub", "TimelineSeek", "Tmp",
];

let singleton: SqliteDatabase | null = null;

export function openDatabase(path = databasePath): SqliteDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new BetterSqlite3(path);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  if (path !== ":memory:") database.pragma("journal_mode = WAL");
  initializeDatabase(database);
  return database;
}

export function getDatabase(): SqliteDatabase {
  singleton ??= openDatabase();
  return singleton;
}

export function initializeDatabase(database: SqliteDatabase): void {
  database.exec(`
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
  `);

  const columns = new Set(
    (database.prepare("PRAGMA table_info(room_runs)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (!columns.has("states_json")) database.exec("ALTER TABLE room_runs ADD COLUMN states_json TEXT NOT NULL DEFAULT '[]'");
  if (!columns.has("actions_json")) database.exec("ALTER TABLE room_runs ADD COLUMN actions_json TEXT NOT NULL DEFAULT '[]'");
  if (!columns.has("is_hidden")) database.exec("ALTER TABLE room_runs ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0");

  const rows = database.prepare("SELECT rowid, player_name FROM room_runs").all() as Array<{ rowid: number; player_name: string }>;
  const updateVisibility = database.prepare("UPDATE room_runs SET is_hidden = ? WHERE rowid = ?");
  const transaction = database.transaction(() => {
    for (const row of rows) updateVisibility.run(isDebugPlayerName(row.player_name) ? 1 : 0, row.rowid);
  });
  transaction();
}

function id(): string {
  return randomUUID().replaceAll("-", "");
}

function isDebugPlayerName(playerName: string): boolean {
  const value = String(playerName || "").trim();
  return DEBUG_PLAYER_NAMES.has(value) || DEBUG_PLAYER_PREFIXES.some((prefix) => value.startsWith(prefix));
}

type RoomRunRow = {
  player_name: string;
  entry_from_scene: string;
  exit_to_scene: string;
  total_time: number;
  frame_count: number;
  frames_json: string;
  states_json: string;
  actions_json: string;
  source_label: string | null;
  is_hidden: number;
  updated_at: string;
};

function roomRunPayload(row: RoomRunRow) {
  const frames = JSON.parse(row.frames_json) as Array<[number, number]>;
  let frameStates = JSON.parse(row.states_json || "[]") as Array<{
    x: number; y: number; facing_right: boolean; anim_clip: string; anim_frame: number; action: string;
  }>;
  let actionSequence = JSON.parse(row.actions_json || "[]") as Array<{
    start_frame: number; end_frame: number; action: string; clip: string;
  }>;
  if (!frameStates.length) {
    frameStates = frames.map(([x, y]) => ({ x, y, facing_right: true, anim_clip: "", anim_frame: 0, action: "move" }));
  }
  const hasClip = frameStates.some((state) => state.anim_clip.trim());
  if (!hasClip && frameStates.every((state) => ["move", "idle"].includes(state.action || "move"))) {
    const refined = refineActionsWithMotion(frameStates.map((state) => ({
      x: Number(state.x), y: Number(state.y), facingRight: Boolean(state.facing_right),
      animClip: String(state.anim_clip || ""), animFrame: Number(state.anim_frame || 0), action: String(state.action || "move"),
    })));
    frameStates = refined.map((state) => ({
      x: state.x, y: state.y, facing_right: state.facingRight,
      anim_clip: state.animClip, anim_frame: state.animFrame, action: state.action,
    }));
    actionSequence = buildActionSequence(refined).map((segment) => ({
      start_frame: segment.startFrame, end_frame: segment.endFrame, action: segment.action, clip: segment.clip,
    }));
  } else if (!actionSequence.length && frameStates.length) {
    actionSequence = [{ start_frame: 0, end_frame: frameStates.length - 1, action: frameStates[0].action, clip: frameStates[0].anim_clip }];
  }
  return {
    player_name: row.player_name,
    total_time: Number(row.total_time),
    frame_count: Number(row.frame_count),
    frames,
    frame_states: frameStates,
    action_sequence: actionSequence,
    source_label: row.source_label,
    is_hidden: Boolean(row.is_hidden),
    updated_at: row.updated_at,
    entry_from_scene: row.entry_from_scene,
    exit_to_scene: row.exit_to_scene,
  };
}

export function listPracticeRuns(sceneName: string, database = getDatabase()) {
  const rows = database.prepare(`
    SELECT player_name, entry_from_scene, exit_to_scene, total_time, frame_count,
           frames_json, states_json, actions_json, source_label, is_hidden, updated_at
    FROM room_runs
    WHERE scene_name = ? AND COALESCE(is_hidden, 0) = 0
    ORDER BY total_time ASC, player_name ASC
  `).all(sceneName) as RoomRunRow[];
  return rows.map(roomRunPayload);
}

export type PublicUser = {
  id: string;
  handle: string;
  display_name: string;
  avatar_url: string;
  created_at: string;
  providers: Array<{ provider: string; login: string }>;
};

export function getUser(userId: string, database = getDatabase()): PublicUser | null {
  const row = database.prepare(`
    SELECT id, handle, display_name, avatar_url, created_at
    FROM users WHERE id = ? AND disabled_at IS NULL
  `).get(userId) as Omit<PublicUser, "providers"> | undefined;
  if (!row) return null;
  const identities = database.prepare(`
    SELECT provider, provider_login AS login FROM oauth_identities
    WHERE user_id = ? ORDER BY created_at
  `).all(userId) as Array<{ provider: string; login: string }>;
  return { ...row, providers: identities };
}

function normalizeHandle(login: string): string {
  return String(login || "player").trim().toLowerCase().replace(HANDLE_PATTERN, "-").replace(/^[-_]+|[-_]+$/gu, "").slice(0, 28) || "player";
}

function availableHandle(database: SqliteDatabase, login: string, providerUserId: string): string {
  const base = normalizeHandle(login);
  const suffix = providerUserId.slice(-6).toLowerCase();
  let candidate = base;
  let index = 0;
  const exists = database.prepare("SELECT 1 FROM users WHERE handle = ?");
  while (exists.get(candidate)) {
    index += 1;
    const tail = index === 1 ? suffix : `${suffix}-${index}`;
    candidate = `${base.slice(0, Math.max(1, 31 - tail.length))}-${tail}`;
  }
  return candidate;
}

export function upsertOAuthUser(input: {
  provider: string;
  providerUserId: string;
  providerLogin: string;
  displayName: string;
  avatarUrl: string;
}, database = getDatabase()): PublicUser {
  const transaction = database.transaction(() => {
    const identity = database.prepare(`
      SELECT user_id FROM oauth_identities WHERE provider = ? AND provider_user_id = ?
    `).get(input.provider, input.providerUserId) as { user_id: string } | undefined;
    const userId = identity?.user_id || id();
    if (identity) {
      database.prepare(`
        UPDATE users SET display_name = ?, avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(input.displayName, input.avatarUrl, userId);
      database.prepare(`
        UPDATE oauth_identities SET provider_login = ?, provider_avatar_url = ?, updated_at = CURRENT_TIMESTAMP
        WHERE provider = ? AND provider_user_id = ?
      `).run(input.providerLogin, input.avatarUrl, input.provider, input.providerUserId);
    } else {
      database.prepare(`
        INSERT INTO users (id, handle, display_name, avatar_url) VALUES (?, ?, ?, ?)
      `).run(userId, availableHandle(database, input.providerLogin, input.providerUserId), input.displayName, input.avatarUrl);
      database.prepare(`
        INSERT INTO oauth_identities (id, user_id, provider, provider_user_id, provider_login, provider_avatar_url)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id(), userId, input.provider, input.providerUserId, input.providerLogin, input.avatarUrl);
    }
    return userId;
  });
  const userId = transaction();
  const user = getUser(userId, database);
  if (!user) throw new Error("OAuth user was not persisted");
  return user;
}

export function validateRooms(rooms: RecordedRoom[], allowedRoutes: Readonly<Record<string, readonly [string, string]>>): RecordedRoom[] {
  if (!rooms.length) throw new Error("Replay 中没有可用房间");
  if (rooms.length > 8) throw new Error("单次上传包含的房间数量过多");
  for (const room of rooms) {
    const route = allowedRoutes[room.key.sceneName];
    if (!route || route[0] !== room.key.entryFromScene || route[1] !== room.key.exitToScene) {
      throw new Error(`Replay 房间路线无效：${room.key.sceneName}`);
    }
    if (!Number.isFinite(room.totalTime) || room.totalTime <= 0 || room.totalTime > MAX_ROOM_SECONDS) {
      throw new Error(`Replay 房间用时无效：${room.key.sceneName}`);
    }
    if (room.frames.length < 2 || room.frames.length > MAX_ROOM_FRAMES) {
      throw new Error(`Replay 帧数无效：${room.key.sceneName}`);
    }
    if (room.frameStates.some((state) => !Number.isFinite(state.x) || !Number.isFinite(state.y))) {
      throw new Error(`Replay 坐标无效：${room.key.sceneName}`);
    }
  }
  return rooms;
}

function serializeStates(states: FrameState[]): string {
  return JSON.stringify(states.map((state) => ({
    x: state.x, y: state.y, facing_right: state.facingRight,
    anim_clip: state.animClip, anim_frame: state.animFrame, action: state.action,
  })));
}

function serializeActions(actions: ActionSegment[]): string {
  return JSON.stringify(actions.map((segment) => ({
    start_frame: segment.startFrame, end_frame: segment.endFrame,
    action: segment.action, clip: segment.clip,
  })));
}

export function storeUpload(input: {
  userId: string;
  originalFilename: string;
  rooms: RecordedRoom[];
  gameVersion: string;
}, database = getDatabase()) {
  const uploadId = id();
  const runIds: string[] = [];
  const transaction = database.transaction(() => {
    database.prepare(`
      INSERT INTO replay_uploads (id, user_id, original_filename, game_version) VALUES (?, ?, ?, ?)
    `).run(uploadId, input.userId, input.originalFilename, input.gameVersion);
    const insertRun = database.prepare(`
      INSERT INTO replay_room_runs (
        id, upload_id, user_id, scene_name, entry_from_scene, exit_to_scene,
        total_time, frame_count, frames_json, states_json, actions_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const room of input.rooms) {
      const runId = id();
      runIds.push(runId);
      insertRun.run(
        runId, uploadId, input.userId, room.key.sceneName, room.key.entryFromScene,
        room.key.exitToScene, room.totalTime, room.frames.length, JSON.stringify(room.frames),
        serializeStates(room.frameStates), serializeActions(room.actionSequence),
      );
    }
  });
  transaction();
  return { upload_id: uploadId, run_ids: runIds, room_count: runIds.length };
}

export function listLeaderboard(sceneName: string, limit = 100, database = getDatabase()) {
  const rows = database.prepare(`
    WITH ranked AS (
      SELECT runs.*, ROW_NUMBER() OVER (
        PARTITION BY runs.user_id ORDER BY runs.total_time ASC, runs.created_at ASC
      ) AS user_rank
      FROM replay_room_runs AS runs WHERE runs.scene_name = ?
    )
    SELECT ranked.id, ranked.total_time, ranked.frame_count, ranked.entry_from_scene,
           ranked.exit_to_scene, ranked.created_at, users.id AS user_id, users.handle,
           users.display_name, users.avatar_url,
           COALESCE((SELECT provider FROM oauth_identities
             WHERE oauth_identities.user_id = users.id ORDER BY created_at LIMIT 1), '') AS provider
    FROM ranked JOIN users ON users.id = ranked.user_id
    WHERE ranked.user_rank = 1 AND users.disabled_at IS NULL
    ORDER BY ranked.total_time ASC, users.handle ASC LIMIT ?
  `).all(sceneName, Math.max(1, Math.min(Math.trunc(limit), 100))) as Array<Record<string, string | number>>;
  return rows.map((row, index) => ({
    rank: index + 1,
    run_id: row.id,
    total_time: Number(row.total_time),
    frame_count: Number(row.frame_count),
    entry_from_scene: row.entry_from_scene,
    exit_to_scene: row.exit_to_scene,
    created_at: row.created_at,
    user: {
      id: row.user_id, handle: row.handle, display_name: row.display_name,
      avatar_url: row.avatar_url, provider: row.provider,
    },
  }));
}

export function getReplay(runId: string, database = getDatabase()) {
  const row = database.prepare(`
    SELECT runs.*, users.handle, users.display_name, users.avatar_url
    FROM replay_room_runs AS runs JOIN users ON users.id = runs.user_id
    WHERE runs.id = ? AND users.disabled_at IS NULL
  `).get(runId) as Record<string, string | number> | undefined;
  if (!row) return null;
  return {
    run_id: row.id,
    scene_name: row.scene_name,
    entry_from_scene: row.entry_from_scene,
    exit_to_scene: row.exit_to_scene,
    total_time: Number(row.total_time),
    frame_count: Number(row.frame_count),
    frames: JSON.parse(String(row.frames_json)),
    frame_states: JSON.parse(String(row.states_json)),
    action_sequence: JSON.parse(String(row.actions_json)),
    player_name: row.display_name,
    user: { id: row.user_id, handle: row.handle, display_name: row.display_name, avatar_url: row.avatar_url },
    created_at: row.created_at,
  };
}

export function listUserUploads(userId: string, database = getDatabase()) {
  return database.prepare(`
    SELECT uploads.id, uploads.original_filename, uploads.game_version, uploads.created_at,
           COUNT(runs.id) AS room_count
    FROM replay_uploads AS uploads LEFT JOIN replay_room_runs AS runs ON runs.upload_id = uploads.id
    WHERE uploads.user_id = ? GROUP BY uploads.id ORDER BY uploads.created_at DESC
  `).all(userId);
}

export function deleteUpload(uploadId: string, userId: string, database = getDatabase()): boolean {
  return database.prepare("DELETE FROM replay_uploads WHERE id = ? AND user_id = ?").run(uploadId, userId).changes > 0;
}
