/**
 * 差异化草稿管理模块（draft.ts）
 * 支持普通练习（general）、章节练习（chapter）、错题重做（wrong）三种模式的独立物理隔离存储。
 * 解决跨模式草稿互相覆盖、退出错题练习草稿丢失，以及首页恢复弹窗语义混淆的问题。
 */

import { getCurrentUser } from "../../auth";
import type { Question } from "../../types";

export type DraftKind = "general" | "chapter" | "wrong";

const DRAFT_PREFIX = "quizapp.draft.";
const draftKey = (kind: DraftKind): string =>
  `${DRAFT_PREFIX}${kind}.v1.${getCurrentUser()?.username ?? "anon"}`;

export interface PracticeDraft {
  kind: DraftKind;
  params: Record<string, string>;
  /** 本次题序（保序还原） */
  ids: string[];
  index: number;
  /** 当前题是否已作答结算（已判定显示答案） */
  settled?: boolean;
  at: number;
  /** 模式语义元数据（用于弹窗清晰呈现） */
  title?: string;
  domain?: string;
  domainLabel?: string;
}

export function saveDraft(
  kind: DraftKind,
  params: Record<string, string>,
  queue: Question[],
  index: number,
  settled: boolean,
  meta?: { title?: string; domain?: string; domainLabel?: string; done?: boolean; isReviewMode?: boolean },
): void {
  if (meta?.isReviewMode) return;                        // 查看解析模式不存草稿
  if (meta?.done || !queue.length) { clearDraft(kind); return; }
  // 如果已作答且已到最后一题，视为已完成练习，不再写草稿
  if (settled && index >= queue.length - 1) { clearDraft(kind); return; }
  if (index >= queue.length) { clearDraft(kind); return; }
  try {
    const draft: PracticeDraft = {
      kind,
      params,
      ids: queue.map((q) => q.id),
      index,
      settled: !!settled,
      at: Date.now(),
      title: meta?.title,
      domain: meta?.domain,
      domainLabel: meta?.domainLabel,
    };
    localStorage.setItem(draftKey(kind), JSON.stringify(draft));
  } catch { /* ignore */ }
}

export function readDraft(kind: DraftKind): PracticeDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(kind));
    if (!raw) return null;
    const d = JSON.parse(raw) as PracticeDraft;
    if (!d || !Array.isArray(d.ids) || !d.ids.length) return null;
    if (typeof d.index !== "number" || d.index < 0) return null;
    return d;
  } catch { return null; }
}

export function clearDraft(kind: DraftKind): void {
  try { localStorage.removeItem(draftKey(kind)); } catch { /* ignore */ }
}

/**
 * 错题草稿动态核验：过滤掉已被用户在错题本列表中手动移出的题目
 */
export function sanitizeWrongDraft(
  draft: PracticeDraft,
  wrongbook: Record<string, unknown>,
): { valid: boolean; draft: PracticeDraft } {
  const activeIds = draft.ids.filter((id) => !!wrongbook[id]);
  if (!activeIds.length) {
    clearDraft("wrong");
    return { valid: false, draft };
  }
  const newIndex = Math.min(draft.index, activeIds.length - 1);
  return {
    valid: true,
    draft: {
      ...draft,
      ids: activeIds,
      index: Math.max(0, newIndex),
    },
  };
}
