/** 首页：题库多选 + 进度总览 + 领域×题型筛选 + 入口 */

import {
  getQuestions, getLoadedQuestions, getMeta, getBanks, getSelectedBanks, setSelectedBanks, countBy,
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

/** 简短书名提取：《…》取书名号内文本；没有书名号则用完整标题（不做硬截断） */
function shortBankTitle(title: string): string {
  const match = title.match(/《(.+?)》/);
  return match ? match[1] : title;
}

/** 单个题库的进度统计（基于全部已加载库，与是否选中无关） */
type BankStat = { total: number; answered: number; correct: number };

/** 题库选择行：勾选态 + 书名 + 行内进度 */
function bankSegment(bank: BankMeta, on: boolean, stat: BankStat | undefined, isLastSelected: boolean): string {
  const loaded = isBankLoaded(bank.id);
  const failed = isBankFailed(bank.id);
  const shortTitle = shortBankTitle(bank.title);
  const targetTotal = Object.values(bank.typeCounts ?? {}).reduce((a, b) => a + b, 0);

  let mark = `<span class="seg__mark seg__mark--idle"></span>`;
  let nums = "";
  let pct = 0;

  if (failed) {
    mark = `<span class="seg__mark seg__mark--fail">⚠</span>`;
    nums = `<span class="seg__nums seg__nums--fail">加载失败 · 点击重试</span>`;
  } else if (!loaded) {
    mark = `<span class="seg__mark seg__mark--load">⋯</span>`;
    nums = `<span class="seg__nums">目标 ${targetTotal} 题</span>`;
  } else if (stat) {
    if (on) mark = `<span class="seg__mark seg__mark--on">✓</span>`;
    pct = stat.total ? Math.round((stat.answered / stat.total) * 100) : 0;
    const rate = stat.answered ? `<b>${Math.round((stat.correct / stat.answered) * 100)}%</b>` : "";
    nums = `<span class="seg__nums">${stat.answered}/${stat.total}${rate}</span>`;
  }

  const tip = isLastSelected ? "至少保留一个题库" : bank.title;

  return `<button type="button" class="seg seg--hero${on ? " is-on" : ""}" data-bank="${esc(bank.id)}"
      aria-pressed="${on}" title="${esc(tip)}">
    ${mark}
    <span class="seg__body">
      <span class="seg__row">
        <span class="seg__name">${esc(shortTitle)}</span>
        ${nums}
      </span>
      <span class="seg__bar"><i style="width:${pct}%"></i></span>
    </span>
  </button>`;
}

/** 题库卡片（折叠详情中使用） */
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

  return `<button type="button" class="bank-card${on ? " is-on" : ""}" data-bank="${esc(bank.id)}">
    <span class="bank-card__check">${on ? "✓" : ""}</span>
    <span class="bank-card__body">
      <span class="bank-card__title">${esc(bank.title)}</span>
      <span class="bank-card__meta">${meta}</span>
    </span>
  </button>`;
}

let showBankDetails = false;

const view: View = {
  async render(root) {
    const banks = getBanks();
    const selected = new Set(getSelectedBanks());
    const questions = getQuestions();
    const meta = getMeta();
    const store = getStore();
    const s = computeStats(questions, store);

    if (!banks.length) {
      root.innerHTML = emptyState({ icon: "📚", title: "题库清单为空", desc: "请检查 data/banks.json 是否正常加载。" });
      return;
    }

    // 清理属于未选中库的筛选条件（避免切换题库后出现 0 命中的死筛选）
    const availDomains = new Set(selectedDomains());
    for (const d of [...filter.domains]) if (!availDomains.has(d)) filter.domains.delete(d);

    const dCounts = countBy("domain");
    const tCounts = countBy("type");
    const dl = domainLabels();
    const tl = typeLabels();

    // 各库进度：基于「全部已加载库」计算，未选中的库也能显示自己的进度
    // （不能用 questions —— 它只含选中库，会把已加载未选中的库算成 0/0）
    const records = store?.records ?? {};
    const allLoaded = getLoadedQuestions();
    const bankStat = new Map<string, BankStat>();
    for (const b of banks) {
      const bQs = allLoaded.filter((q) => q.id.startsWith(b.id + "-"));
      bankStat.set(b.id, {
        total: bQs.length,
        answered: bQs.filter((q) => records[q.id]).length,
        correct: bQs.filter((q) => records[q.id]?.lastCorrect).length,
      });
    }

    const matched = matchQuestions();
    const hasFilter = filter.domains.size > 0 || filter.types.size > 0;

    root.innerHTML = `
      <section class="hero">
        <header class="hero__head">
          <div class="hero__head-main">
            <div class="hero__eyebrow">${esc(meta?.source ?? "学前教育政策与法规 · 考点精编")}</div>
            <h1 class="hero__title">刷题手册</h1>
          </div>
          <div class="hero__head-side">
            <span class="hero__head-count">已选 ${selected.size}/${banks.length} 库</span>
            <button type="button" class="hero-head-btn" id="toggleSelectAll"
              title="已选 ${selected.size}/${banks.length} 库，可多选">
              ${selected.size === banks.length ? "单选指南" : "全选题库"}
            </button>
          </div>
        </header>

        <div class="hero__grid">
          <!-- 统计 / 入口（移动端在前；桌面端由 grid-area 排到右列） -->
          <div class="hero__col hero__col--stats">
            <div class="hero__stats">
              <div class="hero__stat"><b>${s.progress.answered}/${s.progress.total}</b><span>已刷题数</span></div>
              <div class="hero__stat"><b>${s.answered ? s.rate + "%" : "—"}</b><span>正确率</span></div>
              <div class="hero__stat"><b>${s.wrongCount}</b><span>错题在册</span></div>
            </div>

            <p class="hero__hint">当前题池 ${questions.length} 题　·　总进度 ${s.progress.percent}%</p>

            <button class="btn btn--block" id="quickStart">
              ${s.progress.answered ? "继续刷题" : "开始刷题"}
            </button>
          </div>

          <!-- 题库选择（移动端在后；桌面端由 grid-area 排到左列） -->
          <div class="hero__col hero__col--banks">
            <div class="hero__panel">
              <div class="seg-group">
                ${banks.map((b) =>
                  bankSegment(b, selected.has(b.id), bankStat.get(b.id), selected.size === 1 && selected.has(b.id))
                ).join("")}
              </div>
              <button type="button" class="bank-details-toggle" id="toggleBankDetails">
                ${showBankDetails ? "收起题库详细说明 ▲" : "查看各题库题量与指标详情 ▼"}
              </button>
              <div id="bankDetailsContainer" style="display:${showBankDetails ? "block" : "none"}">
                <div class="bank-grid">
                  ${banks.map((b) => bankCard(b, selected.has(b.id))).join("")}
                </div>
              </div>
            </div>
          </div>
        </div>
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
    `;

    /* ---------- 事件 ---------- */
    const rerender = (): void => { void view.render(root); };

    // 切换题库通用逻辑
    const toggleBankSelection = async (id: string, btnElement?: HTMLButtonElement): Promise<void> => {
      const cur = new Set(getSelectedBanks());
      if (!isBankLoaded(id) && !cur.has(id)) {
        if (btnElement) {
          btnElement.disabled = true;
          btnElement.classList.add("is-loading");
          // 定点替换文本：整行 textContent 会抹掉勾选槽/进度条 DOM
          const numsEl = btnElement.querySelector(".seg__nums, .bank-card__meta");
          if (numsEl) numsEl.textContent = "加载中…";
        }
        const bs = await ensureBank(id);
        if (!bs) { rerender(); return; }
        cur.add(id);
        await setSelectedBanks([...cur]);
        rerender();
        return;
      }

      if (cur.has(id)) {
        if (cur.size === 1) return; // 至少保留一个题库
        cur.delete(id);
      } else {
        cur.add(id);
      }
      await setSelectedBanks([...cur]);
      rerender();
    };

    // 题库行点击
    root.querySelectorAll<HTMLButtonElement>(".seg").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.bank;
        if (id) void toggleBankSelection(id, btn);
      });
    });

    // 展开卡片点击
    root.querySelectorAll<HTMLButtonElement>(".bank-card").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.bank;
        if (id) void toggleBankSelection(id, btn);
      });
    });

    // 全选/单选切换
    root.querySelector("#toggleSelectAll")?.addEventListener("click", async () => {
      const allBanks = getBanks().map((b) => b.id);
      const cur = getSelectedBanks();
      if (cur.length === allBanks.length) {
        // 全选状态下点击切回仅"G"
        await setSelectedBanks(["G"]);
      } else {
        await setSelectedBanks(allBanks);
      }
      rerender();
    });

    // 折叠展开详情
    root.querySelector("#toggleBankDetails")?.addEventListener("click", () => {
      showBankDetails = !showBankDetails;
      const container = root.querySelector<HTMLElement>("#bankDetailsContainer");
      const toggle = root.querySelector<HTMLElement>("#toggleBankDetails");
      if (container && toggle) {
        container.style.display = showBankDetails ? "block" : "none";
        toggle.textContent = showBankDetails ? "收起题库详细说明 ▲" : "查看各题库题量与指标详情 ▼";
      }
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
