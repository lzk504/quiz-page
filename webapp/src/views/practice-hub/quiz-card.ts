/**
 * 题目卡片与交互通用渲染器
 * 提供单选/多选/判断/填空/简答的题干、选项、逐空、对照、判定反馈卡片渲染与输入提取
 */

import { esc } from "../../utils";
import { displayAnswer, displayUserAnswer, type GradeResult } from "../../scoring";
import type { Question } from "../../types";

export function letterOf(i: number): string {
  return String.fromCharCode(65 + i);
}

export function renderOptions(q: Question, userAnswer: unknown, settled: boolean): string {
  const multi = q.type === "multiple";
  const sel = multi ? new Set<string>((userAnswer as string[]) ?? []) : (userAnswer as string | null);

  const opts = (q.options ?? []).map((text, i) => {
    const L = letterOf(i);
    const picked = multi ? (sel as Set<string>).has(L) : sel === L;
    let cls = picked ? " is-sel" : "";

    if (settled) {
      const ans = Array.isArray(q.answer) ? q.answer : [q.answer];
      const isRight = ans.map((a) => String(a)).includes(L);
      if (isRight) cls = " is-ok";
      else if (picked) cls = " is-bad";
      else cls = "";
    }

    return `<button type="button" class="opt${cls}" data-letter="${L}" ${settled ? "disabled" : ""}>
      <span class="opt__key">${L}</span>
      <span class="opt__text">${esc(text)}</span>
    </button>`;
  }).join("");

  const hint = multi
    ? `<p class="opt-hint" id="multiHint">${
        settled ? "" : ((sel as Set<string>).size ? `已选 ${[...(sel as Set<string>)].sort().join("")}` : "可多选，选好后点「确认答案」")
      }</p>`
    : "";

  return `<p class="stem">${esc(q.stem)}</p>
    <div class="opts" data-multi="${multi}">${opts}</div>${hint}`;
}

export function renderJudge(q: Question, userAnswer: unknown, settled: boolean): string {
  const picked = userAnswer === true ? true : userAnswer === false ? false : null;
  const btn = (v: boolean, emoji: string, label: string): string => {
    let cls = "";
    if (settled) {
      if (v === q.answer) cls = " is-ok";
      else if (userAnswer === v) cls = " is-bad";
    } else if (picked === v) {
      cls = " is-sel";
    }
    return `<button type="button" class="opt judge__btn${cls}" data-judge="${v}" ${settled ? "disabled" : ""}>
      <span class="opt__key">${emoji}</span>
      <span class="opt__text">${label}</span></button>`;
  };
  return `<p class="stem">${esc(q.stem)}</p>
    <div class="judge">${btn(true, "√", "正确")}${btn(false, "×", "错误")}</div>`;
}

export function renderFill(q: Question, userAnswer: unknown, settled: boolean, awaitingJudge = false): string {
  const parts = String(q.stem).split(/_{4}/);
  const blanks = Math.max(0, parts.length - 1);
  const refs = Array.isArray(q.answer) ? (q.answer as string[]).map(String) : [];
  const ua = Array.isArray(userAnswer) ? (userAnswer as string[]) : [];
  const locked = settled;
  const judged = settled && !awaitingJudge;

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

export function renderShort(q: Question, userAnswer: unknown, settled: boolean): string {
  const ua = typeof userAnswer === "string" ? userAnswer : "";
  const head = `<p class="stem">${esc(q.stem)}</p>`;

  if (settled) {
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

export function renderQuestionBody(q: Question, userAnswer: unknown, settled: boolean, awaitingJudge = false): string {
  switch (q.type) {
    case "single":
    case "multiple": return renderOptions(q, userAnswer, settled);
    case "judge":    return renderJudge(q, userAnswer, settled);
    case "fill":     return renderFill(q, userAnswer, settled, awaitingJudge);
    case "short":    return renderShort(q, userAnswer, settled);
    default:         return `<p class="stem">${esc(q.stem)}</p>`;
  }
}

export function renderFeedbackCard(
  q: Question,
  settled: boolean,
  awaitingJudge: boolean,
  result: GradeResult | null,
  userAnswer: unknown,
  extraActionHtml = "",
): string {
  if (!settled) return "";

  if (awaitingJudge) {
    return `<div class="feedback">
        <div class="answer-line">参考答案：<b class="answer-line__block">${esc(displayAnswer(q))}</b></div>
        ${q.analysis ? `<div class="analysis"><span class="analysis__label">解析</span>${esc(q.analysis)}</div>` : ""}
      </div>`;
  }

  if (!result) return "";
  const ok = result.correct;
  return `<div class="feedback">
      <div class="verdict verdict--${ok ? "ok" : "bad"}">
        <span class="verdict__icon">${ok ? "✓" : "×"}</span>
        ${ok ? "回答正确" : "回答错误"}
        <small>你的答案：${esc(displayUserAnswer(q, userAnswer) || "（未作答）")}</small>
      </div>
      ${ok ? "" : `<div class="answer-line">正确答案：<b class="answer-line__block">${esc(displayAnswer(q))}</b></div>`}
      ${q.analysis ? `<div class="analysis"><span class="analysis__label">解析</span>${esc(q.analysis)}</div>` : ""}
      ${extraActionHtml}
    </div>`;
}

export function collectAnswer(root: HTMLElement, q: Question, fallbackUserAnswer: unknown): unknown {
  if (q.type === "fill") {
    const inputs = root.querySelectorAll<HTMLInputElement>(".blank-input");
    return Array.from(inputs).map((i) => i.value.trim());
  }
  if (q.type === "short") {
    const ta = root.querySelector<HTMLTextAreaElement>("#shortInput");
    return (ta?.value ?? "").trim();
  }
  return fallbackUserAnswer;
}
