import "server-only";

import type { NextRequest } from "next/server";

import { requireUser } from "@/lib/auth";
import { PRACTICE_ROOMS, PRACTICE_ROUTES } from "@/lib/constants";
import {
  deleteUpload,
  getReplay,
  listLeaderboard,
  listUserUploads,
  storeUpload,
  validateRooms,
} from "@/lib/database";
import { parseUpload, ReplayParseError } from "@/lib/replay";
import { errorJson, noStoreJson } from "@/lib/responses";

export async function uploadReplay(request: NextRequest) {
  let user;
  try {
    user = await requireUser(request);
  } catch {
    return errorJson("请先通过 GitHub 或 Discord 登录", 401);
  }

  const form = await request.formData();
  const file = form.get("replay_file");
  if (!(file instanceof File) || file.size <= 0) return errorJson("上传文件为空", 400);
  if (file.size > 16 * 1024 * 1024) return errorJson("Replay 文件超过 16 MB", 413);

  try {
    const rooms = validateRooms(
      parseUpload(file.name || "replay.json", Buffer.from(await file.arrayBuffer())),
      PRACTICE_ROUTES,
    );
    const upload = storeUpload({
      userId: user.id,
      originalFilename: file.name || "replay.json",
      rooms,
      gameVersion: String(form.get("game_version") || "").trim().slice(0, 32),
    });
    return noStoreJson({ upload, user });
  } catch (error) {
    const detail = error instanceof ReplayParseError || error instanceof Error
      ? error.message
      : "Replay 校验失败";
    return errorJson(detail, 400);
  }
}

export function leaderboard(sceneName: string, request: NextRequest) {
  if (!PRACTICE_ROOMS.includes(sceneName)) return errorJson("该房间不在苦痛之路排行榜中", 404);
  const limit = Number(request.nextUrl.searchParams.get("limit") || 100);
  return noStoreJson({ scene_name: sceneName, runs: listLeaderboard(sceneName, limit) });
}

export function replay(runId: string) {
  const value = getReplay(runId);
  return value ? noStoreJson({ replay: value }) : errorJson("Replay 不存在", 404);
}

export async function uploads(request: NextRequest) {
  try {
    const user = await requireUser(request);
    return noStoreJson({ uploads: listUserUploads(user.id) });
  } catch {
    return errorJson("请先通过 GitHub 或 Discord 登录", 401);
  }
}

export async function removeUpload(request: NextRequest, uploadId: string) {
  try {
    const user = await requireUser(request);
    return deleteUpload(uploadId, user.id)
      ? noStoreJson({ ok: true })
      : errorJson("上传记录不存在", 404);
  } catch {
    return errorJson("请先通过 GitHub 或 Discord 登录", 401);
  }
}
