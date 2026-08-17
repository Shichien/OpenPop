import { NextRequest } from "next/server";

import { uploadReplay } from "@/lib/social-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return uploadReplay(request);
}
