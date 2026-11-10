"use strict";

const CACHE_NAME = "openpop-unity-assets-v1";
const CACHEABLE = /\/unity-practice-builds\/.*\.(?:data|wasm|framework\.js)\.br(?:\?|$)/i;
const fills = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith("openpop-unity-assets-") && name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function cacheUnityAsset(request, event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const key = request.url;
  if (fills.has(key)) {
    await fills.get(key);
    const completed = await cache.match(request);
    if (completed) return completed;
  }

  const response = await fetch(request);
  if (!response.ok) return response;
  const fill = cache.put(request, response.clone()).finally(() => fills.delete(key));
  fills.set(key, fill);
  event.waitUntil(fill);
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || !CACHEABLE.test(new URL(request.url).pathname)) return;
  event.respondWith(cacheUnityAsset(request, event));
});
