/**
 * 题库页「题型专项」入口卡：真实题量/进度统计与行渲染。
 * 独立文件以保持 banks.ts 在 300 行约束内，且不触碰章节目录的既有样式与断言。
 */

import { getStore } from "../storage";
import { esc, pct } from "../utils";
import { typeLabels } from "../state";
import type { Question, QuestionType } from "../types";

/** 题型专项固定顺序（与题库题型配比一致） */
const TYPE_ORDER: readonly QuestionType[] = ["single", "multiple", "judge", "fill", "short"];
const TYPE_BADGE: Record<QuestionType, string> = {
  single: "单", multiple: "多", judge: "判", fill: "填", short: "简",
};

export interface TypeStat {
  type: QuestionType;
  label: string;
  total: number;
  answered: number;
  correct: number;
}

/** 当前库各题型真实题量与进度（不使用 meta.typeCounts 目标值） */
export function typeStats(questions: Question[]): TypeStat[] {
  const records = getStore().records ?? {};
  const labels = typeLabels();
  return TYPE_ORDER.map((type) => {
    const qs = questions.filter((q) => q.type === type);
    return {
      type,
      label: labels[type] ?? type,
      total: qs.length,
      answered: qs.filter((q) => records[q.id]).length,
      correct: qs.filter((q) => records[q.id]?.lastCorrect).length,
    };
  });
}

function typeChip(st: TypeStat): string {
  if (st.total === 0) return `<span class="chapter__chip">暂无题目</span>`;
  if (st.answered >= st.total) return `<span class="chapter__chip chapter__chip--done">已完成</span>`;
  if (st.answered > 0) return `<span class="chapter__chip chapter__chip--doing">进行中</span>`;
  return `<span class="chapter__chip">未开始</span>`;
}

/** 题型专项卡 HTML（五行入口，点击由 banks.ts 统一绑定） */
export function typeCard(stats: TypeStat[]): string {
  const rows = stats.map((st) => {
    const mastery = st.answered ? pct(st.correct, st.answered) : 0;
    return `<button class="type-row" data-type="${st.type}">
      <span class="chapter__idx">${TYPE_BADGE[st.type]}</span>
      <span class="chapter__body">
        <span class="chapter__title">${esc(st.label)}</span>
        <span class="chapter__meta">
          共 <b>${st.total}</b> 题 · 已练 <b>${st.answered}</b> · 掌握度 <b>${st.answered ? mastery + "%" : "—"}</b>
        </span>
        <span class="chapter__bar"><i style="width:${st.total ? pct(st.answered, st.total) : 0}%"></i></span>
      </span>
      ${typeChip(st)}
      <span class="chapter__arrow">›</span>
    </button>`;
  }).join("");

  return `
    <section class="card">
      <h2 class="card__title">题型专项 <small>按题型单独练习</small></h2>
      <div class="type-list">${rows}</div>
    </section>`;
}
