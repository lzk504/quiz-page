/**
 * /api/* 业务 handler + 路由装配。
 *
 * 依赖：store（可插拔存储）/ router（路由+中间件+响应助手）/ ratelimit（限流）/ auth（密码学）
 *
 * 错误格式：{ error: <code>, message: <zh> }；HTTP 状态码 400/401/403/404/409/429/500。
 */

import {
  hashPassword, verifyPassword, issueToken,
  generateInviteCode, USERNAME_RE, validatePassword,
} from "./auth";
import { createStore } from "./services/storage";
import { createDailyRateLimiter } from "./services/rate-limit-daily";
import { createRouter, json, fail, readJson, type Handler } from "./router";
import { createRateLimiter, clientIp } from "./ratelimit";
import type { Ctx, Env, Invite, NewUserRec, RegisterResult } from "./types";

/* ---------------- 限流（register/login 防爆破，10 次/分钟/IP） ---------------- */

const limiter = createRateLimiter();
const LIMIT = 10;
const rlRegisterKey = (c: Ctx) => `${clientIp(c.request)}:register`;
const rlLoginKey = (c: Ctx) => `${clientIp(c.request)}:login`;

/* ---------------- 每日限额（KV 持久，未登录 9 次/登录 64 次） ---------------- */

const dailyLimiter = createDailyRateLimiter();

/** 仅测试/开发用：清空限流计数 */
export function _resetRateLimitForTest(): void {
  limiter.reset();
}

/* ---------------- 注册 ---------------- */

export const register: Handler = async (c) => {
  const r = await readJson(c.request);
  if (!r.ok) return fail(400, r.error, r.message);
  const { username, password, inviteCode } = r.value as {
    username?: string; password?: string; inviteCode?: string;
  };

  if (!username || !USERNAME_RE.test(username)) {
    return fail(400, "invalid_input", "用户名需 3-32 位字母、数字、下划线或短横线");
  }
  const pwErr = validatePassword(password);
  if (pwErr) return fail(400, "invalid_input", pwErr);

  // 建号全流程（首用户判定/查重/邀请码校验/原子写入）下沉到存储层
  const rec: NewUserRec = {
    id: crypto.randomUUID(),
    username,
    passwordHash: await hashPassword(password!),
    createdAt: Date.now(),
  };
  const result: RegisterResult = await c.store.registerUser(rec, inviteCode);

  if (!result.ok) {
    switch (result.reason) {
      case "conflict":        return fail(409, "conflict", "用户名已存在");
      case "invite_required": return fail(400, "invalid_input", "需要邀请码");
      case "invite_invalid":  return fail(403, "forbidden", "邀请码无效");
      case "invite_used":     return fail(403, "forbidden", "邀请码已被使用");
    }
  }

  const token = await issueToken(rec.username, result.role, c.env.JWT_SECRET);
  return json({
    token,
    user: { id: rec.id, username: rec.username, role: result.role, createdAt: rec.createdAt },
  }, 201);
};

/* ---------------- 登录 ---------------- */

export const login: Handler = async (c) => {
  const r = await readJson(c.request);
  if (!r.ok) return fail(400, r.error, r.message);
  const { username, password } = r.value as { username?: string; password?: string };
  if (!username || !password) return fail(400, "invalid_input", "用户名和密码不能为空");

  const auth = await c.store.getUserAuth(username);
  if (!auth) return fail(401, "unauthorized", "用户名或密码错误");
  const ok = await verifyPassword(password, auth.passwordHash?.saltHex, auth.passwordHash?.hashHex);
  if (!ok) return fail(401, "unauthorized", "用户名或密码错误");

  const token = await issueToken(username, auth.role, c.env.JWT_SECRET);
  return json({ token, user: { id: auth.id, username, role: auth.role, createdAt: auth.createdAt } });
};

/* ---------------- /api/bootstrap ---------------- */

export const bootstrap: Handler = async (c) => {
  const count = await c.store.getUserCount();
  return json({ initialized: count > 0 });
};

/* ---------------- /api/me ---------------- */

export const me: Handler = async (c) => {
  const auth = await c.store.getUserAuth(c.user!.sub);
  if (!auth) return fail(401, "unauthorized", "用户不存在");
  return json({ id: auth.id, username: auth.username, role: auth.role, createdAt: auth.createdAt });
};

/* ---------------- 刷题数据 ---------------- */

export const getStore: Handler = async (c) => {
  const storeData = await c.store.getStore(c.user!.sub);
  if (!storeData) return json({ store: null, updatedAt: null });
  return json({ store: storeData, updatedAt: storeData.updatedAt || 0 });
};

export const putStore: Handler = async (c) => {
  const r = await readJson(c.request);
  if (!r.ok) return fail(400, r.error, r.message);
  const { store, baseUpdatedAt } = r.value as {
    store?: Record<string, unknown>; baseUpdatedAt?: number;
  };
  if (!store || typeof store !== "object") {
    return fail(400, "invalid_input", "缺少 store 字段");
  }

  // 乐观锁：云端 updatedAt > 客户端 baseUpdatedAt → 409
  const existing = await c.store.getStore(c.user!.sub);
  const existingUpdatedAt = existing?.updatedAt || 0;
  if (baseUpdatedAt && existingUpdatedAt && existingUpdatedAt > baseUpdatedAt) {
    return fail(409, "conflict", "云端有更新版本，请刷新后合并", { serverUpdatedAt: existingUpdatedAt });
  }

  const finalStore = { ...store, updatedAt: Date.now() } as { updatedAt: number };
  await c.store.putStore(c.user!.sub, finalStore as never);
  return json({ updatedAt: finalStore.updatedAt });
};

export const deleteStore: Handler = async (c) => {
  await c.store.deleteStore(c.user!.sub);
  return new Response(null, { status: 204 });
};

/* ---------------- 邀请码 ---------------- */

export const createInvite: Handler = async (c) => {
  const code = generateInviteCode();
  const invite: Invite = { code, createdBy: c.user!.sub, createdAt: Date.now(), usedBy: null, usedAt: null };
  await c.store.createInvite(invite);
  return json(invite, 201);
};

export const listInvites: Handler = async (c) => {
  return json(await c.store.listInvites());
};

/* ---------------- 管理员：全量备份导出 ---------------- */

export const adminBackup: Handler = async (c) => {
  const data = await c.store.exportAll();
  return json(data);
};

/* ---------------- 开发调试：清库（仅 ALLOW_DEV_RESET=1 时注册生效） ---------------- */

export const devReset: Handler = async (c) => {
  if (c.env.ALLOW_DEV_RESET !== "1") return fail(404, "not_found", "接口不存在");

  if (c.env.DB) {
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM users"),
      c.env.DB.prepare("DELETE FROM invites"),
      c.env.DB.prepare("DELETE FROM quiz_stores"),
      c.env.DB.prepare("DELETE FROM meta"),
    ]);
  }
  // 清空 KV 每日限额计数（本地/测试重跑用）
  if (c.env.RATE_LIMITS) {
    try {
      const list = await c.env.RATE_LIMITS.list();
      for (const k of list.keys || []) await c.env.RATE_LIMITS.delete(k.name);
    } catch (e) {
      console.error("[dev/reset] 清 KV 限额计数失败", e);
    }
  }
  _resetRateLimitForTest();
  return json({ ok: true });
};

/* ---------------- 装配 ---------------- */

const router = createRouter();

router.route("POST", "/api/register", register, {
  before: [limiter.rateLimit(rlRegisterKey, LIMIT), dailyLimiter.dailyLimit],
});
router.route("POST", "/api/login", login, {
  before: [limiter.rateLimit(rlLoginKey, LIMIT), dailyLimiter.dailyLimit],
});
router.route("GET", "/api/bootstrap", bootstrap);
router.route("GET", "/api/me", me, { auth: true });
router.route("GET", "/api/store", getStore, { auth: true });
router.route("PUT", "/api/store", putStore, { auth: true });
router.route("DELETE", "/api/store", deleteStore, { auth: true });
router.route("POST", "/api/invites", createInvite, { auth: true, admin: true });
router.route("GET", "/api/invites", listInvites, { auth: true, admin: true });
router.route("GET", "/api/admin/backup", adminBackup, { auth: true, admin: true });
router.route("POST", "/api/dev/reset", devReset);

export async function handleApi(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  storeOverride?: import("./types").Store,
): Promise<Response> {
  const url = new URL(request.url);
  const c: Ctx = {
    request,
    env,
    store: storeOverride ?? createStore(env),
    url,
    method: request.method.toUpperCase(),
    path: url.pathname,
    user: null,
  };

  try {
    return await router.dispatch(c);
  } catch (e) {
    console.error("[api] error", c.path, c.method, e);
    return fail(500, "server_error", "服务器内部错误");
  }
}
