/**
 * 错题本（v6 重写 + 题库分类）：三数字概览 + 题库筛选 + 题型筛选 + 平铺卡片
 *                              + 单题重做 / 收藏 / 移出 + 批量移出 + 一键重做
 *
 * 核心优化：
 * - 采用 WrongbookManager 统一管理错题与题库预加载，解决跨库错题被静默丢弃的问题；
 * - 动态根据真实数据统计题库与题型错题数（不硬编码任何数据）；
 * - 错题列表分页（每页 10 条 + 页码器 + 总数展示），避免一次性渲染上百条卡片导致的卡顿。
 */

import "./wrongbook.css";
import { removeFromWrongbook, toggleFavorite, isFavorite } from "../storage";
import { displayAnswer, displayUserAnswer } from "../scoring";
import { wrongLevel } from "../goal";
import { esc, fmtTime, pct } from "../utils";
import { navigate } from "../router";
import { typeTag, questionDomainTag, bankTag, emptyState, toast, confirmDialog } from "../ui";
import type { View } from "../types";
import { WrongbookManager, type WrongItem } from "./practice-hub/wrongbook-manager";

/* ---------------- 模块级 UI 状态 ---------------- */

let activeBank = "all";
let activeType = "all";
let batchMode = false;
/** 当前页码（1-based）；筛选切换时重置回第 1 页，paint 内会按总页数 clamp */
let page = 1;
/** 每页错题条数（与考试结算页逐题解析区一致） */
const PAGE_SIZE = 10;
const checked = new Set<string>();

const TYPE_FILTERS: Array<{ key: string; label: string }> = [
  { key: "all", label: "全部题型" },
  { key: "single", label: "单选题" },
  { key: "multiple", label: "多选题" },
  { key: "judge", label: "判断题" },
  { key: "fill", label: "填空题" },
  { key: "short", label: "简答题" },
];

/** 答案文本截断（错因解析/简答参考答案可能很长） */
function clip(text: string, max = 220): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/**
 * 分页器：窄屏只留「上一页 / 下一页 + 共 N 题·第 X/Y 页」，宽屏展开页码（5 位滑动窗口 + 省略号）。
 * 与考试结算页逐题解析区同款交互。
 */
function pagerHtml(cur: number, pages: number, total: number): string {
  const btn = (n: number) =>
    `<button type="button" class="wb-pager__num${n === cur ? " is-on" : ""}" data-page="${n}">${n}</button>`;
  const gap = `<span class="wb-pager__gap">…</span>`;

  let nums = "";
  if (pages <= 7) {
    for (let i = 1; i <= pages; i++) nums += btn(i);
  } else {
    let start = Math.max(1, cur - 2);
    const end = Math.min(pages, start + 4);
    start = Math.max(1, end - 4);
    if (start > 1) nums += btn(1) + (start > 2 ? gap : "");
    for (let i = start; i <= end; i++) nums += btn(i);
    if (end < pages) nums += (end < pages - 1 ? gap : "") + btn(pages);
  }

  return `
    <nav class="wb-pager" aria-label="错题列表分页">
      <button type="button" class="wb-pager__btn" data-page="${cur - 1}" ${cur <= 1 ? "disabled" : ""}>‹ 上一页</button>
      <span class="wb-pager__nums">${nums}</span>
      <button type="button" class="wb-pager__btn" data-page="${cur + 1}" ${cur >= pages ? "disabled" : ""}>下一页 ›</button>
      <span class="wb-pager__hint">共 ${total} 题 · 第 ${cur} / ${pages} 页</span>
    </nav>
  `;
}

function renderItem(it: WrongItem): string {
  const { q, w, wrongAttempts } = it;
  const level = wrongLevel(wrongAttempts);
  const badgeCls = level === "red" ? "wb-badge--red" : level === "amber" ? "wb-badge--amber" : "";
  const mine = displayUserAnswer(q, w.lastUserAnswer);
  const right = displayAnswer(q);
  const starred = isFavorite(q.id);

  return `<div class="wb-item" data-id="${esc(q.id)}">
    <div class="wb-item__top">
      <div class="wb-item__tags">
        ${batchMode ? `<button class="wb-check${checked.has(q.id) ? " is-on" : ""}" data-act="check" aria-label="选择">✓</button>` : ""}
        ${typeTag(q.type)}${questionDomainTag(q)}${bankTag(q)}
      </div>
      <span class="wb-badge ${badgeCls}">◷ 错 ${wrongAttempts} 次</span>
    </div>
    <div class="wb-item__stem">${esc(q.stem)}</div>
    <div class="wb-item__answers">
      <div class="wb-item__line wb-item__line--mine">我的答案：<b>${esc(clip(mine))}</b></div>
      <div class="wb-item__line wb-item__line--right">正确答案：<b>${esc(clip(right))}</b></div>
    </div>
    ${q.analysis ? `<div class="wb-item__analysis"><b>错因解析</b>${esc(clip(q.analysis, 320))}</div>` : ""}
    <div class="wb-item__foot">
      <span>上次错误 ${w.lastWrongAt ? esc(fmtTime(w.lastWrongAt)) : "—"}</span>
      <span class="wb-item__act">
        <button class="btn btn--sm btn--ghost" data-act="redo" style="padding:0 8px">↻ 重做本题</button>
        <button class="btn btn--sm btn--ghost" data-act="fav" style="padding:0 8px">${starred ? "★ 已收藏" : "☆ 收藏"}</button>
        <button class="btn btn--sm btn--danger" data-act="remove" style="padding:0 8px">移出</button>
      </span>
    </div>
  </div>`;
}

/* ---------------- 视图 ---------------- */

const view: View = {
  async render(root) {
    // 确保所有题库加载完毕，杜绝部分题库未就绪导致的统计失真
    await WrongbookManager.ensureReady();

    const bankCounts = WrongbookManager.getBankCounts();
    const totalPending = bankCounts.reduce((acc, b) => acc + b.count, 0);

    // 如果选中的题库不存在，重置为 all
    if (activeBank !== "all" && !bankCounts.some((b) => b.bankId === activeBank)) {
      activeBank = "all";
    }

    if (totalPending === 0) {
      root.innerHTML = `
        <div class="page-head">
          <h1 class="page-head__title">错题本</h1>
        </div>
        <div id="wbList"></div>
      `;
      const listBox = root.querySelector<HTMLElement>("#wbList")!;
      listBox.innerHTML = emptyState({
        icon: "✅",
        title: "错题本是空的",
        desc: "刷题时答错的题目会自动收进这里，重做答对后会自动移出。",
        action: `<button class="btn btn--primary" id="wPractice">去刷题</button>`,
      });
      listBox.querySelector("#wPractice")?.addEventListener("click", () => navigate("general-practice", { fresh: "1" }));
      return;
    }

    const stats = WrongbookManager.getStats(activeBank);
    const bankItems = WrongbookManager.getItems({ bankId: activeBank, type: "all" });

    root.innerHTML = `
      <div class="page-head">
        <h1 class="page-head__title">错题本</h1>
        <button class="btn btn--sm ${batchMode ? "btn--primary" : ""}" id="wbManage">${batchMode ? "完成" : "管理"}</button>
      </div>
      <div class="wb-kpi">
        <div class="wb-kpi__cell wb-kpi__cell--bad"><b>${stats.total}</b><span>错题总数</span></div>
        <div class="wb-kpi__cell wb-kpi__cell--ok"><b>${stats.corrected}</b><span>已订正</span></div>
        <div class="wb-kpi__cell"><b>${stats.pending}</b><span>待复习</span></div>
      </div>
      <section class="card">
        <div style="font-size:12px;color:var(--text-sub);margin-bottom:6px;font-weight:500">题库筛选</div>
        <div class="chips" id="wbBankChips">
          <button class="chip${activeBank === "all" ? " is-on" : ""}" data-bank="all">
            全部题库<span class="chip__n">${totalPending}</span>
          </button>
          ${bankCounts.map((b) => `
            <button class="chip${activeBank === b.bankId ? " is-on" : ""}" data-bank="${esc(b.bankId)}">
              ${esc(b.bankName)}<span class="chip__n">${b.count}</span>
            </button>
          `).join("")}
        </div>

        <div style="font-size:12px;color:var(--text-sub);margin-top:12px;margin-bottom:6px;font-weight:500">题型筛选</div>
        <div class="chips" id="wbTypeChips">
          ${TYPE_FILTERS.map((t) => {
            const n = t.key === "all" ? bankItems.length : bankItems.filter((it) => it.q.type === t.key).length;
            return `<button class="chip${activeType === t.key ? " is-on" : ""}" data-type="${esc(t.key)}">
              ${esc(t.label)}<span class="chip__n">${n}</span>
            </button>`;
          }).join("")}
        </div>

        <p class="about" style="margin:12px 0 0">
          答错自动收录，<b>重做答对后自动移出</b>；
          ${stats.total ? `历史共错过 ${stats.total} 题，已订正 ${stats.corrected} 题（${pct(stats.corrected, stats.total)}%）。` : ""}
        </p>
      </section>
      <div id="wbList"></div>
      <div id="wbPager"></div>
      <div id="wbCta"></div>
    `;

    const listBox = root.querySelector<HTMLElement>("#wbList")!;
    const pagerBox = root.querySelector<HTMLElement>("#wbPager")!;
    const ctaBox = root.querySelector<HTMLElement>("#wbCta")!;

    /**
     * 局部重绘错题列表（仅渲染当前页，避免一次性渲染上百条卡片导致的卡顿）。
     * scroll=true 时把列表顶部滚入视野（翻页专用；勾选/收藏等重绘不打断当前视口）。
     */
    const paint = (scroll = false): void => {
      const filtered = WrongbookManager.getItems({ bankId: activeBank, type: activeType });
      const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
      page = Math.min(Math.max(1, page), pages);   // 兜底：移出/筛选后页码残留也不会白屏
      const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

      listBox.innerHTML = slice.length
        ? `<section class="card" style="padding:12px 16px">${slice.map(renderItem).join("")}</section>`
        : emptyState({ icon: "🔍", title: "该筛选下暂无错题", desc: "换个题库或题型，或选择「全部题型」。" });

      pagerBox.innerHTML = filtered.length
        ? pages > 1
          ? pagerHtml(page, pages, filtered.length)
          : `<nav class="wb-pager" aria-label="错题列表分页"><span class="wb-pager__hint">共 ${filtered.length} 题</span></nav>`
        : "";

      ctaBox.innerHTML = batchMode
        ? `<div class="sticky-cta">
             <button class="btn btn--danger" id="wbBatchRemove" ${checked.size ? "" : "disabled"}>
               批量移出错题本 (${checked.size})
             </button>
           </div>`
        : `<div class="sticky-cta">
             <button class="btn btn--primary" id="wbRedoAll" ${filtered.length ? "" : "disabled"}>
               ↻ 一键重做当前错题（${filtered.length} 道）
             </button>
           </div>`;

      /* 翻页：改页码 → 重绘当前页 → 列表顶部对齐视口顶（尊重 prefers-reduced-motion） */
      pagerBox.querySelectorAll<HTMLButtonElement>(".wb-pager [data-page]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const n = Number(btn.dataset.page);
          if (btn.disabled || !Number.isFinite(n) || n === page || n < 1 || n > pages) return;
          page = n;
          paint(true);
        });
      });

      listBox.querySelectorAll<HTMLElement>(".wb-item").forEach((node) => {
        const id = node.dataset.id!;
        node.querySelector('[data-act="check"]')?.addEventListener("click", () => {
          if (checked.has(id)) checked.delete(id); else checked.add(id);
          paint();
        });
        node.querySelector('[data-act="redo"]')?.addEventListener("click", () => {
          navigate("wrong-practice", { qid: id });
        });
        node.querySelector('[data-act="fav"]')?.addEventListener("click", () => {
          const on = toggleFavorite(id);
          toast(on ? "已加入收藏" : "已取消收藏", "ok");
          paint();
        });
        node.querySelector('[data-act="remove"]')?.addEventListener("click", async () => {
          const ok = await confirmDialog({
            title: "移出错题本",
            message: "确定将本题移出错题本吗？",
            danger: true,
            confirmText: "移出",
          });
          if (!ok) return;
          await WrongbookManager.remove(id);
          checked.delete(id);
          toast("已移出错题本", "ok");
          void view.render(root);
        });
      });

      ctaBox.querySelector("#wbRedoAll")?.addEventListener("click", () => {
        if (!filtered.length) return;
        const params: Record<string, string> = { fresh: "1" };
        if (activeBank !== "all") params.banks = activeBank;
        if (activeType !== "all") params.type = activeType;
        navigate("wrong-practice", params);
      });

      ctaBox.querySelector("#wbBatchRemove")?.addEventListener("click", async () => {
        if (!checked.size) return;
        const ok = await confirmDialog({
          title: "批量移出错题本",
          message: `确定把选中的 ${checked.size} 道题移出错题本吗？`,
          danger: true,
          confirmText: "移出",
        });
        if (!ok) return;
        for (const id of checked) {
          await WrongbookManager.remove(id);
        }
        const n = checked.size;
        checked.clear();
        toast(`已移出 ${n} 道题`, "ok");
        void view.render(root);
      });

      if (scroll) {
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const top = listBox.getBoundingClientRect().top + window.scrollY - 8;
        window.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
      }
    };

    paint();

    root.querySelector("#wbBankChips")?.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".chip");
      if (!btn?.dataset.bank) return;
      activeBank = btn.dataset.bank;
      page = 1;                       // 筛选变化 → 回到第 1 页
      void view.render(root);
    });

    root.querySelector("#wbTypeChips")?.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".chip");
      if (!btn?.dataset.type) return;
      activeType = btn.dataset.type;
      page = 1;                       // 筛选变化 → 回到第 1 页
      root.querySelectorAll<HTMLButtonElement>("#wbTypeChips .chip").forEach((b) => {
        b.classList.toggle("is-on", b.dataset.type === activeType);
      });
      paint();
    });

    root.querySelector("#wbManage")?.addEventListener("click", () => {
      batchMode = !batchMode;
      checked.clear();
      void view.render(root);
    });
  },
};

export default view;
