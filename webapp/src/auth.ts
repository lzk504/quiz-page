/**
 * 前端鉴权：JWT token 存取 + 带鉴权的 fetch 封装 + 注册/登录/登出。
 * token 仅存 localStorage["quizapp.token.v1"]；刷题数据由 storage.ts 走 /api/store。
 */

import type { AuthUser } from "./types";

const TOKEN_KEY = "quizapp.token.v1";

let currentUser: AuthUser | null = null;

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); }
  catch { return null; }
}

export function setToken(t: string | null): void {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* 隐私模式：忽略，会话内有效 */ }
}

export function clearToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  currentUser = null;
}

export function isLoggedIn(): boolean { return !!getToken(); }

export function getCurrentUser(): AuthUser | null { return currentUser; }
export function setCurrentUser(u: AuthUser | null): void { currentUser = u; }

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface ApiFetchOpts {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

interface AuthResponse {
  token: string;
  user: AuthUser;
}

/**
 * 带鉴权的 fetch 封装。401 自动清 token 并跳登录页。
 * 抛 ApiError；成功返回已解析的 JSON（204 返回 null）。
 */
export async function apiFetch<T = any>(path: string, { method = "GET", body, headers }: ApiFetchOpts = {}): Promise<T> {
  const token = getToken();
  const h: Record<string, string> = { ...(headers || {}) };
  if (token) h["Authorization"] = `Bearer ${token}`;
  if (body !== undefined && !h["Content-Type"]) h["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network", "网络错误，请检查连接");
  }

  if (res.status === 401) {
    clearToken();
    if (!location.hash.startsWith("#/login")) location.hash = "#/login";
    throw new ApiError(401, "unauthorized", "登录已过期，请重新登录");
  }

  let data: any = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try { data = await res.json(); } catch { /* ignore */ }
  } else if (res.status !== 204) {
    try { data = await res.text(); } catch { /* ignore */ }
  }
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error || "error",
      data?.message || `请求失败（${res.status}）`,
    );
  }
  return data as T;
}

export async function register(username: string, password: string, inviteCode?: string): Promise<AuthResponse> {
  const res = await fetch("/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, inviteCode: inviteCode || undefined }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || "error", data.message || "注册失败");
  setToken(data.token);
  currentUser = data.user;
  return data as AuthResponse;
}

export async function login(username: string, password: string): Promise<AuthResponse> {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || "error", data.message || "用户名或密码错误");
  setToken(data.token);
  currentUser = data.user;
  return data as AuthResponse;
}

export function logout(): void {
  clearToken();
}

/** 校验当前 token，无效返回 null（不抛错） */
export async function fetchMe(): Promise<AuthUser | null> {
  if (!isLoggedIn()) return null;
  try {
    const u = await apiFetch<AuthUser>("/api/me");
    currentUser = u;
    return u;
  } catch {
    // 401 或其他错误均按未登录处理
    return null;
  }
}

export function initAuth(): void {
  // 启动时仅读 token；currentUser 由 fetchMe() 填充
  currentUser = null;
}
