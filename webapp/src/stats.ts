/**
 * 统计计算。纯函数：输入题库 + store，输出各类口径的统计对象。
 * 正确率口径：以每题「最近一次作答」是否答对为准（lastCorrect）。
 * 输入 questions 为「当前题池」（选中库合并），故所有分桶都是该口径。
 */

import { pct } from "./utils";
import { domainLabels, typeLabels, questionDomainLabel, getBank } from "./state";
import type { Question, QuizStore } from "./types";

interface Bucket {
  answered: number;
  correct: number;
  total: number;
}

export interface RateRow extends Bucket {
  key: string;
  label: string;
  rate: number;
}

export interface Stats {
  totalQuestions: number;
  answered: number;
  correct: number;
  rate: number;
  progress: { answered: number; total: number; percent: number };
  wrongCount: number;
  wrongIds: string[];
  byBank: RateRow[];
  byDomain: RateRow[];
  byType: RateRow[];
}

const bankIdOf = (id: string): string => (id.includes("-") ? id.split("-")[0] : "");

export function computeStats(questions: Question[], store: QuizStore | null | undefined): Stats {
  const records = store?.records ?? {};
  const wrongbook = store?.wrongbook ?? {};

  const buckets: {
    all: Bucket;
    byBank: Record<string, Bucket>;
    byDomain: Record<string, Bucket>;
    byType: Record<string, Bucket>;
  } = {
    all: { answered: 0, correct: 0, total: questions.length },
    byBank: {},
    byDomain: {},
    byType: {},
  };

  const ensure = (map: Record<string, Bucket>, key: string, total: number): Bucket => {
    if (!map[key]) map[key] = { answered: 0, correct: 0, total };
    return map[key];
  };

  // 分母：按题库/领域/题型统计题目总量
  const domainLabelOf = new Map<string, string>();
  for (const q of questions) {
    const bank = bankIdOf(q.id);
    ensure(buckets.byBank, bank, 0).total++;
    ensure(buckets.byDomain, q.domain, 0).total++;
    ensure(buckets.byType, q.type, 0).total++;
    if (!domainLabelOf.has(q.domain)) domainLabelOf.set(q.domain, questionDomainLabel(q));
  }

  for (const q of questions) {
    const rec = records[q.id];
    if (!rec) continue;
    const bank = bankIdOf(q.id);
    buckets.all.answered++;
    if (rec.lastCorrect) {
      buckets.all.correct++;
      buckets.byBank[bank].correct++;
      buckets.byDomain[q.domain].correct++;
      buckets.byType[q.type].correct++;
    }
    buckets.byBank[bank].answered++;
    buckets.byDomain[q.domain].answered++;
    buckets.byType[q.type].answered++;
  }

  // 错题本中可能含已不在题库的旧 id，计数只认现存题目
  const existingIds = new Set(questions.map((q) => q.id));
  const wrongIds = Object.keys(wrongbook).filter((id) => existingIds.has(id));

  const dl = domainLabels();
  const tl = typeLabels();

  return {
    totalQuestions: questions.length,

    answered: buckets.all.answered,
    correct: buckets.all.correct,
    rate: pct(buckets.all.correct, buckets.all.answered),

    progress: {
      answered: buckets.all.answered,
      total: questions.length,
      percent: pct(buckets.all.answered, questions.length),
    },

    wrongCount: wrongIds.length,
    wrongIds,

    byBank: Object.entries(buckets.byBank).map(([key, v]) => ({
      key, label: getBank(key)?.title ?? key, ...v, rate: pct(v.correct, v.answered),
    })),
    byDomain: Object.entries(buckets.byDomain).map(([key, v]) => ({
      key, label: domainLabelOf.get(key) ?? dl[key] ?? key, ...v, rate: pct(v.correct, v.answered),
    })),
    byType: Object.entries(buckets.byType).map(([key, v]) => ({
      key, label: tl[key] ?? key, ...v, rate: pct(v.correct, v.answered),
    })),
  };
}
