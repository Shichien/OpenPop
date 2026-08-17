import "server-only";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

const DEFAULT_R2_PUBLIC_URL = "https://pub-1b49211ea9574b738e1f01da86abe74d.r2.dev";
const HERO_MANIFEST_KEY = "generated/hero/knight_manifest.20260805T033206.json";

function trimUrl(value: string | undefined): string {
  return String(value || "").trim().replace(/\/+$/u, "");
}

export const projectRoot = process.cwd();
export const dataDirectory = resolve(projectRoot, "data");
export const databasePath = process.env.POP_DATABASE_PATH || resolve(dataDirectory, "replays.sqlite3");
export const unityBuildDirectory = resolve(projectRoot, "runtime", "unity-webgl");
export const publicUrl = trimUrl(process.env.POP_PUBLIC_URL);
export const r2PublicUrl = trimUrl(process.env.POP_R2_PUBLIC_URL) || DEFAULT_R2_PUBLIC_URL;
export const heroManifestUrl = trimUrl(process.env.POP_HERO_MANIFEST_URL)
  || `${r2PublicUrl}/${HERO_MANIFEST_KEY}`;

export function sessionCookieSecure(): boolean {
  const configured = process.env.SESSION_COOKIE_SECURE;
  if (configured != null) return !["0", "false", "no", "off"].includes(configured.trim().toLowerCase());
  return publicUrl.startsWith("https://");
}

let cachedSessionSecret: Uint8Array | null = null;

export function sessionSecret(): Uint8Array {
  if (cachedSessionSecret) return cachedSessionSecret;
  mkdirSync(dataDirectory, { recursive: true });
  const configured = String(process.env.SESSION_SECRET || "").trim();
  const secretPath = resolve(dataDirectory, "session-secret");
  let secret = configured;
  if (!secret && existsSync(secretPath)) secret = readFileSync(secretPath, "utf8").trim();
  if (!secret) {
    secret = randomBytes(64).toString("base64url");
    writeFileSync(secretPath, secret, { encoding: "utf8", mode: 0o600 });
  }
  cachedSessionSecret = new TextEncoder().encode(secret);
  return cachedSessionSecret;
}
