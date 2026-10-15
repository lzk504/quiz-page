/**
 * 错题重做专属视图（wrong-practice.ts）
 * 特性：
 *   - 错题池全量乱序入队（支持单题重做 qid 或指定题型 type）；
 *   - 即时反馈：提交后即时判分；
 *   - 错题订正专属交互：答对时提供【移出错题本】按钮，主动确认才移出；
 *   - 隔离作答记录：未作答题绝不自显历史答案，支持上一题回看与前进；
 *   - 错题专属完成总结页：展示订正率、移出统计，支持再刷剩余错题或返回错题本。
 */

import { getLoadedQuestions, getQuestion } from "../../state";
import { getStore, recordAnswer, removeFromWrongbook, toggleFavorite, isFavorite } from "../../storage";
import { grade, isSelfJudged, type GradeResult } from "../../scoring";
import { shuffle } from "../../goal";
import { esc } from "../../utils";
import { navigate } from "../../router";
import { domainTag, typeTag, bankTag, emptyState, toast, confirmDialog, closeActiveDialog } from "../../ui";
import type { Question, View } from "../../types";
import { renderQuestionBody, renderFeedbackCard, collectAnswer } from "./quiz-card";
import { saveDraft, readDraft, clearDraft, sanitizeWrongDraft, type PracticeDraft } from "./draft";

interface WrongSession {
  queue: Question[];
  params: Record<string, string>;
  index: number;
  settled: boolean;
  awaitingJudge: boolean;
  result: GradeResult | null;
  userAnswer: unknown;
  stats: { answered: number; correct: number; wrongCleared: number };
  sessionAnswers: Map<string, { userAnswer: unknown; result: GradeResult }>;
  done?: boolean;
}

let W: WrongSession | null = null;

function buildWrongPool(params: Record<string, string>): Question[] {
  const wrongIds = new Set(Object.keys(getStore().wrongbook));
  let pool = getLoadedQuestions().filter((q) => wrongIds.has(q.id));
  if (params.qid) return pool.filter((q) => q.id === params.qid);
  if (params.type) pool = pool.filter((q) => q.type === params.type);
  if (params.banks) {
    const ids = params.banks.split(",").filter(Boolean);
    pool = pool.filter((q) => ids.includes(q.id.split("-")[0]));
  }
  if (params.domain) {
    const domains = params.domain.split(",").filter(Boolean);
    if (domains.length) pool = pool.filter((q) => domains.includes(q.domain));
  }
  return shuffle(pool);
}

function createWrongSession(params: Record<string, string>): WrongSession {
  const queue = buildWrongPool(params);
  return {
    queue,
    params,
    index: 0,
    settled: false,
    awaitingJudge: false,
    result: null,
    userAnswer: null,
    stats: { answered: 0, correct: 0, wrongCleared: 0 },
    sessionAnswers: new Map(),
    done: false,
  };
}

function renderFeedback(q: Question): string {
  const s = W!;
  if (!s.settled) return "";

  let extraHtml = "";
  if (s.result?.correct) {
    const inWrongbook = !!getStore().wrongbook[q.id];
    if (inWrongbook) {
      extraHtml = `<div class="feedback__wrong-act" style="margin-top:12px;padding-top:10px;border-top:1px dashed var(--c-border);display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:13px;color:var(--c-ok)">★ 订正成功！可移出错题本</span>
        <button class="btn btn--sm btn--ghost" id="pRemoveWrong" style="color:var(--c-bad);padding:2px 10px">移出错题本</button>
      </div>`;
    } else {
      extraHtml = `<div class="feedback__wrong-act" style="margin-top:12px;padding-top:10px;border-top:1px dashed var(--c-border);display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:13px;color:var(--c-muted)">✓ 已从错题本移出</span>
        <button class="btn btn--sm" disabled style="padding:2px 10px;opacity:0.6">已移出</button>
      </div>`;
    }
  }

  return renderFeedbackCard(q, s.settled, s.awaitingJudge, s.result, s.userAnswer, extraHtml);
}

function renderActions(q: Question): string {
  const s = W!;
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
    core = `<button class="btn btn--primary btn--block" id="pNext">${last ? "完成错题重做" : "下一题 →"}</button>`;
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

function renderCard(root: HTMLElement): void {
  const s = W;
  if (!s) return;

  if (!s.queue.length) {
    root.innerHTML = emptyState({
      icon: "🎉",
      title: "错题本是空的",
      desc: "暂无需要订正的错题，去题库或首页开始刷题吧！",
      action: `<button class="btn btn--primary" id="wGoHome">返回首页</button>`,
    });
    root.querySelector("#wGoHome")?.addEventListener("click", () => navigate("home"));
    return;
  }

  if (s.index >= s.queue.length) {
    renderWrongSummary(root);
    return;
  }

  const q = s.queue[s.index];
  const pctDone = Math.round((s.index / s.queue.length) * 100);
  const starred = isFavorite(q.id);

  root.innerHTML = `
    <div class="practice-head">
      <span class="practice-head__idx"><b>${s.index + 1}</b> / ${s.queue.length}</span>
      <span class="practice-head__title">错题重刷 · 全量</span>
      <button class="star-btn${starred ? " is-on" : ""}" id="pStar" title="${starred ? "取消收藏" : "收藏本题"}">★</button>
      <button class="btn btn--sm btn--ghost" id="pExit">退出</button>
    </div>
    <div class="mini-bar"><i style="width:${pctDone}%"></i></div>

    <section class="card">
      <div class="tags">${typeTag(q.type)}${domainTag(q.domain)}${bankTag(q)}</div>
      <div id="qBody">${renderQuestionBody(q, s.userAnswer, s.settled, s.awaitingJudge)}</div>
      <div id="qFeedback">${renderFeedback(q)}</div>
    </section>

    <div class="actions" id="qActions">${renderActions(q)}</div>
  `;

  bind(root, q);
}

function repaintQuestion(root: HTMLElement, q: Question): void {
  const s = W!;
  const body = root.querySelector("#qBody");
  if (body) body.innerHTML = renderQuestionBody(q, s.userAnswer, s.settled, s.awaitingJudge);
  const fb = root.querySelector("#qFeedback");
  if (fb) fb.innerHTML = renderFeedback(q);
  const actions = root.querySelector("#qActions");
  if (actions) actions.innerHTML = renderActions(q);
  bind(root, q);
}

function submit(root: HTMLElement, q: Question): void {
  const s = W!;
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
  const s = W!;
  if (!s.awaitingJudge) return;
  s.awaitingJudge = false;
  s.result = { correct: saysCorrect };
  finalize(q, saysCorrect);
  repaintQuestion(root, q);
}

function finalize(q: Question, isCorrect: boolean): void {
  const s = W!;
  s.sessionAnswers.set(q.id, { userAnswer: s.userAnswer, result: s.result! });
  recordAnswer(q, s.userAnswer, isCorrect);
  s.stats.answered++;
  if (isCorrect) s.stats.correct++;
}

function bind(root: HTMLElement, q: Question): void {
  const s = W!;

  root.querySelector("#pExit")?.addEventListener("click", () => navigate("wrongbook"));

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

  /* 移出错题本确认 */
  root.querySelector<HTMLButtonElement>("#pRemoveWrong")?.addEventListener("click", (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    if (removeFromWrongbook(q.id)) {
      s.stats.wrongCleared++;
      toast("已移出错题本", "ok");
      btn.disabled = true;
      btn.textContent = "已移出";
      btn.style.color = "var(--c-muted)";
      btn.style.opacity = "0.6";
      const infoSpan = btn.parentElement?.querySelector("span");
      if (infoSpan) {
        infoSpan.textContent = "✓ 已从错题本移出";
        infoSpan.style.color = "var(--c-muted)";
      }
    }
  });

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
      renderWrongSummary(root);
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

function renderWrongSummary(root: HTMLElement): void {
  const s = W!;
  s.done = true;
  const { answered, correct, wrongCleared } = s.stats;
  const rate = answered ? Math.round((correct / answered) * 100) : 0;
  const total = s.queue.length;
  const wrongIds = Object.keys(getStore().wrongbook);

  root.innerHTML = `
    <section class="card" style="text-align:center">
      <div class="summary__rate">${rate}<small>%</small></div>
      <div class="summary__label">本次错题订正正确率</div>
      <p class="about" style="text-align:center;margin:8px 0 14px">
        共订正 <b>${answered}</b> / ${total} 道题 · 答对 <b>${correct}</b> 题${
          wrongCleared ? ` · 手动移出 <b>${wrongCleared}</b> 题` : ""
        }
      </p>
      <div class="kpi-row">
        <div class="kpi"><b>${correct}</b><span>本次订正正确</span></div>
        <div class="kpi"><b>${wrongCleared}</b><span>已移出错题本</span></div>
        <div class="kpi"><b>${wrongIds.length}</b><span>剩余错题总数</span></div>
      </div>
    </section>

    <div class="actions" style="flex-direction:column">
      ${wrongIds.length ? `<button class="btn btn--primary btn--block" id="wRetryLeft">再刷一遍剩余错题（${wrongIds.length} 题）</button>` : ""}
      <button class="btn btn--block" id="wBackWrongbook">返回错题本</button>
      <button class="btn btn--block" id="wGoHome">返回首页</button>
    </div>
  `;

  root.querySelector("#wRetryLeft")?.addEventListener("click", () => {
    clearDraft("wrong");
    W = createWrongSession(W!.params);
    renderCard(root);
  });
  root.querySelector("#wBackWrongbook")?.addEventListener("click", () => {
    clearDraft("wrong");
    navigate("wrongbook");
  });
  root.querySelector("#wGoHome")?.addEventListener("click", () => {
    clearDraft("wrong");
    navigate("home");
  });
}

let renderSeq = 0;

function resumeWrongSession(d: PracticeDraft): WrongSession {
  const s = createWrongSession(d.params);
  const queue = d.ids.map((id) => getQuestion(id)).filter((q): q is Question => !!q);
  if (queue.length) {
    s.queue = queue;
    const nextIdx = d.settled ? d.index + 1 : d.index;
    s.index = Math.min(Math.max(0, nextIdx), queue.length - 1);
  }
  s.done = false;
  return s;
}

export const wrongPracticeView: View = {
  async render(root, params) {
    const p = params ?? {};
    const seq = ++renderSeq;

    const rawDraft = readDraft("wrong");
    if (rawDraft && rawDraft.ids.length && p.fresh !== "1") {
      const { valid, draft } = sanitizeWrongDraft(rawDraft, getStore().wrongbook);
      if (valid && draft.ids.length) {
        const qIdx = draft.settled ? draft.index + 1 : draft.index;
        const targetHumanIdx = Math.min(qIdx + 1, draft.ids.length);
        const isSettledDesc = draft.settled
          ? `上次已订正完第 ${draft.index + 1} 题，将从第 ${targetHumanIdx} 题继续作答。`
          : `上次在第 ${targetHumanIdx} 题尚未作答，将恢复到该题。`;

        const resume = await confirmDialog({
          title: "继续错题重做？",
          message: `检测到上次未完成的错题重做（共 ${draft.ids.length} 题）。${isSettledDesc}`,
          confirmText: `从第 ${targetHumanIdx} 题继续`,
          cancelText: "重新开始",
        });

        if (seq !== renderSeq) return;

        if (resume) {
          W = resumeWrongSession(draft);
          renderCard(root);
          return;
        }
        clearDraft("wrong");
      }
    }

    W = createWrongSession(p);
    renderCard(root);
  },
  unmount() {
    renderSeq++;
    if (W) {
      saveDraft("wrong", W.params, W.queue, W.index, W.settled, { done: W.done, title: "错题重刷" });
    }
    closeActiveDialog();
    W = null;
  },
};

export default wrongPracticeView;
