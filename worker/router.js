/**
 * 轻量路由 + 中间件链：对齐 nodewarden 的 router 分层（public / authenticated / admin）。
 *
 * 依赖方向（无环）：routes.js → { router.js, store.js, ratelimit.js, auth.js }
 * ratelimit.js → router.js（仅取 fail）
 *
 * 统一请求上下文 c = { request, env, store, url, method, path, user }。
 * 中间件返回 Response 表示短路（401/403/429），返回 undefined 表示放行。
 */

import { verifyJwt } from "./auth.js";

/* ---------------- 响应助手 ---------------- */

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function fail(status, code, message, extra = {}) {
  return json({ error: code, message, ...extra }, status);
}

export async function readJson(request) {
  let text;
  try { text = await request.text(); }
  catch { return { ok: false, error: "invalid_input", message: "请求体读取失败" }; }
  if (!text) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(text) }; }
  catch { return { ok: false, error: "invalid_input", message: "请求体不是合法 JSON" }; }
}

/* ---------------- 鉴权中间件 ---------------- */

/** 解析并校验 Bearer token；成功则 c.user = payload，失败返回 401 */
export async function requireAuth(c) {
  const auth = c.request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return fail(401, "unauthorized", "未登录或登录已过期");
  const payload = await verifyJwt(m[1].trim(), c.env.JWT_SECRET);
  if (!payload || !payload.sub) return fail(401, "unauthorized", "未登录或登录已过期");
  c.user = payload;
  return undefined;
}

/** 校验当前用户是否为管理员；非 admin 返回 403 */
export async function requireAdmin(c) {
  const auth = await c.store.getUserAuth(c.user.sub);
  if (!auth || auth.role !== "admin") return fail(403, "forbidden", "需要管理员权限");
  return undefined;
}

/* ---------------- 路由表 ---------------- */

export function createRouter() {
  const routes = [];

  function route(method, path, handler, opts = {}) {
    routes.push({ method, path, handler, ...opts });
  }

  /**
   * 分发。顺序是「零行为差异」的关键（与原 if-else 严格对齐）：
   *  ① 公开路由精确匹配
   *  ② 全局鉴权门：其余 /api 一律先验 JWT —— 未登录 401 优先于 404
   *  ③ admin 门：含 admin 选项的 path 在「方法匹配之前」判 403
   *  ④ 受保护路由精确匹配，否则 404
   */
  async function dispatch(c) {
    // ① 公开路由
    const pub = routes.find((r) => r.method === c.method && r.path === c.path && !r.auth);
    if (pub) return runChain(pub, c);

    // ② 全局鉴权门
    const denied = await requireAuth(c);
    if (denied) return denied;

    // ③ admin 门（path 级）
    const adminPaths = new Set(routes.filter((r) => r.admin).map((r) => r.path));
    if (adminPaths.has(c.path)) {
      const forbidden = await requireAdmin(c);
      if (forbidden) return forbidden;
    }

    // ④ 受保护路由
    const rt = routes.find((r) => r.method === c.method && r.path === c.path && r.auth);
    if (!rt) return fail(404, "not_found", "接口不存在");
    return runChain(rt, c);
  }

  async function runChain(entry, c) {
    const mws = entry.before || [];
    for (const mw of mws) {
      const res = await mw(c);
      if (res) return res;
    }
    return entry.handler(c);
  }

  return { route, dispatch };
}
