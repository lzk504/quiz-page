/**
 * 内置限流：纯内存固定窗口（单 isolate）。
 *
 * 为什么不写持久化：
 *   - 免费层 KV 每日仅 1000 次写，登录/注册被爆破时几分钟就打爆写配额
 *   - 单 isolate 内存 Map 毫秒级、零配额消耗
 *   - 多 isolate / 多 colo 下计数不精确（限额被放大），但对「防脚本小子爆破」已足够；
 *     真正的分布式攻击交给 Cloudflare 官方 Rate Limiting Rules（README 已建议）
 */

import { fail, type Middleware } from "./router";
import type { Ctx } from "./types";

export interface RateLimiter {
  rateLimit(keyFn: (c: Ctx) => string, limit: number): Middleware;
  reset(): void;
}

export function createRateLimiter({ windowMs = 60_000 }: { windowMs?: number } = {}): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  function check(key: string, limit: number): boolean {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    if (b.count >= limit) return false;
    b.count++;
    return true;
  }

  function reset(): void {
    buckets.clear();
  }

  /** 中间件工厂：rateLimit(keyFn, limit) => middleware(c) */
  function rateLimit(keyFn: (c: Ctx) => string, limit: number): Middleware {
    return async (c: Ctx) => {
      if (!check(keyFn(c), limit)) {
        return fail(429, "rate_limited", "请求过于频繁，请稍后再试");
      }
      return undefined;
    };
  }

  return { rateLimit, reset };
}

/** 真实 IP：生产只信 Cloudflare 注入的 CF-Connecting-IP（不可伪造） */
export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP")
    || request.headers.get("X-Real-IP")
    || "unknown";
}
