/** 应用入口：初始化存储 → 加载题库 → 注册视图 → 启动路由 */

import { loadQuestions, on, getMeta, getQuestions } from "./state.js";
import { initStorage, getStore, isPersistent, setValidIds } from "./storage.js";
import { register, startRouter } from "./router.js";
import { computeStats } from "./stats.js";
import { esc } from "./utils.js";

import home from "./views/home.js";
import practice from "./views/practice.js";
import wrongbook from "./views/wrongbook.js";
import stats from "./views/stats.js";
import settings from "./views/settings.js";

const TABS = ["home", "practice", "wrongbook", "stats", "settings"];
const TAB_OF_ROUTE = { home: "home", practice: "practice", wrongbook: "wrongbook", stats: "stats", settings: "settings" };

/* ---------------- 顶栏 / 标签栏同步 ---------------- */

function syncChrome(route) {
  // 底部导航高亮
  const tab = TAB_OF_ROUTE[route.view] ?? "home";
  document.querySelectorAll(".tab").forEach((node) => {
    node.classList.toggle("is-active", node.dataset.tab === tab);
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

function syncBadge() {
  const badge = document.getElementById("tabBadge");
  if (!badge) return;
  const n = computeStats(getQuestions(), getStore()).wrongCount;
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.hidden = n === 0;
}

/* ---------------- 降级横幅 ---------------- */

function showBanner(text, kind = "warn") {
  const b = document.getElementById("banner");
  if (!b) return;
  b.textContent = text;
  b.dataset.kind = kind;
  b.hidden = false;
}

function hideBanner() {
  const b = document.getElementById("banner");
  if (b) b.hidden = true;
}

/* ---------------- 错误页 ---------------- */

function renderLoadError(app, err) {
  const isFile = location.protocol === "file:";
  app.innerHTML = `
    <div class="error">
      <div class="error__icon">📡</div>
      <h2>题库加载失败</h2>
      <p>${esc(err?.message ?? "未知错误")}</p>
      ${isFile
        ? `<p>检测到你是用 <code>file://</code> 直接打开的页面。浏览器出于安全限制会阻止本地文件读取 JSON，请改用本地服务器访问：</p>
           <p><code>python -m http.server 8000</code> 然后访问 <code>http://localhost:8000</code></p>`
        : `<p>请确认 <code>data/questions.json</code> 存在且可访问；如果是刚部署，稍等片刻让 CDN 缓存生效。</p>`}
      <div class="actions" style="justify-content:center;margin-top:18px">
        <button class="btn btn--primary" id="retry">重新加载</button>
      </div>
    </div>
  `;
  app.querySelector("#retry")?.addEventListener("click", () => location.reload());
}

/* ---------------- 启动 ---------------- */

async function boot() {
  const app = document.getElementById("app");

  register("home", home);
  register("practice", practice);
  register("wrongbook", wrongbook);
  register("stats", stats);
  register("settings", settings);

  try {
    await loadQuestions();
  } catch (err) {
    console.error("[boot] 题库加载失败", err);
    renderLoadError(app, err);
    return;
  }

  // 先注入题库 id 集，再初始化存储：v1→v2 迁移需要它剔除已删除题的记录
  setValidIds(getQuestions().map((q) => q.id));
  const persistent = initStorage();

  if (!persistent) {
    showBanner("本地存储不可用（可能是隐私模式或浏览器限制），本次答题进度不会被保存。");
  }

  // 数据变化时同步顶栏与角标
  on("store-changed", () => syncChrome({ view: location.hash.replace(/^#\/?/, "").split("?")[0] || "home" }));
  on("storage-broken", () => {
    if (isPersistent()) return;
    showBanner("本地存储不可用（可能是隐私模式或浏览器限制），本次答题进度不会被保存。");
  });

  const meta = getMeta();
  if (meta?.title) document.title = meta.title;

  startRouter((route) => syncChrome(route));
}

boot();
