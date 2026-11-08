/**
 * 题型专项练习视图层：题干/反馈/动作按钮渲染与事件绑定。
 * 仅负责 DOM，会话状态与生命周期由 type-practice.ts 持有。
 */

import { esc } from "../../utils";
import { typeTag, domainTag, bankTag, emptyState } from "../../ui";
import type { Question } from "../../types";
import { typeLabels } from "../../state";
import { isFavorite, toggleFavorite } from "../../storage";
import { renderQuestionBody, renderFeedbackCard } from "./quiz-card";
import type { TypeSession } from "./type-practice";

export interface TypePracticeHandlers {
  onSubmit: (root: HTMLElement, q: Question) => void;
  onJudge: (root: HTMLElement, q: Question, saysCorrect: boolean) => void;
  onPrev: () => void;
  onNext: () => void;
  onExit: (root: HTMLElement) => void;
  onAgain: () => void;
  onBackToTypes: () => void;
  onHome: () => void;
}

/** 渲染空态（非法题型、题库加载失败、无题目） */
export function renderTypeEmpty(root: HTMLElement, title: string, desc: string, onBack: () => void): void {
  root.innerHTML = emptyState({
    icon: "🎯",
    title,
    desc,
    action: `<button class="btn btn--primary" id="pExit">返回题库</button>`,
  });
  root.querySelector("#pExit")?.addEventListener("click", onBack);
}

/** 渲染当前题目整页 */
export function renderTypeQuestion(root: HTMLElement, s: TypeSession, h: TypePracticeHandlers): void {
  const q = s.queue[s.index];
  if (!q) return;
  const pctDone = Math.round((s.index / s.queue.length) * 100);
  const starred = isFavorite(q.id);

  root.innerHTML = `
    <div class="practice-head">
      <span class="practice-head__idx"><b>${s.index + 1}</b> / ${s.queue.length}</span>
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

    <div class="actions" id="qActions">${renderTypeActions(s, q)}</div>
  `;

  bindTypeQuestion(root, s, q, h);
}

/** 动作区 HTML（自判 / 上下一题 / 确认） */
export function renderTypeActions(s: TypeSession, q: Question): string {
  const last = s.index === s.queue.length - 1;

  if (s.awaitingJudge) {
    return `<div class="self-judge">
      <button class="btn btn--ok btn--block" id="pJudgeOk">我答对了 ✓</button>
      <button class="btn btn--bad btn--block" id="pJudgeBad">我答错了 ×</button>
    </div>`;
  }

  const prevBtn = s.index > 0 ? `<button class="btn btn--block" id="pPrev">‹ 上一题</button>` : "";

  let core: string;
  if (s.settled) {
    core = `<button class="btn btn--primary btn--block" id="pNext">${last ? "完成本次练习" : "下一题 →"}</button>`;
  } else if (q.type === "multiple") {
    core = `<button class="btn btn--primary btn--block" id="pConfirm" disabled>确认答案</button>`;
  } else if (q.type === "fill" || q.type === "short") {
    core = `<button class="btn btn--primary btn--block" id="pConfirm">对照答案</button>`;
  } else {
    core = "";
  }

  if (!prevBtn) return core;
  return `<div class="self-judge">${prevBtn}${core}</div>`;
}

/** 局部重绘题目/反馈/动作区，不重建头部与进度条 */
export function repaintTypeQuestion(root: HTMLElement, s: TypeSession, q: Question, h: TypePracticeHandlers): void {
  const body = root.querySelector("#qBody");
  if (body) body.innerHTML = renderQuestionBody(q, s.userAnswer, s.settled, s.awaitingJudge);
  const fb = root.querySelector("#qFeedback");
  if (fb) fb.innerHTML = renderFeedbackCard(q, s.settled, s.awaitingJudge, s.result, s.userAnswer);
  const actions = root.querySelector("#qActions");
  if (actions) actions.innerHTML = renderTypeActions(s, q);
  bindContent(root, s, q, h);
}

/** 绑定当前题目的全部交互（整页渲染后调用） */
export function bindTypeQuestion(root: HTMLElement, s: TypeSession, q: Question, h: TypePracticeHandlers): void {
  bindHeader(root, q, h);
  bindContent(root, s, q, h);
}

function bindHeader(root: HTMLElement, q: Question, h: TypePracticeHandlers): void {
  root.querySelector("#pExit")?.addEventListener("click", () => h.onExit(root));
  root.querySelector("#pStar")?.addEventListener("click", () => {
    const btn = root.querySelector<HTMLElement>("#pStar");
    if (!btn) return;
    const on = toggleFavorite(q.id);
    btn.classList.toggle("is-on", on);
    btn.title = on ? "取消收藏" : "收藏本题";
  });
}

/** 绑定题面与动作区（局部重绘后只重绑这部分，避免头部监听器叠加） */
function bindContent(root: HTMLElement, s: TypeSession, q: Question, h: TypePracticeHandlers): void {
  bindOptions(root, s, q, h);
  bindKeyboard(root, s, q, h);

  root.querySelector("#pConfirm")?.addEventListener("click", () => h.onSubmit(root, q));
  root.querySelector("#pJudgeOk")?.addEventListener("click", () => h.onJudge(root, q, true));
  root.querySelector("#pJudgeBad")?.addEventListener("click", () => h.onJudge(root, q, false));
  root.querySelector("#pPrev")?.addEventListener("click", () => h.onPrev());
  root.querySelector("#pNext")?.addEventListener("click", (e) => {
    (e.currentTarget as HTMLButtonElement).disabled = true;
    h.onNext();
  });
}

/** 选项 / 判断题交互 */
function bindOptions(root: HTMLElement, s: TypeSession, q: Question, h: TypePracticeHandlers): void {
  const optsBox = root.querySelector<HTMLElement>(".opts");
  if (!optsBox) return;
  const multi = optsBox.dataset.multi === "true";

  optsBox.querySelectorAll<HTMLButtonElement>(".opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (s.settled) return;
      const letter = btn.dataset.letter!;
      if (!multi) {
        s.userAnswer = letter;
        h.onSubmit(root, q);
        return;
      }
      const set = new Set<string>((s.userAnswer as string[]) ?? []);
      if (set.has(letter)) set.delete(letter); else set.add(letter);
      s.userAnswer = [...set].sort();
      optsBox.querySelectorAll<HTMLButtonElement>(".opt").forEach((b) => {
        b.classList.toggle("is-sel", set.has(b.dataset.letter!));
      });
      const confirm = root.querySelector<HTMLButtonElement>("#pConfirm");
      if (confirm) confirm.disabled = set.size === 0;
      const hint = root.querySelector("#multiHint");
      if (hint) hint.textContent = set.size ? `已选 ${(s.userAnswer as string[]).join("")}` : "可多选，选好后点「确认答案」";
    });
  });
}

/** 填空 / 简答键盘快捷提交 */
function bindKeyboard(root: HTMLElement, s: TypeSession, q: Question, h: TypePracticeHandlers): void {
  if (s.settled) return;
  root.querySelectorAll<HTMLInputElement>(".blank-input").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const inputs = Array.from(root.querySelectorAll<HTMLInputElement>(".blank-input"));
      const idx = inputs.indexOf(input);
      if (idx >= 0 && idx < inputs.length - 1) inputs[idx + 1].focus();
      else h.onSubmit(root, q);
    });
  });
  root.querySelector<HTMLTextAreaElement>("#shortInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      h.onSubmit(root, q);
    }
  });
}

/** 结算页：本次正确率 + 三个后续动作 */
export function renderTypeSummary(root: HTMLElement, s: TypeSession, h: TypePracticeHandlers): void {
  const { answered, correct, wrongAdded } = s.stats;
  const rate = answered ? Math.round((correct / answered) * 100) : 0;
  const label = typeLabels()[s.type] ?? s.type;

  root.innerHTML = `
    <section class="card" style="text-align:center">
      <div class="summary__rate">${rate}<small>%</small></div>
      <div class="summary__label">本次${esc(label)}练习正确率</div>
      <p class="about" style="text-align:center;margin:8px 0 14px">
        共答 <b>${answered}</b> / ${s.queue.length} 题 · 答对 <b>${correct}</b> 题${
          wrongAdded ? ` · 新增错题 <b>${wrongAdded}</b> 题` : ""
        }
      </p>
      <p class="about" style="text-align:center">本组共 ${s.queue.length} 题</p>
    </section>

    <div class="actions" style="flex-direction:column">
      <button class="btn btn--primary btn--block" id="pAgain">同题型再练一组</button>
      <button class="btn btn--block" id="pBackTypes">返回题型专项</button>
      <button class="btn btn--block" id="pHome">返回首页</button>
    </div>
  `;

  root.querySelector("#pAgain")?.addEventListener("click", () => h.onAgain());
  root.querySelector("#pBackTypes")?.addEventListener("click", () => h.onBackToTypes());
  root.querySelector("#pHome")?.addEventListener("click", () => h.onHome());
}
