/**
 * 端到端验证入口（v6 起由 `scripts/_verify-v6.mjs` 承载核心断言）。
 *
 * 用法：node scripts/e2e-check.js [baseUrl] [outDir]
 * 环境变量：E2E_TARGET
 *
 * 前置：npm run dev（默认 http://127.0.0.1:8787），并确保 .dev.vars 中
 *      ALLOW_DEV_RESET="1" 以支持测试沙箱重置。
 */
import { spawn } from "node:child_process";
import path from "node:path";

const BASE = process.argv[2] || process.env.E2E_TARGET || "http://127.0.0.1:8787";
const OUT = process.argv[3] || path.join(process.cwd(), "scripts", "_shots");

const script = path.join(process.cwd(), "scripts", "_verify-v6.mjs");
const child = spawn(process.execPath, [script, BASE, OUT], {
  stdio: "inherit",
  env: process.env,
  windowsHide: true,
});

child.on("error", (e) => {
  console.error("e2e 启动失败:", e.message);
  process.exit(1);
});

child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
