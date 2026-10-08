/**
 * 本地开发服务器：内存 mock KV + 静态资产服务 + /api/* 路由到 Worker 的 handleApi。
 * 用法：node scripts/dev-server.mjs    （默认 127.0.0.1:8123）
 *
 * 不依赖 wrangler / Cloudflare 账号，纯 Node 22+ 即可跑。生产部署用 wrangler（见 README）。
 * JWT_SECRET 从 .dev.vars 或环境变量读取。
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi, _resetRateLimitForTest } from "../worker/routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT) || 8123;

/* ---------------- .dev.vars 与 JWT_SECRET ---------------- */

function loadDevVars() {
  const file = path.join(ROOT, ".dev.vars");
  const out = {};
  if (!fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, "utf-8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"(.*)"\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const devVars = loadDevVars();
const JWT_SECRET = process.env.JWT_SECRET || devVars.JWT_SECRET || "dev-fallback-not-secure-please-set-30-plus-chars";
if (JWT_SECRET.length < 30) {
  console.warn(`[dev-server] JWT_SECRET 仅 ${JWT_SECRET.length} 字符，建议 ≥30。请在 .dev.vars 设置。`);
}

/* ---------------- 内存 mock KV（模拟 Cloudflare KV 接口） ---------------- */

class MockKV {
  constructor() { this.m = new Map(); }

  async get(key, opts) {
    const v = this.m.get(key);
    if (v == null) return null;
    if (opts && opts.type === "json") {
      try { return JSON.parse(v); } catch { return null; }
    }
    return v;
  }

  async put(key, value, _opts) {
    this.m.set(key, String(value));
    return null;
  }

  async delete(key) {
    this.m.delete(key);
    return null;
  }

  async list({ prefix = "", limit = 1000 } = {}) {
    const keys = [];
    for (const k of this.m.keys()) {
      if (k.startsWith(prefix)) keys.push({ name: k });
      if (keys.length >= limit) break;
    }
    return { keys, list_complete: keys.length < limit, cursor: null };
  }

  /** 仅开发调试用：导出全部 key 列表 */
  _dump() { return [...this.m.keys()]; }
  /** 仅开发调试用：清空（e2e 跑前重置） */
  _reset() { this.m.clear(); }
}

const kv = new MockKV();
const env = { KV: kv, JWT_SECRET };

/* ---------------- 静态资产 ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

async function serveStatic(reqPath, res) {
  let p = decodeURIComponent(reqPath);
  if (p === "/" || p === "") p = "/index.html";
  const filePath = path.join(ROOT, p);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end("forbidden"); return;
  }
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      const idx = path.join(filePath, "index.html");
      if (fs.existsSync(idx)) return serveFile(idx, res);
      res.writeHead(403); res.end("forbidden"); return;
    }
    await serveFile(filePath, res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404 not found");
  }
}

async function serveFile(filePath, res) {
  const buf = await fsp.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": "no-cache",
  });
  res.end(buf);
}

/* ---------------- HTTP 服务 ---------------- */

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.alloc(0)));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 调试钩子
  if (url.pathname === "/__dev/kv-dump") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(kv._dump()));
    return;
  }
  if (url.pathname === "/__dev/kv-reset") {
    kv._reset();
    _resetRateLimitForTest();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    const hasBody = !["GET", "HEAD", "DELETE"].includes(req.method);
    const body = hasBody ? await readBody(req) : null;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      headers.set(k, Array.isArray(v) ? v.join(",") : v);
    }
    const init = { method: req.method, headers };
    if (body && body.length) init.body = body;
    const request = new Request(`http://localhost:${PORT}${req.url}`, init);
    let r2;
    try {
      r2 = await handleApi(request, env, {});
    } catch (e) {
      console.error("[dev-server] handleApi 抛出", e);
      r2 = new Response(JSON.stringify({ error: "server_error", message: String(e) }), {
        status: 500, headers: { "content-type": "application/json" },
      });
    }
    const outHeaders = {};
    r2.headers.forEach((v, k) => { outHeaders[k] = v; });
    const buf = r2.body ? Buffer.from(await r2.arrayBuffer()) : null;
    res.writeHead(r2.status, outHeaders);
    res.end(buf);
    return;
  }

  await serveStatic(url.pathname, res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[dev-server] http://127.0.0.1:${PORT}/  (KV: 内存 mock | JWT_SECRET: ${JWT_SECRET ? "已加载" : "未设置"})`);
});
