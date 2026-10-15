/**
 * 全真模拟考试视图（exam.ts）
 * 特性：
 *   - 60 分钟倒计时、时间到自动交卷；
 *   - 答题过程零即时反馈，可自由跳题修改作答；
 *   - 退出与交卷二次弹窗确认，未答题不计分、不落库、不进错题本；
 *   - 交卷后客观题批量判分，主观题（填空/简答）进入集中统一自评；
 *   - 出分报告：分题型得分统计、逐题答卷清单、再考一次与错题查看。
 */

import { getQuestions, getLoadedQuestions, typeLabels } from "../../state";
import { recordAnswer } from "../../storage";
import { grade, displayAnswer, displayUserAnswer, isSelfJudged } from "../../scoring";
import { examPick, examBlueprint, examTypeScores, EXAM_MINUTES, type ExamResultRow } from "../../goal";
import { esc } from "../../utils";
import { navigate } from "../../router";
import { domainTag, typeTag, bankTag, emptyState, toast, confirmDialog, closeActiveDialog } from "../../ui";
import type { Question, View } from "../../types";
import { letterOf } from "./quiz-card";

interface ExamSession {
  queue: Question[];
  params: Record<string, string>;
  index: number;
  phase: "answer" | "judging" | "result";
  endsAt: number;
  startedAt: number;
  answers: Map<string, unknown>;
  rows: ExamResultRow[];
  judgeIndex: number;
}

let E: ExamSession | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const isBlank = (q: Question, ua: unknown): boolean => {
  if (q.type === "multiple") return !(Array.isArray(ua) && ua.length);
  if (q.type === "fill") return !(Array.isArray(ua) && ua.some((v) => String(v ?? "").trim()));
  if (q.type === "short") return !String(ua ?? "").trim();
  return ua === undefined || ua === null || ua === "";
};

function poolByBanks(banksParam?: string): Question[] {
  if (!banksParam) return getQuestions();
  const ids = banksParam.split(",").filter(Boolean);
  if (!ids.length) return getQuestions();
  const pool = getLoadedQuestions().filter((q) => ids.includes(q.id.split("-")[0]));
  return pool.length ? pool : getQuestions();
}

function createExamSession(params: Record<string, string>): ExamSession {
  const pool = poolByBanks(params.banks);
  const queue = examPick(pool, examBlueprint());
  return {
    queue,
    params,
    index: 0,
    phase: "answer",
    endsAt: Date.now() + EXAM_MINUTES * 60 * 1000,
    startedAt: Date.now(),
    answers: new Map<string, unknown>(),
    rows: [],
    judgeIndex: 0,
  };
}

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
    const s = E;
    if (!s || s.phase !== "answer") { stopTimer(); return; }
    const left = s.endsAt - Date.now();
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

function examAnsweredCount(): number {
  const s = E;
  if (!s) return 0;
  let n = 0;
  for (const q of s.queue) {
    const ua = s.answers.get(q.id);
    if (!isBlank(q, ua)) n++;
  }
  return n;
}

function examBody(q: Question): string {
  const s = E!;
  const ua = s.answers.get(q.id);

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

function collectExamAnswer(root: HTMLElement): void {
  const s = E;
  if (!s) return;
  const q = s.queue[s.index];
  if (!q) return;
  if (q.type === "fill") {
    const inputs = root.querySelectorAll<HTMLInputElement>(".blank-input");
    s.answers.set(q.id, Array.from(inputs).map((i) => i.value.trim()));
  } else if (q.type === "short") {
    const ta = root.querySelector<HTMLTextAreaElement>("#shortInput");
    s.answers.set(q.id, (ta?.value ?? "").trim());
  }
}

function renderExam(root: HTMLElement): void {
  const s = E;
  if (!s) return;

  if (!s.queue.length) {
    root.innerHTML = emptyState({
      icon: "📝", title: "没有可抽的题目",
      desc: "当前刷题范围内题目不足，去题库 tab 调整范围后再试。",
      action: `<button class="btn btn--primary" id="examGoBanks">去题库</button>`,
    });
    root.querySelector("#examGoBanks")?.addEventListener("click", () => navigate("banks"));
    return;
  }

  if (s.phase === "judging") { renderExamJudge(root); return; }
  if (s.phase === "result") { renderExamResult(root); return; }

  const q = s.queue[s.index];
  const answered = examAnsweredCount();
  const progress = Math.round((answered / s.queue.length) * 100);

  root.innerHTML = `
    <div class="exam-head">
      <span class="exam-progress"><b>${s.index + 1}</b> / ${s.queue.length}　已答 ${answered}</span>
      <span class="exam-timer" id="examTimer">⏱ ${fmtClock(s.endsAt - Date.now())}</span>
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

function bindExamQuestion(root: HTMLElement, q: Question): void {
  const s = E;
  if (!s) return;

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
          const set = new Set<string>((s.answers.get(q.id) as string[]) ?? []);
          if (set.has(L)) set.delete(L); else set.add(L);
          s.answers.set(q.id, [...set].sort());
        } else {
          s.answers.set(q.id, L);
        }
        refresh();
      });
    });
  }

  root.querySelectorAll<HTMLButtonElement>(".judge__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      s.answers.set(q.id, btn.dataset.judge === "true");
      refresh();
    });
  });
}

function bindExamNav(root: HTMLElement): void {
  const s = E;
  if (!s) return;

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
    if (answered === 0) return;
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
    submitExam(root, false);
  });
}

function submitExam(root: HTMLElement, auto: boolean): void {
  const s = E;
  if (!s || s.phase !== "answer") return;

  collectExamAnswer(root);

  const rows: ExamResultRow[] = [];
  try {
    for (const q of s.queue) {
      const ua = s.answers.get(q.id);
      if (isBlank(q, ua)) {
        rows.push({ q, userAnswer: ua, correct: false, skipped: true });
        continue;
      }
      if (isSelfJudged(q)) {
        rows.push({ q, userAnswer: ua, correct: false });
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

  stopTimer();
  s.rows = rows;
  s.judgeIndex = 0;
  s.phase = "judging";

  if (auto) toast("考试时间已到，已自动交卷", "bad");

  const pending = s.rows.filter((r) => isSelfJudged(r.q) && !r.skipped);
  if (pending.length) renderExamJudge(root);
  else { s.phase = "result"; renderExamResult(root); }
}

function renderExamJudge(root: HTMLElement): void {
  const s = E;
  if (!s) return;
  const pending = s.rows.filter((r) => isSelfJudged(r.q) && !r.skipped);

  if (s.judgeIndex >= pending.length) {
    s.phase = "result";
    renderExamResult(root);
    return;
  }

  const row = pending[s.judgeIndex];
  const q = row.q;
  const mine = displayUserAnswer(q, row.userAnswer);

  root.innerHTML = `
    <div class="exam-head">
      <span class="exam-progress">自评 <b>${s.judgeIndex + 1}</b> / ${pending.length}</span>
      <span class="exam-timer">交卷后自评</span>
    </div>
    <div class="mini-bar"><i style="width:${Math.round((s.judgeIndex / pending.length) * 100)}%"></i></div>

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
    s.judgeIndex++;
    if (s.judgeIndex >= pending.length) {
      s.phase = "result";
      renderExamResult(root);
    } else {
      renderExamJudge(root);
    }
  };
  root.querySelector("#ejOk")?.addEventListener("click", () => judge(true));
  root.querySelector("#ejBad")?.addEventListener("click", () => judge(false));
}

function renderExamResult(root: HTMLElement): void {
  const s = E;
  if (!s) return;
  const rows = s.rows;
  const answered = rows.filter((r) => !r.skipped);
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
    E = createExamSession(E!.params);
    startTimer(root);
    renderExam(root);
  });
  root.querySelector("#exBanks")?.addEventListener("click", () => navigate("banks"));
  root.querySelector("#exWrong")?.addEventListener("click", () => navigate("wrongbook"));
  root.querySelector("#exHome")?.addEventListener("click", () => navigate("home"));
}

export function debugExam(): {
  mode: string; phase: string | null; total: number; answered: number; judged: number;
  score: number | null; endsAt: number | null;
} {
  if (!E) return { mode: "exam", phase: null, total: 0, answered: 0, judged: 0, score: null, endsAt: null };
  const rows = E.rows;
  const answered = rows.filter((r) => !r.skipped);
  const correct = answered.filter((r) => r.correct).length;
  const score = answered.length ? Math.round((correct / answered.length) * 100) : null;
  return {
    mode: "exam",
    phase: E.phase,
    total: E.queue.length,
    answered: examAnsweredCount(),
    judged: E.judgeIndex,
    score: E.phase === "result" ? score : null,
    endsAt: E.endsAt,
  };
}

export const examView: View = {
  async render(root, params) {
    const p = params ?? {};
    E = createExamSession(p);
    startTimer(root);
    renderExam(root);
  },
  unmount() {
    stopTimer();
    closeActiveDialog();
    E = null;
  },
};

export default examView;
