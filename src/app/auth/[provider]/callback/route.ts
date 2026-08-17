import { NextRequest, NextResponse } from "next/server";

import { authCookieAges, authCookieNames, authCookieOptions, finishOAuth, isProvider, providerEnabled } from "@/lib/auth";
import { errorJson } from "@/lib/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  if (!isProvider(provider) || !providerEnabled(provider)) return errorJson("该登录方式尚未配置", 404);
  try {
    const result = await finishOAuth(request, provider);
    const response = NextResponse.redirect(new URL("/?login=success", request.nextUrl.origin), 303);
    response.cookies.set(authCookieNames.session, result.session, { ...authCookieOptions, maxAge: authCookieAges.session });
    response.cookies.delete(authCookieNames.oauth);
    return response;
  } catch (error) {
    return errorJson(error instanceof Error ? error.message : "OAuth 登录失败", 400);
  }
}
