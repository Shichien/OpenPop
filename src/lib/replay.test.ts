import { describe, expect, it } from "vitest";

import { buildActionSequence, decodeShareString, encodeCollection, type RecordedRoom } from "@/lib/replay";

describe("Replay RTMC", () => {
  it("round-trips room coordinates and animation state", () => {
    const frameStates = [
      { x: 10, y: 20, facingRight: false, animClip: "Idle", animFrame: 0, action: "idle" },
      { x: 10.1, y: 20, facingRight: false, animClip: "Run", animFrame: 1, action: "run" },
    ];
    const room: RecordedRoom = {
      key: { sceneName: "White_Palace_18", entryFromScene: "White_Palace_06", exitToScene: "White_Palace_17" },
      totalTime: 0.033,
      frames: frameStates.map((frame) => [frame.x, frame.y]),
      frameStates,
      actionSequence: buildActionSequence(frameStates),
    };
    const decoded = decodeShareString(encodeCollection([room]));
    expect(decoded).toHaveLength(1);
    expect(decoded[0].key).toEqual(room.key);
    expect(decoded[0].frames).toEqual(room.frames);
    expect(decoded[0].frameStates.map((frame) => frame.animClip)).toEqual(["Idle", "Run"]);
  });
});
