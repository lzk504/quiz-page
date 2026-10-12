/** 刷题页：随机抽题 · 即时判定（填空/简答为用户自判） · 解析展示 */

import { getQuestions, getSelectedBanks, questionDomainLabel, typeLabels } from "../state";
import { getStore, recordAnswer } from "../storage";
import { grade, displayAnswer, displayUserAnswer, isSelfJudged, type GradeResult } from "../scoring";
import { esc } from "../utils";
import { navigate } from "../router";
import { domainTag, typeTag, bankTag, emptyState } from "../ui";
import type { Question, View } from "../types";

/** 单次练习的抽题上限（错题重刷不受限） */
export const MAX_PER_SESSION = 100;

/* ---------------- 会话状态（刷新即重置） ---------------- */

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
}

let S: Session | null = null;

/** Fisher–Yates 洗牌（返回新数组，不改原数组） */
export function shuffle<T>(input: T[]): T[] {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 可抽题池（按 params 过滤，未经随机与截断） */
function buildPool(params: Record<string, string>): Question[] {
  const all = getQuestions();
  if (params.mode === "wrong") {
    const wrongIds = new Set(Object.keys(getStore().wrongbook));
    return all.filter((q) => wrongIds.has(q.id));
  }
  const domains = params.domain ? String(params.domain).split(",").filter(Boolean) : [];
  const types = params.type ? String(params.type).split(",").filter(Boolean) : [];
  return all.filter((q) => {
    if (domains.length && !domains.includes(q.domain)) return false;
    if (types.length && !types.includes(q.type)) return false;
    return true;
  });
}

function createSession(params: Record<string, string>): Session {
  const pool = buildPool(params);
  let title: string;

  if (params.mode === "wrong") {
    title = "错题重刷";
  } else {
    const domains = params.domain ? String(params.domain).split(",").filter(Boolean) : [];
    const types = params.type ? String(params.type).split(",").filter(Boolean) : [];
    const dNames = domains.map((d) => {
      const sample = pool.find((q) => q.domain === d);
      return sample ? questionDomainLabel(sample) : d;
    });
    const tNames = types.map((t) => typeLabels()[t] ?? t);
    title = [...tNames, ...dNames].join(" · ") || "全部题目";
    if (getSelectedBanks().length > 1) title = `合并刷题 · ${title}`;
  }

  // 每次开始都重新随机打乱；普通练习截断到 100 题，错题重刷全部入队
  const shuffled = shuffle(pool);
  const queue = params.mode === "wrong" ? shuffled : shuffled.slice(0, MAX_PER_SESSION);

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
  };
}

/* ---------------- 渲染 ---------------- */

const letterOf = (i: number): string => "ABCDE"[i];

function paint(root: HTMLElement): void {
  const s = S!;
  const { queue, index } = s;

  if (!queue.length) {
    root.innerHTML = emptyState({
      icon: "🎉",
      title: s.params.mode === "wrong" ? "错题本是空的" : "没有符合条件的题目",
      desc: s.params.mode === "wrong"
        ? "答错的题会自动出现在这里，先把题刷起来吧。"
        : "试试放宽筛选条件，或者切换题库。",
      action: `<button class="btn btn--primary" id="pExit">返回首页</button>`,
    });
    root.querySelector("#pExit")?.addEventListener("click", () => navigate("home"));
    return;
  }

  if (index >= queue.length) { renderSummary(root); return; }

  const q = queue[index];
  const pctDone = Math.round((s.stats.answered / queue.length) * 100);

  root.innerHTML = `
    <div class="practice-head">
      <span class="practice-head__idx"><b>${index + 1}</b> / ${queue.length}</span>
      <span class="practice-head__title">${esc(s.title)}</span>
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
  const btn = (v: boolean, emoji: string, label: string): string => {
    let cls = "";
    if (s.settled) {
      if (v === q.answer) cls = " is-ok";
      else if (s.userAnswer === v) cls = " is-bad";
    }
    return `<button type="button" class="judge__btn${cls}" data-judge="${v}" ${s.settled ? "disabled" : ""}>
      <em>${emoji}</em>${label}</button>`;
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

  // 自判题：已提交但未判定 → 显示自判按钮
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

  // 自判题：先给参考答案与解析，等用户判定
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
  const { answered, correct, wrongAdded, wrongCleared } = s.stats;
  const rate = answered ? Math.round((correct / answered) * 100) : 0;
  const batchSize = s.queue.length;

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
      ${s.params.mode === "wrong" ? "" : `<p class="about" style="text-align:center">本批共 ${batchSize} 题（单次上限 ${MAX_PER_SESSION} 题）</p>`}
    </section>
    <div class="actions" style="flex-direction:column">
      <button class="btn btn--primary btn--block" id="pAgain">再刷一遍</button>
      ${s.params.mode === "wrong" ? "" : `<button class="btn btn--block" id="pShuffle">换一批</button>`}
      <button class="btn btn--block" id="pStats">查看统计</button>
      <button class="btn btn--block" id="pHome">返回首页</button>
    </div>
  `;

  // 再刷一遍：同一批题、重新打乱顺序
  root.querySelector("#pAgain")?.addEventListener("click", () => {
    const s2 = S!;
    s2.queue = shuffle(s2.queue);
    s2.index = 0;
    s2.settled = false;
    s2.awaitingJudge = false;
    s2.result = null;
    s2.userAnswer = null;
    s2.stats = { answered: 0, correct: 0, wrongAdded: 0, wrongCleared: 0 };
    paint(root);
  });

  // 换一批：重新过滤题池 + 重新随机抽题
  root.querySelector("#pShuffle")?.addEventListener("click", () => {
    S = createSession(S!.params);
    paint(root);
  });

  root.querySelector("#pStats")?.addEventListener("click", () => navigate("stats"));
  root.querySelector("#pHome")?.addEventListener("click", () => navigate("home"));
}

/* ---------------- 交互 ---------------- */

function repaintQuestion(root: HTMLElement, q: Question): void {
  const body = root.querySelector("#qBody");
  if (body) body.innerHTML = renderBody(q);
  const fb = root.querySelector("#qFeedback");
  if (fb) fb.innerHTML = renderFeedback(q);
  const actions = root.querySelector("#qActions");
  if (actions) actions.innerHTML = renderActions(q);
  bind(root, q);
}

/** 从 DOM 收集当前作答（填空/简答需要读输入框） */
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

/** 提交（客观题判分；自判题展示参考答案等待用户判定） */
function submit(root: HTMLElement, q: Question): void {
  const s = S!;
  if (s.settled) return;

  const userAnswer = collectAnswer(root, q);
  if (q.type === "multiple" && !((userAnswer as string[]) ?? []).length) return;
  s.userAnswer = userAnswer;

  if (isSelfJudged(q)) {
    // 自判：先对照答案，不写记录
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

/** 自判：用户点击「我答对了 / 我答错了」后落库 */
function judgeSelf(root: HTMLElement, q: Question, saysCorrect: boolean): void {
  const s = S!;
  if (!s.awaitingJudge) return;
  s.awaitingJudge = false;
  s.result = { correct: saysCorrect };
  finalize(q, saysCorrect);
  repaintQuestion(root, q);
}

/** 写入存储并累计本次统计 */
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

  /* 填空/简答：Ctrl+Enter 快捷提交 */
  const textInput = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(".blank-input, .short-input");
  if (textInput && !s.settled) {
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

  root.querySelector<HTMLButtonElement>("#pNext")?.addEventListener("click", (e) => {
    (e.currentTarget as HTMLButtonElement).disabled = true;   // 防抖：避免连点导致越界
    s.index++;
    s.settled = false;
    s.awaitingJudge = false;
    s.result = null;
    s.userAnswer = null;
    paint(root);
  });
}

/* ---------------- 调试钩子 ---------------- */

/**
 * 只读快照：当前会话的题序与当前题目 id。
 * 供 e2e 验证「再刷一遍 = 同一批 / 换一批 = 重新抽题」这类不可见的会话契约。
 */
export function debugSession(): { ids: string[]; index: number; current: string | null } {
  if (!S) return { ids: [], index: 0, current: null };
  return { ids: S.queue.map((q) => q.id), index: S.index, current: S.queue[S.index]?.id ?? null };
}

/* ---------------- 视图导出 ---------------- */

const view: View = {
  async render(root, params) {
    S = createSession(params ?? {});
    paint(root);
  },
  unmount() {
    S = null;
  },
};

export default view;
