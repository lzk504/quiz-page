/**
 * 统计计算。纯函数：输入题库 + store，输出各类口径的统计对象。
 * 正确率口径：以每题「最近一次作答」是否答对为准（lastCorrect）。
 */

import { pct } from "./utils.js";
import { domainLabels, typeLabels } from "./state.js";

export function computeStats(questions, store) {
  const records = store?.records ?? {};
  const wrongbook = store?.wrongbook ?? {};

  const buckets = {
    all:       { answered: 0, correct: 0, total: questions.length },
    byDomain:  {},
    byType:    {},
  };

  const ensure = (map, key, total) => {
    if (!map[key]) map[key] = { answered: 0, correct: 0, total };
    return map[key];
  };

  // 分母：按领域/题型统计题目总量
  for (const q of questions) {
    ensure(buckets.byDomain, q.domain, 0).total++;
    ensure(buckets.byType, q.type, 0).total++;
  }

  for (const q of questions) {
    const rec = records[q.id];
    if (!rec) continue;
    buckets.all.answered++;
    if (rec.lastCorrect) {
      buckets.all.correct++;
      buckets.byDomain[q.domain].correct++;
      buckets.byType[q.type].correct++;
    }
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

    byDomain: Object.entries(buckets.byDomain).map(([key, v]) => ({
      key, label: dl[key] ?? key, ...v, rate: pct(v.correct, v.answered),
    })),
    byType: Object.entries(buckets.byType).map(([key, v]) => ({
      key, label: tl[key] ?? key, ...v, rate: pct(v.correct, v.answered),
    })),
  };
}
