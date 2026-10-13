/**
 * 题库 tab（v6 新建）：选库 → 该库总览 → 练习/考试模式 → 章节目录（领域）→ 题型说明 → 刷题范围
 *
 * 约定：
 *  - tab 内选库是**单选**（模块级 activeBank），与首页/「我的」维护的 selectedBanks（刷题范围）互不联动；
 *  - 章节 = 领域（单级，数据只有一层）；
 *  - 点章节行始终进入**练习模式**（考试模式必须走顶部「开始模拟考试」）。
 */

import {
  getBanks, getBank, isBankLoaded, isBankFailed, ensureBank, bankQuestionCount,
  getSelectedBanks, setSelectedBanks, getLoadedQuestions, questionDomainLabel, typeLabels,
} from "../state";
import { getStore } from "../storage";
import { esc, pct } from "../utils";
import { navigate } from "../router";
import { bar, emptyState, toast } from "../ui";
import type { BankMeta, Question, View } from "../types";

/* ---------------- 模块级 UI 状态（跨 render 保留） ---------------- */

let activeBank = "";
let examMode = false;
let query = "";

/* ---------------- 计算 ---------------- */

const bankOf = (q: Question): string => q.id.split("-")[0];

function questionsOf(bankId: string): Question[] {
  return getLoadedQuestions().filter((q) => bankOf(q) === bankId);
}

interface ChapterStat {
  domain: string;
  label: string;
  total: number;
  answered: number;
  correct: number;
  match: number;
}

function chapterStats(bank: BankMeta, questions: Question[]): ChapterStat[] {
  const records = getStore().records ?? {};
  const q = query.trim().toLowerCase();
  return bank.domains.map((domain) => {
    const qs = questions.filter((x) => x.domain === domain);
    const answered = qs.filter((x) => records[x.id]).length;
    const correct = qs.filter((x) => records[x.id]?.lastCorrect).length;
    const match = q ? qs.filter((x) => x.stem.toLowerCase().includes(q)).length : qs.length;
    const sample = qs[0];
    return {
      domain,
      label: sample ? questionDomainLabel(sample) : (bank.domainLabels?.[domain] ?? domain),
      total: qs.length,
      answered,
      correct,
      match,
    };
  });
}

function chapterChip(st: ChapterStat): string {
  if (st.total === 0) return `<span class="chapter__chip">暂无题目</span>`;
  if (st.answered >= st.total) return `<span class="chapter__chip chapter__chip--done">已完成</span>`;
  if (st.answered > 0) return `<span class="chapter__chip chapter__chip--doing">进行中</span>`;
  return `<span class="chapter__chip">未开始</span>`;
}

/* ---------------- 渲染片段 ---------------- */

function bankPills(): string {
  const current = getSelectedBanks();
  return `<div class="bank-pills">${getBanks().map((b) => `
    <button class="bank-pill${b.id === activeBank ? " is-on" : ""}" data-bank="${esc(b.id)}">
      <span class="bank-pill__dot"></span>${esc(b.id)} · ${esc(shortTitle(b.title))}
      ${current.includes(b.id) ? `<span class="tag" style="font-size:10px;padding:1px 6px">范围内</span>` : ""}
    </button>`).join("")}</div>`;
}

function shortTitle(title: string): string {
  const m = title.match(/《(.+?)》/);
  return m ? m[1] : title;
}

function overviewCard(bank: BankMeta, questions: Question[]): string {
  const records = getStore().records ?? {};
  const answered = questions.filter((q) => records[q.id]).length;
  const correct = questions.filter((q) => records[q.id]?.lastCorrect).length;
  const total = questions.length;
  const target = Object.values(bank.typeCounts ?? {}).reduce((a, c) => a + c, 0) || total;

  return `
    <section class="card">
      <h2 class="card__title">${esc(bank.title)}${bank.source ? `<small>${esc(bank.source)}</small>` : ""}</h2>
      <div class="kpi-row">
        <div class="kpi"><b>${total || target}</b><span>题库题量</span></div>
        <div class="kpi"><b>${answered}</b><span>已练习题</span></div>
        <div class="kpi kpi--rate"><b>${answered ? pct(correct, answered) + "%" : "—"}</b><span>平均正确率</span></div>
      </div>
      ${total ? `<div class="rate-row" style="margin-top:14px">
        <div class="rate-row__head"><span>本库进度</span><span>${answered}/${total}　<b>${pct(answered, total)}%</b></span></div>
        ${bar(pct(answered, total))}
      </div>` : ""}
    </section>`;
}

function modeCard(bank: BankMeta, chapters: ChapterStat[]): string {
  const first = chapters.find((c) => c.total > 0 && c.answered < c.total) ?? chapters.find((c) => c.total > 0);
  const label = first ? `▷ 开始练习第 ${chapters.indexOf(first) + 1} 章` : "▷ 开始练习";

  return `
    <section class="card">
      <h2 class="card__title">选择答题模式</h2>
      <div class="mode-grid">
        <button class="mode${examMode ? "" : " is-on"}" data-mode="practice">
          <span class="mode__radio"></span>
          <span class="mode__body">
            <span class="mode__title">练习模式</span>
            <span class="mode__desc">每题作答后立即反馈，附详细解析</span>
          </span>
        </button>
        <button class="mode${examMode ? " is-on" : ""}" data-mode="exam">
          <span class="mode__radio"></span>
          <span class="mode__body">
            <span class="mode__title">考试模式</span>
            <span class="mode__desc">限时作答，交卷后统一反馈解析</span>
          </span>
        </button>
      </div>
      <div class="actions" style="margin-top:14px">
        ${examMode
          ? `<button class="btn btn--primary btn--block" id="startMode">▷ 开始模拟考试</button>`
          : `<button class="btn btn--primary btn--block" id="startMode" ${first ? "" : "disabled"}>${label}</button>`}
      </div>
    </section>`;
}

function chapterCardText(bank: BankMeta, chapters: ChapterStat[]): string {
  const shown = query.trim() ? chapters.filter((c) => c.match > 0) : chapters;
  if (!shown.length) {
    return `<p class="about" style="margin:0">没有匹配「${esc(query.trim())}」的题目，换个关键词试试。</p>`;
  }
  return `<div class="chapter-list">${shown.map((c) => {
    const idx = chapters.indexOf(c) + 1;
    const mastery = c.answered ? pct(c.correct, c.answered) : 0;
    return `<button class="chapter" data-domain="${esc(c.domain)}">
      <span class="chapter__idx">${idx}</span>
      <span class="chapter__body">
        <span class="chapter__title">${esc(c.label)}</span>
        <span class="chapter__meta">
          ${query.trim() ? `命中 <b>${c.match}</b> 题 · ` : ""}共 <b>${c.total}</b> 题 · 已练 <b>${c.answered}</b> · 掌握度 <b>${c.answered ? mastery + "%" : "—"}</b>
        </span>
        <span class="chapter__bar"><i style="width:${c.total ? pct(c.answered, c.total) : 0}%"></i></span>
      </span>
      ${chapterChip(c)}
      <span class="chapter__arrow">›</span>
    </button>`;
  }).join("")}</div>`;
}

function typeCardText(bank: BankMeta, questions: Question[]): string {
  const counts: Record<string, number> = {};
  for (const q of questions) counts[q.type] = (counts[q.type] ?? 0) + 1;
  const groups = [
    { type: "single,multiple", key: "single", label: "单选题 · 多选题", desc: "4 选 1 / 多选全对才得分" },
    { type: "judge", key: "judge", label: "判断题", desc: "判断表述正确与否" },
    { type: "fill", key: "fill", label: "填空题", desc: "一题多空，作答后自判" },
    { type: "short", key: "short", label: "简答题", desc: "开放作答，对照参考答案自判" },
  ];
  return `<div class="type-grid">${groups.map((g) => {
    const n = g.type.split(",").reduce((a, t) => a + (counts[t] ?? 0), 0);
    return `<button class="type-card" data-type="${esc(g.type)}">
      <span class="type-card__label">${g.label}</span>
      <span class="type-card__count">${n} 题</span>
      <span class="type-card__desc">${g.desc}</span>
    </button>`;
  }).join("")}</div>`;
}

function scopeCard(): string {
  const current = new Set(getSelectedBanks());
  return `
    <section class="card">
      <h2 class="card__title">我的刷题范围 <small>可多选，影响「快速刷题 / 考试」的题池</small></h2>
      ${getBanks().map((b) => `
        <div class="scope-row">
          <span class="scope-row__text">
            <b>${esc(b.title)}</b>
            <span>${isBankLoaded(b.id) ? `已加载 ${bankQuestionCount(b.id)} 题` : "尚未加载"}</span>
          </span>
          <button class="switch${current.has(b.id) ? " is-on" : ""}" data-scope="${esc(b.id)}"
            role="switch" aria-checked="${current.has(b.id)}" aria-label="把 ${esc(b.title)} 加入刷题范围"></button>
        </div>`).join("")}
      <p class="about" style="margin:10px 0 0">至少保留一个题库；未勾选的库不会被抽题，但历史记录仍会保留。</p>
    </section>`;
}

/* ---------------- 视图 ---------------- */

const view: View = {
  async render(root, params) {
    const banks = getBanks();
    if (!banks.length) {
      root.innerHTML = emptyState({ icon: "📚", title: "题库清单为空", desc: "请检查 data/banks.json 是否正常加载。" });
      return;
    }

    const initial = params?.bank && banks.some((b) => b.id === params.bank) ? params.bank : "";
    if (initial && initial !== activeBank) activeBank = initial;
    if (!activeBank || !banks.some((b) => b.id === activeBank)) activeBank = banks[0].id;

    const bank = getBank(activeBank)!;

    // 按需加载选中的库（首次进入某库时拉取题文件）
    if (!isBankLoaded(activeBank) && !isBankFailed(activeBank)) {
      root.innerHTML = `<div class="loading"><div class="loading__spinner"></div><p>正在加载《${esc(shortTitle(bank.title))}》题库…</p></div>`;
      const bs = await ensureBank(activeBank);
      if (!bs) {
        root.innerHTML = emptyState({
          icon: "⚠️", title: "题库加载失败",
          desc: `${esc(bank.title)} 未能加载，请检查网络后重试。`,
          action: `<button class="btn btn--primary" id="retryBank">重新加载</button>`,
        });
        root.querySelector("#retryBank")?.addEventListener("click", () => { void view.render(root); });
        return;
      }
    }

    if (isBankFailed(activeBank)) {
      root.innerHTML = emptyState({
        icon: "⚠️", title: "题库加载失败",
        desc: `${esc(bank.title)} 未能加载，请检查网络后重试。`,
        action: `<button class="btn btn--primary" id="retryBank">重新加载</button>`,
      });
      root.querySelector("#retryBank")?.addEventListener("click", () => {
        void ensureBank(activeBank).then(() => view.render(root));
      });
      return;
    }

    const questions = questionsOf(activeBank);
    const chapters = chapterStats(bank, questions);

    root.innerHTML = `
      <div class="page-head">
        <button class="page-head__back" id="banksBack" title="返回首页">‹</button>
        <h1 class="page-head__title">题库</h1>
        <span class="page-head__right">${getBanks().length} 个题库</span>
      </div>

      ${bankPills()}

      <div class="search-row">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>
        <input class="search-input" id="bankSearch" type="search" placeholder="搜索题干关键词（统计本章命中题数）" value="${esc(query)}">
      </div>

      ${overviewCard(bank, questions)}
      ${modeCard(bank, chapters)}

      <section class="card">
        <h2 class="card__title">章节目录 <small>点击章节开始做题</small></h2>
        <div id="chapterBox">${chapterCardText(bank, chapters)}</div>
      </section>

      <section class="card">
        <h2 class="card__title">题型说明 <small>按题型专项练习</small></h2>
        ${typeCardText(bank, questions)}
      </section>

      ${scopeCard()}
    `;

    /* ---------- 事件 ---------- */
    root.querySelector("#banksBack")?.addEventListener("click", () => navigate("home"));

    root.querySelectorAll<HTMLButtonElement>(".bank-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.bank;
        if (!id || id === activeBank) return;
        activeBank = id;
        query = "";
        void view.render(root);
      });
    });

    // 题干搜索：只重绘章节目录，避免输入框失焦
    const search = root.querySelector<HTMLInputElement>("#bankSearch");
    search?.addEventListener("input", () => {
      query = search.value;
      const box = root.querySelector("#chapterBox");
      if (box) {
        box.innerHTML = chapterCardText(bank, chapters);
        bindChapters(box as HTMLElement);
      }
    });

    root.querySelectorAll<HTMLButtonElement>(".mode").forEach((btn) => {
      btn.addEventListener("click", () => {
        examMode = btn.dataset.mode === "exam";
        void view.render(root);
      });
    });

    root.querySelector("#startMode")?.addEventListener("click", () => {
      if (examMode) { navigate("practice", { mode: "exam", banks: activeBank }); return; }
      const first = chapters.find((c) => c.total > 0 && c.answered < c.total) ?? chapters.find((c) => c.total > 0);
      if (first) navigate("practice", { domain: first.domain, banks: activeBank });
      else navigate("practice", { banks: activeBank });
    });

    bindChapters(root);

    root.querySelectorAll<HTMLButtonElement>(".type-card").forEach((btn) => {
      btn.addEventListener("click", () => {
        const type = btn.dataset.type;
        if (type) navigate("practice", { type, banks: activeBank });
      });
    });

    root.querySelectorAll<HTMLButtonElement>(".switch").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.scope;
        if (!id) return;
        const cur = new Set(getSelectedBanks());
        if (cur.has(id)) {
          if (cur.size === 1) { toast("至少保留一个题库", "info"); return; }
          cur.delete(id);
        } else {
          cur.add(id);
          if (!isBankLoaded(id) && !isBankFailed(id)) {
            btn.disabled = true;
            await ensureBank(id);
          }
        }
        await setSelectedBanks([...cur]);
        void view.render(root);
      });
    });

    function bindChapters(scope: HTMLElement): void {
      scope.querySelectorAll<HTMLButtonElement>(".chapter").forEach((btn) => {
        btn.addEventListener("click", () => {
          const domain = btn.dataset.domain;
          if (domain) navigate("practice", { domain, banks: activeBank });
        });
      });
    }
  },
};

export default view;
