/**
 * 错题本（v6 重写）：三数字概览 + 题型筛选 + 平铺卡片（我的答案 / 正确答案 / 错因解析）
 *                    + 单题重做 / 收藏 / 移出 + 批量移出 + 一键重做
 *
 * 与旧版的区别：移除「题库→领域」两级折叠与三个下拉，改为题型 chips + 平铺列表。
 */

import { getLoadedQuestions, getQuestion } from "../state";
import { getStore, removeFromWrongbook, toggleFavorite, isFavorite } from "../storage";
import { displayAnswer, displayUserAnswer } from "../scoring";
import { wrongbookStats, wrongLevel } from "../goal";
import { esc, fmtTime, pct } from "../utils";
import { navigate } from "../router";
import { typeTag, questionDomainTag, bankTag, emptyState, toast } from "../ui";
import type { Question, View, WrongbookEntry } from "../types";

/* ---------------- 模块级 UI 状态 ---------------- */

let activeType = "all";
let batchMode = false;
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

interface Item { q: Question; w: WrongbookEntry; wrongAttempts: number }

function collect(): Item[] {
  const store = getStore();
  const records = store.records ?? {};
  const out: Item[] = [];
  for (const q of getLoadedQuestions()) {
    const w = store.wrongbook[q.id];
    if (!w) continue;
    out.push({ q, w, wrongAttempts: records[q.id]?.wrongAttempts ?? w.wrongCount ?? 1 });
  }
  // 错误次数多的排在前面，「上次错误」近的次之
  return out.sort(
    (a, b) => b.wrongAttempts - a.wrongAttempts || (b.w.lastWrongAt ?? 0) - (a.w.lastWrongAt ?? 0),
  );
}

function renderItem(it: Item): string {
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
    let items = collect();
    const stats = wrongbookStats(getLoadedQuestions(), getStore());

    root.innerHTML = `
      <div class="page-head">
        <h1 class="page-head__title">错题本</h1>
        <button class="btn btn--sm ${batchMode ? "btn--primary" : ""}" id="wbManage">${batchMode ? "完成" : "管理"}</button>
      </div>
      ${items.length ? `
        <div class="wb-kpi">
          <div class="wb-kpi__cell wb-kpi__cell--bad"><b>${stats.total}</b><span>错题总数</span></div>
          <div class="wb-kpi__cell wb-kpi__cell--ok"><b>${stats.corrected}</b><span>已订正</span></div>
          <div class="wb-kpi__cell"><b>${stats.pending}</b><span>待复习</span></div>
        </div>
        <section class="card">
          <div class="chips" id="wbTypeChips">
            ${TYPE_FILTERS.map((t) => {
              const n = t.key === "all" ? items.length : items.filter((it) => it.q.type === t.key).length;
              return `<button class="chip${activeType === t.key ? " is-on" : ""}" data-type="${esc(t.key)}">
                ${esc(t.label)}<span class="chip__n">${n}</span></button>`;
            }).join("")}
          </div>
          <p class="about" style="margin:12px 0 0">
            答错自动收录，<b>错题重刷答对一次即自动移出</b>；
            ${stats.total ? `历史共错过 ${stats.total} 题，已订正 ${stats.corrected} 题（${pct(stats.corrected, stats.total)}%）。` : ""}
          </p>
        </section>
      ` : ""}
      <div id="wbList"></div>
      <div id="wbCta"></div>
    `;

    const listBox = root.querySelector<HTMLElement>("#wbList")!;
    const ctaBox = root.querySelector<HTMLElement>("#wbCta")!;

    if (!items.length) {
      root.querySelector("#wbManage")?.remove();
      listBox.innerHTML = emptyState({
        icon: "✅",
        title: "错题本是空的",
        desc: "刷题时答错的题目会自动收进这里，重刷答对一次后自动移出。",
        action: `<button class="btn btn--primary" id="wPractice">去刷题</button>`,
      });
      listBox.querySelector("#wPractice")?.addEventListener("click", () => navigate("practice", { fresh: "1" }));
      return;
    }

    const paint = (): void => {
      const filtered = activeType === "all" ? items : items.filter((it) => it.q.type === activeType);
      listBox.innerHTML = filtered.length
        ? `<section class="card" style="padding:12px 16px">${filtered.map(renderItem).join("")}</section>`
        : emptyState({ icon: "🔍", title: "该题型下暂无错题", desc: "换个题型，或选择「全部题型」。" });

      ctaBox.innerHTML = batchMode
        ? `<div class="sticky-cta">
             <button class="btn btn--danger" id="wbBatchRemove" ${checked.size ? "" : "disabled"}>
               批量移出错题本 (${checked.size})
             </button>
           </div>`
        : `<div class="sticky-cta">
             <button class="btn btn--primary" id="wbRedoAll">
               ↻ 一键重做当前错题（${filtered.length} 道）
             </button>
           </div>`;

      listBox.querySelectorAll<HTMLElement>(".wb-item").forEach((node) => {
        const id = node.dataset.id!;
        node.querySelector('[data-act="check"]')?.addEventListener("click", () => {
          if (checked.has(id)) checked.delete(id); else checked.add(id);
          paint();
        });
        node.querySelector('[data-act="redo"]')?.addEventListener("click", () => {
          navigate("practice", { mode: "wrong", qid: id });
        });
        node.querySelector('[data-act="fav"]')?.addEventListener("click", () => {
          const on = toggleFavorite(id);
          toast(on ? "已加入收藏" : "已取消收藏", "ok");
          paint();
        });
        node.querySelector('[data-act="remove"]')?.addEventListener("click", () => {
          removeFromWrongbook(id);
          checked.delete(id);
          toast("已移出错题本", "ok");
          void view.render(root);
        });
      });

      ctaBox.querySelector("#wbRedoAll")?.addEventListener("click", () => {
        const typeParam = activeType === "all" ? undefined : activeType;
        navigate("practice", typeParam ? { mode: "wrong", type: typeParam } : { mode: "wrong" });
      });
      ctaBox.querySelector("#wbBatchRemove")?.addEventListener("click", () => {
        if (!checked.size) return;
        if (!window.confirm(`确定把选中的 ${checked.size} 道题移出错题本吗？`)) return;
        for (const id of checked) removeFromWrongbook(id);
        const n = checked.size;
        checked.clear();
        toast(`已移出 ${n} 道题`, "ok");
        void view.render(root);
      });
    };

    paint();

    root.querySelector("#wbTypeChips")?.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".chip");
      if (!btn?.dataset.type) return;
      activeType = btn.dataset.type;
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
