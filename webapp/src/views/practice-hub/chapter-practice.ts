/**
 * 章节练习专属视图（chapter-practice.ts）
 * 对应路由：#/chapter-practice
 * 特性：
 *   - 章节做题：按目录顺序做题、断点记忆、一键跳转下一章、已完成章节全量解析浏览；
 *   - 独立草稿隔离（kind: "chapter"），弹窗明确标识「章节练习【某章节】」；
 *   - 实时作答隔离（sessionAnswers），确保未答题不提前展示答案。
 */

import {
  getLoadedQuestions, getQuestion, getSelectedBanks, getBank,
  questionDomainLabel,
} from "../../state";
import { getStore, recordAnswer, toggleFavorite, isFavorite } from "../../storage";
import { grade, isSelfJudged, type GradeResult } from "../../scoring";
import { chapterOrderSort, chapterResumeSort } from "../../goal";
import { setLastScope } from "../../local-prefs";
import { esc } from "../../utils";
import { navigate } from "../../router";
import { domainTag, typeTag, bankTag, emptyState, confirmDialog, closeActiveDialog } from "../../ui";
import type { Question, View } from "../../types";
import { renderQuestionBody, renderFeedbackCard, collectAnswer } from "./quiz-card";
import { saveDraft, readDraft, clearDraft, type PracticeDraft } from "./draft";

interface ChapterSession {
  queue: Question[];
  title: string;
  domainName: string;
  params: Record<string, string>;
  index: number;
  settled: boolean;
  awaitingJudge: boolean;
  result: GradeResult | null;
  userAnswer: unknown;
  stats: { answered: number; correct: number; wrongAdded: number; wrongCleared: number };
  emptyHint?: string;
  done?: boolean;
  isReviewMode?: boolean;
  sessionAnswers: Map<string, { userAnswer: unknown; result: GradeResult }>;
}

let S: ChapterSession | null = null;
let renderSeq = 0;

function resumeSession(d: PracticeDraft): ChapterSession {
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
  const all = getLoadedQuestions();
  if (!banksParam) return all;
  const ids = banksParam.split(",").filter(Boolean);
  if (!ids.length) return all;
  const pool = all.filter((q) => ids.includes(q.id.split("-")[0]));
  return pool.length ? pool : all;
}

function createSession(params: Record<string, string>): ChapterSession {
  let pool = poolByBanks(params.banks);
  if (params.domain) {
    pool = pool.filter((q) => q.domain === params.domain);
  }

  const sample = pool.find((q) => q.domain === params.domain);
  const domainName = sample ? questionDomainLabel(sample) : (params.domain ?? "未知章节");
  const title = `${domainName} · 章节做题`;

  const sorted = params.review === "1"
    ? chapterOrderSort(pool)
    : chapterResumeSort(pool, getStore().records ?? {});

  let emptyHint: string | undefined;
  if (!pool.length) emptyHint = "该章节暂无题目。";

  return {
    queue: sorted,
    title,
    domainName,
    params,
    index: 0,
    settled: false,
    awaitingJudge: false,
    result: null,
    userAnswer: null,
    stats: { answered: 0, correct: 0, wrongAdded: 0, wrongCleared: 0 },
    emptyHint,
    isReviewMode: params.review === "1",
    sessionAnswers: new Map(),
  };
}

function renderCard(root: HTMLElement): void {
  const s = S;
  if (!s) return;
  const { queue, index } = s;

  if (!queue.length) {
    root.innerHTML = emptyState({
      icon: "📚",
      title: s.emptyHint ?? "该章节暂无题目",
      desc: "请返回题库重新挑选其他章节练习。",
      action: `<button class="btn btn--primary" id="pGoBanks">返回题库</button>`,
    });
    root.querySelector("#pGoBanks")?.addEventListener("click", () => navigate("banks"));
    return;
  }

  if (index >= queue.length) { renderSummary(root); return; }

  const q = queue[index];
  const storeRecords = getStore().records ?? {};
  const chapterDone = queue.filter((item) => !!storeRecords[item.id]?.attempts).length;
  const pctDone = Math.round((chapterDone / queue.length) * 100);
  const starred = isFavorite(q.id);

  root.innerHTML = `
    <div class="practice-head">
      <span class="practice-head__idx">已完成 <b>${chapterDone}</b> / ${queue.length}</span>
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

  const prevBtn = s.index > 0
    ? `<button class="btn btn--block" id="pPrev">‹ 上一题</button>`
    : "";

  let core: string;
  if (s.settled) {
    core = `<button class="btn btn--primary btn--block" id="pNext">${last ? "完成本章练习" : "下一题 →"}</button>`;
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
  root.querySelector("#pExit")?.addEventListener("click", () => navigate("banks"));

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
    if (s.isReviewMode) {
      const records = getStore().records ?? {};
      const rec = records[prevQ.id];
      s.settled = true;
      s.userAnswer = rec?.lastUserAnswer;
      s.result = { correct: !!rec?.lastCorrect };
    } else {
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
    }
    renderCard(root);
  });

  /* 下一题 */
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
        renderCard(root);
      }
      return;
    }
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

  let nextDomain: string | null = null;
  let nextDomainLabel = "";
  let bankId: string | null = null;
  if (s.params.domain) {
    bankId = s.params.banks || (s.queue[0]?.id.split("-")[0] ?? getSelectedBanks()[0] ?? null);
    const b = bankId ? getBank(bankId) : null;
    if (b && Array.isArray(b.domains)) {
      const idx = b.domains.indexOf(s.params.domain);
      if (idx >= 0 && idx < b.domains.length - 1) {
        nextDomain = b.domains[idx + 1];
        const sample = getLoadedQuestions().find((q) => q.domain === nextDomain);
        nextDomainLabel = sample ? questionDomainLabel(sample) : nextDomain;
      }
    }
  }

  root.innerHTML = `
    <section class="card" style="text-align:center">
      <div class="summary__rate">${rate}<small>%</small></div>
      <div class="summary__label">本章练习完成</div>
      <p class="about" style="text-align:center;margin:8px 0 14px">
        本章共 <b>${batchSize}</b> 题 · 答对 <b>${correct}</b> 题${
          wrongAdded ? ` · 新增错题 <b>${wrongAdded}</b> 题` : ""
        }${wrongCleared ? ` · 移出错题 <b>${wrongCleared}</b> 题` : ""}
      </p>
    </section>

    <div class="actions" style="flex-direction:column">
      ${nextDomain ? `<button class="btn btn--primary btn--block" id="pNextChapter">继续下一章节：${esc(nextDomainLabel)} →</button>` : ""}
      <button class="btn ${nextDomain ? "btn--ghost" : "btn--primary"} btn--block" id="pReviewAnswers">查看本章全题解析</button>
      <button class="btn btn--ghost btn--block" id="pRedoChapter">重刷本章全部题目</button>
      <button class="btn btn--block" id="pBackBanks">返回题库目录</button>
      <button class="btn btn--block" id="pHome">返回首页</button>
    </div>
  `;

  root.querySelector("#pNextChapter")?.addEventListener("click", () => {
    navigate("chapter-practice", { domain: nextDomain!, banks: bankId! });
  });

  root.querySelector("#pReviewAnswers")?.addEventListener("click", () => {
    const s2 = createSession({ ...s.params, review: "1" });
    S = s2;
    s2.index = 0;
    const records = getStore().records ?? {};
    const firstQ = s2.queue[0];
    const rec = records[firstQ?.id ?? ""];
    s2.settled = true;
    s2.userAnswer = rec?.lastUserAnswer;
    s2.result = { correct: !!rec?.lastCorrect };
    s2.isReviewMode = true;
    renderCard(root);
  });

  root.querySelector("#pRedoChapter")?.addEventListener("click", () => {
    const s2 = createSession({ ...s.params, review: "0" });
    S = s2;
    s2.index = 0;
    s2.settled = false;
    s2.awaitingJudge = false;
    s2.result = null;
    s2.userAnswer = null;
    s2.stats = { answered: 0, correct: 0, wrongAdded: 0, wrongCleared: 0 };
    s2.isReviewMode = false;
    s2.done = false;
    renderCard(root);
  });

  root.querySelector("#pBackBanks")?.addEventListener("click", () => navigate("banks"));
  root.querySelector("#pHome")?.addEventListener("click", () => navigate("home"));
}

export const chapterPracticeView: View = {
  async render(root, rawParams) {
    const params = rawParams ?? {};
    const seq = ++renderSeq;

    const banks = params.banks ? params.banks.split(",").filter(Boolean) : getSelectedBanks();
    setLastScope({ banks, domain: params.domain, type: params.type, from: "chapter" });

    const draft = readDraft("chapter");
    // 仅当草稿与当前所选章节一致时才提示恢复当前章节草稿
    const isSameChapter = draft && draft.params.domain === params.domain;

    if (isSameChapter && draft.ids.length && params.fresh !== "1") {
      const qIdx = draft.settled ? draft.index + 1 : draft.index;
      const targetHumanIdx = Math.min(qIdx + 1, draft.ids.length);
      const isSettledDesc = draft.settled
        ? `上次已作答完第 ${draft.index + 1} 题，将从第 ${targetHumanIdx} 题继续作答。`
        : `上次在第 ${targetHumanIdx} 题尚未作答，将恢复到该题。`;

      const domainName = draft.domainLabel ?? params.domain ?? "本章节";
      const resume = await confirmDialog({
        title: "继续章节练习？",
        message: `检测到上次未完成的章节练习【${domainName}】（共 ${draft.ids.length} 题）。${isSettledDesc}`,
        confirmText: `从第 ${targetHumanIdx} 题继续`,
        cancelText: "重新开始",
      });

      if (seq !== renderSeq) return;

      if (resume) {
        S = resumeSession(draft);
        renderCard(root);
        return;
      }
      clearDraft("chapter");
    }

    const s = createSession(params);
    S = s;

    // 章节做完全做完检测与弹窗
    const records = getStore().records ?? {};
    const allDone = s.queue.length > 0 && s.queue.every((q) => !!records[q.id]);

    if (allDone) {
      s.isReviewMode = true;
      const firstQ = s.queue[0];
      const rec = records[firstQ.id];
      s.settled = true;
      s.userAnswer = rec?.lastUserAnswer;
      s.result = { correct: !!rec?.lastCorrect };
      renderCard(root);

      const redo = await confirmDialog({
        title: "本章已完成",
        message: `章节【${s.domainName}】共 ${s.queue.length} 道题已全部练习完成。\n是否选择重新作答本章题目？`,
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
        renderCard(root);
      }
      return;
    }

    renderCard(root);
  },
  unmount() {
    renderSeq++;
    if (S) {
      saveDraft("chapter", S.params, S.queue, S.index, S.settled, {
        done: S.done,
        title: S.title,
        domain: S.params.domain,
        domainLabel: S.domainName,
        isReviewMode: S.isReviewMode,
      });
    }
    closeActiveDialog();
    S = null;
  },
};

export default chapterPracticeView;
