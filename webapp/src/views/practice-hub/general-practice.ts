/**
 * 普通全范围练习视图（general-practice.ts）
 * 对应路由：#/general-practice
 * 特性：
 *   - 题库全范围刷题：随机 ≤100 题、即时判定、填空/简答对照后自评；
 *   - 支持今日目标（daily）与单题练习（fav）；
 *   - 独立草稿隔离（kind: "general"），弹窗明确标识「全范围练习」；
 *   - 实时作答隔离（sessionAnswers），确保未答题不提前展示答案。
 */

import {
  getQuestions, getLoadedQuestions, getQuestion, getSelectedBanks,
  questionDomainLabel, typeLabels,
} from "../../state";
import { getStore, recordAnswer, toggleFavorite, isFavorite } from "../../storage";
import { grade, isSelfJudged, type GradeResult } from "../../scoring";
import { shuffle, DAILY_GOAL, todayAnswered, smartPracticeSort } from "../../goal";
import { setLastScope } from "../../local-prefs";
import { esc } from "../../utils";
import { navigate } from "../../router";
import { domainTag, typeTag, bankTag, emptyState, confirmDialog, closeActiveDialog } from "../../ui";
import type { Question, View } from "../../types";
import { renderQuestionBody, renderFeedbackCard, collectAnswer } from "./quiz-card";
import { saveDraft, readDraft, clearDraft, type PracticeDraft } from "./draft";

export const MAX_PER_SESSION = 100;

interface GeneralSession {
  queue: Question[];
  title: string;
  params: Record<string, string>;
  index: number;
  settled: boolean;
  awaitingJudge: boolean;
  result: GradeResult | null;
  userAnswer: unknown;
  stats: { answered: number; correct: number; wrongAdded: number; wrongCleared: number };
  emptyHint?: string;
  done?: boolean;
  sessionAnswers: Map<string, { userAnswer: unknown; result: GradeResult }>;
}

let S: GeneralSession | null = null;
let renderSeq = 0;

function resumeSession(d: PracticeDraft): GeneralSession {
  const s = createSession(d.params);
  const queue = d.ids.map((id) => getQuestion(id)).filter((q): q is Question => !!q);
  if (queue.length) {
    s.queue = queue;
    const nextIdx = d.settled ? d.index + 1 : d.index;
    s.index = Math.min(Math.max(0, nextIdx), queue.length - 1);
  }
  s.done = false;
  return s;
}

function poolByBanks(banksParam?: string): Question[] {
  if (!banksParam) return getQuestions();
  const ids = banksParam.split(",").filter(Boolean);
  if (!ids.length) return getQuestions();
  const pool = getLoadedQuestions().filter((q) => ids.includes(q.id.split("-")[0]));
  return pool.length ? pool : getQuestions();
}

function buildPool(params: Record<string, string>): Question[] {
  const mode = params.mode ?? "";

  if (mode === "fav") {
    const q = params.qid ? getQuestion(params.qid) : undefined;
    return q ? [q] : [];
  }

  let pool = poolByBanks(params.banks);

  if (params.domain) {
    const domains = params.domain.split(",").filter(Boolean);
    if (domains.length) pool = pool.filter((q) => domains.includes(q.domain));
  }
  if (params.type) {
    const types = params.type.split(",").filter(Boolean);
    if (types.length) pool = pool.filter((q) => types.includes(q.type));
  }

  if (mode === "daily") {
    const store = getStore();
    const untouched = pool.filter((q) => !(store.records[q.id]?.attempts));
    return shuffle(untouched);
  }

  return pool;
}

function createSession(params: Record<string, string>): GeneralSession {
  const mode = params.mode ?? "";
  const pool = buildPool(params);
  let title = "全库练习";
  let emptyHint: string | undefined;

  if (mode === "fav") {
    title = "收藏题目练习";
    if (!pool.length) emptyHint = "未找到该收藏题目，可能已被移除。";
  } else if (mode === "daily") {
    const left = Math.max(0, DAILY_GOAL - todayAnswered(getStore()));
    title = `今日目标（还需刷 ${left} 题）`;
    if (!pool.length) emptyHint = left === 0 ? "今日目标已达成！太棒了 🎉" : "当前范围内暂无新题可刷，换个题库试试。";
  } else {
    const types = (params.type ?? "").split(",").filter(Boolean);
    const domains = (params.domain ?? "").split(",").filter(Boolean);
    const dNames = domains.map((d) => {
      const sample = pool.find((q) => q.domain === d);
      return sample ? questionDomainLabel(sample) : d;
    });
    const tNames = types.map((t) => typeLabels()[t] ?? t);
    title = [...tNames, ...dNames].join(" · ") || "全库全范围练习";
  }

  let queue: Question[];
  if (mode === "fav" || mode === "daily") queue = pool;
  else queue = smartPracticeSort(pool, getStore()).slice(0, MAX_PER_SESSION);

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
    emptyHint,
    sessionAnswers: new Map(),
  };
}

function renderCard(root: HTMLElement): void {
  const s = S;
  if (!s) return;
  const { queue, index } = s;

  if (!queue.length) {
    root.innerHTML = emptyState({
      icon: s.emptyHint ? "🎯" : "📚",
      title: s.emptyHint ?? "没有符合条件的题目",
      desc: s.emptyHint ? "返回首页继续练习，或去题库换个条件。" : "可放宽题型或领域筛选。",
      action: `<button class="btn btn--primary" id="pExit">返回首页</button>`,
    });
    root.querySelector("#pExit")?.addEventListener("click", () => navigate("home"));
    return;
  }

  if (index >= queue.length) { renderSummary(root); return; }

  const q = queue[index];
  const pctDone = Math.round((index / queue.length) * 100);
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
      <div id="qBody">${renderQuestionBody(q, s.userAnswer, s.settled, s.awaitingJudge)}</div>
      <div id="qFeedback">${renderFeedbackCard(q, s.settled, s.awaitingJudge, s.result, s.userAnswer)}</div>
    </section>

    <div class="actions" id="qActions">${renderActions(q)}</div>
  `;

  bind(root, q);
}

function renderActions(q: Question): string {
  const s = S!;
  const last = s.index === s.queue.length - 1;

  if (s.awaitingJudge) {
    return `<div class="self-judge">
      <button class="btn btn--ok btn--block" id="pJudgeOk">我答对了 ✓</button>
      <button class="btn btn--bad btn--block" id="pJudgeBad">我答错了 ×</button>
    </div>`;
  }

  const prevBtn = s.index > 0
    ? `<button class="btn btn--block" id="pPrev">‹ 上一题</button>`
    : "";

  let core: string;
  if (s.settled) {
    core = `<button class="btn btn--primary btn--block" id="pNext">${last ? "完成本次练习" : "下一题 →"}</button>`;
  } else if (q.type === "multiple") {
    core = `<button class="btn btn--primary btn--block" id="pConfirm" disabled>确认答案</button>`;
  } else if (isSelfJudged(q)) {
    core = `<button class="btn btn--primary btn--block" id="pConfirm">对照答案</button>`;
  } else {
    core = "";
  }

  if (!prevBtn) return core;
  return `<div class="self-judge">${prevBtn}${core}</div>`;
}

function repaintQuestion(root: HTMLElement, q: Question): void {
  const s = S!;
  const body = root.querySelector("#qBody");
  if (body) body.innerHTML = renderQuestionBody(q, s.userAnswer, s.settled, s.awaitingJudge);
  const fb = root.querySelector("#qFeedback");
  if (fb) fb.innerHTML = renderFeedbackCard(q, s.settled, s.awaitingJudge, s.result, s.userAnswer);
  const actions = root.querySelector("#qActions");
  if (actions) actions.innerHTML = renderActions(q);
  bind(root, q);
}

function submit(root: HTMLElement, q: Question): void {
  const s = S!;
  if (s.settled) return;

  const userAnswer = collectAnswer(root, q, s.userAnswer);
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
  s.sessionAnswers.set(q.id, { userAnswer: s.userAnswer, result: s.result! });
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

  /* 填空/简答：Enter / Ctrl+Enter */
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

  /* 动作按钮 */
  root.querySelector("#pConfirm")?.addEventListener("click", () => submit(root, q));
  root.querySelector("#pJudgeOk")?.addEventListener("click", () => judgeSelf(root, q, true));
  root.querySelector("#pJudgeBad")?.addEventListener("click", () => judgeSelf(root, q, false));

  /* 上一题 */
  root.querySelector<HTMLButtonElement>("#pPrev")?.addEventListener("click", () => {
    if (s.index <= 0) return;
    s.index--;
    const prevQ = s.queue[s.index];
    const recInSession = s.sessionAnswers.get(prevQ.id);
    if (recInSession) {
      s.settled = true;
      s.userAnswer = recInSession.userAnswer;
      s.result = recInSession.result;
    } else {
      const records = getStore().records ?? {};
      const rec = records[prevQ.id];
      s.settled = !!rec;
      s.userAnswer = rec?.lastUserAnswer ?? null;
      s.result = rec ? { correct: !!rec.lastCorrect } : null;
    }
    renderCard(root);
  });

  /* 下一题 */
  root.querySelector<HTMLButtonElement>("#pNext")?.addEventListener("click", (e) => {
    (e.currentTarget as HTMLButtonElement).disabled = true;
    s.index++;
    s.awaitingJudge = false;
    if (s.index >= s.queue.length) {
      s.done = true;
      renderSummary(root);
      return;
    }
    const nextQ = s.queue[s.index];
    const recInSession = s.sessionAnswers.get(nextQ.id);
    if (recInSession) {
      s.settled = true;
      s.userAnswer = recInSession.userAnswer;
      s.result = recInSession.result;
    } else {
      s.settled = false;
      s.userAnswer = null;
      s.result = null;
    }
    renderCard(root);
  });
}

function renderSummary(root: HTMLElement): void {
  const s = S!;
  s.done = true;
  const { answered, correct, wrongAdded, wrongCleared } = s.stats;
  const rate = answered ? Math.round((correct / answered) * 100) : 0;
  const batchSize = s.queue.length;
  const mode = s.params.mode ?? "";

  root.innerHTML = `
    <section class="card" style="text-align:center">
      <div class="summary__rate">${rate}<small>%</small></div>
      <div class="summary__label">本次全范围练习正确率</div>
      <p class="about" style="text-align:center;margin:8px 0 14px">
        共答 <b>${answered}</b> / ${batchSize} 题 · 答对 <b>${correct}</b> 题${
          wrongAdded ? ` · 新增错题 <b>${wrongAdded}</b> 题` : ""
        }${wrongCleared ? ` · 移出错题 <b>${wrongCleared}</b> 题` : ""}
      </p>
      <p class="about" style="text-align:center">本组共 ${batchSize} 题</p>
    </section>

    <div class="actions" style="flex-direction:column">
      ${mode === "fav" ? "" : `<button class="btn btn--primary btn--block" id="pShuffle">再来一组全范围练习</button>`}
      <button class="btn btn--block" id="pStats">查看做题统计</button>
      <button class="btn btn--block" id="pHome">返回首页</button>
    </div>
  `;

  root.querySelector("#pShuffle")?.addEventListener("click", () => {
    S = createSession(S!.params);
    renderCard(root);
  });

  root.querySelector("#pStats")?.addEventListener("click", () => navigate("stats"));
  root.querySelector("#pHome")?.addEventListener("click", () => navigate("home"));
}

export function debugSession(): { ids: string[]; index: number; current: string | null } {
  if (!S) return { ids: [], index: 0, current: null };
  return { ids: S.queue.map((q) => q.id), index: S.index, current: S.queue[S.index]?.id ?? null };
}

export const generalPracticeView: View = {
  async render(root, rawParams) {
    const params = rawParams ?? {};
    const seq = ++renderSeq;
    const mode = params.mode ?? "";

    if (!mode) {
      const banks = params.banks ? params.banks.split(",").filter(Boolean) : getSelectedBanks();
      setLastScope({ banks, domain: params.domain, type: params.type, from: undefined });
    }

    const draft = !mode ? readDraft("general") : null;

    if (draft && draft.ids.length && params.fresh !== "1") {
      const qIdx = draft.settled ? draft.index + 1 : draft.index;
      const targetHumanIdx = Math.min(qIdx + 1, draft.ids.length);
      const isSettledDesc = draft.settled
        ? `上次已作答完第 ${draft.index + 1} 题，将从第 ${targetHumanIdx} 题继续作答。`
        : `上次在第 ${targetHumanIdx} 题尚未作答，将恢复到该题。`;

      const resume = await confirmDialog({
        title: "继续全范围练习？",
        message: `检测到上次未完成的题库全范围练习（共 ${draft.ids.length} 题）。${isSettledDesc}`,
        confirmText: `从第 ${targetHumanIdx} 题继续`,
        cancelText: "重新开始",
      });

      if (seq !== renderSeq) return;

      if (resume) {
        S = resumeSession(draft);
        renderCard(root);
        return;
      }
      clearDraft("general");
    }

    S = createSession(params);
    renderCard(root);
  },
  unmount() {
    renderSeq++;
    if (S && !S.params.mode) {
      saveDraft("general", S.params, S.queue, S.index, S.settled, { done: S.done, title: S.title });
    }
    closeActiveDialog();
    S = null;
  },
};

export default generalPracticeView;
