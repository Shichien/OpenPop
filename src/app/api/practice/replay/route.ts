import { NextRequest } from "next/server";
import { CAMERA_PROJECTION, PRACTICE_ROOMS } from "@/lib/constants";
import { listPracticeRuns } from "@/lib/database";
import { errorJson, noStoreJson } from "@/lib/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const sceneName = request.nextUrl.searchParams.get("scene_name") || "";
  if (!PRACTICE_ROOMS.includes(sceneName)) return errorJson(`苦痛之路房间不存在：${sceneName}`, 404);
  return noStoreJson({ scene_name: sceneName, projection: CAMERA_PROJECTION, runs: listPracticeRuns(sceneName) });
}
