/**
 * /api/* 业务 handler + 路由装配。
 *
 * 依赖：store.js（可插拔存储）/ router.js（路由+中间件+响应助手）/ ratelimit.js（限流）
 *       auth.js（密码学工具）
 *
 * 错误格式：{ error: <code>, message: <zh> }；HTTP 状态码 400/401/403/404/409/429/500。
 */

import {
  hashPassword, verifyPassword, issueToken,
  generateInviteCode, USERNAME_RE, validatePassword,
} from "./auth.js";
import { createStore } from "./store.js";
import { createRouter, json, fail, readJson } from "./router.js";
import { createRateLimiter, clientIp } from "./ratelimit.js";

/* ---------------- 限流（register/login 防爆破，10 次/分钟/IP） ---------------- */

const limiter = createRateLimiter();
const LIMIT = 10;
const rlRegisterKey = (c) => `${clientIp(c.request)}:register`;
const rlLoginKey = (c) => `${clientIp(c.request)}:login`;

/** 仅测试/开发用：清空限流计数（dev-server 的 /__dev/kv-reset 联动调用） */
export function _resetRateLimitForTest() {
  limiter.reset();
}

/* ---------------- 注册 ---------------- */

export async function register(c) {
  const r = await readJson(c.request);
  if (!r.ok) return fail(400, r.error, r.message);
  const { username, password, inviteCode } = r.value || {};

  if (!username || !USERNAME_RE.test(username)) {
    return fail(400, "invalid_input", "用户名需 3-32 位字母、数字、下划线或短横线");
  }
  const pwErr = validatePassword(password);
  if (pwErr) return fail(400, "invalid_input", pwErr);

  const users = await c.store.getUsers();
  const isFirst = users.count === 0;

  // 先查重：用户名已存在直接 409（避免被"需要邀请码"掩盖，UX 更明确）
  if (users.byUsername[username]) {
    return fail(409, "conflict", "用户名已存在");
  }

  // 非首用户必须提供未使用过的邀请码
  let invite = null;
  if (!isFirst) {
    if (!inviteCode || typeof inviteCode !== "string") {
      return fail(400, "invalid_input", "需要邀请码");
    }
    invite = await c.store.getInvite(inviteCode);
    if (!invite) return fail(403, "forbidden", "邀请码无效");
    if (invite.usedBy) return fail(403, "forbidden", "邀请码已被使用");
  }

  const authRec = {
    id: crypto.randomUUID(),
    username,
    passwordHash: await hashPassword(password),
    role: isFirst ? "admin" : "user",
    createdAt: Date.now(),
  };
  await c.store.putUserAuth(username, authRec);

  users.count += 1;
  users.byUsername[username] = { id: authRec.id, role: authRec.role, createdAt: authRec.createdAt };
  await c.store.putUsers(users);

  if (invite) {
    invite.usedBy = username;
    invite.usedAt = Date.now();
    await c.store.putInvite(invite);
  }

  const token = await issueToken(username, authRec.role, c.env.JWT_SECRET);
  return json({
    token,
    user: { id: authRec.id, username, role: authRec.role, createdAt: authRec.createdAt },
  }, 201);
}

/* ---------------- 登录 ---------------- */

export async function login(c) {
  const r = await readJson(c.request);
  if (!r.ok) return fail(400, r.error, r.message);
  const { username, password } = r.value || {};
  if (!username || !password) return fail(400, "invalid_input", "用户名和密码不能为空");

  const auth = await c.store.getUserAuth(username);
  if (!auth) return fail(401, "unauthorized", "用户名或密码错误");
  const ok = await verifyPassword(password, auth.passwordHash?.saltHex, auth.passwordHash?.hashHex);
  if (!ok) return fail(401, "unauthorized", "用户名或密码错误");

  const token = await issueToken(username, auth.role, c.env.JWT_SECRET);
  return json({ token, user: { id: auth.id, username, role: auth.role, createdAt: auth.createdAt } });
}

/* ---------------- /api/bootstrap ---------------- */

export async function bootstrap(c) {
  const users = await c.store.getUsers();
  return json({ initialized: users.count > 0 });
}

/* ---------------- /api/me ---------------- */

export async function me(c) {
  const auth = await c.store.getUserAuth(c.user.sub);
  if (!auth) return fail(401, "unauthorized", "用户不存在");
  return json({ id: auth.id, username: auth.username, role: auth.role, createdAt: auth.createdAt });
}

/* ---------------- 刷题数据 ---------------- */

export async function getStore(c) {
  const storeData = await c.store.getStore(c.user.sub);
  if (!storeData) return json({ store: null, updatedAt: null });
  return json({ store: storeData, updatedAt: storeData.updatedAt || 0 });
}

export async function putStore(c) {
  const r = await readJson(c.request);
  if (!r.ok) return fail(400, r.error, r.message);
  const { store, baseUpdatedAt } = r.value || {};
  if (!store || typeof store !== "object") {
    return fail(400, "invalid_input", "缺少 store 字段");
  }

  // 乐观锁：云端 updatedAt > 客户端 baseUpdatedAt → 409
  const existing = await c.store.getStore(c.user.sub);
  const existingUpdatedAt = existing?.updatedAt || 0;
  if (baseUpdatedAt && existingUpdatedAt && existingUpdatedAt > baseUpdatedAt) {
    return fail(409, "conflict", "云端有更新版本，请刷新后合并", { serverUpdatedAt: existingUpdatedAt });
  }

  const finalStore = { ...store, updatedAt: Date.now() };
  await c.store.putStore(c.user.sub, finalStore);
  return json({ updatedAt: finalStore.updatedAt });
}

export async function deleteStore(c) {
  await c.store.deleteStore(c.user.sub);
  return new Response(null, { status: 204 });
}

/* ---------------- 邀请码 ---------------- */

export async function createInvite(c) {
  const code = generateInviteCode();
  const invite = { code, createdBy: c.user.sub, createdAt: Date.now(), usedBy: null, usedAt: null };
  await c.store.putInvite(invite);
  return json(invite, 201);
}

export async function listInvites(c) {
  return json(await c.store.listInvites());
}

/* ---------------- 装配 ---------------- */

const router = createRouter();

router.route("POST", "/api/register", register, {
  before: [limiter.rateLimit(rlRegisterKey, LIMIT)],
});
router.route("POST", "/api/login", login, {
  before: [limiter.rateLimit(rlLoginKey, LIMIT)],
});
router.route("GET", "/api/bootstrap", bootstrap);
router.route("GET", "/api/me", me, { auth: true });
router.route("GET", "/api/store", getStore, { auth: true });
router.route("PUT", "/api/store", putStore, { auth: true });
router.route("DELETE", "/api/store", deleteStore, { auth: true });
router.route("POST", "/api/invites", createInvite, { auth: true, admin: true });
router.route("GET", "/api/invites", listInvites, { auth: true, admin: true });

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const c = {
    request,
    env,
    store: createStore(env),
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
