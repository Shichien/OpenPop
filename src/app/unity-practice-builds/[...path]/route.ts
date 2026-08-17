import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";

import { unityBuildDirectory } from "@/lib/config";
import { IMMUTABLE_CACHE } from "@/lib/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ path: string[] }> };

function contentType(path: string): string {
  const sourcePath = path.endsWith(".br") ? path.slice(0, -3) : path;
  if (sourcePath.endsWith(".wasm")) return "application/wasm";
  if (sourcePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (sourcePath.endsWith(".data")) return "application/octet-stream";
  return ({
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
  } as Record<string, string>)[extname(sourcePath).toLowerCase()] || "application/octet-stream";
}

async function serve(method: "GET" | "HEAD", context: Context): Promise<Response> {
  const parts = (await context.params).path;
  const root = resolve(unityBuildDirectory);
  const target = resolve(root, ...parts);
  if (target !== root && !target.startsWith(`${root}${sep}`)) return new Response("Not found", { status: 404 });
  if (!existsSync(target) || !statSync(target).isFile()) return new Response("Not found", { status: 404 });
  const stats = statSync(target);
  const headers = new Headers({
    "Content-Type": contentType(target),
    "Content-Length": String(stats.size),
    "Cache-Control": IMMUTABLE_CACHE,
  });
  if (target.endsWith(".br")) {
    headers.set("Content-Encoding", "br");
    headers.set("Vary", "Accept-Encoding");
  }
  if (method === "HEAD") return new Response(null, { headers });
  return new Response(Readable.toWeb(createReadStream(target)) as ReadableStream, { headers });
}

export function GET(_request: Request, context: Context) { return serve("GET", context); }
export function HEAD(_request: Request, context: Context) { return serve("HEAD", context); }
