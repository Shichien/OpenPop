import { heroManifestUrl } from "@/lib/config";
import { errorJson } from "@/lib/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const game = new URL(request.url).searchParams.get("game")?.trim().toLowerCase().replaceAll("-", "_") || "hollow_knight";
  if (!["hollow_knight", "hk", "knight"].includes(game)) return errorJson("该人物资源不属于苦痛之路项目", 404);
  return Response.redirect(heroManifestUrl, 307);
}
