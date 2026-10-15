/**
 * 题库数据加载与内存状态 + 极简发布订阅（v3：多题库）。
 *
 * 数据源：
 *   data/banks.json     —— 题库清单（唯一入口）
 *   data/bank-<id>.json —— 各题库文件（按需加载）
 *
 * 规则：
 *  - 启动时读清单 + 恢复「选中库」偏好（localStorage），只加载选中的库；
 *  - 用户勾选其他库时按需拉取（ensureBank），加载后常驻内存不卸载；
 *  - getQuestions() 返回「已加载库」按清单顺序合并的题目；
 *  - 题目 id 前缀（G-/P-/Y-）即所属库，全局唯一，故 byId 可全局索引。
 */

import type { BankMeta, Meta, Question } from "./types";

type Listener = (payload?: unknown) => void;

const listeners = new Map<string, Set<Listener>>();

const BANKS_URL = "data/banks.json";
const SELECTED_KEY = "quizapp.banks.v1";
/** 默认选中的库（Q11：默认仅指南库 G） */
const DEFAULT_BANK_ID = "G";

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

/* ---------------- 内部状态 ---------------- */

interface BankState {
  bank: BankMeta;
  meta: Meta;
  questions: Question[];
}

interface BanksFile {
  version?: number;
  banks?: BankMeta[];
}

const state = {
  banks: [] as BankMeta[],
  loaded: new Map<string, BankState>(),
  inflight: new Map<string, Promise<BankState | null>>(),
  failed: new Set<string>(),
  selected: new Set<string>(),
  questions: [] as Question[],
  byId: new Map<string, Question>(),
  ready: false,
};

/** 合并缓存重建：questions = 选中库（已加载）的题目；byId = 全部已加载库（含未选中） */
function rebuild(): void {
  const selected: Question[] = [];
  const all: Question[] = [];
  for (const bank of state.banks) {
    const lb = state.loaded.get(bank.id);
    if (!lb) continue;
    all.push(...lb.questions);
    if (state.selected.has(bank.id)) selected.push(...lb.questions);
  }
  state.questions = selected;
  state.byId = new Map(all.map((q) => [q.id, q]));
}

function readSelected(): string[] | null {
  try {
    const raw = localStorage.getItem(SELECTED_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return null;
    return arr.filter((x): x is string => typeof x === "string");
  } catch { return null; }
}

function writeSelected(ids: string[]): void {
  try { localStorage.setItem(SELECTED_KEY, JSON.stringify(ids)); } catch { /* ignore */ }
}

/* ---------------- 加载 ---------------- */

/**
 * 加载单个题库（幂等、并发去重）。加载成功后常驻内存。
 * 失败时返回 null 并记录到 failed，由视图决定如何降级展示。
 */
export function ensureBank(id: string): Promise<BankState | null> {
  const existing = state.loaded.get(id);
  if (existing) return Promise.resolve(existing);

  const pending = state.inflight.get(id);
  if (pending) return pending;

  const bank = state.banks.find((b) => b.id === id);
  if (!bank) return Promise.resolve(null);

  const task = (async (): Promise<BankState | null> => {
    try {
      const res = await fetch(bank.file, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = (await res.json()) as { meta?: Meta; questions?: Question[] };
      if (!data || !Array.isArray(data.questions)) {
        throw new Error("题库格式不正确：缺少 questions 数组");
      }
      const bs: BankState = { bank, meta: data.meta ?? {}, questions: data.questions };
      state.loaded.set(id, bs);
      state.failed.delete(id);
      rebuild();
      emit("bank-loaded", id);
      return bs;
    } catch (e) {
      state.failed.add(id);
      console.error(`[state] 题库 ${id} 加载失败`, e);
      emit("bank-failed", { id, error: e });
      return null;
    } finally {
      state.inflight.delete(id);
    }
  })();

  state.inflight.set(id, task);
  return task;
}

/**
 * 加载全部已知题库（并发、带缓存），确保跨库数据完整。
 */
export async function ensureAllBanks(): Promise<void> {
  await Promise.all(state.banks.map((b) => ensureBank(b.id)));
}

/**
 * 启动入口：读清单 → 恢复选中库 → 加载选中库。
 * 单个库加载失败不阻塞启动（该库视为不可用）。
 */
export async function loadBanks(url: string = BANKS_URL): Promise<void> {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = (await res.json()) as BanksFile;
  const banks = data?.banks;
  if (!Array.isArray(banks) || banks.length === 0) {
    throw new Error("题库清单格式不正确：缺少 banks 数组");
  }
  state.banks = banks;

  const known = new Set(banks.map((b) => b.id));
  const stored = readSelected();
  let selected = (stored ?? [DEFAULT_BANK_ID]).filter((id) => known.has(id));
  // 单选语义（v6.1）：刷题范围恒为单库，历史多选数据收敛为清单顺序第一个并回写
  if (selected.length > 1) {
    const ordered = banks.filter((b) => selected.includes(b.id)).map((b) => b.id);
    selected = [ordered[0]];
    writeSelected(selected);
  }
  if (selected.length === 0) {
    selected = [known.has(DEFAULT_BANK_ID) ? DEFAULT_BANK_ID : banks[0].id];
  }
  state.selected = new Set(selected);

  await Promise.all(selected.map((id) => ensureBank(id)));
  rebuild();
  state.ready = true;
  emit("data-loaded", state);
}

/** 更新选中库：持久化偏好 + 按需加载 + 广播 */
export async function setSelectedBanks(ids: string[]): Promise<void> {
  const known = new Set(state.banks.map((b) => b.id));
  const next = ids.filter((id) => known.has(id));
  const finalIds = next.length ? next : [state.banks[0]?.id].filter(Boolean) as string[];

  state.selected = new Set(finalIds);
  writeSelected(finalIds);
  await Promise.all(finalIds.map((id) => ensureBank(id)));
  rebuild();
  emit("banks-changed", getSelectedBanks());
}

/* ---------------- 读访问 ---------------- */

/** 清单里的全部题库（含未加载） */
export const getBanks = (): BankMeta[] => state.banks;
export const getBank = (id: string): BankMeta | undefined => state.banks.find((b) => b.id === id);
export const isBankLoaded = (id: string): boolean => state.loaded.has(id);
export const isBankFailed = (id: string): boolean => state.failed.has(id);
/** 当前选中（且已加载）的库的题目，按清单顺序合并 —— 即「刷题范围」 */
export const getQuestions = (): Question[] => state.questions;
/** 全部已加载库的题目（含未选中），用于按 id 反查 */
export const getLoadedQuestions = (): Question[] => [...state.byId.values()];
export const getQuestion = (id: string): Question | undefined => state.byId.get(id);
export const isReady = (): boolean => state.ready;
/** 当前选中的库 id（按清单顺序） */
export const getSelectedBanks = (): string[] =>
  state.banks.filter((b) => state.selected.has(b.id)).map((b) => b.id);

const bankIdOf = (id: string): string => (id.includes("-") ? id.split("-")[0] : "");

/** 题目所属题库 */
export function getBankOf(q: Question | string): BankMeta | undefined {
  return getBank(bankIdOf(typeof q === "string" ? q : q.id));
}

/* ---------------- 题库展示名（v6.1：隐藏 G/P/Y 编号） ---------------- */

/** 题库固定短名（展示用，不带编号） */
const BANK_SHORT_NAMES: Record<string, string> = { G: "指南", P: "评估", Y: "纲要" };

/** 书名号短标题：《…》取书名号内文本；无书名号则原样返回 */
export function bankShortTitle(title: string): string {
  const m = title.match(/《(.+?)》/);
  return m ? m[1] : title;
}

/** 题库展示短名（无编号；未知库回退为书名短标题） */
export function bankShortName(bankId: string): string {
  const b = getBank(bankId);
  return BANK_SHORT_NAMES[bankId] ?? (b ? bankShortTitle(b.title) : bankId);
}

/** 库内题量（按已加载的实际数据） */
export function bankQuestionCount(id: string): number {
  return state.loaded.get(id)?.questions.length ?? 0;
}

/** 合并态 meta（标题/来源取首个选中库；counts 为已加载库合计） */
export function getMeta(): Meta | null {
  if (!state.banks.length) return null;
  const labels: Record<string, string> = {};
  const counts: Record<string, number> = {};
  let total = 0;
  for (const b of state.banks) {
    Object.assign(labels, b.domainLabels ?? {});
    const lb = state.loaded.get(b.id);
    if (!lb) continue;
    for (const [k, v] of Object.entries(lb.meta?.counts ?? {})) {
      if (k === "total") continue;
      if (typeof v === "number") counts[k] = (counts[k] ?? 0) + v;
    }
    total += lb.questions.length;
  }
  const primary = state.loaded.get(getSelectedBanks()[0]) ?? state.loaded.get(state.banks[0].id);
  return {
    title: primary?.meta?.title ?? state.banks[0].title,
    source: primary?.meta?.source ?? state.banks[0].source,
    version: 3,
    counts: { ...counts, total },
    domainLabels: labels,
  };
}

/* ---------------- 标签 ---------------- */

/** 领域/题型展示配置：优先取各库 meta 里的标签，缺省时用内置表 */
const FALLBACK_DOMAIN_LABELS: Record<string, string> = {
  health: "健康", language: "语言", society: "社会",
  science: "科学", art: "艺术", general: "综合",
};
const FALLBACK_TYPE_LABELS: Record<string, string> = {
  single: "单选题", multiple: "多选题", judge: "判断题",
  fill: "填空题", short: "简答题",
};

export function domainLabels(): Record<string, string> {
  const out: Record<string, string> = { ...FALLBACK_DOMAIN_LABELS };
  for (const b of state.banks) Object.assign(out, b.domainLabels ?? {});
  return out;
}

export const typeLabels = (): Record<string, string> => FALLBACK_TYPE_LABELS;

/** 按题目所属库解析领域标签（各库领域自治） */
export function questionDomainLabel(q: Question): string {
  const b = getBankOf(q);
  return b?.domainLabels?.[q.domain] ?? domainLabels()[q.domain] ?? q.domain;
}

/** 按题型/领域统计题量（选中库口径） */
export function countBy(key: "domain" | "type"): Record<string, number> {
  const out: Record<string, number> = {};
  for (const q of state.questions) out[q[key]] = (out[q[key]] ?? 0) + 1;
  return out;
}

/** 按库统计题量（已加载库的实际题数，与是否选中无关） */
export function countByBank(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of state.banks) {
    const lb = state.loaded.get(b.id);
    if (lb) out[b.id] = lb.questions.length;
  }
  return out;
}

/** 选中库的领域集合（按清单顺序，去重） */
export function selectedDomains(): string[] {
  const out: string[] = [];
  for (const b of state.banks) {
    if (!state.selected.has(b.id)) continue;
    for (const d of b.domains) if (!out.includes(d)) out.push(d);
  }
  return out;
}
