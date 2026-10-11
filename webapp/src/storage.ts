/**
 * 存储层：内存 cache + 云端（D1）同步。
 *
 * 对外签名与旧 localStorage 版本保持一致（视图层零改动）：
 *   getStore() 同步返回 cache；recordAnswer/removeFromWrongbook 同步返回结果；
 *   saveStore 同步更新 cache + 异步推云端。
 *
 * store 结构（v2，与服务端同形）：
 * {
 *   version: 2,
 *   records:  { [qid]: { attempts, wrongAttempts, lastCorrect, lastUserAnswer, firstAt, lastAt } },
 *   wrongbook:{ [qid]: { wrongCount, addedAt, lastUserAnswer, lastWrongAt } },
 *   updatedAt: number
 * }
 *
 * STORE_KEY 仅用于「首次上云迁移」：从本地旧 v1 数据读出后上云，然后清源。
 */

import { emit } from "./state";
import { migrateV1toV2, type LegacyStore } from "./migrate";
import { apiFetch, isLoggedIn } from "./auth";
import type { Question, QuizStore, RecordEntry, WrongbookEntry, SyncStatus } from "./types";

export const STORE_KEY = "quizapp.data.v1";   // 旧 localStorage key，仅迁移用
export const SCHEMA_VERSION = 2;

let available = true;            // localStorage 可用性（token 存取兜底）
let cache: QuizStore | null = null;   // 内存中的 store（同步读源）
let baseUpdatedAt = 0;           // 服务端最近已知 updatedAt（乐观锁基线）
let validIds: Set<string> | null = null;   // 题库 id 集（迁移剔除孤儿用）
let putTimer: ReturnType<typeof setTimeout> | null = null;  // debounce 定时器
let putInFlight = false;         // 是否正在发送 PUT
let putRetry = 0;                // 重试计数
let sync: SyncStatus = { status: "idle", lastSyncAt: 0, error: null };

/* ---------------- 工具 ---------------- */

const emptyStore = (): QuizStore => ({
  version: SCHEMA_VERSION,
  records: {},
  wrongbook: {},
  updatedAt: 0,
});

function setSync(status: SyncStatus["status"], error: string | null = null): void {
  sync = { status, lastSyncAt: status === "ok" ? Date.now() : sync.lastSyncAt, error };
  emit("sync-status", sync);
}

export function getSyncStatus(): SyncStatus { return sync; }

export function getBaseUpdatedAt(): number { return baseUpdatedAt; }

function probe(): boolean {
  try {
    const k = "__quizapp_probe__";
    localStorage.setItem(k, "1");
    localStorage.removeItem(k);
    return true;
  } catch { return false; }
}

/** 结构校验与修补 */
function normalize(raw: unknown): QuizStore | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Partial<QuizStore>;
  const store = emptyStore();
  store.version = Number(src.version) || SCHEMA_VERSION;
  store.updatedAt = Number(src.updatedAt) || 0;
  if (src.records && typeof src.records === "object" && !Array.isArray(src.records)) {
    store.records = src.records as Record<string, RecordEntry>;
  }
  if (src.wrongbook && typeof src.wrongbook === "object" && !Array.isArray(src.wrongbook)) {
    store.wrongbook = src.wrongbook as Record<string, WrongbookEntry>;
  }
  return store;
}

function migrateIfNeeded(store: QuizStore | null): QuizStore {
  if (!store || store.version >= SCHEMA_VERSION) return store ?? emptyStore();
  return migrateV1toV2(store as unknown as LegacyStore, validIds);
}

/** 注入题库 id 集；须在 initStorage() 之前调用 */
export function setValidIds(ids: string[]): void {
  validIds = new Set(ids);
}

/* ---------------- 云端读写 ---------------- */

async function loadStoreFromCloud(): Promise<QuizStore> {
  if (!isLoggedIn()) return emptyStore();
  try {
    const data = await apiFetch<{ store: QuizStore | null; updatedAt: number | null }>("/api/store");
    if (data && data.store) {
      const parsed = normalize(data.store);
      const migrated = migrateIfNeeded(parsed);
      baseUpdatedAt = data.updatedAt || migrated.updatedAt || 0;
      setSync("ok");
      return migrated;
    }
    // 云端无数据：检查本地是否有旧 v1 数据，首次上云迁移
    const localStore = tryReadLocalLegacy();
    if (localStore) {
      const migrated = migrateIfNeeded(localStore);
      migrated.updatedAt = Date.now();
      try {
        const put = await apiFetch<{ updatedAt: number }>("/api/store", {
          method: "PUT",
          body: { store: migrated, baseUpdatedAt: 0 },
        });
        baseUpdatedAt = put?.updatedAt || migrated.updatedAt;
        clearLocalLegacy();
        setSync("ok");
        console.info("[storage] 本地旧数据已迁移上云并清源");
      } catch (e) {
        baseUpdatedAt = 0;
        setSync("error", (e as Error)?.message || "上云失败");
        console.warn("[storage] 首次上云失败，保留本地副本", e);
      }
      return migrated;
    }
    baseUpdatedAt = 0;
    setSync("ok");
    return emptyStore();
  } catch (e) {
    setSync("error", (e as Error)?.message || "拉取失败");
    console.warn("[storage] 云端拉取失败，使用空 store", e);
    return emptyStore();
  }
}

function tryReadLocalLegacy(): QuizStore | null {
  if (!available) return null;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    return normalize(JSON.parse(raw));
  } catch { return null; }
}

function clearLocalLegacy(): void {
  try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
}

/* ---------------- 对外同步 API ---------------- */

export function getStore(): QuizStore {
  if (!cache) cache = emptyStore();
  return cache;
}

export function saveStore(store: QuizStore = getStore(), { silent = false }: { silent?: boolean } = {}): boolean {
  store.updatedAt = Date.now();
  cache = store;
  schedulePut();
  if (!silent) emit("store-changed", store);
  return true;
}

/* ---------------- 异步推云 ---------------- */

function schedulePut(): void {
  if (!isLoggedIn()) return;   // 未登录：仅内存，不推
  if (putTimer) clearTimeout(putTimer);
  putTimer = setTimeout(() => { putTimer = null; doPut(); }, 800);
}

async function doPut(): Promise<void> {
  if (!isLoggedIn() || putInFlight) return;
  putInFlight = true;
  setSync("pending");
  try {
    const data = await apiFetch<{ updatedAt: number }>("/api/store", {
      method: "PUT",
      body: { store: cache, baseUpdatedAt },
    });
    baseUpdatedAt = data?.updatedAt ?? cache!.updatedAt;
    putRetry = 0;
    setSync("ok");
  } catch (e) {
    const err = e as { status?: number; message?: string };
    if (err.status === 409) {
      // 云端有更新：拉回 merge 后重试一次
      try {
        const remote = await apiFetch<{ store: QuizStore | null; updatedAt: number | null }>("/api/store");
        if (remote?.store) {
          const merged = mergeWithRemote(normalize(remote.store) ?? emptyStore());
          cache = merged;
          baseUpdatedAt = remote.updatedAt || merged.updatedAt;
          emit("store-changed", cache);
        }
        putRetry = 0;
        setSync("ok");
      } catch {
        setSync("error", "云端有更新，合并失败");
      }
    } else if (err.status === 0) {
      putRetry++;
      if (putRetry <= 3) {
        setSync("error", "网络异常，重试中…");
        setTimeout(() => { putInFlight = false; doPut(); }, 1500 * putRetry);
        putInFlight = false;
        return;
      }
      setSync("error", "同步失败，将在网络恢复后重试");
    } else {
      setSync("error", err.message || "同步失败");
    }
    putRetry = 0;
  } finally {
    putInFlight = false;
  }
}

/** 远端 store 与本地 cache 按 lastAt 新者胜合并 */
function mergeWithRemote(remote: QuizStore): QuizStore {
  const cur = cache ?? emptyStore();
  const merged = emptyStore();
  merged.updatedAt = Math.max(cur.updatedAt || 0, remote.updatedAt || 0);
  for (const key of ["records", "wrongbook"] as const) {
    const out: Record<string, RecordEntry | WrongbookEntry> = { ...(cur[key] || {}) };
    for (const [qid, entry] of Object.entries(remote[key] || {})) {
      const mine = out[qid] as (RecordEntry & WrongbookEntry) | undefined;
      const myTime = mine?.lastAt ?? mine?.lastWrongAt ?? mine?.addedAt ?? 0;
      const e = entry as RecordEntry & WrongbookEntry;
      const theirTime = e?.lastAt ?? e?.lastWrongAt ?? e?.addedAt ?? 0;
      if (!mine || theirTime > myTime) out[qid] = entry;
    }
    merged[key] = out as never;
  }
  return merged;
}

/**
 * 轮询同步用：把远端较新的 store 合并进 cache。
 * 返回 true 表示确有更新并已合并（调用方据此提示用户）。
 */
export function applyRemoteStore(remote: QuizStore, remoteUpdatedAt: number): boolean {
  const remoteTs = remote.updatedAt || remoteUpdatedAt || 0;
  if (remoteTs <= baseUpdatedAt) return false;
  const merged = mergeWithRemote(remote);
  cache = merged;
  baseUpdatedAt = remoteTs;
  emit("store-changed", cache);
  return true;
}

/** 立即把待发数据推上去（页面隐藏/关闭前调用） */
export function flushStore(): void {
  if (putTimer) { clearTimeout(putTimer); putTimer = null; }
  if (!isLoggedIn() || !cache) return;
  // 空 store 不 flush（clearAll 已 DELETE 云端，避免用空覆盖或与迁移冲突）
  const isEmpty = Object.keys(cache.records).length === 0 && Object.keys(cache.wrongbook).length === 0;
  if (isEmpty) return;
  try {
    // keepalive:true 允许页面卸载后请求仍发出；body ≤64KB（store 远小于）
    fetch("/api/store", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...getTokenHeader(),
      },
      body: JSON.stringify({ store: cache, baseUpdatedAt }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* ignore */ }
}

function getTokenHeader(): Record<string, string> {
  try {
    const t = localStorage.getItem("quizapp.token.v1");
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch { return {}; }
}

/* ---------------- 可用性 & 初始化 ---------------- */

export const isPersistent = (): boolean => available && isLoggedIn();

export async function initStorage(): Promise<boolean> {
  available = probe();
  if (!available) emit("storage-broken", new Error("localStorage 不可用，登录态无法保持"));
  if (isLoggedIn()) {
    cache = await loadStoreFromCloud();
  } else {
    cache = emptyStore();
  }
  return available;
}

/* ---------------- 业务写入 ---------------- */

/**
 * 记录一次作答。答对时若在错题本中则移出；答错则收录进错题本。
 */
export function recordAnswer(
  question: Question,
  userAnswer: unknown,
  isCorrect: boolean,
): { isCorrect: boolean; enteredWrongbook: boolean; leftWrongbook: boolean } {
  const store = getStore();
  const now = Date.now();
  const id = question.id;

  const prev = store.records[id];
  store.records[id] = {
    attempts: (prev?.attempts ?? 0) + 1,
    wrongAttempts: (prev?.wrongAttempts ?? 0) + (isCorrect ? 0 : 1),
    lastCorrect: !!isCorrect,
    lastUserAnswer: userAnswer,
    firstAt: prev?.firstAt ?? now,
    lastAt: now,
  };

  let enteredWrongbook = false;
  let leftWrongbook = false;

  if (isCorrect) {
    if (store.wrongbook[id]) {
      delete store.wrongbook[id];
      leftWrongbook = true;
    }
  } else {
    const w = store.wrongbook[id];
    store.wrongbook[id] = {
      wrongCount: (w?.wrongCount ?? 0) + 1,
      addedAt: w?.addedAt ?? now,
      lastUserAnswer: userAnswer,
      lastWrongAt: now,
    };
    enteredWrongbook = true;
  }

  saveStore(store);
  return { isCorrect, enteredWrongbook, leftWrongbook };
}

export function removeFromWrongbook(questionId: string): boolean {
  const store = getStore();
  if (!store.wrongbook[questionId]) return false;
  delete store.wrongbook[questionId];
  saveStore(store);
  return true;
}

export function clearAll(): boolean {
  cache = emptyStore();
  baseUpdatedAt = 0;
  if (isLoggedIn()) {
    apiFetch("/api/store", { method: "DELETE" }).catch(() => {});
  }
  emit("store-changed", cache);
  return true;
}

/** 导出：返回可下载的 JSON 文本（当前 cache） */
export function exportJson(): string {
  return JSON.stringify(getStore(), null, 2);
}

export interface ImportCheck {
  ok: boolean;
  store?: QuizStore;
  reason?: string;
  summary?: { records: number; wrongbook: number };
}

/** 导入校验：不触碰现有数据。v1 旧备份自动迁移。 */
export function validateImport(text: string): ImportCheck {
  let raw: any;
  try { raw = JSON.parse(text); }
  catch { return { ok: false, reason: "不是合法的 JSON 文件" }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "文件内容不是对象结构" };
  }
  if (raw.records === undefined && raw.wrongbook === undefined && raw.recite === undefined) {
    return { ok: false, reason: "缺少 records / wrongbook 字段，可能不是本应用的备份" };
  }
  if (raw.version !== undefined && Number(raw.version) > SCHEMA_VERSION) {
    return { ok: false, reason: `备份版本 v${raw.version} 高于当前应用版本 v${SCHEMA_VERSION}` };
  }
  for (const key of ["records", "wrongbook"]) {
    const v = raw[key];
    if (v !== undefined && (typeof v !== "object" || v === null || Array.isArray(v))) {
      return { ok: false, reason: `${key} 字段格式应为对象` };
    }
  }
  const store = migrateIfNeeded(normalize(raw));
  return { ok: true, store, summary: summarize(raw) };
}

function summarize(raw: any): { records: number; wrongbook: number } {
  return {
    records: Object.keys(raw.records ?? {}).length,
    wrongbook: Object.keys(raw.wrongbook ?? {}).length,
  };
}

/** 导入应用：mode = 'replace' | 'merge'（merge 按 lastAt 新者胜） */
export function applyImport(store: QuizStore, mode: "replace" | "merge" = "replace"): QuizStore {
  if (mode === "replace") {
    cache = store;
    baseUpdatedAt = 0;
    saveStore(cache);
    return cache;
  }
  const cur = getStore();
  for (const key of ["records", "wrongbook"] as const) {
    for (const [qid, entry] of Object.entries(store[key] ?? {})) {
      const mine = cur[key][qid] as { lastAt?: number } | undefined;
      const myTime = mine?.lastAt ?? 0;
      const e = entry as RecordEntry & WrongbookEntry;
      const theirTime = e?.lastAt ?? e?.lastWrongAt ?? e?.addedAt ?? 0;
      if (!mine || theirTime > myTime) cur[key][qid] = entry as never;
    }
  }
  saveStore(cur);
  return cur;
}
