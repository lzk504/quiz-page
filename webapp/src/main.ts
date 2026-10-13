/** 应用入口：初始化存储 → 加载题库 → 注册视图 → 启动路由 */

import "./style.css";

import { loadBanks, on, getMeta, getQuestions, getBanks } from "./state";
import { initStorage, getStore, isPersistent, setValidIds, flushStore,
  exportJson, validateImport, applyImport, clearAll, toggleFavorite, isFavorite } from "./storage";
import { initAuth, isLoggedIn, fetchMe, clearToken } from "./auth";
import { startSync } from "./sync";
import { register, startRouter, type Route } from "./router";
import { computeStats } from "./stats";
import { esc, APP_NAME } from "./utils";
import type { SyncStatus } from "./types";

import home from "./views/home";
import banks from "./views/banks";
import practice, { debugSession, debugExam } from "./views/practice";
import wrongbook from "./views/wrongbook";
import me from "./views/me";
import favorites from "./views/favorites";
import stats from "./views/stats";
import settings from "./views/settings";
import login from "./views/login";

/**
 * 自动化/调试钩子：暴露当前用户的存储 API 与刷题会话快照。
 * 仅能读写「当前登录用户自己」的数据（服务端按 token 隔离），无越权风险。
 * 供 e2e 测试与浏览器控制台排查使用。
 */
(window as unknown as { __quiz: unknown }).__quiz = {
  storage: {
    getStore, exportJson, validateImport, applyImport, clearAll,
    // 调试用：收藏读写（视图外的快捷入口，供 e2e 构造数据）
    favorites: () => ({ ...getStore().favorites }),
    isFavorite, toggleFavorite,
  },
  practice: { session: debugSession, exam: debugExam },
  /** 应用名（e2e 断言标题口径用） */
  appName: APP_NAME,
};

const TAB_OF_ROUTE: Record<string, string> = {
  home: "home",
  banks: "banks",
  wrongbook: "wrongbook",
  me: "me",
  // 子页归属「我的」
  stats: "me", settings: "me", favorites: "me",
  // practice 不在表内：沉浸页不高亮任何 tab
};

/* ---------------- 顶栏 / 标签栏同步 ---------------- */

function syncChrome(route: Route): void {
  // 登录页不显示统计
  if (route.view === "login" || !isLoggedIn()) {
    const node = document.getElementById("topMeta");
    if (node) node.textContent = "";
    const badge = document.getElementById("tabBadge");
    if (badge) badge.hidden = true;
    document.querySelectorAll(".tab").forEach((n) => n.classList.toggle("is-active", false));
    return;
  }

  // 底部导航高亮
  const tab = TAB_OF_ROUTE[route.view] ?? "home";
  document.querySelectorAll(".tab").forEach((node) => {
    node.classList.toggle("is-active", (node as HTMLElement).dataset.tab === tab);
  });

  // 顶栏右侧：进度摘要
  const meta = getMeta();
  const s = computeStats(getQuestions(), getStore());
  const node = document.getElementById("topMeta");
  if (node) {
    node.textContent = meta
      ? `${s.progress.answered}/${s.progress.total} · ${s.answered ? s.rate + "%" : "未答题"}`
      : "";
  }

  syncBadge();
}

function syncBadge(): void {
  const badge = document.getElementById("tabBadge");
  if (!badge) return;
  const n = computeStats(getQuestions(), getStore()).wrongCount;
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.hidden = n === 0;
}

/* ---------------- 降级横幅 ---------------- */

function showBanner(text: string, kind = "warn"): void {
  const b = document.getElementById("banner");
  if (!b) return;
  b.textContent = text;
  b.dataset.kind = kind;
  b.hidden = false;
}

function hideBanner(): void {
  const b = document.getElementById("banner");
  if (b) b.hidden = true;
}

/* ---------------- 错误页 ---------------- */

function renderLoadError(app: HTMLElement, err: Error): void {
  const isFile = location.protocol === "file:";
  app.innerHTML = `
    <div class="error">
      <div class="error__icon">📡</div>
      <h2>题库加载失败</h2>
      <p>${esc(err?.message ?? "未知错误")}</p>
      ${isFile
        ? `<p>检测到你是用 <code>file://</code> 直接打开的页面。请改用 <code>npm run dev</code> 或访问部署后的站点。</p>`
        : `<p>请确认 <code>data/banks.json</code> 与各题库文件已随构建产物发布；如果是刚部署，稍等片刻让 CDN 缓存生效。</p>`}
      <div class="actions" style="justify-content:center;margin-top:18px">
        <button class="btn btn--primary" id="retry">重新加载</button>
      </div>
    </div>
  `;
  app.querySelector("#retry")?.addEventListener("click", () => location.reload());
}

/* ---------------- 启动 ---------------- */

async function boot(): Promise<void> {
  const app = document.getElementById("app")!;

  register("home", home);
  register("banks", banks);
  register("practice", practice);
  register("wrongbook", wrongbook);
  register("me", me);
  register("favorites", favorites);
  register("stats", stats);
  register("settings", settings);
  register("login", login);

  try {
    await loadBanks();
  } catch (err) {
    console.error("[boot] 题库加载失败", err);
    renderLoadError(app, err as Error);
    return;
  }

  // 先注入题库 id 集与题库前缀，再初始化存储：迁移/清理需要它剔除失效记录
  setValidIds(getQuestions().map((q) => q.id), getBanks().map((b) => b.id));

  // 鉴权：读 token → 校验 → 已登录则拉云端 store
  initAuth();
  let persistent = true;
  if (isLoggedIn()) {
    const me = await fetchMe();
    if (!me) {
      clearToken();   // token 失效：清掉，让路由守卫把用户送到登录页
    } else {
      persistent = await initStorage();
      startSync();    // 登录后启动跨设备轮询同步
    }
  }

  if (!persistent) {
    showBanner("本地存储不可用（可能是隐私模式或浏览器限制），登录态无法保持，每次打开需重新登录。");
  }

  // 数据变化时同步顶栏与角标
  const refreshChrome = (): void => {
    const view = location.hash.replace(/^#\/?/, "").split("?")[0] || "home";
    syncChrome({ view, params: {} });
  };
  on("store-changed", refreshChrome);
  on("data-loaded", refreshChrome);
  on("banks-changed", refreshChrome);
  on("storage-broken", () => {
    if (isPersistent()) return;
    showBanner("本地存储不可用（可能是隐私模式或浏览器限制），登录态无法保持，每次打开需重新登录。");
  });
  on("sync-status", (s) => {
    const st = s as SyncStatus | undefined;
    if (st?.status === "error" && st?.error) {
      showBanner(`数据同步失败：${st.error}（已在本地保存，将在网络恢复后重试）`, "warn");
    } else {
      hideBanner();
    }
  });

  // 页面隐藏 / 关闭前把待发数据 flush 到云端
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushStore();
  });
  window.addEventListener("beforeunload", () => flushStore());

  // 文档标题固定为应用名，不随题库/视图变化（口径见 utils.APP_NAME）
  document.title = APP_NAME;

  startRouter((route) => syncChrome(route));
}

void boot();
