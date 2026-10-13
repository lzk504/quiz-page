/**
 * 首页（v6 重写）：问候 + 备考横幅 + 今日目标 + 继续上次练习 + 快捷入口
 *                  + 我的备考科目 + 今日推荐复习
 *
 * 说明：
 *  - 应用大标题固定为 APP_NAME（考点精编），不随题库变化；
 *  - 首页不再承担「选库 / 领域题型筛选」，这些职责移到题库 tab；
 *  - 各库进度一律基于「全部已加载库」（getLoadedQuestions），不能用 getQuestions（只含刷题范围）。
 */

import {
  getBanks, getLoadedQuestions, getQuestion, bankQuestionCount, isBankLoaded, ensureBank,
  questionDomainLabel, typeLabels, getBank, getSelectedBanks,
} from "../state";
import { getStore } from "../storage";
import {
  dailyGoal, streakDays, todayRecommended, daysUntil, DAILY_GOAL,
  type RecGroup, WRONG_RED,
} from "../goal";
import { getExamDate, getLastScope, type LastScope } from "../local-prefs";
import { getCurrentUser } from "../auth";
import { esc, pct, APP_NAME, fmtDate } from "../utils";
import { navigate } from "../router";
import { emptyState } from "../ui";
import type { BankMeta, Question, View } from "../types";

/* ---------------- 小工具 ---------------- */

/** 简短书名提取：《…》取书名号内文本；没有书名号则用完整标题（不做硬截断） */
function shortBankTitle(title: string): string {
  const match = title.match(/《(.+?)》/);
  return match ? match[1] : title;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return "凌晨好";
  if (h < 12) return "早上好";
  if (h < 18) return "下午好";
  return "晚上好";
}

interface BankStat { total: number; answered: number; correct: number }

/** 各库进度（基于全部已加载库） */
function bankStats(): Map<string, BankStat> {
  const records = getStore().records ?? {};
  const all = getLoadedQuestions();
  const map = new Map<string, BankStat>();
  for (const b of getBanks()) {
    const qs = all.filter((q) => q.id.startsWith(b.id + "-"));
    map.set(b.id, {
      total: qs.length,
      answered: qs.filter((q) => records[q.id]).length,
      correct: qs.filter((q) => records[q.id]?.lastCorrect).length,
    });
  }
  return map;
}

/* ---------------- 继续上次练习 ---------------- */

/** 上次练习范围内的题池（已加载库口径） */
function scopePool(scope: LastScope): Question[] {
  const types = scope.type ? scope.type.split(",").filter(Boolean) : [];
  return getLoadedQuestions().filter((q) => {
    if (!scope.banks.includes(q.id.split("-")[0])) return false;
    if (scope.domain && q.domain !== scope.domain) return false;
    if (types.length && !types.includes(q.type)) return false;
    return true;
  });
}

function scopeLabel(scope: LastScope, pool: Question[]): string {
  const parts: string[] = [];
  const bankTitles = scope.banks
    .map((id) => getBank(id))
    .filter((b): b is BankMeta => !!b)
    .map((b) => shortBankTitle(b.title));
  if (bankTitles.length) parts.push(bankTitles.join(" + "));
  if (scope.domain) {
    const sample = pool.find((q) => q.domain === scope.domain);
    parts.push(sample ? questionDomainLabel(sample) : scope.domain);
  }
  if (scope.type) parts.push(scope.type.split(",").filter(Boolean).map((t) => typeLabels()[t] ?? t).join("／"));
  return parts.join(" · ") || "全部题目";
}

/* ---------------- 渲染片段 ---------------- */

function continueCard(): string {
  const scope = getLastScope();
  const pool = scope ? scopePool(scope) : [];
  const records = getStore().records ?? {};

  if (!scope || !pool.length) {
    return `
      <section class="card continue-card" id="startCard">
        <div class="continue-card__head">
          <h2 class="card__title" style="margin:0">开始刷题</h2>
          <span class="continue-card__tag">练习模式</span>
        </div>
        <p class="continue-card__desc">还没有练习足迹。先去题库挑一个章节，或者直接快速刷题。</p>
        <div class="actions" style="margin-top:14px">
          <button class="btn btn--primary" id="qStart">快速刷题</button>
          <button class="btn" id="qGoBanks">去题库选章节</button>
        </div>
      </section>`;
  }

  const answered = pool.filter((q) => records[q.id]).length;
  const correct = pool.filter((q) => records[q.id]?.lastCorrect).length;
  const rest = Math.max(0, pool.length - answered);
  const rate = answered ? pct(correct, answered) : 0;

  return `
    <section class="card continue-card" id="continueCard">
      <div class="continue-card__head">
        <h2 class="card__title" style="margin:0">▷ 继续上次练习</h2>
        <span class="continue-card__tag">练习模式</span>
      </div>
      <p class="continue-card__desc">${esc(scopeLabel(scope, pool))} · 还有 <b>${rest}</b> 题没做过。</p>
      <div class="continue-card__meta">
        <span>本范围进度 <b>${answered}/${pool.length}</b></span>
        <span>正确率 ${answered ? `<b>${rate}%</b>` : "—"}</span>
      </div>
      <div class="rate-row__bar"><i class="bar--blue" style="width:${pct(answered, pool.length)}%"></i></div>
      <div class="actions" style="margin-top:14px">
        <button class="btn btn--primary" id="qContinue">接着做题</button>
      </div>
    </section>`;
}

/** 快捷入口 */
function quickGrid(): string {
  const items = [
    { id: "quickChapter", icon: "▦", tone: "violet", label: "章节练习", desc: "按领域刷题" },
    { id: "quickExam", icon: "⏱", tone: "red", label: "考试模式", desc: "100 题 · 60 分钟" },
    { id: "quickWrong", icon: "✎", tone: "green", label: "错题本", desc: "重刷错题" },
    { id: "quickFav", icon: "★", tone: "gold", label: "我的收藏", desc: "好题收藏" },
  ];
  return `<div class="quick-grid">${items.map((it) => `
    <button class="quick" id="${it.id}">
      <span class="quick__icon quick__icon--${it.tone}">${it.icon}</span>
      <span>
        <span class="quick__label">${it.label}</span>
        <span class="quick__desc">${it.desc}</span>
      </span>
    </button>`).join("")}</div>`;
}

/** 我的备考科目 */
function subjectList(stats: Map<string, BankStat>): string {
  return `<div class="subject-list">${getBanks().map((b) => {
    const st = stats.get(b.id) ?? { total: 0, answered: 0, correct: 0 };
    const rate = st.answered ? pct(st.correct, st.answered) : 0;
    const loaded = isBankLoaded(b.id);
    const target = Object.values(b.typeCounts ?? {}).reduce((a, c) => a + c, 0) || bankQuestionCount(b.id);
    return `<button class="subject" data-bank="${esc(b.id)}">
      <span class="subject__badge subject__badge--${esc(b.id)}">${esc(b.id)}</span>
      <span class="subject__body">
        <span class="subject__title">${esc(b.title)}</span>
        <span class="subject__meta">
          <span>${loaded ? `已练 <b>${st.answered}</b> / ${st.total} 题` : `目标 ${target} 题 · 待加载`}</span>
          <span>${st.answered ? `正确率 ${rate}%` : "未开始"}</span>
        </span>
        <span class="subject__bar"><i style="width:${st.total ? pct(st.answered, st.total) : 0}%"></i></span>
      </span>
    </button>`;
  }).join("")}</div>`;
}

/** 今日推荐复习 */
function recommendCard(recs: RecGroup[]): string {
  const store = getStore();
  const streak = streakDays(store);
  const total = Object.keys(store.records ?? {}).length;

  const body = recs.length
    ? `<div class="rec-list">${recs.map((r) => `
        <button class="rec rec--${r.level}" data-domain="${esc(r.domain)}">
          <span class="rec__mark">❗</span>
          <span class="rec__body">
            <span class="rec__title">${esc(r.label)}</span>
            <span class="rec__meta">累计错 ${r.maxWrong} 次 · 涉及 ${r.count} 道题</span>
          </span>
          <span class="rec__go rec__go--${r.level}">去复习 ›</span>
        </button>`).join("")}</div>`
    : `<p class="about" style="margin:0">暂无高频错题，继续保持！</p>`;

  return `
    <section class="card">
      <h2 class="card__title">今日推荐复习
        <small><button class="btn btn--sm btn--ghost" id="goWrongbook" style="padding:0 8px">错题本 ›</button></small>
      </h2>
      ${body}
      <p class="hero__foot" style="color:var(--text-3);opacity:1">
        连续学习 <b>${streak}</b> 天　·　累计做题 <b>${total}</b> 题
        ${recs.some((r) => r.maxWrong >= WRONG_RED) ? "　·　红色组建议优先复习" : ""}
      </p>
    </section>`;
}

/* ---------------- 视图 ---------------- */

const view: View = {
  async render(root) {
    const banks = getBanks();
    if (!banks.length) {
      root.innerHTML = emptyState({ icon: "📚", title: "题库清单为空", desc: "请检查 data/banks.json 是否正常加载。" });
      return;
    }

    const store = getStore();
    const user = getCurrentUser();
    const username = user?.username ?? "同学";
    const goal = dailyGoal(store);
    const stats = bankStats();
    const recs = todayRecommended(getLoadedQuestions(), store);

    const examDate = getExamDate();
    const left = daysUntil(examDate);
    const examRight = left === null
      ? `设置考试日期 ›<small>暂未设置</small>`
      : left >= 0
        ? `${left} 天后开考<small>${esc(examDate!)}</small>`
        : `已过考试日<small>${esc(examDate!)}</small>`;

    const bankTitles = banks.map((b) => shortBankTitle(b.title));
    const totalTarget = banks.reduce(
      (a, b) => a + (Object.values(b.typeCounts ?? {}).reduce((x, y) => x + y, 0) || bankQuestionCount(b.id)), 0);

    root.innerHTML = `
      <section class="hero hero--home">
        <div class="greet">
          <div class="greet__avatar">${esc(username.slice(0, 1))}</div>
          <div class="greet__text">
            <h1 class="hero__title greet__name">${esc(APP_NAME)}</h1>
            <p class="greet__hello">${greeting()}，${esc(username)} · 今天也要稳稳拿分</p>
          </div>
          <button class="greet__gear" id="goSettings" title="学习设置">⚙</button>
        </div>

        <div class="exam-banner">
          <div>
            <b class="exam-banner__title">备考科目 · 学前教育考点精编</b>
            <span class="exam-banner__sub">${esc(bankTitles.join(" / "))} · 共 ${totalTarget || 0} 题</span>
          </div>
          <button class="exam-banner__right" id="goExamDate">${examRight}</button>
        </div>

        <button class="goal" id="goDaily">
          <span class="goal__head">
            <span class="goal__label">今日目标 · ${DAILY_GOAL} 题</span>
            <span class="goal__num"><b>${goal.done}</b> / ${goal.goal} 题 · 完成 ${goal.percent}%</span>
          </span>
          <span class="goal__bar"><i style="width:${goal.percent}%"></i></span>
        </button>
      </section>

      ${continueCard()}
      ${quickGrid()}

      <section class="card">
        <h2 class="card__title">我的备考科目
          <small><button class="btn btn--sm btn--ghost" id="allBanks" style="padding:0 8px">全部题库 ›</button></small>
        </h2>
        ${subjectList(stats)}
      </section>

      ${recommendCard(recs)}
    `;

    /* ---------- 事件 ---------- */
    const startDefault = (): void => navigate("practice", { fresh: "1" });

    root.querySelector("#goSettings")?.addEventListener("click", () => navigate("settings"));
    root.querySelector("#goExamDate")?.addEventListener("click", () => navigate("settings"));
    root.querySelector("#goDaily")?.addEventListener("click", () => navigate("practice", { mode: "daily" }));

    root.querySelector("#qStart")?.addEventListener("click", startDefault);
    root.querySelector("#qGoBanks")?.addEventListener("click", () => navigate("banks"));
    root.querySelector("#qContinue")?.addEventListener("click", () => {
      const scope = getLastScope();
      if (!scope) { startDefault(); return; }
      const params: Record<string, string> = { banks: scope.banks.join(","), fresh: "0" };
      if (scope.domain) params.domain = scope.domain;
      if (scope.type) params.type = scope.type;
      navigate("practice", params);
    });

    root.querySelector("#quickChapter")?.addEventListener("click", () => navigate("banks"));
    root.querySelector("#quickExam")?.addEventListener("click", () => navigate("practice", { mode: "exam" }));
    root.querySelector("#quickWrong")?.addEventListener("click", () => navigate("wrongbook"));
    root.querySelector("#quickFav")?.addEventListener("click", () => navigate("favorites"));

    root.querySelector("#allBanks")?.addEventListener("click", () => navigate("banks"));
    root.querySelectorAll<HTMLButtonElement>(".subject").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.bank;
        if (id) void ensureBank(id);
        navigate("banks", id ? { bank: id } : undefined);
      });
    });

    root.querySelector("#goWrongbook")?.addEventListener("click", () => navigate("wrongbook"));
    root.querySelectorAll<HTMLButtonElement>(".rec").forEach((btn) => {
      btn.addEventListener("click", () => {
        const domain = btn.dataset.domain;
        navigate("practice", domain ? { mode: "wrong", domain } : { mode: "wrong" });
      });
    });
  },
};

export default view;
