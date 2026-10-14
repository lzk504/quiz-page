/**
 * 刷题页（v6 大改 / v6.1 修复）：练习模式（即时判定）· 错题重刷 · 今日目标 · 单题练习 · 考试模式
 *
 * 模式（params.mode）：
 *   （无）  练习模式：随机 ≤100 题、即时判定、填空/简答对照后自评；**支持中途退出续刷（本地草稿）**
 *   wrong  错题重刷：错题池全量入队（不截断）
 *   daily  今日目标：抽未做过的题，上限 = 100 − 今日已刷
 *   fav    单题练习（qid）
 *   exam   考试模式：60 分钟 · 零反馈 · 交卷后统一自评 · 出分
 *
 * 考试语义（与练习模式的差别，勿混用状态）：
 *   - 作答过程中不判分、不落库、不显示答案；
 *   - 交卷时才批量判分：已作答的客观题直接落库，已作答的填空/简答进入统一自评；
 *     **未作答题不计分、不自评、不落库、不进错题本**（分母 = 已作答题数）；
 *   - 交卷 / 退出均需自定义弹窗确认；退出 = 按已作答题目提前交卷出分（不再直接作废）；
 *   - 考试模式**不提供草稿续刷**（只有普通练习模式有）。
 */

import { getQuestions, getLoadedQuestions, getQuestion, getSelectedBanks, getBank,
  questionDomainLabel, typeLabels } from "../state";
import { getStore, recordAnswer, toggleFavorite, isFavorite } from "../storage";
import { grade, displayAnswer, displayUserAnswer, isSelfJudged, type GradeResult } from "../scoring";
import {
  shuffle, examPick, examBlueprint, examTypeScores, DAILY_GOAL, todayAnswered, EXAM_MINUTES,
  chapterOrderSort, smartPracticeSort,
  type ExamResultRow,
} from "../goal";
import { setLastScope } from "../local-prefs";
import { getCurrentUser } from "../auth";
import { esc } from "../utils";
import { navigate } from "../router";
import { domainTag, typeTag, bankTag, emptyState, toast, confirmDialog, closeActiveDialog } from "../ui";
import type { Question, View } from "../types";

/** 单次练习的抽题上限（考试 = 100 题蓝图；错题重刷不受限） */
export const MAX_PER_SESSION = 100;

export { shuffle };

/* ---------------- 会话状态（刷新即重置） ---------------- */

interface ExamState {
  phase: "answer" | "judging" | "result";
  endsAt: number;
  startedAt: number;
  /** qid → 用户作答（作答阶段实时写，切题前收集） */
  answers: Map<string, unknown>;
  rows: ExamResultRow[];
  judgeIndex: number;
}

interface Session {
  queue: Question[];
  title: string;
  params: Record<string, string>;
  index: number;
  /** 已提交：客观题=判分完成；自判题=已对照参考答案 */
  settled: boolean;
  /** 自判题已对照答案、等待用户点「我答对了 / 我答错了」 */
  awaitingJudge: boolean;
  result: GradeResult | null;
  userAnswer: unknown;
  stats: { answered: number; correct: number; wrongAdded: number; wrongCleared: number };
  exam: ExamState | null;
  /** 今日目标模式的说明（目标已达成等） */
  emptyHint?: string;
  /** 已渲染过总结页（本次练习完成），用于 unmount 不写草稿 */
  done?: boolean;
  /** 是否处于已完成章节的答案解析浏览模式（不写草稿、支持双向翻题） */
  isReviewMode?: boolean;
}

let S: Session | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
/** 渲染代次：异步等待（续刷弹窗）期间若已切走，用代次判断放弃本次渲染 */
let renderSeq = 0;

/* ---------------- 练习草稿（仅普通练习模式，key 含用户名防多账号串） ---------------- */

const DRAFT_PREFIX = "quizapp.draft.v1.";
const draftKey = (): string => DRAFT_PREFIX + (getCurrentUser()?.username ?? "anon");

interface PracticeDraft {
  params: Record<string, string>;
  /** 本次题序（保序还原） */
  ids: string[];
  index: number;
  at: number;
}

function saveDraft(): void {
  const s = S;
  if (!s || s.params.mode || s.isReviewMode) return;              // 特殊模式与查看解析模式不存草稿
  if (s.done || !s.queue.length || s.index >= s.queue.length) { clearDraft(); return; }
  try {
    const draft: PracticeDraft = { params: s.params, ids: s.queue.map((q) => q.id), index: s.index, at: Date.now() };
    localStorage.setItem(draftKey(), JSON.stringify(draft));
  } catch { /* ignore */ }
}

function readDraft(): PracticeDraft | null {
  try {
    const raw = localStorage.getItem(draftKey());
    if (!raw) return null;
    const d = JSON.parse(raw) as PracticeDraft;
    if (!d || !Array.isArray(d.ids) || !d.ids.length) return null;
    if (typeof d.index !== "number" || d.index < 0) return null;
    return d;
  } catch { return null; }
}

function clearDraft(): void {
  try { localStorage.removeItem(draftKey()); } catch { /* ignore */ }
}

/** 按草稿还原会话（题序保序；题池缩水时 clamp 当前题） */
function resumeSession(d: PracticeDraft): Session {
  const s = createSession(d.params);
  const queue = d.ids.map((id) => getQuestion(id)).filter((q): q is Question => !!q);
  if (queue.length) {
    s.queue = queue;
    s.index = Math.min(Math.max(0, d.index), queue.length - 1);
  }
  s.done = false;
  return s;
}

/* ---------------- 题池 ---------------- */

/** 按 params.banks 限定的题池（缺省 = 当前刷题范围） */
function poolByBanks(banksParam?: string): Question[] {
  if (!banksParam) return getQuestions();
  const ids = banksParam.split(",").filter(Boolean);
  if (!ids.length) return getQuestions();
  const pool = getLoadedQuestions().filter((q) => ids.includes(q.id.split("-")[0]));
  return pool.length ? pool : getQuestions();
}

const isBlank = (q: Question, ua: unknown): boolean => {
  if (q.type === "multiple") return !(Array.isArray(ua) && ua.length);
  if (q.type === "fill") return !(Array.isArray(ua) && ua.some((v) => String(v ?? "").trim()));
  if (q.type === "short") return !String(ua ?? "").trim();
  return ua === undefined || ua === null || ua === "";
};

/** 未作答的题排在前面（「继续上次练习」用，保持组内随机） */
function unansweredFirst(pool: Question[]): Question[] {
  const records = getStore().records ?? {};
  const fresh: Question[] = [];
  const done: Question[] = [];
  for (const q of pool) (records[q.id] ? done : fresh).push(q);
  return [...shuffle(fresh), ...shuffle(done)];
}

function buildPool(params: Record<string, string>): Question[] {
  const mode = params.mode ?? "";

  if (mode === "fav") {
    const q = params.qid ? getQuestion(params.qid) : undefined;
    return q ? [q] : [];
  }

  if (mode === "wrong") {
    const wrongIds = new Set(Object.keys(getStore().wrongbook));
    let pool = getLoadedQuestions().filter((q) => wrongIds.has(q.id));
    if (params.qid) return pool.filter((q) => q.id === params.qid);
    if (params.banks) {
      const ids = params.banks.split(",").filter(Boolean);
      pool = pool.filter((q) => ids.includes(q.id.split("-")[0]));
    }
    if (params.domain) {
      const domains = params.domain.split(",").filter(Boolean);
      if (domains.length) pool = pool.filter((q) => domains.includes(q.domain));
    }
    if (params.type) {
      const types = params.type.split(",").filter(Boolean);
      if (types.length) pool = pool.filter((q) => types.includes(q.type));
    }
    return pool;
  }

  if (mode === "exam") {
    // 题池 = 刷题范围；从题库 tab 进入时用当前浏览的那个库
    return poolByBanks(params.banks);
  }

  if (mode === "daily") {
    const remaining = Math.max(0, DAILY_GOAL - todayAnswered(getStore()));
    const base = poolByBanks(params.banks);
    const records = getStore().records ?? {};
    const fresh = base.filter((q) => !records[q.id]);
    const ordered = fresh.length ? fresh : base;
    return shuffle(ordered).slice(0, remaining);
  }

  const pool = poolByBanks(params.banks);
  const domains = params.domain ? String(params.domain).split(",").filter(Boolean) : [];
  const types = params.type ? String(params.type).split(",").filter(Boolean) : [];
  const filtered = pool.filter((q) => {
    if (domains.length && !domains.includes(q.domain)) return false;
    if (types.length && !types.includes(q.type)) return false;
    return true;
  });

  // 1. 章节目录发起的练习：严格按题型固定顺序（单选>多选>判断>填空>简答）
  if (params.from === "chapter") {
    return chapterOrderSort(filtered);
  }
  // 2. 其它普通练习：采用智能推荐（未做题优先 > 错题 > 艾宾浩斯复习）
  return smartPracticeSort(filtered, getStore());
}

function createSession(params: Record<string, string>): Session {
  const mode = params.mode ?? "";
  const pool = buildPool(params);
  let title: string;
  let emptyHint: string | undefined;

  if (mode === "exam") {
    title = "模拟考试 · 学前教育考点精编";
  } else if (mode === "daily") {
    const remaining = Math.max(0, DAILY_GOAL - todayAnswered(getStore()));
    title = `今日目标 · 还剩 ${remaining} 题`;
    if (remaining <= 0) emptyHint = "今日的 100 题目标已经完成，太棒了！";
    else if (!pool.length) emptyHint = "当前范围内没有可以抽的新题，去题库换个章节吧。";
  } else if (mode === "fav") {
    const q = pool[0];
    title = q ? `收藏练习 · ${questionDomainLabel(q)}` : "收藏练习";
    if (!q) emptyHint = "这道题已不在当前题库中。";
  } else if (mode === "wrong") {
    if (params.qid && pool[0]) {
      title = `错题单练 · ${questionDomainLabel(pool[0])}`;
    } else if (params.domain) {
      const sample = pool[0];
      title = `错题重刷 · ${sample ? questionDomainLabel(sample) : params.domain}`;
    } else if (params.banks) {
      title = "错题重刷 · 题库专属";
    } else {
      title = "错题重刷 · 全量";
    }
  } else {
    const domains = params.domain ? String(params.domain).split(",").filter(Boolean) : [];
    const types = params.type ? String(params.type).split(",").filter(Boolean) : [];
    const dNames = domains.map((d) => {
      const sample = pool.find((q) => q.domain === d);
      return sample ? questionDomainLabel(sample) : d;
    });
    const tNames = types.map((t) => typeLabels()[t] ?? t);
    title = [...tNames, ...dNames].join(" · ") || "全部题目";
  }

  // 队列：考试按蓝图抽题；错题重刷全量重排；单题/今日目标用已排序的池；章节练习动态全量入队；普通练习截断到 100
  let queue: Question[];
  if (mode === "exam") queue = examPick(pool, examBlueprint());
  else if (mode === "wrong") queue = shuffle(pool);
  else if (mode === "fav" || mode === "daily") queue = pool;
  else if (params.from === "chapter") queue = pool;
  else queue = pool.slice(0, MAX_PER_SESSION);

  return {
    queue,
    title,
    params,
    index: 0,
    settled: false,
    awaitingJudge: false,
    result: null,
    userAnswer: null,
    stats: { answered: 0, correct: 0, wrongAdded: 0, wrongCleared: 0 },
    exam: mode === "exam"
      ? {
          phase: "answer",
          endsAt: Date.now() + EXAM_MINUTES * 60 * 1000,
          startedAt: Date.now(),
          answers: new Map<string, unknown>(),
          rows: [],
          judgeIndex: 0,
        }
      : null,
    emptyHint,
  };
}

/* ---------------- 公共渲染片段 ---------------- */

const letterOf = (i: number): string => "ABCDE"[i];

/* ---------------- 练习模式 ---------------- */

function paint(root: HTMLElement): void {
  const s = S!;
  const { queue, index } = s;

  if (!queue.length) {
    root.innerHTML = emptyState({
      icon: s.emptyHint ? "🎯" : "🎉",
      title: s.emptyHint ?? (s.params.mode === "wrong" ? "错题本是空的" : "没有符合条件的题目"),
      desc: s.emptyHint
        ? "回到首页看看今日推荐复习，或去题库挑一个章节。"
        : s.params.mode === "wrong"
          ? "答错的题会自动出现在这里，先把题刷起来吧。"
          : "试试放宽条件，或者切换题库。",
      action: `<button class="btn btn--primary" id="pExit">返回首页</button>`,
    });
    root.querySelector("#pExit")?.addEventListener("click", () => navigate("home"));
    return;
  }

  if (index >= queue.length) { renderSummary(root); return; }

  const q = queue[index];
  const pctDone = Math.round((s.stats.answered / queue.length) * 100);
  const starred = isFavorite(q.id);

  root.innerHTML = `
    <div class="practice-head">
      <span class="practice-head__idx"><b>${index + 1}</b> / ${queue.length}</span>
      <span class="practice-head__title">${esc(s.title)}</span>
      <button class="star-btn${starred ? " is-on" : ""}" id="pStar" title="${starred ? "取消收藏" : "收藏本题"}">★</button>
      <button class="btn btn--sm btn--ghost" id="pExit">退出</button>
    </div>
    <div class="mini-bar"><i style="width:${pctDone}%"></i></div>

    <section class="card">
      <div class="tags">${typeTag(q.type)}${domainTag(q.domain)}${bankTag(q)}</div>
      <div id="qBody">${renderBody(q)}</div>
      <div id="qFeedback">${renderFeedback(q)}</div>
    </section>

    <div class="actions" id="qActions">${renderActions(q)}</div>
  `;

  bind(root, q);
}

function renderBody(q: Question): string {
  switch (q.type) {
    case "single":
    case "multiple": return renderOptions(q);
    case "judge":    return renderJudge(q);
    case "fill":     return renderFill(q);
    case "short":    return renderShort(q);
    default:         return `<p class="stem">${esc(q.stem)}</p>`;
  }
}

function renderOptions(q: Question): string {
  const s = S!;
  const multi = q.type === "multiple";
  const sel = multi ? new Set<string>((s.userAnswer as string[]) ?? []) : (s.userAnswer as string | null);

  const opts = (q.options ?? []).map((text, i) => {
    const L = letterOf(i);
    const picked = multi ? (sel as Set<string>).has(L) : sel === L;
    let cls = picked ? " is-sel" : "";

    if (s.settled) {
      const ans = Array.isArray(q.answer) ? q.answer : [q.answer];
      const isRight = ans.map((a) => String(a)).includes(L);
      if (isRight) cls = " is-ok";
      else if (picked) cls = " is-bad";
      else cls = "";
    }

    return `<button type="button" class="opt${cls}" data-letter="${L}" ${s.settled ? "disabled" : ""}>
      <span class="opt__key">${L}</span>
      <span class="opt__text">${esc(text)}</span>
    </button>`;
  }).join("");

  const hint = multi
    ? `<p class="opt-hint" id="multiHint">${
        s.settled ? "" : ((sel as Set<string>).size ? `已选 ${[...(sel as Set<string>)].sort().join("")}` : "可多选，选好后点「确认答案」")
      }</p>`
    : "";

  return `<p class="stem">${esc(q.stem)}</p>
    <div class="opts" data-multi="${multi}">${opts}</div>${hint}`;
}

function renderJudge(q: Question): string {
  const s = S!;
  const picked = s.userAnswer === true ? true : s.userAnswer === false ? false : null;
  const btn = (v: boolean, emoji: string, label: string): string => {
    let cls = "";
    if (s.settled) {
      if (v === q.answer) cls = " is-ok";
      else if (s.userAnswer === v) cls = " is-bad";
    } else if (picked === v) {
      cls = " is-sel";
    }
    return `<button type="button" class="opt judge__btn${cls}" data-judge="${v}" ${s.settled ? "disabled" : ""}>
      <span class="opt__key">${emoji}</span>
      <span class="opt__text">${label}</span></button>`;
  };
  return `<p class="stem">${esc(q.stem)}</p>
    <div class="judge">${btn(true, "√", "正确")}${btn(false, "×", "错误")}</div>`;
}

/** 填空题：题干中的 ____ 占位符渲染为输入框（提交后变为逐空对照） */
function renderFill(q: Question): string {
  const s = S!;
  const parts = String(q.stem).split(/_{4}/);
  const blanks = Math.max(0, parts.length - 1);
  const refs = Array.isArray(q.answer) ? (q.answer as string[]).map(String) : [];
  const ua = Array.isArray(s.userAnswer) ? (s.userAnswer as string[]) : [];
  const locked = s.settled;                     // 已提交（对照答案 或 已完成自判）
  const judged = s.settled && !s.awaitingJudge; // 已自判：此时才染对错色

  let html = `<p class="stem stem--fill">`;
  for (let i = 0; i < blanks; i++) {
    html += esc(parts[i]);
    if (locked) {
      const mine = String(ua[i] ?? "").trim();
      const ref = refs[i] ?? "";
      const hit = mine && mine.replace(/\s+/g, "") === ref.replace(/\s+/g, "");
      const stateCls = judged ? (hit ? " is-ok" : " is-bad") : "";
      html += `<span class="blank blank--locked${stateCls}">
        <em>${esc(mine || "（未填）")}</em><i>${esc(ref)}</i></span>`;
    } else {
      html += `<input type="text" class="blank-input" data-blank="${i}"
        value="${esc(ua[i] ?? "")}" autocomplete="off" spellcheck="false" aria-label="第 ${i + 1} 空">`;
    }
  }
  html += esc(parts[blanks] ?? "") + `</p>`;

  if (locked) {
    html += `<p class="opt-hint">格式为「你的作答 ／ 参考答案」，仅供对照，对错由你自己判定。</p>`;
  } else {
    html += `<p class="opt-hint">共 ${blanks} 空，允许留空；填好后点「对照答案」。</p>`;
  }
  return html;
}

/** 简答题：填写框 → 对照参考答案 */
function renderShort(q: Question): string {
  const s = S!;
  const ua = typeof s.userAnswer === "string" ? s.userAnswer : "";
  const head = `<p class="stem">${esc(q.stem)}</p>`;

  if (s.settled) {
    return `${head}
      <div class="short-answer">
        <div class="short-answer__label">你的作答</div>
        <p class="short-answer__text">${ua.trim() ? esc(ua) : "<i>（未填写）</i>"}</p>
      </div>
      <p class="opt-hint">请对照下方参考答案自行判定。</p>`;
  }
  return `${head}
    <textarea class="short-input" id="shortInput" rows="5"
      placeholder="写下你的答案（可留空直接对照参考答案）">${esc(ua)}</textarea>`;
}

function renderActions(q: Question): string {
  const s = S!;
  const last = s.index === s.queue.length - 1;

  if (s.isReviewMode) {
    return `<div class="self-judge">
      <button class="btn btn--block" id="pPrev" ${s.index === 0 ? "disabled" : ""}>‹ 上一题</button>
      <button class="btn btn--primary btn--block" id="pNext">${last ? "完成查看" : "下一题 ›"}</button>
    </div>`;
  }

  if (s.awaitingJudge) {
    return `<div class="self-judge">
      <button class="btn btn--ok btn--block" id="pJudgeOk">我答对了 ✓</button>
      <button class="btn btn--bad btn--block" id="pJudgeBad">我答错了 ×</button>
    </div>`;
  }

  if (s.settled) {
    return `<button class="btn btn--primary btn--block" id="pNext">${last ? "完成本次练习" : "下一题 →"}</button>`;
  }

  if (q.type === "multiple") {
    return `<button class="btn btn--primary btn--block" id="pConfirm" disabled>确认答案</button>`;
  }
  if (isSelfJudged(q)) {
    return `<button class="btn btn--primary btn--block" id="pConfirm">对照答案</button>`;
  }
  return "";
}

function renderFeedback(q: Question): string {
  const s = S!;
  if (!s.settled) return "";

  if (s.awaitingJudge) {
    return `<div class="feedback">
        <div class="answer-line">参考答案：<b class="answer-line__block">${esc(displayAnswer(q))}</b></div>
        ${q.analysis ? `<div class="analysis"><span class="analysis__label">解析</span>${esc(q.analysis)}</div>` : ""}
      </div>`;
  }

  if (!s.result) return "";
  const ok = s.result.correct;
  return `<div class="feedback">
      <div class="verdict verdict--${ok ? "ok" : "bad"}">
        <span class="verdict__icon">${ok ? "✓" : "×"}</span>
        ${ok ? "回答正确" : "回答错误"}
        <small>你的答案：${esc(displayUserAnswer(q, s.userAnswer) || "（未作答）")}</small>
      </div>
      ${ok ? "" : `<div class="answer-line">正确答案：<b class="answer-line__block">${esc(displayAnswer(q))}</b></div>`}
      ${q.analysis ? `<div class="analysis"><span class="analysis__label">解析</span>${esc(q.analysis)}</div>` : ""}
    </div>`;
}

function renderSummary(root: HTMLElement): void {
  const s = S!;
  s.done = true;                                 // 到达总结页 = 本次练习完成（unmount 不再写草稿）
  const { answered, correct, wrongAdded, wrongCleared } = s.stats;
  const rate = answered ? Math.round((correct / answered) * 100) : 0;
  const batchSize = s.queue.length;
  const mode = s.params.mode ?? "";
  const isChapter = s.params.from === "chapter";
  const bankId = s.params.banks?.split(",")[0];
  const curBank = bankId ? getBank(bankId) : undefined;
  let nextDomain: string | undefined;
  if (isChapter && curBank && s.params.domain) {
    const idx = curBank.domains.indexOf(s.params.domain);
    if (idx >= 0 && idx < curBank.domains.length - 1) {
      nextDomain = curBank.domains[idx + 1];
    }
  }

  root.innerHTML = `
    <section class="card summary">
      <div class="summary__score">${answered ? rate : "—"}<small>${answered ? "%" : ""}</small></div>
      <div class="summary__label">本次练习正确率${answered ? `（${correct}/${answered}）` : ""}</div>
      <div class="summary__grid">
        <div class="summary__cell"><b>${answered}</b><span>作答</span></div>
        <div class="summary__cell"><b style="color:var(--ok)">${correct}</b><span>答对</span></div>
        <div class="summary__cell"><b style="color:var(--bad)">${answered - correct}</b><span>答错</span></div>
      </div>
      ${wrongAdded || wrongCleared ? `<p class="about" style="text-align:center">
        新增错题 <b>${wrongAdded}</b> 题${wrongCleared ? `　·　移出错题本 <b>${wrongCleared}</b> 题` : ""}
      </p>` : ""}
      ${mode === "wrong" || mode === "fav" ? "" : `<p class="about" style="text-align:center">本批共 ${batchSize} 题</p>`}
    </section>
    <div class="actions" style="flex-direction:column">
      ${isChapter && nextDomain ? `<button class="btn btn--primary btn--block" id="pNextChapter">进入下一章节 ›</button>` : ""}
      ${mode === "fav" ? "" : `<button class="btn ${isChapter && nextDomain ? "" : "btn--primary"} btn--block" id="pAgain">再刷一遍</button>`}
      ${isChapter || mode === "wrong" || mode === "fav" ? "" : `<button class="btn btn--block" id="pShuffle">换一批</button>`}
      ${isChapter ? `<button class="btn btn--block" id="pBanks">返回题库</button>` : ""}
      <button class="btn btn--block" id="pStats">查看数据报告</button>
      <button class="btn btn--block" id="pHome">返回首页</button>
    </div>
  `;

  root.querySelector("#pNextChapter")?.addEventListener("click", () => {
    navigate("practice", { domain: nextDomain!, banks: bankId!, from: "chapter" });
  });

  root.querySelector("#pBanks")?.addEventListener("click", () => {
    navigate("banks", bankId ? { bank: bankId } : undefined);
  });

  root.querySelector("#pAgain")?.addEventListener("click", () => {
    const s2 = S!;
    if (s2.params.from === "chapter") {
      s2.queue = chapterOrderSort(s2.queue);
    } else {
      s2.queue = shuffle(s2.queue);
    }
    s2.index = 0;
    s2.settled = false;
    s2.awaitingJudge = false;
    s2.result = null;
    s2.userAnswer = null;
    s2.stats = { answered: 0, correct: 0, wrongAdded: 0, wrongCleared: 0 };
    s2.isReviewMode = false;
    s2.done = false;
    paint(root);
  });

  root.querySelector("#pShuffle")?.addEventListener("click", () => {
    S = createSession(S!.params);
    paint(root);
  });

  root.querySelector("#pStats")?.addEventListener("click", () => navigate("stats"));
  root.querySelector("#pHome")?.addEventListener("click", () => navigate("home"));
}

/* ---------------- 练习交互 ---------------- */

function repaintQuestion(root: HTMLElement, q: Question): void {
  const body = root.querySelector("#qBody");
  if (body) body.innerHTML = renderBody(q);
  const fb = root.querySelector("#qFeedback");
  if (fb) fb.innerHTML = renderFeedback(q);
  const actions = root.querySelector("#qActions");
  if (actions) actions.innerHTML = renderActions(q);
  bind(root, q);
}

function collectAnswer(root: HTMLElement, q: Question): unknown {
  if (q.type === "fill") {
    const inputs = root.querySelectorAll<HTMLInputElement>(".blank-input");
    return Array.from(inputs).map((i) => i.value.trim());
  }
  if (q.type === "short") {
    const ta = root.querySelector<HTMLTextAreaElement>("#shortInput");
    return (ta?.value ?? "").trim();
  }
  return S!.userAnswer;
}

function submit(root: HTMLElement, q: Question): void {
  const s = S!;
  if (s.settled) return;

  const userAnswer = collectAnswer(root, q);
  if (q.type === "multiple" && !((userAnswer as string[]) ?? []).length) return;
  s.userAnswer = userAnswer;

  if (isSelfJudged(q)) {
    s.settled = true;
    s.awaitingJudge = true;
    repaintQuestion(root, q);
    return;
  }

  s.settled = true;
  s.result = grade(q, userAnswer);
  finalize(q, !!s.result?.correct);
  repaintQuestion(root, q);
}

function judgeSelf(root: HTMLElement, q: Question, saysCorrect: boolean): void {
  const s = S!;
  if (!s.awaitingJudge) return;
  s.awaitingJudge = false;
  s.result = { correct: saysCorrect };
  finalize(q, saysCorrect);
  repaintQuestion(root, q);
}

function finalize(q: Question, isCorrect: boolean): void {
  const s = S!;
  const r = recordAnswer(q, s.userAnswer, isCorrect);
  s.stats.answered++;
  if (isCorrect) s.stats.correct++;
  if (r.enteredWrongbook) s.stats.wrongAdded++;
  if (r.leftWrongbook) s.stats.wrongCleared++;
}

function bind(root: HTMLElement, q: Question): void {
  const s = S!;
  root.querySelector("#pExit")?.addEventListener("click", () => navigate("home"));

  root.querySelector("#pStar")?.addEventListener("click", (e) => {
    const on = toggleFavorite(q.id);
    (e.currentTarget as HTMLElement).classList.toggle("is-on", on);
    (e.currentTarget as HTMLElement).title = on ? "取消收藏" : "收藏本题";
  });

  /* 选择题 */
  const optsBox = root.querySelector<HTMLElement>(".opts");
  if (optsBox) {
    const multi = optsBox.dataset.multi === "true";
    optsBox.querySelectorAll<HTMLButtonElement>(".opt").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (s.settled) return;
        const L = btn.dataset.letter!;
        if (multi) {
          const set = new Set<string>((s.userAnswer as string[]) ?? []);
          if (set.has(L)) set.delete(L); else set.add(L);
          s.userAnswer = [...set].sort();
          optsBox.querySelectorAll<HTMLButtonElement>(".opt").forEach((b) => {
            b.classList.toggle("is-sel", set.has(b.dataset.letter!));
          });
          const confirm = root.querySelector<HTMLButtonElement>("#pConfirm");
          if (confirm) confirm.disabled = set.size === 0;
          const hint = root.querySelector("#multiHint");
          if (hint) hint.textContent = set.size ? `已选 ${(s.userAnswer as string[]).join("")}` : "可多选，选好后点「确认答案」";
        } else {
          s.userAnswer = L;
          submit(root, q);
        }
      });
    });
  }

  /* 判断题 */
  root.querySelectorAll<HTMLButtonElement>(".judge__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (s.settled) return;
      s.userAnswer = btn.dataset.judge === "true";
      submit(root, q);
    });
  });

  /* 填空/简答：Enter 顺序跳空 / Ctrl+Enter 提交 */
  if (!s.settled) {
    root.querySelectorAll<HTMLInputElement>(".blank-input").forEach((input) => {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const inputs = Array.from(root.querySelectorAll<HTMLInputElement>(".blank-input"));
          const idx = inputs.indexOf(input);
          if (idx >= 0 && idx < inputs.length - 1) inputs[idx + 1].focus();
          else submit(root, q);
        }
      });
    });
    root.querySelector<HTMLTextAreaElement>("#shortInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit(root, q);
      }
    });
  }

  /* 动作 */
  root.querySelector("#pConfirm")?.addEventListener("click", () => submit(root, q));
  root.querySelector("#pJudgeOk")?.addEventListener("click", () => judgeSelf(root, q, true));
  root.querySelector("#pJudgeBad")?.addEventListener("click", () => judgeSelf(root, q, false));

  root.querySelector<HTMLButtonElement>("#pPrev")?.addEventListener("click", () => {
    if (!s.isReviewMode || s.index <= 0) return;
    s.index--;
    const records = getStore().records ?? {};
    const prevQ = s.queue[s.index];
    const rec = records[prevQ.id];
    s.settled = true;
    s.userAnswer = rec?.lastUserAnswer;
    s.result = { correct: !!rec?.lastCorrect };
    paint(root);
  });

  root.querySelector<HTMLButtonElement>("#pNext")?.addEventListener("click", (e) => {
    (e.currentTarget as HTMLButtonElement).disabled = true;
    if (s.isReviewMode) {
      if (s.index >= s.queue.length - 1) {
        s.done = true;
        renderSummary(root);
      } else {
        s.index++;
        const records = getStore().records ?? {};
        const nextQ = s.queue[s.index];
        const rec = records[nextQ.id];
        s.settled = true;
        s.userAnswer = rec?.lastUserAnswer;
        s.result = { correct: !!rec?.lastCorrect };
        paint(root);
      }
      return;
    }
    s.index++;
    s.settled = false;
    s.awaitingJudge = false;
    s.result = null;
    s.userAnswer = null;
    paint(root);
  });
}

/* ---------------- 考试模式 ---------------- */

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function stopTimer(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

function startTimer(root: HTMLElement): void {
  stopTimer();
  const tick = (): void => {
    const s = S;
    if (!s?.exam || s.exam.phase !== "answer") { stopTimer(); return; }
    const left = s.exam.endsAt - Date.now();
    const node = root.querySelector<HTMLElement>("#examTimer");
    if (node) {
      node.textContent = `⏱ ${fmtClock(left)}`;
      node.classList.toggle("is-warn", left < 5 * 60 * 1000);
    }
    if (left <= 0) submitExam(root, true);
  };
  tick();
  timer = setInterval(tick, 1000);
}

/** 考试作答进度（已填内容的题数） */
function examAnsweredCount(): number {
  const exam = S!.exam!;
  let n = 0;
  for (const q of S!.queue) {
    const ua = exam.answers.get(q.id);
    if (!isBlank(q, ua)) n++;
  }
  return n;
}

function examBody(q: Question): string {
  const exam = S!.exam!;
  const ua = exam.answers.get(q.id);

  switch (q.type) {
    case "single":
    case "multiple": {
      const multi = q.type === "multiple";
      const sel = multi ? new Set<string>((ua as string[]) ?? []) : (ua as string | null);
      const opts = (q.options ?? []).map((text, i) => {
        const L = letterOf(i);
        const picked = multi ? (sel as Set<string>).has(L) : sel === L;
        return `<button type="button" class="opt${picked ? " is-sel" : ""}" data-letter="${L}">
          <span class="opt__key">${L}</span>
          <span class="opt__text">${esc(text)}</span>
        </button>`;
      }).join("");
      const hint = multi
        ? `<p class="opt-hint" id="multiHint">${(sel as Set<string>).size ? `已选 ${[...(sel as Set<string>)].sort().join("")}` : "可多选，可随时修改"}</p>`
        : "";
      return `<p class="stem">${esc(q.stem)}</p><div class="opts" data-multi="${multi}">${opts}</div>${hint}`;
    }
    case "judge": {
      const picked = ua === true ? true : ua === false ? false : null;
      const btn = (v: boolean, emoji: string, label: string): string =>
        `<button type="button" class="opt judge__btn${picked === v ? " is-sel" : ""}" data-judge="${v}">
          <span class="opt__key">${emoji}</span>
          <span class="opt__text">${label}</span></button>`;
      return `<p class="stem">${esc(q.stem)}</p><div class="judge">${btn(true, "√", "正确")}${btn(false, "×", "错误")}</div>`;
    }
    case "fill": {
      const parts = String(q.stem).split(/_{4}/);
      const blanks = Math.max(0, parts.length - 1);
      const arr = Array.isArray(ua) ? (ua as string[]) : [];
      let html = `<p class="stem stem--fill">`;
      for (let i = 0; i < blanks; i++) {
        html += esc(parts[i]);
        html += `<input type="text" class="blank-input" data-blank="${i}" value="${esc(arr[i] ?? "")}"
          autocomplete="off" spellcheck="false" aria-label="第 ${i + 1} 空">`;
      }
      html += esc(parts[blanks] ?? "") + `</p>`;
      html += `<p class="opt-hint">共 ${blanks} 空，允许留空；交卷后统一对照参考答案。</p>`;
      return html;
    }
    case "short": {
      const text = typeof ua === "string" ? ua : "";
      return `<p class="stem">${esc(q.stem)}</p>
        <textarea class="short-input" id="shortInput" rows="5"
          placeholder="写下你的答案（可留空）">${esc(text)}</textarea>
        <p class="opt-hint">交卷后统一对照参考答案自评。</p>`;
    }
    default:
      return `<p class="stem">${esc(q.stem)}</p>`;
  }
}

/** 切题/交卷前把输入框内容收进 answers */
function collectExamAnswer(root: HTMLElement): void {
  const s = S!;
  const exam = s.exam!;
  const q = s.queue[s.index];
  if (!q) return;
  if (q.type === "fill") {
    const inputs = root.querySelectorAll<HTMLInputElement>(".blank-input");
    exam.answers.set(q.id, Array.from(inputs).map((i) => i.value.trim()));
  } else if (q.type === "short") {
    const ta = root.querySelector<HTMLTextAreaElement>("#shortInput");
    exam.answers.set(q.id, (ta?.value ?? "").trim());
  }
}

function renderExam(root: HTMLElement): void {
  const s = S!;
  const exam = s.exam!;

  if (!s.queue.length) {
    root.innerHTML = emptyState({
      icon: "📝", title: "没有可抽的题目",
      desc: "当前刷题范围内题目不足，去题库 tab 调整范围后再试。",
      action: `<button class="btn btn--primary" id="examGoBanks">去题库</button>`,
    });
    root.querySelector("#examGoBanks")?.addEventListener("click", () => navigate("banks"));
    return;
  }

  if (exam.phase === "judging") { renderExamJudge(root); return; }
  if (exam.phase === "result") { renderExamResult(root); return; }

  const q = s.queue[s.index];
  const answered = examAnsweredCount();
  const progress = Math.round((answered / s.queue.length) * 100);

  root.innerHTML = `
    <div class="exam-head">
      <span class="exam-progress"><b>${s.index + 1}</b> / ${s.queue.length}　已答 ${answered}</span>
      <span class="exam-timer" id="examTimer">⏱ ${fmtClock(exam.endsAt - Date.now())}</span>
      <button class="btn btn--sm btn--ghost" id="examExit">退出</button>
    </div>
    <div class="mini-bar"><i style="width:${progress}%"></i></div>

    <section class="card">
      <div class="tags">${typeTag(q.type)}${domainTag(q.domain)}${bankTag(q)}</div>
      <div id="qBody">${examBody(q)}</div>
    </section>

    <div class="actions" id="qActions">
      <button class="btn" id="examPrev" ${s.index === 0 ? "disabled" : ""}>← 上一题</button>
      ${s.index === s.queue.length - 1
        ? `<button class="btn btn--primary" id="examSubmit" ${answered ? "" : "disabled"}>交卷</button>`
        : `<button class="btn btn--primary" id="examNext">下一题 →</button>`}
    </div>
    <div class="actions" style="margin-top:10px">
      <button class="btn btn--block" id="examSubmit2" ${answered ? "" : "disabled"}>交卷（已答 ${answered} / ${s.queue.length}）</button>
    </div>
  `;

  bindExamQuestion(root, q);
  bindExamNav(root);
}

/** 题面绑定（选项 / 判断题）——只重绘 #qBody 后单独调用，避免重复绑定导航按钮 */
function bindExamQuestion(root: HTMLElement, q: Question): void {
  const s = S!;
  const exam = s.exam!;

  /** 重绘题面 + 同步进度显示 */
  const refresh = (): void => {
    const body = root.querySelector("#qBody");
    if (body) body.innerHTML = examBody(q);
    const answered = examAnsweredCount();
    const prog = root.querySelector(".exam-progress");
    if (prog) prog.innerHTML = `<b>${s.index + 1}</b> / ${s.queue.length}　已答 ${answered}`;
    const sub2 = root.querySelector<HTMLButtonElement>("#examSubmit2");
    if (sub2) {
      sub2.textContent = `交卷（已答 ${answered} / ${s.queue.length}）`;
      sub2.disabled = answered === 0;
    }
    const sub1 = root.querySelector<HTMLButtonElement>("#examSubmit");
    if (sub1) sub1.disabled = answered === 0;
    const bar = root.querySelector(".mini-bar i") as HTMLElement | null;
    if (bar) bar.style.width = `${Math.round((answered / s.queue.length) * 100)}%`;
    bindExamQuestion(root, q);
  };

  const optsBox = root.querySelector<HTMLElement>(".opts");
  if (optsBox) {
    const multi = optsBox.dataset.multi === "true";
    optsBox.querySelectorAll<HTMLButtonElement>(".opt").forEach((btn) => {
      btn.addEventListener("click", () => {
        const L = btn.dataset.letter!;
        if (multi) {
          const set = new Set<string>((exam.answers.get(q.id) as string[]) ?? []);
          if (set.has(L)) set.delete(L); else set.add(L);
          exam.answers.set(q.id, [...set].sort());
        } else {
          exam.answers.set(q.id, L);
        }
        refresh();
      });
    });
  }

  root.querySelectorAll<HTMLButtonElement>(".judge__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      exam.answers.set(q.id, btn.dataset.judge === "true");
      refresh();
    });
  });
}

/** 导航绑定（上一题 / 下一题 / 交卷 / 退出）——每屏只绑定一次 */
function bindExamNav(root: HTMLElement): void {
  const s = S!;

  root.querySelector("#examPrev")?.addEventListener("click", () => {
    collectExamAnswer(root);
    s.index = Math.max(0, s.index - 1);
    renderExam(root);
  });

  root.querySelector("#examNext")?.addEventListener("click", () => {
    collectExamAnswer(root);
    s.index = Math.min(s.queue.length - 1, s.index + 1);
    renderExam(root);
  });

  const submitHandler = async (): Promise<void> => {
    collectExamAnswer(root);
    const answered = examAnsweredCount();
    if (answered === 0) return;                 // 未作答不可交卷（按钮也已禁用）
    const blank = s.queue.length - answered;
    const msg = blank > 0
      ? `还有 ${blank} 道题未作答，交卷后仅按已作答的 ${answered} 题计分（未作答不计分）。确定交卷吗？`
      : "确定交卷吗？交卷后本次考试不可再修改。";
    const ok = await confirmDialog({
      title: "交卷确认", message: msg, confirmText: "交卷", danger: true,
    });
    if (!ok) return;
    submitExam(root, false);
  };
  root.querySelector("#examSubmit")?.addEventListener("click", () => { void submitHandler(); });
  root.querySelector("#examSubmit2")?.addEventListener("click", () => { void submitHandler(); });

  root.querySelector("#examExit")?.addEventListener("click", async () => {
    const answered = examAnsweredCount();
    const ok = await confirmDialog({
      title: "退出考试",
      message: answered > 0
        ? `退出将结束本次考试，并按已作答的 ${answered} 题出分（未作答不计分）。确定退出吗？`
        : "退出将结束本次考试。当前尚未作答任何题目，退出后本次考试不计分。确定退出吗？",
      confirmText: "退出并出分", cancelText: "继续作答", danger: true,
    });
    if (!ok) return;
    submitExam(root, false);                    // 提前交卷出分（不再直接作废回首页）
  });
}

/** 交卷：先判分（不改 phase，异常可重试）→ 客观题批量落库 → 自判题进入统一自评 */
function submitExam(root: HTMLElement, auto: boolean): void {
  const s = S;
  if (!s?.exam || s.exam.phase !== "answer") return;
  const exam = s.exam;

  collectExamAnswer(root);

  // ① 先判分，全部成功后才切阶段：中途异常时 phase 仍为 "answer"，可重试
  const rows: ExamResultRow[] = [];
  try {
    for (const q of s.queue) {
      const ua = exam.answers.get(q.id);
      if (isBlank(q, ua)) {
        rows.push({ q, userAnswer: ua, correct: false, skipped: true });  // 未作答：不计分 / 不自评 / 不落库
        continue;
      }
      if (isSelfJudged(q)) {
        rows.push({ q, userAnswer: ua, correct: false });                 // 待自评
        continue;
      }
      let correct = false;
      try { correct = !!grade(q, ua)?.correct; }
      catch (e) { console.error("[exam] 判分异常", q.id, e); }
      recordAnswer(q, ua, correct);
      rows.push({ q, userAnswer: ua, correct });
    }
  } catch (e) {
    console.error("[exam] 交卷失败", e);
    toast("交卷失败，请重试", "bad");
    return;
  }

  // ② 全部成功：停表 + 进入判分/出分阶段
  stopTimer();
  exam.rows = rows;
  exam.judgeIndex = 0;
  exam.phase = "judging";

  if (auto) toast("考试时间已到，已自动交卷", "bad");

  const pending = exam.rows.filter((r) => isSelfJudged(r.q) && !r.skipped);
  if (pending.length) renderExamJudge(root);
  else { exam.phase = "result"; renderExamResult(root); }
}

/** 自评阶段：逐题展示「你的作答 / 参考答案 / 解析」+ 我答对了 / 我答错了 */
function renderExamJudge(root: HTMLElement): void {
  const s = S!;
  const exam = s.exam!;
  const pending = exam.rows.filter((r) => isSelfJudged(r.q) && !r.skipped);

  if (exam.judgeIndex >= pending.length) {
    exam.phase = "result";
    renderExamResult(root);
    return;
  }

  const row = pending[exam.judgeIndex];
  const q = row.q;
  const mine = displayUserAnswer(q, row.userAnswer);

  root.innerHTML = `
    <div class="exam-head">
      <span class="exam-progress">自评 <b>${exam.judgeIndex + 1}</b> / ${pending.length}</span>
      <span class="exam-timer">交卷后自评</span>
    </div>
    <div class="mini-bar"><i style="width:${Math.round((exam.judgeIndex / pending.length) * 100)}%"></i></div>

    <section class="exam-judge__item" style="margin-top:14px">
      <div class="tags">${typeTag(q.type)}${domainTag(q.domain)}${bankTag(q)}</div>
      <p class="stem">${esc(q.stem)}</p>
      <div class="short-answer">
        <div class="short-answer__label">你的作答</div>
        <p class="short-answer__text">${esc(mine)}</p>
      </div>
      <div class="answer-line" style="margin-top:10px">参考答案：<b class="answer-line__block">${esc(displayAnswer(q))}</b></div>
      ${q.analysis ? `<div class="analysis"><span class="analysis__label">解析</span>${esc(q.analysis)}</div>` : ""}
      <div class="exam-judge__btns">
        <button class="btn btn--ok btn--block" id="ejOk">我答对了 ✓</button>
        <button class="btn btn--bad btn--block" id="ejBad">我答错了 ×</button>
      </div>
      <p class="exam-judge__hint">判定结果将计入成绩与错题本。</p>
    </section>
  `;

  const judge = (says: boolean): void => {
    row.correct = says;
    recordAnswer(q, row.userAnswer, says);
    exam.judgeIndex++;
    if (exam.judgeIndex >= pending.length) {
      exam.phase = "result";
      renderExamResult(root);
    } else {
      renderExamJudge(root);
    }
  };
  root.querySelector("#ejOk")?.addEventListener("click", () => judge(true));
  root.querySelector("#ejBad")?.addEventListener("click", () => judge(false));
}

function renderExamResult(root: HTMLElement): void {
  const s = S!;
  const exam = s.exam!;
  const rows = exam.rows;
  const answered = rows.filter((r) => !r.skipped);      // 分母 = 已作答题数
  const total = answered.length;
  const correct = answered.filter((r) => r.correct).length;
  const score = total ? Math.round((correct / total) * 100) : 0;
  const typeScores = examTypeScores(answered, typeLabels());
  const wrong = total - correct;
  const skipped = rows.length - total;

  const label = total
    ? `共作答 ${total} 题 · 答对 ${correct} 题 · 答错 ${wrong} 题（正确率 ${score}%）${
        skipped ? ` · 未作答 ${skipped} 题不计分` : ""}`
    : "本次考试未作答任何题目，未计分";

  root.innerHTML = `
    <section class="card">
      <div class="exam-score">${total ? score : "—"}${total ? "<small> 分</small>" : ""}</div>
      <div class="exam-score__label">${label}</div>
      ${typeScores.length ? `<h2 class="card__title">分题型得分</h2>
      <div class="kpi-row">
        ${typeScores.map((t) => `
          <div class="kpi">
            <b>${t.correct}/${t.total}</b>
            <span>${esc(t.label)}</span>
          </div>`).join("")}
      </div>` : ""}
    </section>

    <section class="card">
      <h2 class="card__title">逐题清单 <small>你的答案 / 正确答案</small></h2>
      <div class="exam-table">
        ${rows.map((r, i) => {
          const cls = r.skipped ? "exam-row--skip" : r.correct ? "exam-row--ok" : "exam-row--bad";
          const mark = r.skipped ? "—" : r.correct ? "✓" : "×";
          const mine = r.skipped ? "未作答" : displayUserAnswer(r.q, r.userAnswer);
          return `<div class="exam-row ${cls}">
            <span class="exam-row__idx">${i + 1}</span>
            <span class="exam-row__mine">${esc(mine)}</span>
            <span class="exam-row__right">${esc(displayAnswer(r.q))}</span>
            <span class="exam-row__mark">${mark}</span>
          </div>`;
        }).join("")}
      </div>
    </section>

    <div class="actions" style="flex-direction:column">
      <button class="btn btn--primary btn--block" id="exAgain">再考一次</button>
      <button class="btn btn--block" id="exBanks">返回题库</button>
      <button class="btn btn--block" id="exWrong">查看错题本（${wrong}）</button>
      <button class="btn btn--block" id="exHome">返回首页</button>
    </div>
  `;

  root.querySelector("#exAgain")?.addEventListener("click", () => {
    S = createSession(S!.params);
    startTimer(root);
    renderExam(root);
  });
  root.querySelector("#exBanks")?.addEventListener("click", () => navigate("banks"));
  root.querySelector("#exWrong")?.addEventListener("click", () => navigate("wrongbook"));
  root.querySelector("#exHome")?.addEventListener("click", () => navigate("home"));
}

/* ---------------- 调试钩子 ---------------- */

/** 只读快照：练习会话的题序与当前题（e2e 验证「同批 / 换批」契约） */
export function debugSession(): { ids: string[]; index: number; current: string | null } {
  if (!S) return { ids: [], index: 0, current: null };
  return { ids: S.queue.map((q) => q.id), index: S.index, current: S.queue[S.index]?.id ?? null };
}

/** 只读快照：考试状态（e2e 验证考试契约） */
export function debugExam(): {
  mode: string; phase: string | null; total: number; answered: number; judged: number;
  score: number | null; endsAt: number | null;
} {
  if (!S?.exam) return { mode: S?.params.mode ?? "", phase: null, total: 0, answered: 0, judged: 0, score: null, endsAt: null };
  const rows = S.exam.rows;
  const answeredRows = rows.filter((r) => !r.skipped);
  const correct = answeredRows.filter((r) => r.correct).length;
  return {
    mode: S.params.mode ?? "",
    phase: S.exam.phase,
    total: S.queue.length,
    answered: examAnsweredCount(),
    judged: S.exam.judgeIndex,
    score: S.exam.phase === "result" && answeredRows.length
      ? Math.round((correct / answeredRows.length) * 100)
      : null,
    endsAt: S.exam.endsAt,
  };
}

/* ---------------- 视图导出 ---------------- */

const view: View = {
  async render(root, params) {
    const p = params ?? {};
    const mode = p.mode ?? "";
    const seq = ++renderSeq;

    // 普通练习模式：若有本地草稿，先询问「继续上次」还是「重新开始」
    let s: Session;
    let resumedDraft = false;
    if (!mode) {
      const d = readDraft();
      if (d) {
        const cont = await confirmDialog({
          title: "继续上次练习？",
          message: `上次练习到第 ${Math.min(d.index + 1, d.ids.length)} 题（共 ${d.ids.length} 题）。\n选「继续刷题」接着上次的进度，选「重新开始」则放弃本地记录并重新抽题。`,
          confirmText: "继续刷题",
          cancelText: "重新开始",
        });
        if (seq !== renderSeq) return;              // 等待期间已切走，放弃本次渲染
        if (cont) { s = resumeSession(d); resumedDraft = true; }
        else { clearDraft(); s = createSession(p); }
      } else {
        s = createSession(p);
      }
    } else {
      s = createSession(p);
    }
    S = s;

    // 只对「普通练习」记录范围偏好（错题/今日/收藏/考试不进「继续上次练习」）
    if (!mode) {
      const banks = p.banks ? p.banks.split(",").filter(Boolean) : getSelectedBanks();
      setLastScope({ banks, domain: p.domain, type: p.type });
    }

    if (S.exam) { renderExam(root); startTimer(root); return; }

    // 章节目录练习全做完检测与弹窗
    const isChapter = !mode && p.from === "chapter" && !resumedDraft;
    const records = getStore().records ?? {};
    const allDone = isChapter && s.queue.length > 0 && s.queue.every((q) => !!records[q.id]);

    if (allDone) {
      s.isReviewMode = true;
      const firstQ = s.queue[0];
      const rec = records[firstQ.id];
      s.settled = true;
      s.userAnswer = rec?.lastUserAnswer;
      s.result = { correct: !!rec?.lastCorrect };
      paint(root);

      const redo = await confirmDialog({
        title: "本章已完成",
        message: `该章节共 ${s.queue.length} 道题已全部练习完成。\n是否选择重新作答本章题目？`,
        confirmText: "重新作答",
        cancelText: "查看解析",
      });
      if (seq !== renderSeq) return;
      if (redo) {
        s.isReviewMode = false;
        s.settled = false;
        s.result = null;
        s.userAnswer = null;
        s.stats = { answered: 0, correct: 0, wrongAdded: 0, wrongCleared: 0 };
        s.index = 0;
        paint(root);
      }
      return;
    }

    paint(root);
  },
  unmount() {
    renderSeq++;                                // 让仍在等待弹窗的 render 放弃
    stopTimer();
    closeActiveDialog();
    saveDraft();                                // 仅普通练习模式写入；完成 / 到底则清草稿
    S = null;
  },
};

export default view;
