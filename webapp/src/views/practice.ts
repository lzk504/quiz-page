/** 刷题页：顺序刷题 · 即时判定 · 解析展示 */

import { getQuestions, domainLabels, typeLabels } from "../state";
import { getStore, recordAnswer } from "../storage";
import { grade, displayAnswer, displayUserAnswer, type GradeResult } from "../scoring";
import { esc } from "../utils";
import { navigate } from "../router";
import { domainTag, typeTag, emptyState } from "../ui";
import type { Question, View } from "../types";

/* ---------------- 会话状态（刷新即重置） ---------------- */

interface Session {
  queue: Question[];
  title: string;
  params: Record<string, string>;
  index: number;
  settled: boolean;
  result: GradeResult | null;
  userAnswer: unknown;
  stats: { answered: number; correct: number; wrongAdded: number; wrongCleared: number };
}

let S: Session | null = null;

function createSession(params: Record<string, string>): Session {
  const all = getQuestions();
  let queue: Question[];
  let title: string;

  if (params.mode === "wrong") {
    const wrongIds = new Set(Object.keys(getStore().wrongbook));
    queue = all.filter((q) => wrongIds.has(q.id));
    title = "错题重刷";
  } else {
    const domains = params.domain ? String(params.domain).split(",").filter(Boolean) : [];
    const types = params.type ? String(params.type).split(",").filter(Boolean) : [];
    queue = all.filter((q) => {
      if (domains.length && !domains.includes(q.domain)) return false;
      if (types.length && !types.includes(q.type)) return false;
      return true;
    });
    const dNames = domains.map((d) => domainLabels()[d] ?? d);
    const tNames = types.map((t) => typeLabels()[t] ?? t);
    title = [...tNames, ...dNames].join(" · ") || "全部题目";
  }

  return {
    queue,
    title,
    params,
    index: 0,
    settled: false,
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
        : "试试放宽筛选条件，或者直接刷全部题目。",
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
      <div class="tags">${typeTag(q.type)}${domainTag(q.domain)}</div>
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

function renderActions(q: Question): string {
  const s = S!;
  if (s.settled) {
    const last = s.index === s.queue.length - 1;
    return `<button class="btn btn--primary btn--block" id="pNext">${last ? "完成本次练习" : "下一题 →"}</button>`;
  }
  if (q.type === "multiple") {
    return `<button class="btn btn--primary btn--block" id="pConfirm" disabled>确认答案</button>`;
  }
  return "";
}

function renderFeedback(q: Question): string {
  const s = S!;
  if (!s.settled || !s.result) return "";
  const ok = s.result.correct;
  return `<div class="feedback">
      <div class="verdict verdict--${ok ? "ok" : "bad"}">
        <span class="verdict__icon">${ok ? "✓" : "×"}</span>
        ${ok ? "回答正确" : "回答错误"}
        <small>你的答案：${esc(displayUserAnswer(q, s.userAnswer))}</small>
      </div>
      ${ok ? "" : `<div class="answer-line">正确答案：<b>${esc(displayAnswer(q))}</b></div>`}
      ${q.analysis ? `<div class="analysis"><span class="analysis__label">解析</span>${esc(q.analysis)}</div>` : ""}
    </div>`;
}

function renderSummary(root: HTMLElement): void {
  const s = S!;
  const { answered, correct, wrongAdded, wrongCleared } = s.stats;
  const rate = answered ? Math.round((correct / answered) * 100) : 0;

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
    </section>
    <div class="actions" style="flex-direction:column">
      <button class="btn btn--primary btn--block" id="pAgain">再刷一遍</button>
      <button class="btn btn--block" id="pStats">查看统计</button>
      <button class="btn btn--block" id="pHome">返回首页</button>
    </div>
  `;

  root.querySelector("#pAgain")?.addEventListener("click", () => {
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

function submit(root: HTMLElement, q: Question): void {
  const s = S!;
  if (s.settled) return;

  const userAnswer = s.userAnswer;
  if (q.type === "multiple" && !((userAnswer as string[]) ?? []).length) return;

  s.settled = true;
  s.result = grade(q, userAnswer);

  const r = recordAnswer(q, userAnswer, !!s.result?.correct);
  s.stats.answered++;
  if (s.result?.correct) s.stats.correct++;
  if (r.enteredWrongbook) s.stats.wrongAdded++;
  if (r.leftWrongbook) s.stats.wrongCleared++;

  repaintQuestion(root, q);
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

  /* 动作 */
  root.querySelector("#pConfirm")?.addEventListener("click", () => submit(root, q));

  root.querySelector<HTMLButtonElement>("#pNext")?.addEventListener("click", (e) => {
    (e.currentTarget as HTMLButtonElement).disabled = true;   // 防抖：避免连点导致越界
    s.index++;
    s.settled = false;
    s.result = null;
    s.userAnswer = null;
    paint(root);
  });
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
