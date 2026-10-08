/**
 * /api/* 路由分发与鉴权中间件。
 *
 * 依赖 env.KV（Cloudflare KV binding，本地开发由 scripts/dev-server.mjs 提供内存 mock）
 *      env.JWT_SECRET（30+ 字符 secret）
 *
 * 错误格式：{ error: <code>, message: <zh> }；HTTP 状态码 400/401/403/404/409/500。
 */

import {
  hashPassword, verifyPassword, issueToken, verifyJwt,
  generateInviteCode, USERNAME_RE, validatePassword,
} from "./auth.js";

/* ---------------- 响应助手 ---------------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function fail(status, code, message, extra = {}) {
  return json({ error: code, message, ...extra }, status);
}

async function readJson(request) {
  let text;
  try { text = await request.text(); }
  catch { return { ok: false, error: "invalid_input", message: "请求体读取失败" }; }
  if (!text) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(text) }; }
  catch { return { ok: false, error: "invalid_input", message: "请求体不是合法 JSON" }; }
}

async function requireAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const payload = await verifyJwt(m[1].trim(), env.JWT_SECRET);
  if (!payload || !payload.sub) return null;
  return payload;
}

async function requireAdmin(request, env, user) {
  const auth = await env.KV.get(`user:${user.sub}:auth`, { type: "json" });
  return auth && auth.role === "admin";
}

/* ---------------- 主分发 ---------------- */

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  try {
    // 公开端点
    if (path === "/api/register" && method === "POST") return await register(request, env);
    if (path === "/api/login" && method === "POST") return await login(request, env);
    if (path === "/api/bootstrap" && method === "GET") {
      const users = await getUsers(env);
      return json({ initialized: users.count > 0 });
    }

    // 鉴权端点
    const user = await requireAuth(request, env);
    if (!user) return fail(401, "unauthorized", "未登录或登录已过期");

    if (path === "/api/me" && method === "GET") return await me(request, env, user);

    if (path === "/api/store") {
      if (method === "GET") return await getStore(request, env, user);
      if (method === "PUT") return await putStore(request, env, user);
      if (method === "DELETE") return await deleteStore(request, env, user);
    }

    if (path === "/api/invites") {
      const isAdmin = await requireAdmin(request, env, user);
      if (!isAdmin) return fail(403, "forbidden", "需要管理员权限");
      if (method === "POST") return await createInvite(request, env, user);
      if (method === "GET") return await listInvites(request, env);
    }

    return fail(404, "not_found", "接口不存在");
  } catch (e) {
    console.error("[api] error", path, method, e);
    return fail(500, "server_error", "服务器内部错误");
  }
}

/* ---------------- 用户表读写 ---------------- */

async function getUsers(env) {
  const raw = await env.KV.get("users", { type: "json" });
  if (raw && typeof raw === "object") return raw;
  return { version: 1, count: 0, byUsername: {} };
}

async function putUsers(env, users) {
  await env.KV.put("users", JSON.stringify(users));
}

/* ---------------- 注册 ---------------- */

export async function register(request, env) {
  const r = await readJson(request);
  if (!r.ok) return fail(400, r.error, r.message);
  const { username, password, inviteCode } = r.value || {};

  if (!username || !USERNAME_RE.test(username)) {
    return fail(400, "invalid_input", "用户名需 3-32 位字母、数字、下划线或短横线");
  }
  const pwErr = validatePassword(password);
  if (pwErr) return fail(400, "invalid_input", pwErr);

  const users = await getUsers(env);
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
    invite = await env.KV.get(`invite:${inviteCode}`, { type: "json" });
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
  await env.KV.put(`user:${username}:auth`, JSON.stringify(authRec));

  users.count += 1;
  users.byUsername[username] = { id: authRec.id, role: authRec.role, createdAt: authRec.createdAt };
  await putUsers(env, users);

  if (invite) {
    invite.usedBy = username;
    invite.usedAt = Date.now();
    await env.KV.put(`invite:${inviteCode}`, JSON.stringify(invite));
  }

  const token = await issueToken(username, authRec.role, env.JWT_SECRET);
  return json({
    token,
    user: { id: authRec.id, username, role: authRec.role, createdAt: authRec.createdAt },
  }, 201);
}

/* ---------------- 登录 ---------------- */

export async function login(request, env) {
  const r = await readJson(request);
  if (!r.ok) return fail(400, r.error, r.message);
  const { username, password } = r.value || {};
  if (!username || !password) return fail(400, "invalid_input", "用户名和密码不能为空");

  const auth = await env.KV.get(`user:${username}:auth`, { type: "json" });
  if (!auth) return fail(401, "unauthorized", "用户名或密码错误");
  const ok = await verifyPassword(password, auth.passwordHash?.saltHex, auth.passwordHash?.hashHex);
  if (!ok) return fail(401, "unauthorized", "用户名或密码错误");

  const token = await issueToken(username, auth.role, env.JWT_SECRET);
  return json({ token, user: { id: auth.id, username, role: auth.role, createdAt: auth.createdAt } });
}

/* ---------------- /api/me ---------------- */

export async function me(request, env, user) {
  const auth = await env.KV.get(`user:${user.sub}:auth`, { type: "json" });
  if (!auth) return fail(401, "unauthorized", "用户不存在");
  return json({ id: auth.id, username: auth.username, role: auth.role, createdAt: auth.createdAt });
}

/* ---------------- 刷题数据 ---------------- */

export async function getStore(request, env, user) {
  const raw = await env.KV.get(`store:${user.sub}`);
  if (!raw) return json({ store: null, updatedAt: null });
  try {
    const store = JSON.parse(raw);
    return json({ store, updatedAt: store.updatedAt || 0 });
  } catch {
    return json({ store: null, updatedAt: null });
  }
}

export async function putStore(request, env, user) {
  const r = await readJson(request);
  if (!r.ok) return fail(400, r.error, r.message);
  const { store, baseUpdatedAt } = r.value || {};
  if (!store || typeof store !== "object") {
    return fail(400, "invalid_input", "缺少 store 字段");
  }

  // 乐观锁：云端 updatedAt > 客户端 baseUpdatedAt → 409
  const existingRaw = await env.KV.get(`store:${user.sub}`);
  let existingUpdatedAt = 0;
  if (existingRaw) {
    try { existingUpdatedAt = JSON.parse(existingRaw).updatedAt || 0; } catch {}
  }
  if (baseUpdatedAt && existingUpdatedAt && existingUpdatedAt > baseUpdatedAt) {
    return fail(409, "conflict", "云端有更新版本，请刷新后合并", { serverUpdatedAt: existingUpdatedAt });
  }

  const newStore = { ...store, updatedAt: Date.now() };
  await env.KV.put(`store:${user.sub}`, JSON.stringify(newStore));
  return json({ updatedAt: newStore.updatedAt });
}

export async function deleteStore(request, env, user) {
  await env.KV.delete(`store:${user.sub}`);
  return new Response(null, { status: 204 });
}

/* ---------------- 邀请码 ---------------- */

export async function createInvite(request, env, user) {
  const code = generateInviteCode();
  const invite = { code, createdBy: user.sub, createdAt: Date.now(), usedBy: null, usedAt: null };
  await env.KV.put(`invite:${code}`, JSON.stringify(invite));
  return json(invite, 201);
}

export async function listInvites(request, env) {
  const list = await env.KV.list({ prefix: "invite:" });
  const out = [];
  for (const k of list.keys || []) {
    const v = await env.KV.get(k.name, { type: "json" });
    if (v) out.push(v);
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return json(out);
}
