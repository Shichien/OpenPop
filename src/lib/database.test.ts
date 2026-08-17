import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";

import { listPracticeRuns, listLeaderboard, openDatabase, storeUpload, upsertOAuthUser } from "@/lib/database";
import { buildActionSequence, type RecordedRoom } from "@/lib/replay";

let database: Database | null = null;
afterEach(() => database?.close());

describe("SQLite persistence", () => {
  it("preserves OAuth users and leaderboard runs", () => {
    database = openDatabase(":memory:");
    const user = upsertOAuthUser({
      provider: "github", providerUserId: "42", providerLogin: "player",
      displayName: "Player", avatarUrl: "",
    }, database);
    const states = [
      { x: 1, y: 2, facingRight: true, animClip: "Idle", animFrame: 0, action: "idle" },
      { x: 2, y: 2, facingRight: true, animClip: "Run", animFrame: 1, action: "run" },
    ];
    const room: RecordedRoom = {
      key: { sceneName: "White_Palace_18", entryFromScene: "White_Palace_06", exitToScene: "White_Palace_17" },
      totalTime: 1.5,
      frames: states.map((state) => [state.x, state.y]),
      frameStates: states,
      actionSequence: buildActionSequence(states),
    };
    storeUpload({ userId: user.id, originalFilename: "run.rtmc", rooms: [room], gameVersion: "1.5.12620" }, database);
    expect(listLeaderboard("White_Palace_18", 100, database)).toHaveLength(1);
    expect(listPracticeRuns("White_Palace_18", database)).toHaveLength(0);
  });
});
