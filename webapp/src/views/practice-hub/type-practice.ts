/**
 * 题型专项练习（type-practice.ts）
 * 路由：#/type-practice?type=single|multiple|judge|fill|short&banks=G
 *
 * 设计边界：
 *   - 独立会话，不复用普通练习的草稿 / lastScope 生命周期；
 *   - 严格按题库 + 题型过滤，无匹配时呈现空态，绝不回退其他题库或题型；
 *   - 作答记录、判分、收藏、统计完全沿用普通练习口径。
 */

import {
  ensureBank, getBank, getLoadedQuestions, getSelectedBanks, typeLabels,
} from "../../state";
import { getStore, recordAnswer } from "../../storage";
import { grade, isSelfJudged, type GradeResult } from "../../scoring";
import { smartPracticeSort } from "../../goal";
import { navigate } from "../../router";
import { confirmDialog, closeActiveDialog } from "../../ui";
import type { Question, QuestionType, View } from "../../types";
import { collectAnswer } from "./quiz-card";
import { MAX_PER_SESSION } from "./general-practice";
import {
  renderTypeQuestion, renderTypeSummary, renderTypeEmpty, repaintTypeQuestion,
  type TypePracticeHandlers,
} from "./type-practice-ui";

const TYPE_ORDER: readonly QuestionType[] = ["single", "multiple", "judge", "fill", "short"];

export interface TypeSession {
  type: QuestionType;
  bankId: string;
  params: Record<string, string>;
  title: string;
  queue: Question[];
  /** 当前题库 + 题型的完整题池（未排序、未截断），供“再练一组”重新抽题 */
  pool: Question[];
  index: number;
  settled: boolean;
  awaitingJudge: boolean;
  result: GradeResult | null;
  userAnswer: unknown;
  stats: { answered: number; correct: number; wrongAdded: number; wrongCleared: number };
  sessionAnswers: Map<string, { userAnswer: unknown; result: GradeResult }>;
  emptyHint?: string;
  done?: boolean;
}

type Prepared =
  | { ok: true; type: QuestionType; bankId: string; pool: Question[] }
  | { ok: false; title: string; desc: string };

let S: TypeSession | null = null;
let renderSeq = 0;

/** 运行时题型守卫 */
function isQuestionType(v: string): v is QuestionType {
  return (TYPE_ORDER as readonly string[]).includes(v);
}

/** 解析题库：缺省取当前选中库；未知库/加载失败返回错误，不静默换库 */
async function prepare(params: Record<string, string>, seq: number): Promise<Prepared | null> {
  const type = params.type ?? "";
  if (!isQuestionType(type)) {
    return { ok: false, title: "题型参数无效", desc: "请返回题库，从「题型专项」重新选择。" };
  }
  const bankId = (params.banks ?? "").split(",").filter(Boolean)[0] || getSelectedBanks()[0] || "";
  if (!bankId || !getBank(bankId)) {
    return { ok: false, title: "题库不存在", desc: "请返回题库重新选择。" };
  }
  const loaded = await ensureBank(bankId);
  if (seq !== renderSeq) return null;
  if (!loaded) {
    return { ok: false, title: "题库加载失败", desc: "请检查网络后回到题库重试。" };
  }
  const pool = getLoadedQuestions().filter((q) => q.id.split("-")[0] === bankId && q.type === type);
  return { ok: true, type, bankId, pool };
}

function createSession(p: Extract<Prepared, { ok: true }>): TypeSession {
  const label = typeLabels()[p.type] ?? p.type;
  const queue = smartPracticeSort(p.pool, getStore()).slice(0, MAX_PER_SESSION);
  return {
    type: p.type,
    bankId: p.bankId,
    params: { type: p.type, banks: p.bankId },
    title: `${label}专项练习`,
    queue,
    pool: p.pool,
    index: 0,
    settled: false,
    awaitingJudge: false,
    result: null,
    userAnswer: null,
    stats: { answered: 0, correct: 0, wrongAdded: 0, wrongCleared: 0 },
    emptyHint: queue.length ? undefined : `该题库的${label}暂无题目。`,
    sessionAnswers: new Map(),
  };
}

/* ---------------- 会话动作 ---------------- */

function submit(root: HTMLElement, q: Question): void {
  const s = S;
  if (!s || s.settled) return;

  const userAnswer = collectAnswer(root, q, s.userAnswer);
  if (q.type === "multiple" && !((userAnswer as string[]) ?? []).length) return;
  s.userAnswer = userAnswer;

  if (isSelfJudged(q)) {
    s.settled = true;
    s.awaitingJudge = true;
    repaintTypeQuestion(root, s, q, handlers(root));
    return;
  }

  const result = grade(q, userAnswer);
  if (!result) return;
  s.settled = true;
  s.result = result;
  finalize(s, q, result.correct);
  repaintTypeQuestion(root, s, q, handlers(root));
}

function judgeSelf(root: HTMLElement, q: Question, saysCorrect: boolean): void {
  const s = S;
  if (!s || !s.awaitingJudge) return;
  s.awaitingJudge = false;
  s.result = { correct: saysCorrect };
  finalize(s, q, saysCorrect);
  repaintTypeQuestion(root, s, q, handlers(root));
}

function finalize(s: TypeSession, q: Question, correct: boolean): void {
  s.sessionAnswers.set(q.id, { userAnswer: s.userAnswer, result: s.result! });
  const r = recordAnswer(q, s.userAnswer, correct);
  s.stats.answered++;
  if (correct) s.stats.correct++;
  if (r.enteredWrongbook) s.stats.wrongAdded++;
  if (r.leftWrongbook) s.stats.wrongCleared++;
}

function goPrev(root: HTMLElement): void {
  const s = S;
  if (!s || s.index <= 0) return;
  s.index--;
  s.awaitingJudge = false;
  restoreQuestion(s, true);
  renderCurrent(root);
}

function goNext(root: HTMLElement): void {
  const s = S;
  if (!s) return;
  s.index++;
  s.awaitingJudge = false;
  if (s.index >= s.queue.length) {
    s.done = true;
    renderTypeSummary(root, s, handlers(root));
    return;
  }
  restoreQuestion(s, false);
  renderCurrent(root);
}

/** 回看优先用本次会话答案；allowHistory 时仅上一题可回退历史记录，前进绝不提前揭示答案 */
function restoreQuestion(s: TypeSession, allowHistory: boolean): void {
  const q = s.queue[s.index];
  const inSession = s.sessionAnswers.get(q.id);
  if (inSession) {
    s.settled = true;
    s.userAnswer = inSession.userAnswer;
    s.result = inSession.result;
    return;
  }
  const rec = allowHistory ? getStore().records?.[q.id] : undefined;
  s.settled = !!rec;
  s.userAnswer = rec?.lastUserAnswer ?? null;
  s.result = rec ? { correct: !!rec.lastCorrect } : null;
}

async function exitPractice(root: HTMLElement): Promise<void> {
  const s = S;
  if (!s) return;
  const seq = renderSeq;
  if (s.stats.answered > 0 || s.index > 0) {
    const ok = await confirmDialog({
      title: "退出题型专项练习？",
      message: "已作答记录会保留，本次练习的题目顺序不会保存。",
      confirmText: "退出练习",
      cancelText: "继续做题",
      danger: true,
    });
    if (!ok || seq !== renderSeq || S !== s) return;
  }
  navigate("banks", { bank: s.bankId });
}

function again(root: HTMLElement): void {
  const prev = S;
  if (!prev) return;
  S = createSession({ ok: true, type: prev.type, bankId: prev.bankId, pool: prev.pool });
  if (!S.queue.length) {
    renderTypeEmpty(root, "暂无题目", S.emptyHint ?? "该题型暂无题目。", backToBank);
    return;
  }
  renderCurrent(root);
}

function backToBank(): void {
  const bankId = S?.bankId;
  navigate("banks", bankId ? { bank: bankId } : undefined);
}

function handlers(root: HTMLElement): TypePracticeHandlers {
  return {
    onSubmit: (r, q) => submit(r, q),
    onJudge: (r, q, saysCorrect) => judgeSelf(r, q, saysCorrect),
    onPrev: () => goPrev(root),
    onNext: () => goNext(root),
    onExit: (r) => { void exitPractice(r); },
    onAgain: () => again(root),
    onBackToTypes: backToBank,
    onHome: () => navigate("home"),
  };
}

function renderCurrent(root: HTMLElement): void {
  const s = S;
  if (!s) return;
  if (s.done || s.index >= s.queue.length) {
    renderTypeSummary(root, s, handlers(root));
    return;
  }
  renderTypeQuestion(root, s, handlers(root));
}

/** 调试快照：供 E2E 验证题型纯度与 100 题上限 */
export function debugTypeSession(): {
  type: QuestionType | null; bankId: string; ids: string[]; types: string[]; index: number; current: string | null;
} {
  if (!S) return { type: null, bankId: "", ids: [], types: [], index: 0, current: null };
  return {
    type: S.type,
    bankId: S.bankId,
    ids: S.queue.map((q) => q.id),
    types: S.queue.map((q) => q.type),
    index: S.index,
    current: S.queue[S.index]?.id ?? null,
  };
}

export const typePracticeView: View = {
  async render(root, rawParams) {
    const params = rawParams ?? {};
    const seq = ++renderSeq;
    const prepared = await prepare(params, seq);
    if (!prepared || seq !== renderSeq) return;

    if (!prepared.ok) {
      renderTypeEmpty(root, prepared.title, prepared.desc, () => navigate("banks"));
      return;
    }

    S = createSession(prepared);
    if (!S.queue.length) {
      const hint = S.emptyHint ?? "该题型暂无题目。";
      renderTypeEmpty(root, "暂无题目", hint, backToBank);
      return;
    }
    renderCurrent(root);
  },
  unmount() {
    renderSeq++;
    closeActiveDialog();
    S = null;
  },
};

export default typePracticeView;
