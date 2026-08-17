import { NextRequest } from "next/server";

import { leaderboard } from "@/lib/social-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ sceneName: string }> }) {
  return leaderboard((await context.params).sceneName, request);
}
