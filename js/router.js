/**
 * 极简 hash 路由。
 *   #/home   #/login
 *   #/practice?domain=health&type=single
 *   #/practice?mode=wrong
 *   #/wrongbook  #/stats  #/settings
 *
 * 登录守卫：未登录访问非 login 视图 → 重定向 #/login；已登录访问 #/login → #/home。
 */

import { isLoggedIn } from "./auth.js";

const views = new Map();
let current = null;
let onAfter = null;

const PUBLIC_VIEWS = new Set(["login"]);

export function register(name, view) {
  views.set(name, view);
}

export const DEFAULT_ROUTE = "home";

export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const view = (path || DEFAULT_ROUTE).trim() || DEFAULT_ROUTE;
  const params = {};
  for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  return { view, params };
}

export function navigate(path, params) {
  let hash = `#/${path}`;
  if (params && Object.keys(params).length) hash += `?${new URLSearchParams(params)}`;
  if (location.hash === hash) render();
  else location.hash = hash;
}

export function back(fallback = "home") {
  if (history.length > 1) history.back();
  else navigate(fallback);
}

async function render() {
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
  window.scrollTo({ top: 0, behavior: "instant" in document.documentElement.style ? "instant" : "auto" });

  try {
    await target.render(app, params);
  } catch (e) {
    console.error("[router] 渲染出错", e);
    app.innerHTML = `<div class="error"><div class="error__icon">⚠️</div>
      <h2>页面渲染失败</h2><p>${e?.message ?? "未知错误"}</p></div>`;
  }

  onAfter?.({ view, params });
}

export function startRouter(afterRender) {
  onAfter = afterRender;
  window.addEventListener("hashchange", render);
  if (!location.hash) location.replace("#/" + (isLoggedIn() ? DEFAULT_ROUTE : "login"));
  render();
}

export const currentRoute = () => parseHash();
