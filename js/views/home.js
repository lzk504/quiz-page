/** 首页：进度总览 + 领域×题型筛选 + 入口 */

import { getQuestions, getMeta, countBy, domainLabels, typeLabels } from "../state.js";
import { getStore } from "../storage.js";
import { computeStats } from "../stats.js";
import { esc } from "../utils.js";
import { navigate } from "../router.js";
import { emptyState } from "../ui.js";

/** 会话内保留筛选状态 */
const filter = { domains: new Set(), types: new Set() };

export function resetFilter() {
  filter.domains.clear();
  filter.types.clear();
}

function matchQuestions() {
  return getQuestions().filter((q) => {
    if (filter.domains.size && !filter.domains.has(q.domain)) return false;
    if (filter.types.size && !filter.types.has(q.type)) return false;
    return true;
  });
}

function chip(label, count, on, dataAttr) {
  return `<button type="button" class="chip${on ? " is-on" : ""}" ${dataAttr}>
    ${esc(label)}<span class="chip__n">${count}</span>
  </button>`;
}

export default {
  async render(root) {
    const questions = getQuestions();
    const meta = getMeta();
    const store = getStore();
    const s = computeStats(questions, store);

    if (!questions.length) {
      root.innerHTML = emptyState({ icon: "📚", title: "题库为空", desc: "请检查 data/questions.json 是否正常加载。" });
      return;
    }

    const dCounts = countBy("domain");
    const tCounts = countBy("type");
    const dl = domainLabels();
    const tl = typeLabels();

    const matched = matchQuestions();
    const hasFilter = filter.domains.size > 0 || filter.types.size > 0;

    root.innerHTML = `
      <section class="hero">
        <div class="hero__eyebrow">${esc(meta?.source ?? "教育部《3-6岁儿童学习与发展指南》")}</div>
        <h1 class="hero__title">考点精编 · 刷题手册</h1>

        <div class="hero__stats">
          <div class="hero__stat"><b>${s.progress.answered}/${s.progress.total}</b><span>已刷题数</span></div>
          <div class="hero__stat"><b>${s.answered ? s.rate + "%" : "—"}</b><span>正确率</span></div>
          <div class="hero__stat"><b>${s.wrongCount}</b><span>错题在册</span></div>
        </div>

        <div class="hero__bar"><i style="width:${s.progress.percent}%"></i></div>
        <p class="hero__hint">总进度 ${s.progress.percent}%</p>

        <button class="btn btn--block" id="quickStart">
          ${s.progress.answered ? "继续刷题" : "开始刷题"}
        </button>
      </section>

      <section class="card">
        <h2 class="card__title">按领域筛选 <small>不选 = 全部</small></h2>
        <div class="chips" id="domainChips">
          ${Object.entries(dl).map(([k, label]) =>
            chip(label, dCounts[k] ?? 0, filter.domains.has(k), `data-kind="domain" data-key="${k}"`)
          ).join("")}
        </div>
      </section>

      <section class="card">
        <h2 class="card__title">按题型筛选 <small>可多选组合</small></h2>
        <div class="chips" id="typeChips">
          ${Object.entries(tl).map(([k, label]) =>
            chip(label, tCounts[k] ?? 0, filter.types.has(k), `data-kind="type" data-key="${k}"`)
          ).join("")}
        </div>

        <div class="filter-summary">
          <span>命中 <b>${matched.length}</b> 题</span>
          <span style="display:flex;gap:8px">
            ${hasFilter ? `<button class="btn btn--sm btn--ghost" id="clearFilter">清除</button>` : ""}
            <button class="btn btn--sm btn--primary" id="startFiltered" ${matched.length ? "" : "disabled"}>开始刷题</button>
          </span>
        </div>
      </section>

      <section class="card">
        <h2 class="card__title">错题本 <small>${s.wrongCount} 题在册</small></h2>
        <div class="setting-row" style="padding-top:0">
          <div class="setting-row__text">
            <b>${s.wrongCount ? `有 ${s.wrongCount} 道题待复习` : "暂无错题"}</b>
            <span>${s.wrongCount ? "答错自动收录，重刷答对后自动移出" : "答错的题目会自动收进错题本"}</span>
          </div>
          <button class="btn btn--sm ${s.wrongCount ? "btn--primary" : ""}" id="goWrongbook" ${s.wrongCount ? "" : "disabled"}>查看</button>
        </div>
      </section>

      <section class="card">
        <h2 class="card__title">题库概览</h2>
        <div class="about">
          <p>共 <b>${questions.length}</b> 题：${Object.entries(tl).map(([k, l]) => `${esc(l)} ${tCounts[k] ?? 0} 题`).join("　")}。</p>
          <p>数据来源：${esc(meta?.source ?? "《3-6岁儿童学习与发展指南》")}。题目与解析取自《考点精编与刷题手册》，纯前端加载，无后端服务。</p>
        </div>
      </section>
    `;

    /* ---------- 事件 ---------- */
    const rerender = () => this.render(root);

    root.querySelectorAll(".chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const { kind, key } = btn.dataset;
        const set = kind === "domain" ? filter.domains : filter.types;
        set.has(key) ? set.delete(key) : set.add(key);
        rerender();
      });
    });

    root.querySelector("#clearFilter")?.addEventListener("click", () => {
      resetFilter();
      rerender();
    });

    const start = (params) => navigate("practice", params);
    const buildParams = () => {
      const p = {};
      if (filter.domains.size) p.domain = [...filter.domains].join(",");
      if (filter.types.size) p.type = [...filter.types].join(",");
      return p;
    };

    root.querySelector("#startFiltered")?.addEventListener("click", () => start(buildParams()));
    root.querySelector("#quickStart")?.addEventListener("click", () => {
      if (filter.domains.size || filter.types.size) start(buildParams());
      else navigate("practice");
    });
    root.querySelector("#goWrongbook")?.addEventListener("click", () => navigate("wrongbook"));
  },
};
