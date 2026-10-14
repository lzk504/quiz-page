/**
 * 目标 / 打卡 / 推荐 / 考试 口径的纯函数集合（v6 新增）。
 *
 * 与 stats.ts 的分工：
 *   stats.ts  —— 「做题结果」口径（正确率、分领域/题型掌握度）
 *   goal.ts   —— 「学习节奏」口径（今日目标、连续打卡、近 7 天、高频错题、考试抽题）
 *
 * 所有函数都不改 state / store，只读输入、返回新值；视图层不得就地重算这些口径。
 */

import { questionDomainLabel } from "./state";
import { pct } from "./utils";
import type { FavoriteEntry, Question, QuizStore, QuestionType } from "./types";

/** 今日目标题数（固定值，v6 决策 7） */
export const DAILY_GOAL = 100;
/** 单场考试时长（分钟） */
export const EXAM_MINUTES = 60;
/** 高频错题：累计答错达到该值标黄 */
export const WRONG_AMBER = 2;
/** 高频错题：累计答错达到该值标红 */
export const WRONG_RED = 3;

/* ---------------- 日期 ---------------- */

/** 本地当天 00:00 的时间戳 */
export function dayStart(ts: number = Date.now()): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export const isToday = (ts?: number | null): boolean => !!ts && dayStart(ts) === dayStart();

/* ---------------- 今日目标 ---------------- */

export interface DailyGoal {
  done: number;
  goal: number;
  percent: number;
}

/** 今日已刷（按 records 的 lastAt 落在本地今天去重计数） */
export function todayAnswered(store: QuizStore | null | undefined): number {
  let n = 0;
  for (const r of Object.values(store?.records ?? {})) if (isToday(r?.lastAt)) n++;
  return n;
}

export function dailyGoal(store: QuizStore | null | undefined, goal: number = DAILY_GOAL): DailyGoal {
  const done = todayAnswered(store);
  return { done, goal, percent: Math.min(100, pct(done, goal)) };
}

/* ---------------- 打卡 / 近期 ---------------- */

/**
 * 连续打卡天数：从今天（今天还没刷则从昨天）往前逐日回溯，断档即停。
 * 口径基于 records[*].lastAt（每题只留最近一次作答，故为「该日有作答」的近似）。
 */
export function streakDays(store: QuizStore | null | undefined): number {
  const days = new Set<number>();
  for (const r of Object.values(store?.records ?? {})) {
    if (r?.lastAt) days.add(dayStart(r.lastAt));
  }
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  if (!days.has(cursor.getTime())) cursor.setDate(cursor.getDate() - 1);
  let n = 0;
  while (days.has(cursor.getTime())) {
    n++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return n;
}

/** 近 N 天有作答记录的题目数（滚动窗口） */
export function recentAnswered(store: QuizStore | null | undefined, days = 7): number {
  const from = Date.now() - days * 86400000;
  let n = 0;
  for (const r of Object.values(store?.records ?? {})) if ((r?.lastAt ?? 0) >= from) n++;
  return n;
}

export interface WeekSummary {
  /** 本周（周一 00:00 起）有作答记录的题数 */
  count: number;
  correct: number;
  rate: number;
  /** 上周同口径题数 */
  prevCount: number;
  /** 本周 − 上周 */
  delta: number;
  /** 本周正确率最低且样本 ≥3 的领域；无则 null */
  weakest: { domain: string; label: string; rate: number } | null;
}

/** 本周学习小结（供「我的」页文案） */
export function weekSummary(questions: Question[], store: QuizStore | null | undefined): WeekSummary {
  const records = store?.records ?? {};
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));   // 周一为一周起点
  const weekStart = monday.getTime();
  const prevStart = weekStart - 7 * 86400000;

  let count = 0, correct = 0, prevCount = 0;
  const byDomain = new Map<string, { answered: number; correct: number; label: string }>();

  for (const q of questions) {
    const rec = records[q.id];
    if (!rec?.lastAt) continue;
    if (rec.lastAt >= weekStart) {
      count++;
      if (rec.lastCorrect) correct++;
      const b = byDomain.get(q.domain) ?? { answered: 0, correct: 0, label: questionDomainLabel(q) };
      b.answered++;
      if (rec.lastCorrect) b.correct++;
      byDomain.set(q.domain, b);
    } else if (rec.lastAt >= prevStart) {
      prevCount++;
    }
  }

  let weakest: WeekSummary["weakest"] = null;
  for (const [domain, b] of byDomain) {
    if (b.answered < 3) continue;
    const rate = pct(b.correct, b.answered);
    if (!weakest || rate < weakest.rate) weakest = { domain, label: b.label, rate };
  }

  return { count, correct, rate: pct(correct, count), prevCount, delta: count - prevCount, weakest };
}

/* ---------------- 高频错题（今日推荐复习） ---------------- */

export interface RecGroup {
  domain: string;
  label: string;
  /** 组内单题最高累计答错次数 */
  maxWrong: number;
  /** 涉及题数 */
  count: number;
  level: "red" | "amber";
}

/** 错因严重度：≥3 红 / ≥2 黄（<2 不计入推荐） */
export function wrongLevel(wrongAttempts: number): "red" | "amber" | null {
  if (wrongAttempts >= WRONG_RED) return "red";
  if (wrongAttempts >= WRONG_AMBER) return "amber";
  return null;
}

/**
 * 今日推荐复习：仅在「当前错题本内」按领域聚合累计答错 ≥2 的题。
 * @param questions 全部已加载题目（错题可能跨库）
 */
export function todayRecommended(questions: Question[], store: QuizStore | null | undefined): RecGroup[] {
  const records = store?.records ?? {};
  const wrongbook = store?.wrongbook ?? {};
  const groups = new Map<string, { label: string; maxWrong: number; count: number }>();

  for (const q of questions) {
    if (!wrongbook[q.id]) continue;
    const attempts = records[q.id]?.wrongAttempts ?? 0;
    if (attempts < WRONG_AMBER) continue;
    const g = groups.get(q.domain) ?? { label: questionDomainLabel(q), maxWrong: 0, count: 0 };
    g.maxWrong = Math.max(g.maxWrong, attempts);
    g.count++;
    groups.set(q.domain, g);
  }

  return [...groups.entries()]
    .map(([domain, g]) => ({
      domain,
      label: g.label,
      maxWrong: g.maxWrong,
      count: g.count,
      level: (g.maxWrong >= WRONG_RED ? "red" : "amber") as RecGroup["level"],
    }))
    .sort((a, b) => b.maxWrong - a.maxWrong || b.count - a.count);
}

/* ---------------- 错题本 / 收藏 ---------------- */

export interface WrongbookStats {
  /** 历史错题总数：records 中 wrongAttempts > 0 的题数 */
  total: number;
  /** 已订正：其中最近一次已答对 */
  corrected: number;
  /** 待复习：当前在册错题（限定在传入的题库范围内） */
  pending: number;
}

export function wrongbookStats(questions: Question[], store: QuizStore | null | undefined): WrongbookStats {
  const records = store?.records ?? {};
  const wrongbook = store?.wrongbook ?? {};
  let total = 0, corrected = 0, pending = 0;
  for (const q of questions) {
    const rec = records[q.id];
    if ((rec?.wrongAttempts ?? 0) > 0) {
      total++;
      if (rec?.lastCorrect) corrected++;
    }
    if (wrongbook[q.id]) pending++;
  }
  return { total, corrected, pending };
}

export interface FavoriteItem {
  q: Question;
  f: FavoriteEntry;
}

/** 收藏列表（按收藏时间倒序） */
export function favoriteQuestions(questions: Question[], store: QuizStore | null | undefined): FavoriteItem[] {
  const favorites = store?.favorites ?? {};
  const out: FavoriteItem[] = [];
  for (const q of questions) {
    const f = favorites[q.id];
    if (f) out.push({ q, f });
  }
  return out.sort((a, b) => (b.f.addedAt ?? 0) - (a.f.addedAt ?? 0));
}

/* ---------------- 考试 ---------------- */

export type ExamBlueprint = Record<QuestionType, number>;

/** 考试题型配比：单选 50 / 多选 20 / 判断 17 / 填空 10 / 简答 3 = 100 */
export const examBlueprint = (): ExamBlueprint => ({
  single: 50, multiple: 20, judge: 17, fill: 10, short: 3,
});

/** Fisher–Yates 洗牌（返回新数组） */
export function shuffle<T>(input: T[]): T[] {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 按配额抽题：优先满足各题型配额；某题型不足时由其余题型的剩余题目补足。
 * 返回洗牌后的题目（长度 ≤ 配比总和，题池不足时更少）。
 */
export function examPick(pool: Question[], blueprint: ExamBlueprint = examBlueprint()): Question[] {
  const byType = new Map<QuestionType, Question[]>();
  for (const q of pool) {
    const arr = byType.get(q.type) ?? [];
    arr.push(q);
    byType.set(q.type, arr);
  }
  for (const [t, arr] of byType) byType.set(t, shuffle(arr));

  const picked: Question[] = [];
  const rest: Question[] = [];

  for (const [type, quota] of Object.entries(blueprint) as Array<[QuestionType, number]>) {
    const arr = byType.get(type) ?? [];
    picked.push(...arr.slice(0, quota));
    rest.push(...arr.slice(quota));
  }

  const total = Object.values(blueprint).reduce((a, b) => a + b, 0);
  if (picked.length < total) picked.push(...shuffle(rest).slice(0, total - picked.length));

  return shuffle(picked);
}

const TYPE_PRIORITY: Record<string, number> = {
  single: 1,
  multiple: 2,
  judge: 3,
  fill: 4,
  short: 5,
};

/**
 * 章节顺序排序：按题型固定顺序（单选 > 多选 > 判断 > 填空 > 简答），同题型内保持原有 ID 顺序
 */
export function chapterOrderSort(pool: Question[]): Question[] {
  return [...pool].sort((a, b) => {
    const pa = TYPE_PRIORITY[a.type] ?? 99;
    const pb = TYPE_PRIORITY[b.type] ?? 99;
    return pa - pb;
  });
}

/**
 * 智能练习选题排序：未做题优先 > 历史错题/薄弱题 > 最久未练已掌握题（艾宾浩斯防遗忘）
 * 组内保持合理随机扰动，避免顺序死板
 */
export function smartPracticeSort(pool: Question[], store: QuizStore | null | undefined): Question[] {
  const records = store?.records ?? {};
  const wrongbook = store?.wrongbook ?? {};

  const fresh: Question[] = [];
  const wrong: Question[] = [];
  const mastered: Question[] = [];

  for (const q of pool) {
    const rec = records[q.id];
    if (!rec) {
      fresh.push(q);
    } else if (wrongbook[q.id] || !rec.lastCorrect) {
      wrong.push(q);
    } else {
      mastered.push(q);
    }
  }

  // 1. 新题：组内完全随机打乱
  const sortedFresh = shuffle(fresh);

  // 2. 错题：按错误次数降序，次数相同时按最近出错优先
  const sortedWrong = wrong.sort((a, b) => {
    const wa = wrongbook[a.id]?.wrongCount ?? records[a.id]?.wrongAttempts ?? 1;
    const wb = wrongbook[b.id]?.wrongCount ?? records[b.id]?.wrongAttempts ?? 1;
    if (wb !== wa) return wb - wa;
    const ta = wrongbook[a.id]?.lastWrongAt ?? records[a.id]?.lastAt ?? 0;
    const tb = wrongbook[b.id]?.lastWrongAt ?? records[b.id]?.lastAt ?? 0;
    return tb - ta;
  });

  // 3. 已掌握题：按上次作答时间升序（最久没做的排前面）
  const sortedMastered = mastered.sort((a, b) => {
    const ta = records[a.id]?.lastAt ?? 0;
    const tb = records[b.id]?.lastAt ?? 0;
    return ta - tb;
  });

  return [...sortedFresh, ...sortedWrong, ...sortedMastered];
}

/* ---------------- 考试结果 ---------------- */

export interface ExamTypeScore {
  type: QuestionType;
  label: string;
  total: number;
  correct: number;
}

export interface ExamResultRow {
  q: Question;
  userAnswer: unknown;
  correct: boolean;
  /** 未作答（提前交卷 / 超时）：不计分、不进自评、不进错题本 */
  skipped?: boolean;
}

/** 分题型得分（按蓝图顺序） */
export function examTypeScores(
  rows: ExamResultRow[],
  typeLabelsMap: Record<string, string>,
): ExamTypeScore[] {
  const order: QuestionType[] = ["single", "multiple", "judge", "fill", "short"];
  const map = new Map<QuestionType, ExamTypeScore>();
  for (const t of order) map.set(t, { type: t, label: typeLabelsMap[t] ?? t, total: 0, correct: 0 });
  for (const r of rows) {
    const b = map.get(r.q.type);
    if (!b) continue;
    b.total++;
    if (r.correct) b.correct++;
  }
  return order.map((t) => map.get(t)!).filter((b) => b.total > 0);
}
