import { NextRequest } from "next/server";
import { z } from "zod";

import { PRACTICE_ROUTES } from "@/lib/constants";
import { buildActionSequence, classifyAction, encodeCollection, type RecordedRoom } from "@/lib/replay";
import { errorJson, noStoreJson } from "@/lib/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const frameSchema = z.object({
  elapsed: z.number().finite(),
  x: z.number().finite().min(-327.68).max(327.67),
  y: z.number().finite().min(-327.68).max(327.67),
  facingRight: z.boolean(),
  animClip: z.string().default(""),
  animFrame: z.number().finite().default(0),
});

const exportSchema = z.object({
  format: z.literal("original-practice-replay-v1"),
  gameVersion: z.string().min(1).max(32),
  sceneName: z.string(),
  entryFromScene: z.string(),
  exitToScene: z.string(),
  totalTime: z.number().finite(),
  frames: z.array(frameSchema).min(2).max(100_000),
});

export async function POST(request: NextRequest) {
  const parsed = exportSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorJson("Replay 录制格式或帧数据无效", 400);
  const payload = parsed.data;
  const route = PRACTICE_ROUTES[payload.sceneName];
  if (!route || route[0] !== payload.entryFromScene || route[1] !== payload.exitToScene) {
    return errorJson("Replay 房间路线无效", 400);
  }

  let previousElapsed = -1;
  for (const frame of payload.frames) {
    if (frame.elapsed <= previousElapsed) return errorJson("Replay 帧时间无效", 400);
    previousElapsed = frame.elapsed;
  }
  const clipCount = new Set(payload.frames.filter((frame) => frame.animClip).map((frame) => frame.animClip)).size;
  if (payload.frames[0].elapsed < 0 || clipCount > 255) return errorJson("Replay 时间或动画数据无效", 400);

  const frameStates = payload.frames.map((frame) => ({
    x: frame.x,
    y: frame.y,
    facingRight: !frame.facingRight,
    animClip: frame.animClip,
    animFrame: Math.max(0, Math.min(Math.trunc(frame.animFrame), 255)),
    action: classifyAction(frame.animClip),
  }));
  const room: RecordedRoom = {
    key: {
      sceneName: payload.sceneName,
      entryFromScene: payload.entryFromScene,
      exitToScene: payload.exitToScene,
    },
    totalTime: payload.frames.at(-1)!.elapsed,
    frames: frameStates.map((frame) => [frame.x, frame.y]),
    frameStates,
    actionSequence: buildActionSequence(frameStates),
  };
  return noStoreJson({
    filename: `PathOfPain-${payload.sceneName}-${payload.gameVersion}.rtmc.txt`,
    shareText: encodeCollection([room]),
    sceneName: payload.sceneName,
    totalTime: room.totalTime,
    frameCount: room.frames.length,
  });
}
