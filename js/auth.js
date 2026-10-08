/**
 * 前端鉴权：JWT token 存取 + 带鉴权的 fetch 封装 + 注册/登录/登出。
 * token 仅存 localStorage["quizapp.token.v1"]；刷题数据由 storage.js 走 /api/store。
 */

const TOKEN_KEY = "quizapp.token.v1";

let currentUser = null;

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); }
  catch { return null; }
}

export function setToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* 隐私模式：忽略，会话内有效 */ }
}

export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  currentUser = null;
}

export function isLoggedIn() { return !!getToken(); }

export function getCurrentUser() { return currentUser; }
export function setCurrentUser(u) { currentUser = u; }

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * 带鉴权的 fetch 封装。401 自动清 token 并跳登录页。
 * 抛 ApiError；成功返回已解析的 JSON（204 返回 null）。
 */
export async function apiFetch(path, { method = "GET", body, headers } = {}) {
  const token = getToken();
  const h = { ...(headers || {}) };
  if (token) h["Authorization"] = `Bearer ${token}`;
  if (body !== undefined && !h["Content-Type"]) h["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(path, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, "network", "网络错误，请检查连接");
  }

  if (res.status === 401) {
    clearToken();
    if (!location.hash.startsWith("#/login")) location.hash = "#/login";
    throw new ApiError(401, "unauthorized", "登录已过期，请重新登录");
  }

  let data = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try { data = await res.json(); } catch {}
  } else if (res.status !== 204) {
    try { data = await res.text(); } catch {}
  }
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error || "error",
      data?.message || `请求失败（${res.status}）`,
    );
  }
  return data;
}

export async function register(username, password, inviteCode) {
  const res = await fetch("/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, inviteCode: inviteCode || undefined }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || "error", data.message || "注册失败");
  setToken(data.token);
  currentUser = data.user;
  return data;
}

export async function login(username, password) {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || "error", data.message || "用户名或密码错误");
  setToken(data.token);
  currentUser = data.user;
  return data;
}

export function logout() {
  clearToken();
}

/** 校验当前 token，无效返回 null（不抛错） */
export async function fetchMe() {
  if (!isLoggedIn()) return null;
  try {
    const u = await apiFetch("/api/me");
    currentUser = u;
    return u;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    // 其他错误（如网络）也按未登录处理，让用户重试
    return null;
  }
}

export function initAuth() {
  // 启动时仅读 token；currentUser 由 fetchMe() 填充
  currentUser = null;
}
