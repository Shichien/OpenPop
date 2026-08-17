import { NextResponse } from "next/server";

import { authCookieNames } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST() {
  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.delete(authCookieNames.session);
  response.cookies.delete(authCookieNames.oauth);
  return response;
}
