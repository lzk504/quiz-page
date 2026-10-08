/**
 * Cloudflare Worker 入口。
 * 仅 /api/* 走 Worker（由 wrangler.toml 的 run_worker_first=["/api/*"] 保证）；
 * 其余静态资产由平台 ASSETS binding 直接服务（不进入 Worker）。
 *
 * 旧版 wrangler 不支持数组形式 run_worker_first 时，把 wrangler.toml 改为
 * run_worker_first = true，本文件对非 /api 请求仍能兜底 env.ASSETS.fetch(request)。
 */

import { handleApi } from "./routes.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx);
    }
    // 生产环境由平台直接服务静态资产，理论上不会走到这里；保留兜底以防配置退化
    return env.ASSETS.fetch(request);
  },
};
