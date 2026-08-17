import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  serverExternalPackages: ["better-sqlite3"],
  turbopack: {
    root: process.cwd(),
  },
  outputFileTracingIncludes: {
    "/api/practice/builds": ["./runtime/unity-webgl/**/*"],
    "/unity-practice-builds/[...path]": ["./runtime/unity-webgl/**/*"],
  },
};

export default nextConfig;
