/**
 * 全真模拟考试视图（exam.ts）
 * 特性：
 *   - 60 分钟倒计时、时间到自动交卷；
 *   - 全新 Vant 风格界面与 ExamCardSheet 答题卡组件联动；
 *   - 【‹ 上一题】与【下一题 ›】自由双向切换，状态无缝暂存保全；
 *   - 答题卡半模态弹出，题目状态实时高亮（当前题/已作答/未作答），支持直接点击跳题；
 *   - 全新结算页面：深色大看板（得分/满分、评语建议、3列核心用时/错题统计）、各题型正确率进度条、逐题详细对比框与解析。
 *   - 逐题解析区分页（每页 10 条）+ 对错/题型筛选 chips，题型正确率卡可点击联动筛选；
 *     局部重绘（paintReview）避免一次性渲染 100 条导致的卡顿。
 */

import "./exam.css";
import { getQuestions, getLoadedQuestions, typeLabels, questionDomainLabel, getBank } from "../../state";
import { recordAnswer } from "../../storage";
import { grade, displayAnswer, displayUserAnswer, isSelfJudged } from "../../scoring";
import { examPick, examBlueprint, EXAM_MINUTES, type ExamResultRow } from "../../goal";
import { esc } from "../../utils";
import { navigate } from "../../router";
import { domainTag, typeTag, bankTag, emptyState, toast, confirmDialog, closeActiveDialog } from "../../ui";
import type { Question, View } from "../../types";
import { letterOf } from "./quiz-card";
import { ExamCardSheet } from "./exam-card";

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

/* ---------------- 逐题解析区：分页与筛选状态（仅 result 阶段使用） ---------------- */

const REVIEW_PAGE_SIZE = 10;
type WrongFilter = "all" | "wrong" | "blank";
let reviewFilterWrong: WrongFilter = "all";
let reviewFilterType = "all";
let reviewPage = 1;

function resetReviewState(): void {
  reviewFilterWrong = "all";
  reviewFilterType = "all";
  reviewPage = 1;
}

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
      node.innerHTML = `<i class="van-icon van-icon-clock-o"></i> <b>${fmtClock(left)}</b>`;
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
  const progressPct = Math.round(((s.index + 1) / s.queue.length) * 100);

  const bankName = s.params.banks ? getBank(s.params.banks)?.title ?? "全真模拟考试" : "全真模拟考试";

  root.innerHTML = `
    <div class="exam-v2-header">
      <button type="button" class="exam-v2-close" id="examExit" aria-label="退出考试">
        <i class="van-icon van-icon-cross"></i>
      </button>
      <div class="exam-v2-titles">
        <h1 class="exam-v2-title">《${esc(bankName)}》</h1>
        <p class="exam-v2-subtitle">共 ${s.queue.length} 题 · 满分 100 分</p>
      </div>
      <span class="exam-v2-timer" id="examTimer">
        <i class="van-icon van-icon-clock-o"></i> <b>${fmtClock(s.endsAt - Date.now())}</b>
      </span>
    </div>

    <div class="exam-v2-progress-row">
      <div class="exam-v2-progress-bar">
        <div class="exam-v2-progress-fill" style="width:${progressPct}%"></div>
      </div>
      <div class="exam-v2-progress-meta">
        <span class="exam-v2-progress-text">${s.index + 1} / ${s.queue.length}</span>
        <button type="button" class="exam-v2-sheet-btn" id="examOpenSheet">
          <i class="van-icon van-icon-apps-o"></i> 答题卡
        </button>
      </div>
    </div>

    <section class="card" style="padding:16px 16px 14px;margin-bottom:80px">
      <div class="tags">${typeTag(q.type)}${domainTag(q.domain)}${bankTag(q)}</div>
      <div id="qBody">${examBody(q)}</div>
      <p class="opt-hint" style="margin:12px 0 0;font-size:12px;color:var(--text-sub)">
        ${q.type === "single" || q.type === "judge" ? "单选题与判断题：选择选项后点击下方按钮切换" : "选好或填写后可随时回看修改"}
      </p>
      <div class="exam-tip-card">
        <i class="van-icon van-icon-warning-o"></i>
        <span>考试模式下不显示即时对错，交卷后统一给出成绩与逐题解析。</span>
      </div>
    </section>

    <div class="exam-bottom-bar">
      <button type="button" class="btn btn--nav" id="examPrev" ${s.index === 0 ? "disabled" : ""}>
        ‹ 上一题
      </button>
      <button type="button" class="btn btn--nav" id="examNext" ${s.index === s.queue.length - 1 ? "disabled" : ""}>
        下一题 ›
      </button>
      <button type="button" class="btn btn--submit" id="examSubmit">
        交卷
      </button>
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

  // 上一题（无缝保存答案并切换）
  root.querySelector("#examPrev")?.addEventListener("click", () => {
    collectExamAnswer(root);
    if (s.index > 0) {
      s.index--;
      renderExam(root);
    }
  });

  // 下一题（无缝保存答案并切换）
  root.querySelector("#examNext")?.addEventListener("click", () => {
    collectExamAnswer(root);
    if (s.index < s.queue.length - 1) {
      s.index++;
      renderExam(root);
    }
  });

  const submitHandler = async (): Promise<void> => {
    collectExamAnswer(root);
    const answered = examAnsweredCount();
    const blank = s.queue.length - answered;
    const msg = blank > 0
      ? `检测到还有 ${blank} 道题未作答（未作答将按 0 分记错并入错题本）。确定交卷吗？`
      : "确定交卷吗？交卷后将生成成绩报告与逐题解析。";
    const ok = await confirmDialog({
      title: "交卷确认", message: msg, confirmText: "立即交卷", danger: blank > 0,
    });
    if (!ok) return;
    submitExam(root, false);
  };

  root.querySelector("#examSubmit")?.addEventListener("click", () => { void submitHandler(); });

  // 答题卡弹窗入口
  root.querySelector("#examOpenSheet")?.addEventListener("click", () => {
    collectExamAnswer(root);
    ExamCardSheet.open({
      total: s.queue.length,
      currentIndex: s.index,
      isAnswered: (idx) => {
        const itemQ = s.queue[idx];
        if (!itemQ) return false;
        const ua = s.answers.get(itemQ.id);
        return !isBlank(itemQ, ua);
      },
      onSelect: (idx) => {
        s.index = idx;
        renderExam(root);
      },
      onSubmit: () => {
        void submitHandler();
      },
      submitButtonText: "立即交卷并查看成绩",
    });
  });

  // 退出考试确认
  root.querySelector("#examExit")?.addEventListener("click", async () => {
    collectExamAnswer(root);
    const answered = examAnsweredCount();
    const ok = await confirmDialog({
      title: "退出考试",
      message: answered > 0
        ? `退出将提前结束考试并交卷出分（未作答题目将计 0 分）。确定退出吗？`
        : "当前尚未作答任何题目，退出将直接放弃本次考试。确定退出吗？",
      confirmText: answered > 0 ? "交卷退出" : "直接退出",
      cancelText: "继续作答",
      danger: true,
    });
    if (!ok) return;
    if (answered > 0) {
      submitExam(root, false);
    } else {
      stopTimer();
      navigate("home");
    }
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
      // 未作答题目按 0 分且答错计入错题本
      if (isBlank(q, ua)) {
        recordAnswer(q, undefined, false);
        rows.push({ q, userAnswer: undefined, correct: false, skipped: false });
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

  const pending = s.rows.filter((r) => isSelfJudged(r.q) && !isBlank(r.q, r.userAnswer));
  if (pending.length) renderExamJudge(root);
  else { s.phase = "result"; renderExamResult(root); }
}

function renderExamJudge(root: HTMLElement): void {
  const s = E;
  if (!s) return;
  const pending = s.rows.filter((r) => isSelfJudged(r.q) && !isBlank(r.q, r.userAnswer));

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

/* ---------------- 逐题解析区：条目渲染 / 筛选 / 分页 ---------------- */

/** 单条解析卡片（字段与展示结果与原实现保持一致） */
function reviewItemHtml(r: ExamResultRow, no: number, tl: Record<string, string>): string {
  const q = r.q;
  const isOk = r.correct;
  const mineText = isBlank(q, r.userAnswer) ? "未作答" : displayUserAnswer(q, r.userAnswer);
  const rightText = displayAnswer(q);
  const badgeText = isOk ? "✓ 答对" : "⊗ 答错 · 已入错题本";
  const badgeCls = isOk ? "exam-review-item__badge--ok" : "exam-review-item__badge--bad";
  const domainText = q.domain ? (questionDomainLabel(q) || q.domain) : "";

  return `
    <div class="exam-review-item">
      <div class="exam-review-item__head">
        <span class="exam-review-item__title">第 ${no + 1} 题 · ${esc(tl[q.type] ?? q.type)}</span>
        <span class="exam-review-item__badge ${badgeCls}">${badgeText}</span>
      </div>
      <div class="exam-review-item__stem">${esc(q.stem)}</div>
      <div class="exam-review-item__compare">
        <div class="exam-review-item__mine">你的作答: ${esc(mineText)}</div>
        <div class="exam-review-item__right">正确答案: ${esc(rightText)}</div>
      </div>
      ${q.analysis ? `<div class="exam-review-item__analysis"><b>解析：</b>${esc(q.analysis)}</div>` : ""}
      ${domainText ? `<span class="exam-review-item__point">${esc(domainText)}</span>` : ""}
    </div>
  `;
}

/**
 * 当前筛选下的题目。no = 原始 rows 下标（分页后「第 N 题」仍是真实题号，不受筛选影响）。
 * 三个对错筛选项互斥：全部 / 答错（有作答但答错）/ 未作答（空）。
 */
function reviewRows(): Array<{ row: ExamResultRow; no: number }> {
  const rows = E?.rows ?? [];
  const out: Array<{ row: ExamResultRow; no: number }> = [];
  rows.forEach((row, no) => {
    const blank = isBlank(row.q, row.userAnswer);
    if (reviewFilterWrong === "blank" && !blank) return;
    if (reviewFilterWrong === "wrong" && (row.correct || blank)) return;
    if (reviewFilterType !== "all" && row.q.type !== reviewFilterType) return;
    out.push({ row, no });
  });
  return out;
}

/** 分页器：窄屏只留「上一页 / 下一页 + 第 X/Y 页」，宽屏展开页码（5 位滑动窗口 + 省略号） */
function pagerHtml(cur: number, pages: number): string {
  const btn = (n: number) =>
    `<button type="button" class="exam-pager__num${n === cur ? " is-on" : ""}" data-page="${n}">${n}</button>`;
  const gap = `<span class="exam-pager__gap">…</span>`;

  let nums = "";
  if (pages <= 7) {
    for (let i = 1; i <= pages; i++) nums += btn(i);
  } else {
    let start = Math.max(1, cur - 2);
    const end = Math.min(pages, start + 4);
    start = Math.max(1, end - 4);
    if (start > 1) nums += btn(1) + (start > 2 ? gap : "");
    for (let i = start; i <= end; i++) nums += btn(i);
    if (end < pages) nums += (end < pages - 1 ? gap : "") + btn(pages);
  }

  return `
    <nav class="exam-pager" aria-label="逐题解析分页">
      <button type="button" class="exam-pager__btn" data-page="${cur - 1}" ${cur <= 1 ? "disabled" : ""}>‹ 上一页</button>
      <span class="exam-pager__nums">${nums}</span>
      <button type="button" class="exam-pager__btn" data-page="${cur + 1}" ${cur >= pages ? "disabled" : ""}>下一页 ›</button>
      <span class="exam-pager__hint">第 ${cur} / ${pages} 页</span>
    </nav>
  `;
}

/**
 * 局部重绘逐题解析区（列表 + 分页器 + chips/题型卡高亮），不整页重渲染。
 * scroll=true 时把解析卡顶部滚入视野（首次进入结算页传 false，避免打断看分体验）。
 */
function paintReview(root: HTMLElement, scroll: boolean): void {
  const s = E;
  const list = root.querySelector<HTMLElement>("#exReviewList");
  const pager = root.querySelector<HTMLElement>("#exReviewPager");
  if (!s || !list || !pager) return;

  const all = reviewRows();
  const pages = Math.max(1, Math.ceil(all.length / REVIEW_PAGE_SIZE));
  reviewPage = Math.min(Math.max(1, reviewPage), pages);   // 兜底：状态残留也不会白屏

  const tl = typeLabels();
  const slice = all.slice((reviewPage - 1) * REVIEW_PAGE_SIZE, reviewPage * REVIEW_PAGE_SIZE);
  list.innerHTML = slice.length
    ? slice.map(({ row, no }) => reviewItemHtml(row, no, tl)).join("")
    : emptyState({ icon: "🔍", title: "该筛选下没有题目", desc: "换个筛选条件，或选择「全部」。" });
  pager.innerHTML = pages > 1 ? pagerHtml(reviewPage, pages) : "";

  // chips 与题型卡高亮统一从状态反推（单一数据源 → 天然双向同步）
  root.querySelectorAll<HTMLElement>("#exWrongChips .chip").forEach((b) => {
    b.classList.toggle("is-on", b.dataset.wrong === reviewFilterWrong);
  });
  root.querySelectorAll<HTMLElement>("#exTypeChips .chip").forEach((b) => {
    b.classList.toggle("is-on", b.dataset.ftype === reviewFilterType);
  });
  root.querySelectorAll<HTMLElement>(".exam-result-type-row[data-jt]").forEach((b) => {
    const on = b.dataset.jt === reviewFilterType;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-pressed", String(on));
  });

  const hint = root.querySelector<HTMLElement>("#exReviewCount");
  if (hint) {
    hint.textContent = all.length === s.rows.length
      ? `共 ${all.length} 题 · 第 ${reviewPage} / ${pages} 页`
      : `筛选出 ${all.length} / ${s.rows.length} 题 · 第 ${reviewPage} / ${pages} 页`;
  }

  if (scroll) scrollReviewIntoView(root);
}

/** 把解析卡顶部滚到视口上方（不用整页 scrollTo(0)，保留看板位置感） */
function scrollReviewIntoView(root: HTMLElement): void {
  const card = root.querySelector<HTMLElement>("#exReviewCard");
  if (!card) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const top = card.getBoundingClientRect().top + window.scrollY - 8;
  window.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
}

function renderExamResult(root: HTMLElement): void {
  const s = E;
  if (!s) return;
  const rows = s.rows;
  const total = rows.length;
  const correct = rows.filter((r) => r.correct).length;
  const wrong = total - correct;
  const blankCount = rows.filter((r) => isBlank(r.q, r.userAnswer)).length;   // 未作答
  const wrongAnswered = Math.max(0, wrong - blankCount);                      // 有作答但答错
  const score = total ? Math.round((correct / total) * 100) : 0;
  const elapsedMs = Math.max(0, Date.now() - s.startedAt);
  const elapsedText = fmtClock(elapsedMs);

  let comment = "建议先回看解析，再用练习模式巩固本讲内容";
  if (score >= 85) comment = "成绩优异，继续保持良好的做题手感！";
  else if (score >= 60) comment = "成绩良好，注意查漏补缺薄弱考点。";

  // 题型统计
  const typeMap = new Map<string, { total: number; correct: number }>();
  for (const r of rows) {
    const t = r.q.type;
    const item = typeMap.get(t) ?? { total: 0, correct: 0 };
    item.total++;
    if (r.correct) item.correct++;
    typeMap.set(t, item);
  }

  const tl = typeLabels();
  const typeOrder = ["single", "multiple", "judge", "fill", "short"];
  const presentTypes = typeOrder.filter((k) => typeMap.has(k));
  const typeHtml = presentTypes
    .map((k) => {
      const data = typeMap.get(k)!;
      const rate = data.total ? Math.round((data.correct / data.total) * 100) : 0;
      return `
        <div class="exam-result-type-row is-clickable" role="button" tabindex="0" aria-pressed="false" data-jt="${k}">
          <div class="exam-result-type-meta">
            <span>${esc(tl[k] ?? k)}</span>
            <span>${data.correct} / ${data.total} · ${rate}%</span>
          </div>
          <div class="exam-result-type-slot">
            <div class="exam-result-type-fill" style="width:${rate}%"></div>
          </div>
        </div>
      `;
    })
    .join("");

  // 解析区筛选 chips 的计数（基于全量 rows，不随另一维度变化）
  const wrongChips = `
    <button type="button" class="chip" data-wrong="all">全部<span class="chip__n">${total}</span></button>
    <button type="button" class="chip" data-wrong="wrong">答错<span class="chip__n">${wrongAnswered}</span></button>
    <button type="button" class="chip" data-wrong="blank">未作答<span class="chip__n">${blankCount}</span></button>
  `;
  const typeChips = `
    <button type="button" class="chip" data-ftype="all">全部题型<span class="chip__n">${total}</span></button>
    ${presentTypes.map((k) => `<button type="button" class="chip" data-ftype="${k}">${esc(tl[k] ?? k)}<span class="chip__n">${typeMap.get(k)!.total}</span></button>`).join("")}
  `;

  const bankName = s.params.banks ? getBank(s.params.banks)?.title ?? "全真模拟考试" : "全真模拟考试";

  root.innerHTML = `
    <section class="exam-result-hero">
      <div class="exam-result-hero__top">
        <span class="exam-result-hero__title">《${esc(bankName)}》· 已交卷</span>
        <span class="exam-result-hero__tag">考试模式</span>
      </div>
      <div class="exam-result-hero__score-row">
        <span class="exam-result-hero__score">${score}</span>
        <span class="exam-result-hero__total">分 / 100 分</span>
      </div>
      <div class="exam-result-hero__comment">${esc(comment)}</div>
      <div class="exam-result-hero__stats">
        <div>
          <div class="exam-result-hero__num">${correct}</div>
          <div class="exam-result-hero__label">答对题数</div>
        </div>
        <div>
          <div class="exam-result-hero__num">${elapsedText}</div>
          <div class="exam-result-hero__label">考试用时</div>
        </div>
        <div>
          <div class="exam-result-hero__num">${wrong}</div>
          <div class="exam-result-hero__label">新增错题</div>
        </div>
      </div>
    </section>

    ${typeHtml ? `
      <section class="exam-result-type-card">
        <h2 class="exam-result-type-title">各题型正确率<span class="exam-result-type-hint">点击可按题型筛选下方解析</span></h2>
        ${typeHtml}
      </section>
    ` : ""}

    <section class="exam-result-review-card" id="exReviewCard">
      <div class="exam-result-review-head">
        <span class="exam-result-review-title">逐题解析</span>
        <span class="exam-result-review-hint" id="exReviewCount"></span>
      </div>
      <div class="exam-review-filters">
        <div class="chips" id="exWrongChips">${wrongChips}</div>
        <div class="chips" id="exTypeChips">${typeChips}</div>
      </div>
      <div id="exReviewList"></div>
      <div id="exReviewPager"></div>
    </section>

    <div class="actions" style="flex-direction:column;gap:10px;margin-bottom:30px">
      <button class="btn btn--primary btn--block" id="exAgain">↻ 再考一次</button>
      <button class="btn btn--block" id="exWrong">✎ 查看错题本（${wrong}）</button>
      <button class="btn btn--block" id="exHome">⌂ 返回首页</button>
    </div>
  `;

  root.querySelector("#exAgain")?.addEventListener("click", () => {
    resetReviewState();
    E = createExamSession(s.params);
    startTimer(root);
    renderExam(root);
  });
  root.querySelector("#exWrong")?.addEventListener("click", () => navigate("wrongbook"));
  root.querySelector("#exHome")?.addEventListener("click", () => navigate("home"));

  // 解析区交互：chips 筛选 / 题型卡联动 / 翻页
  // 只挂一个 root 级委托——列表与分页器是局部重绘的，挂它们身上会被重绘清掉
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;

    const chip = t.closest<HTMLElement>("#exWrongChips .chip, #exTypeChips .chip");
    if (chip) {
      const w = chip.dataset.wrong;
      const ft = chip.dataset.ftype;
      if (w === "all" || w === "wrong" || w === "blank") reviewFilterWrong = w;
      else if (ft) reviewFilterType = ft;
      reviewPage = 1;
      paintReview(root, true);
      return;
    }

    const jump = t.closest<HTMLElement>(".exam-result-type-row[data-jt]");
    if (jump?.dataset.jt) {
      reviewFilterType = jump.dataset.jt;
      reviewPage = 1;
      paintReview(root, true);
      return;
    }

    const pg = t.closest<HTMLElement>(".exam-pager [data-page]");
    if (pg && !(pg as HTMLButtonElement).disabled) {
      reviewPage = Number(pg.dataset.page) || 1;
      paintReview(root, true);
    }
  });

  paintReview(root, false);   // 首次渲染不滚动（此时看板才是主角）
}

export const examView: View = {
  render(root, params) {
    if (!E) {
      resetReviewState();
      E = createExamSession(params ?? {});
      startTimer(root);
    }
    renderExam(root);
  },
  unmount() {
    stopTimer();
    ExamCardSheet.close();
    closeActiveDialog();
    E = null;
  },
};

export default examView;
export const debugExam = () => E;
