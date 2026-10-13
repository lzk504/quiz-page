/**
 * 极简 hash 路由。
 *   #/home  #/banks  #/wrongbook  #/me  #/login
 *   #/practice?domain=health&type=single    练习模式
 *   #/practice?mode=wrong|daily|fav|exam    错题重刷 / 今日目标 / 单题练习 / 考试
 *   #/favorites  #/stats  #/settings
 *
 * 登录守卫：未登录访问非 login 视图 → 重定向 #/login；已登录访问 #/login → #/home。
 */

import { isLoggedIn } from "./auth";
import type { View } from "./types";

const views = new Map<string, View>();
let current: View | null = null;
let onAfter: ((route: Route) => void) | null = null;

const PUBLIC_VIEWS = new Set(["login"]);
/** 自带标题区（蓝卡 / 紫卡 / 沉浸页）的视图：隐藏顶栏品牌栏 */
const TOPBAR_HIDDEN = new Set(["home", "me", "practice", "login"]);

export function register(name: string, view: View): void {
  views.set(name, view);
}

export const DEFAULT_ROUTE = "home";

export interface Route {
  view: string;
  params: Record<string, string>;
}

export function parseHash(hash: string = location.hash): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const view = (path || DEFAULT_ROUTE).trim() || DEFAULT_ROUTE;
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  return { view, params };
}

export function navigate(path: string, params?: Record<string, string>): void {
  let hash = `#/${path}`;
  if (params && Object.keys(params).length) hash += `?${new URLSearchParams(params)}`;
  if (location.hash === hash) void render();
  else location.hash = hash;
}

export function back(fallback = "home"): void {
  if (history.length > 1) history.back();
  else navigate(fallback);
}

async function render(): Promise<void> {
  const { view, params } = parseHash();

  // 登录守卫
  const logged = isLoggedIn();
  if (!logged && !PUBLIC_VIEWS.has(view)) {
    location.replace("#/login");
    return;
  }
  if (logged && view === "login") {
    location.replace("#/home");
    return;
  }

  const target = views.get(view) ?? views.get(DEFAULT_ROUTE);
  if (!target) return;

  const app = document.getElementById("app");
  if (!app) return;

  // 卸载上一个视图
  if (current?.unmount) {
    try { current.unmount(); } catch (e) { console.error("[router] unmount 出错", e); }
  }

  current = target;
  app.innerHTML = "";
  app.classList.toggle("app--flush", view === "practice");
  // 登录页隐藏底部导航与顶栏统计
  app.classList.toggle("app--auth", view === "login");
  // 自带标题区的视图隐藏顶栏品牌栏
  app.classList.toggle("app--nobar", TOPBAR_HIDDEN.has(view));
  window.scrollTo({ top: 0, behavior: "auto" });

  try {
    await target.render(app, params);
  } catch (e) {
    console.error("[router] 渲染出错", e);
    app.innerHTML = `<div class="error"><div class="error__icon">⚠️</div>
      <h2>页面渲染失败</h2><p>${(e as Error)?.message ?? "未知错误"}</p></div>`;
  }

  onAfter?.({ view, params });
}

export function startRouter(afterRender: (route: Route) => void): void {
  onAfter = afterRender;
  window.addEventListener("hashchange", () => { void render(); });
  if (!location.hash) location.replace("#/" + (isLoggedIn() ? DEFAULT_ROUTE : "login"));
  void render();
}

export const currentRoute = (): Route => parseHash();
