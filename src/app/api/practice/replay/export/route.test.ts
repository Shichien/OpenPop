import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { POST } from "@/app/api/practice/replay/export/route";
import { parseUpload } from "@/lib/replay";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/practice/replay/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("practice replay export", () => {
  it("encodes a valid recorded room", async () => {
    const response = await POST(request({
      format: "original-practice-replay-v1",
      gameVersion: "1.5.12620",
      sceneName: "White_Palace_18",
      entryFromScene: "White_Palace_06",
      exitToScene: "White_Palace_17",
      totalTime: 0.1,
      frames: [
        { elapsed: 0, x: 1, y: 2, facingRight: true, animClip: "Idle", animFrame: 0 },
        { elapsed: 0.1, x: 1.2, y: 2, facingRight: true, animClip: "Run", animFrame: 1 },
      ],
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.filename).toBe("PathOfPain-White_Palace_18-1.5.12620.rtmc.txt");
    expect(payload.frameCount).toBe(2);
    const [room] = parseUpload(payload.filename, Buffer.from(payload.shareText));
    expect(room.key).toEqual({
      sceneName: "White_Palace_18",
      entryFromScene: "White_Palace_06",
      exitToScene: "White_Palace_17",
    });
    expect(room.frames).toHaveLength(2);
  });

  it("rejects a room with the wrong route", async () => {
    const response = await POST(request({
      format: "original-practice-replay-v1",
      gameVersion: "1.5.12620",
      sceneName: "White_Palace_18",
      entryFromScene: "White_Palace_17",
      exitToScene: "White_Palace_19",
      totalTime: 0.1,
      frames: [
        { elapsed: 0, x: 1, y: 2, facingRight: true, animClip: "Idle", animFrame: 0 },
        { elapsed: 0.1, x: 1.2, y: 2, facingRight: true, animClip: "Run", animFrame: 1 },
      ],
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ detail: "Replay 房间路线无效" });
  });
});
