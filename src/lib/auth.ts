import "server-only";

import * as oauth from "oauth4webapi";
import { jwtVerify, SignJWT } from "jose";
import type { NextRequest } from "next/server";

import { publicUrl, sessionCookieSecure, sessionSecret } from "@/lib/config";
import { getUser, upsertOAuthUser, type PublicUser } from "@/lib/database";

export const PROVIDERS = ["discord", "github"] as const;
export type Provider = (typeof PROVIDERS)[number];

const SESSION_COOKIE = "pop_session";
const OAUTH_COOKIE = "pop_oauth";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const OAUTH_SECONDS = 60 * 10;

type ProviderDefinition = {
  authorizationServer: oauth.AuthorizationServer;
  clientId: string;
  clientSecret: string;
  scope: string;
};

function credentials(provider: Provider): { clientId: string; clientSecret: string } {
  return provider === "github"
    ? { clientId: String(process.env.GITHUB_CLIENT_ID || "").trim(), clientSecret: String(process.env.GITHUB_CLIENT_SECRET || "").trim() }
    : { clientId: String(process.env.DISCORD_CLIENT_ID || "").trim(), clientSecret: String(process.env.DISCORD_CLIENT_SECRET || "").trim() };
}

function providerDefinition(provider: Provider): ProviderDefinition {
  const { clientId, clientSecret } = credentials(provider);
  if (provider === "github") {
    return {
      clientId,
      clientSecret,
      scope: "read:user",
      authorizationServer: {
        issuer: "https://github.com",
        authorization_endpoint: "https://github.com/login/oauth/authorize",
        token_endpoint: "https://github.com/login/oauth/access_token",
      },
    };
  }
  return {
    clientId,
    clientSecret,
    scope: "identify",
    authorizationServer: {
      issuer: "https://discord.com",
      authorization_endpoint: "https://discord.com/oauth2/authorize",
      token_endpoint: "https://discord.com/api/oauth2/token",
    },
  };
}

export function isProvider(value: string): value is Provider {
  return PROVIDERS.includes(value as Provider);
}

export function providerEnabled(provider: Provider): boolean {
  const value = credentials(provider);
  return Boolean(value.clientId && value.clientSecret);
}

export function callbackUrl(request: NextRequest, provider: Provider): string {
  const origin = publicUrl || request.nextUrl.origin;
  return `${origin}/auth/${provider}/callback`;
}

async function signToken(payload: Record<string, string>, seconds: number): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .sign(sessionSecret());
}

async function verifyToken(token: string): Promise<Record<string, unknown> | null> {
  try {
    return (await jwtVerify(token, sessionSecret(), { algorithms: ["HS256"] })).payload;
  } catch {
    return null;
  }
}

export async function beginOAuth(request: NextRequest, provider: Provider) {
  const definition = providerDefinition(provider);
  if (!definition.clientId || !definition.clientSecret) throw new Error("该登录方式尚未配置");
  const state = oauth.generateRandomState();
  const verifier = oauth.generateRandomCodeVerifier();
  const challenge = await oauth.calculatePKCECodeChallenge(verifier);
  const redirectUri = callbackUrl(request, provider);
  const authorizationUrl = new URL(definition.authorizationServer.authorization_endpoint!);
  authorizationUrl.searchParams.set("client_id", definition.clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", definition.scope);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  return {
    authorizationUrl,
    cookie: await signToken({ provider, state, verifier, redirectUri }, OAUTH_SECONDS),
  };
}

async function resolveIdentity(provider: Provider, accessToken: string) {
  const url = provider === "github" ? "https://api.github.com/user" : "https://discord.com/api/users/@me";
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "OpenPop",
    },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`${provider} 用户信息读取失败：${response.status}`);
  const profile = await response.json() as Record<string, unknown>;
  if (provider === "github") {
    const login = String(profile.login || "").trim();
    return {
      provider,
      providerUserId: String(profile.id || ""),
      providerLogin: login,
      displayName: String(profile.name || login).trim(),
      avatarUrl: String(profile.avatar_url || "").trim(),
    };
  }
  const providerUserId = String(profile.id || "");
  const login = String(profile.global_name || profile.username || "").trim();
  const avatar = String(profile.avatar || "");
  return {
    provider,
    providerUserId,
    providerLogin: String(profile.username || login).trim(),
    displayName: login,
    avatarUrl: avatar ? `https://cdn.discordapp.com/avatars/${providerUserId}/${avatar}.png?size=128` : "",
  };
}

export async function finishOAuth(request: NextRequest, provider: Provider): Promise<{ user: PublicUser; session: string }> {
  const oauthToken = request.cookies.get(OAUTH_COOKIE)?.value;
  const stored = oauthToken ? await verifyToken(oauthToken) : null;
  if (!stored || stored.provider !== provider || typeof stored.state !== "string" || typeof stored.verifier !== "string" || typeof stored.redirectUri !== "string") {
    throw new Error("OAuth 登录状态已失效，请重新登录");
  }
  const definition = providerDefinition(provider);
  const client: oauth.Client = { client_id: definition.clientId };
  const parameters = oauth.validateAuthResponse(definition.authorizationServer, client, request.nextUrl, stored.state);
  const tokenResponse = await oauth.authorizationCodeGrantRequest(
    definition.authorizationServer,
    client,
    oauth.ClientSecretPost(definition.clientSecret),
    parameters,
    stored.redirectUri,
    stored.verifier,
  );
  const tokens = await oauth.processAuthorizationCodeResponse(definition.authorizationServer, client, tokenResponse);
  if (typeof tokens.access_token !== "string") throw new Error("OAuth 平台没有返回访问令牌");
  const user = upsertOAuthUser(await resolveIdentity(provider, tokens.access_token));
  return { user, session: await signToken({ userId: user.id }, SESSION_SECONDS) };
}

export async function currentUser(request: NextRequest): Promise<PublicUser | null> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = await verifyToken(token);
  return typeof payload?.userId === "string" ? getUser(payload.userId) : null;
}

export async function requireUser(request: NextRequest): Promise<PublicUser> {
  const user = await currentUser(request);
  if (!user) throw new Error("请先通过 GitHub 或 Discord 登录");
  return user;
}

export const authCookieNames = { session: SESSION_COOKIE, oauth: OAUTH_COOKIE } as const;
export const authCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: sessionCookieSecure(),
  path: "/",
};
export const authCookieAges = { session: SESSION_SECONDS, oauth: OAUTH_SECONDS } as const;
