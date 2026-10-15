/**
 * KV 每日访问限额（北京时间按天、跨 isolate 持久）。
 *
 * 与 ratelimit.ts 的「分钟级内存限流」互补：
 *   - ratelimit.ts：防爆破（register/login 各 10 次/分钟/IP，纯内存，快）
 *   - 本模块：控制「每日总用量」（未登录 IP 30 次/天、登录用户 64 次/天），
 *     用 KV 持久计数 + 24h TTL 自动回收，跨 isolate/colo 精确
 *
 * 计数 key：
 *   UNAUTH:<ip>:<YYYY-MM-DD>  未登录按 IP 计
 *   AUTH:<userId>:<YYYY-MM-DD> 已登录按用户计
 *
 * ⚠️ KV 写配额：每次受限请求触发 1 读 + 1 写。免费层 KV 每日 1000 次写，
 *   对个人/小团队刷题应用足够；若将来量大，可降级为仅 IP 维度或缩短 TTL。
 */

import { fail, type Middleware } from "../router";
import type { Ctx } from "../types";
import { clientIp } from "../ratelimit";

const TTL_SECONDS = 86400;          // 24 小时自动回收
const UNAUTH_LIMIT = 30;            // 未登录 IP 每日限额（登录/注册尝试计数）
const AUTH_LIMIT = 64;              // 已登录用户每日限额

/** 北京时间 YYYY-MM-DD（UTC+8） */
function beijingDateKey(now = new Date()): string {
  const bjt = new Date(now.getTime() + 8 * 3600 * 1000);
  return bjt.toISOString().split("T")[0];
}

/**
 * 从 Bearer token 中安全提取 userId。
 * 仅做「限额键」用途（不计入安全边界）：解析失败或非本应用 token 一律按未登录处理。
 */
function extractUserId(c: Ctx): string | null {
  const auth = c.request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return null;
    // base64url 解码（对齐现有 auth.ts 的编码约定）
    const b64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64);
    const payload = JSON.parse(json);
    return payload?.sub ?? payload?.id ?? null;
  } catch {
    return null;
  }
}

export interface DailyRateLimiter {
  /** 每日限额中间件：按未登录 IP / 已登录用户分别计数 */
  dailyLimit: Middleware;
}

export function createDailyRateLimiter(): DailyRateLimiter {
  return { dailyLimit };
}

async function dailyLimit(c: Ctx): Promise<Response | undefined> {
  const kv = c.env.RATE_LIMITS;
  // 未绑定 KV 时限频静默放行（不阻塞请求，避免配置缺失导致功能不可用）
  if (!kv) return undefined;

  const userId = extractUserId(c);
  const dateKey = beijingDateKey();
  const ip = clientIp(c.request);

  let limit: number;
  let limitMsg: string;
  let cacheKey: string;
  if (userId) {
    limit = AUTH_LIMIT;
    limitMsg = "今日您的操作次数已达上限，请明日再试。";
    cacheKey = `AUTH:${userId}:${dateKey}`;
  } else {
    limit = UNAUTH_LIMIT;
    limitMsg = "今日免费次数已用完，请登录后继续使用。";
    cacheKey = `UNAUTH:${ip}:${dateKey}`;
  }

  try {
    const currentStr = await kv.get(cacheKey);
    const current = currentStr ? parseInt(currentStr, 10) : 0;
    if (current >= limit) {
      return fail(429, "daily_limit", limitMsg);
    }
    await kv.put(cacheKey, String(current + 1), { expirationTtl: TTL_SECONDS });
  } catch (e) {
    // KV 异常时静默放行（限频是增强能力，不应因限频故障阻塞业务）
    console.error("[rate-limit-daily] KV 计数失败", e);
  }
  return undefined;
}
