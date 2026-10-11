/**
 * Cloudflare Worker 入口。
 * 仅 /api/* 走 Worker（由 wrangler.toml 的 run_worker_first=["/api/*"] 保证）；
 * 其余静态资产由平台 ASSETS binding 直接服务（不进入 Worker）。
 *
 * HIDE_WEB_VAULT=1 时隐藏整站前端（非 /api 路径 404）；此时需把 wrangler.toml 的
 * run_worker_first 改为 true，否则静态请求不经 Worker、拦截不生效。
 */

import { handleApi } from "./routes";
import { isWebVaultHidden, hiddenVaultResponse } from "./web-vault-visibility";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx);
    }

    // 隐藏 Web 前端：非 /api 路径统一 404
    if (isWebVaultHidden(env)) {
      return hiddenVaultResponse(request);
    }

    // 生产环境由平台直接服务静态资产，理论上不会走到这里；保留兜底以防配置退化
    return env.ASSETS.fetch(request);
  },
};
