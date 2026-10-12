/** 首页：题库多选 + 进度总览 + 领域×题型筛选 + 入口 */

import {
  getQuestions, getMeta, getBanks, getSelectedBanks, setSelectedBanks, countBy, countByBank,
  bankQuestionCount, isBankLoaded, isBankFailed, ensureBank, selectedDomains, domainLabels, typeLabels,
} from "../state";
import { getStore } from "../storage";
import { computeStats } from "../stats";
import { esc } from "../utils";
import { navigate } from "../router";
import { emptyState } from "../ui";
import type { BankMeta, View } from "../types";

/** 会话内保留筛选状态 */
const filter = { domains: new Set<string>(), types: new Set<string>() };

export function resetFilter(): void {
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

function chip(label: string, count: number, on: boolean, dataAttr: string): string {
  return `<button type="button" class="chip${on ? " is-on" : ""}" ${dataAttr}>
    ${esc(label)}<span class="chip__n">${count}</span>
  </button>`;
}

/** 题库卡片（多选） */
function bankCard(bank: BankMeta, on: boolean): string {
  const loaded = isBankLoaded(bank.id);
  const failed = isBankFailed(bank.id);
  const targetTotal = Object.values(bank.typeCounts ?? {}).reduce((a, b) => a + b, 0);
  const actual = bankQuestionCount(bank.id);
  let meta: string;
  if (failed) meta = `<span style="color:var(--bad)">加载失败，点击重试</span>`;
  else if (!loaded) meta = `点击加载（目标 <b>${targetTotal}</b> 题）`;
  else if (actual === 0) meta = `<span style="color:var(--text-3)">题目生成中（目标 ${targetTotal} 题）</span>`;
  else meta = `<b>${actual}</b> 题　·　${bank.domains.map((d) => esc(bank.domainLabels[d] ?? d)).join(" / ")}`;

  return `<button type="button" class="bank-card${on ? " is-on" : ""}" data-bank="${esc(bank.id)}" ${failed ? "" : ""}>
    <span class="bank-card__check">${on ? "✓" : ""}</span>
    <span class="bank-card__body">
      <span class="bank-card__title">${esc(bank.title)}</span>
      <span class="bank-card__meta">${meta}</span>
    </span>
  </button>`;
}

const view: View = {
  async render(root) {
    const banks = getBanks();
    const selected = new Set(getSelectedBanks());
    const questions = getQuestions();
    const meta = getMeta();
    const s = computeStats(questions, getStore());

    if (!banks.length) {
      root.innerHTML = emptyState({ icon: "📚", title: "题库清单为空", desc: "请检查 data/banks.json 是否正常加载。" });
      return;
    }

    // 清理属于未选中库的筛选条件（避免切换题库后出现 0 命中的死筛选）
    const availDomains = new Set(selectedDomains());
    for (const d of [...filter.domains]) if (!availDomains.has(d)) filter.domains.delete(d);

    const dCounts = countBy("domain");
    const tCounts = countBy("type");
    const bCounts = countByBank();
    const dl = domainLabels();
    const tl = typeLabels();

    const matched = matchQuestions();
    const hasFilter = filter.domains.size > 0 || filter.types.size > 0;

    root.innerHTML = `
      <section class="hero">
        <div class="hero__eyebrow">${esc(meta?.source ?? "学前教育政策与法规 · 考点精编")}</div>
        <h1 class="hero__title">考点精编 · 刷题手册</h1>

        <div class="hero__stats">
          <div class="hero__stat"><b>${s.progress.answered}/${s.progress.total}</b><span>已刷题数</span></div>
          <div class="hero__stat"><b>${s.answered ? s.rate + "%" : "—"}</b><span>正确率</span></div>
          <div class="hero__stat"><b>${s.wrongCount}</b><span>错题在册</span></div>
        </div>

        <div class="hero__bar"><i style="width:${s.progress.percent}%"></i></div>
        <p class="hero__hint">当前题池 ${questions.length} 题　·　总进度 ${s.progress.percent}%</p>

        <button class="btn btn--block" id="quickStart">
          ${s.progress.answered ? "继续刷题" : "开始刷题"}
        </button>
      </section>

      <section class="card">
        <h2 class="card__title">选择题库 <small>可多选，选中即合并刷题</small></h2>
        <div class="bank-grid">
          ${banks.map((b) => bankCard(b, selected.has(b.id))).join("")}
        </div>
        <p class="opt-hint">已选 ${selected.size} 个题库　·　当前题池 ${questions.length} 题（每次练习随机抽 ${Math.min(100, questions.length)} 题）</p>
      </section>

      <section class="card">
        <h2 class="card__title">按领域筛选 <small>不选 = 全部</small></h2>
        <div class="chips" id="domainChips">
          ${selectedDomains().map((k) =>
            chip(dl[k] ?? k, dCounts[k] ?? 0, filter.domains.has(k), `data-kind="domain" data-key="${esc(k)}"`)
          ).join("") || `<p class="about">暂无领域</p>`}
        </div>
      </section>

      <section class="card">
        <h2 class="card__title">按题型筛选 <small>可多选组合</small></h2>
        <div class="chips" id="typeChips">
          ${Object.entries(tl).map(([k, label]) =>
            chip(label, tCounts[k] ?? 0, filter.types.has(k), `data-kind="type" data-key="${esc(k)}"`)
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
          ${banks.map((b) => {
            const n = bCounts[b.id] ?? 0;
            const target = Object.values(b.typeCounts ?? {}).reduce((a, c) => a + c, 0);
            return `<p>· <b>${esc(b.title)}</b>：${n ? `${n} 题` : `待生成（目标 ${target} 题）`}　·　领域 ${b.domains.map((d) => esc(b.domainLabels[d] ?? d)).join(" / ")}</p>`;
          }).join("")}
          <p>· 当前题池 <b>${questions.length}</b> 题：${Object.entries(tl).map(([k, l]) => `${esc(l)} ${tCounts[k] ?? 0}`).join("　")}。</p>
          <p>· 数据来源：${esc(meta?.source ?? "学前教育政策与法规")}。</p>
        </div>
      </section>
    `;

    /* ---------- 事件 ---------- */
    const rerender = (): void => { void view.render(root); };

    // 题库多选：点击切换选中（未加载则先按需加载）
    root.querySelectorAll<HTMLButtonElement>(".bank-card").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.bank!;
        const cur = new Set(getSelectedBanks());

        // 加载失败或未加载 → 先尝试加载
        if (!isBankLoaded(id) && !cur.has(id)) {
          btn.disabled = true;
          btn.querySelector(".bank-card__meta")!.textContent = "加载中…";
          const bs = await ensureBank(id);
          if (!bs) { rerender(); return; }
          cur.add(id);
          await setSelectedBanks([...cur]);
          rerender();
          return;
        }

        if (cur.has(id)) {
          if (cur.size === 1) return;   // 至少保留一个题库
          cur.delete(id);
        } else {
          cur.add(id);
        }
        await setSelectedBanks([...cur]);
        rerender();
      });
    });

    root.querySelectorAll<HTMLButtonElement>(".chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const { kind, key } = btn.dataset;
        if (!key) return;
        const set = kind === "domain" ? filter.domains : filter.types;
        if (set.has(key)) set.delete(key); else set.add(key);
        rerender();
      });
    });

    root.querySelector("#clearFilter")?.addEventListener("click", () => {
      resetFilter();
      rerender();
    });

    const start = (params?: Record<string, string>): void => navigate("practice", params);
    const buildParams = (): Record<string, string> => {
      const p: Record<string, string> = {};
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

export default view;
