import { NextRequest } from "next/server";

import { uploads } from "@/lib/social-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return uploads(request);
}
