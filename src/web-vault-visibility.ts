/**
 * Web 前端可见性开关（对齐 nodewarden 的 web-vault-visibility）。
 * HIDE_WEB_VAULT=1 时，非 /api 路径一律返回 404，但后端 API 保持可用。
 *
 * ⚠️ 联动约束：开启时必须把 wrangler.toml 的 run_worker_first 改为 true，
 *    否则非 /api 的静态请求不会进入 Worker，本检查不生效。
 */

import type { Env } from "./types";

export function isWebVaultHidden(env: Env): boolean {
  return String(env.HIDE_WEB_VAULT || "").trim() === "1";
}

export function hiddenVaultResponse(request: Request): Response {
  const body = request.method === "HEAD" ? null : "Not Found";
  return new Response(body, {
    status: 404,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
    },
  });
}
