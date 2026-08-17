import { NextRequest, NextResponse } from "next/server";

import { authCookieAges, authCookieNames, authCookieOptions, beginOAuth, isProvider, providerEnabled } from "@/lib/auth";
import { errorJson } from "@/lib/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  if (!isProvider(provider) || !providerEnabled(provider)) return errorJson("该登录方式尚未配置", 404);
  try {
    const flow = await beginOAuth(request, provider);
    const response = NextResponse.redirect(flow.authorizationUrl);
    response.cookies.set(authCookieNames.oauth, flow.cookie, { ...authCookieOptions, maxAge: authCookieAges.oauth });
    return response;
  } catch (error) {
    return errorJson(error instanceof Error ? error.message : "OAuth 登录初始化失败", 400);
  }
}
