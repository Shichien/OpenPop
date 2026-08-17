import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

const root = process.cwd();
const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const standalone = join(root, ".next", "standalone");
const server = join(standalone, "server.js");
if (!existsSync(server)) {
  throw new Error("缺少 Next.js 独立构建，请先运行 npm run build");
}

const { values } = parseArgs({
  options: {
    hostname: { type: "string", default: process.env.HOSTNAME || "0.0.0.0" },
    port: { type: "string", default: process.env.PORT || "3000" },
  },
});

mkdirSync(join(standalone, ".next"), { recursive: true });
cpSync(join(root, "public"), join(standalone, "public"), { recursive: true, force: true });
cpSync(join(root, ".next", "static"), join(standalone, ".next", "static"), { recursive: true, force: true });

const child = spawn(process.execPath, [server], {
  cwd: root,
  env: {
    ...process.env,
    HOSTNAME: values.hostname,
    PORT: values.port,
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});
