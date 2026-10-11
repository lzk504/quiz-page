/**
 * 题库数据加载与内存状态 + 极简发布订阅。
 * 只在这里持有 questions 数组与索引，其余模块通过 getter 访问。
 */

import type { Meta, Question } from "./types";

type Listener = (payload?: unknown) => void;

const listeners = new Map<string, Set<Listener>>();

interface AppState {
  meta: Meta | null;
  questions: Question[];
  byId: Map<string, Question>;
  ready: boolean;
}

const state: AppState = {
  meta: null,
  questions: [],
  byId: new Map(),
  ready: false,
};

export function on(event: string, cb: Listener): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(cb);
  return () => listeners.get(event)?.delete(cb);
}

export function emit(event: string, payload?: unknown): void {
  listeners.get(event)?.forEach((cb) => {
    try {
      cb(payload);
    } catch (e) {
      console.error(`[state] 事件 ${event} 回调出错`, e);
    }
  });
}

interface QuestionsFile {
  meta?: Meta;
  questions?: Question[];
}

export async function loadQuestions(url = "data/questions.json"): Promise<AppState> {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = (await res.json()) as QuestionsFile;
  if (!data || !Array.isArray(data.questions) || data.questions.length === 0) {
    throw new Error("题库格式不正确：缺少 questions 数组");
  }

  state.meta = data.meta ?? null;
  state.questions = data.questions;
  state.byId = new Map(data.questions.map((q) => [q.id, q]));
  state.ready = true;

  emit("data-loaded", state);
  return state;
}

export const getMeta = (): Meta | null => state.meta;
export const getQuestions = (): Question[] => state.questions;
export const getQuestion = (id: string): Question | undefined => state.byId.get(id);
export const isReady = (): boolean => state.ready;

/** 领域/题型展示配置：优先取 meta 里的标签，缺省时用内置表 */
const FALLBACK_DOMAIN_LABELS: Record<string, string> = {
  health: "健康", language: "语言", society: "社会",
  science: "科学", art: "艺术", general: "综合",
};
const FALLBACK_TYPE_LABELS: Record<string, string> = {
  single: "单选题", multiple: "多选题", judge: "判断题",
};

export const domainLabels = (): Record<string, string> =>
  ({ ...FALLBACK_DOMAIN_LABELS, ...(state.meta?.domainLabels ?? {}) });
export const typeLabels = (): Record<string, string> => FALLBACK_TYPE_LABELS;

/** 按题型/领域统计题量 */
export function countBy(key: "domain" | "type"): Record<string, number> {
  const out: Record<string, number> = {};
  for (const q of state.questions) out[q[key]] = (out[q[key]] ?? 0) + 1;
  return out;
}
