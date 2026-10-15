/**
 * 题库 tab（v6 新建 / v6.1 改造）：选库 → 该库总览 → 练习/考试模式 → 章节目录（领域）→ 题型说明
 *
 * 约定：
 *  - **选库是唯一入口**：点顶部 pill 既切换浏览的库，也把该库设为刷题范围（selectedBanks 单库），
 *    章节、简介、题型卡随之联动刷新；v6.1 起取消了独立的「我的刷题范围」开关卡（不再支持多库合并刷题）；
 *  - 章节 = 领域（单级，数据只有一层）；
 *  - 点章节行始终进入**练习模式**（考试模式必须走顶部「开始模拟考试」）。
 */

import {
  getBanks, getBank, isBankLoaded, isBankFailed, ensureBank,
  getSelectedBanks, setSelectedBanks, getLoadedQuestions, questionDomainLabel, typeLabels,
  bankShortName, bankShortTitle,
} from "../state";
import { getStore } from "../storage";
import { esc, pct } from "../utils";
import { navigate } from "../router";
import { bar, emptyState } from "../ui";
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
  return `<div class="bank-pills">${getBanks().map((b) => `
    <button class="bank-pill${b.id === activeBank ? " is-on" : ""}" data-bank="${esc(b.id)}">
      <span class="bank-pill__dot"></span>${esc(bankShortName(b.id))}
    </button>`).join("")}</div>`;
}

/** 简介卡来源文案：去掉与书名完全重复的尾部片段（如「教育部 2012年9月颁布《3-6岁…指南》」→「教育部 2012年9月颁布」） */
function sourceLine(bank: BankMeta): string {
  const src = (bank.source ?? "").trim();
  if (!src) return "";
  const m = src.match(/^(.*?)[，,、·\s]*《(.+?)》\s*$/);
  if (m && m[1] && bankShortTitle(bank.title) === m[2]) return m[1].trim();
  return src;
}

function overviewCard(bank: BankMeta, questions: Question[]): string {
  const records = getStore().records ?? {};
  const answered = questions.filter((q) => records[q.id]).length;
  const correct = questions.filter((q) => records[q.id]?.lastCorrect).length;
  const total = questions.length;
  const target = Object.values(bank.typeCounts ?? {}).reduce((a, c) => a + c, 0) || total;
  const src = sourceLine(bank);

  return `
    <section class="card">
      <h2 class="card__title">${esc(bank.title)}${src ? `<small>${esc(src)}</small>` : ""}</h2>
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

function modeCard(bank: BankMeta): string {
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
          : `<button class="btn btn--primary btn--block" id="startMode">▷ 开始练习</button>`}
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

    // 单选语义（v6.1）：pill 选中的库即为刷题范围；深链 / 首页科目行进入时同步
    if (getSelectedBanks()[0] !== activeBank) await setSelectedBanks([activeBank]);

    // 按需加载选中的库（首次进入某库时拉取题文件）
    if (!isBankLoaded(activeBank) && !isBankFailed(activeBank)) {
      root.innerHTML = `<div class="loading"><div class="loading__spinner"></div><p>正在加载《${esc(bankShortTitle(bank.title))}》题库…</p></div>`;
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
        <h1 class="page-head__title">题库</h1>
        <span class="page-head__right">${getBanks().length} 个题库</span>
      </div>

      ${bankPills()}

      <div class="search-row">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>
        <input class="search-input" id="bankSearch" type="search" placeholder="搜索题干关键词（统计本章命中题数）" value="${esc(query)}">
      </div>

      ${overviewCard(bank, questions)}
      ${modeCard(bank)}

      <section class="card">
        <h2 class="card__title">章节目录 <small>点击章节开始做题</small></h2>
        <div id="chapterBox">${chapterCardText(bank, chapters)}</div>
      </section>

      <section class="card">
        <h2 class="card__title">题型说明 <small>按题型专项练习</small></h2>
        ${typeCardText(bank, questions)}
      </section>
    `;

    /* ---------- 事件 ---------- */

    root.querySelectorAll<HTMLButtonElement>(".bank-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.bank;
        if (!id || id === activeBank) return;
        activeBank = id;
        query = "";
        // 选库 = 选刷题范围（单选），完成后整页重绘联动章节 / 简介 / 题型
        void setSelectedBanks([id]).then(() => view.render(root));
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
      if (examMode) { navigate("exam", { banks: activeBank }); return; }
      navigate("general-practice", { banks: activeBank });
    });

    bindChapters(root);

    root.querySelectorAll<HTMLButtonElement>(".type-card").forEach((btn) => {
      btn.addEventListener("click", () => {
        const type = btn.dataset.type;
        if (type) navigate("general-practice", { type, banks: activeBank });
      });
    });

    function bindChapters(scope: HTMLElement): void {
      scope.querySelectorAll<HTMLButtonElement>(".chapter").forEach((btn) => {
        btn.addEventListener("click", () => {
          const domain = btn.dataset.domain;
          if (domain) navigate("chapter-practice", { domain, banks: activeBank });
        });
      });
    }
  },
};

export default view;
