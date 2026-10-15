/**
 * 存储层：内存 cache + 云端（D1）同步。
 *
 * 对外签名与旧 localStorage 版本保持一致（视图层零改动）：
 *   getStore() 同步返回 cache；recordAnswer/removeFromWrongbook 同步返回结果；
 *   saveStore 同步更新 cache + 异步推云端。
 *
 * store 结构（v5，与服务端同形——服务端不透明透传，不做 schema 校验）：
 * {
 *   version: 5,
 *   records:  { [qid]: { attempts, wrongAttempts, lastCorrect, lastUserAnswer, firstAt, lastAt } },
 *   wrongbook:{ [qid]: { wrongCount, addedAt, lastUserAnswer, lastWrongAt } },
 *   favorites:{ [qid]: { addedAt } },
 *   profile:  { nickname? },
 *   updatedAt: number
 * }
 * qid 为三段式（如 G-S001），见 migrate.ts 的 ID_MIGRATION_V3。
 *
 * STORE_KEY 仅用于「首次上云迁移」：从本地旧 v1 数据读出后上云，然后清源。
 */

import { emit } from "./state";
import { migrateV1toV2, migrateV2toV3, migrateV3toV4, migrateV4toV5, type LegacyStore } from "./migrate";
import { apiFetch, isLoggedIn } from "./auth";
import type { FavoriteEntry, Question, QuizStore, RecordEntry, WrongbookEntry, SyncStatus } from "./types";

export const STORE_KEY = "quizapp.data.v1";   // 旧 localStorage key，仅迁移用
export const SCHEMA_VERSION = 5;
/** Chrome 对 keepalive 请求的 body 上限为 64KB，留出余量 */
const KEEPALIVE_MAX_BYTES = 60000;

let available = true;            // localStorage 可用性（token 存取兜底）
let cache: QuizStore | null = null;   // 内存中的 store（同步读源）
let baseUpdatedAt = 0;           // 服务端最近已知 updatedAt（乐观锁基线）
let validIds: Set<string> | null = null;   // 已加载题库 id 集（清理孤儿记录用）
let bankPrefixes = new Set<string>();      // 已知题库前缀（G/P/Y），保护未加载库的记录
let putTimer: ReturnType<typeof setTimeout> | null = null;  // debounce 定时器
let putInFlight = false;         // 是否正在发送 PUT
let putRetry = 0;                // 重试计数
let sync: SyncStatus = { status: "idle", lastSyncAt: 0, error: null };

/* ---------------- 工具 ---------------- */

const emptyStore = (): QuizStore => ({
  version: SCHEMA_VERSION,
  records: {},
  wrongbook: {},
  favorites: {},
  profile: {},
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
  // 保留原始版本号（缺省记 0），以便迁移链判断是否需要升级
  store.version = Number(src.version) || 0;
  store.updatedAt = Number(src.updatedAt) || 0;
  if (src.records && typeof src.records === "object" && !Array.isArray(src.records)) {
    store.records = src.records as Record<string, RecordEntry>;
  }
  if (src.wrongbook && typeof src.wrongbook === "object" && !Array.isArray(src.wrongbook)) {
    store.wrongbook = src.wrongbook as Record<string, WrongbookEntry>;
  }
  if (src.favorites && typeof src.favorites === "object" && !Array.isArray(src.favorites)) {
    store.favorites = src.favorites as Record<string, FavoriteEntry>;
  }
  if (src.profile && typeof src.profile === "object" && !Array.isArray(src.profile)) {
    store.profile = src.profile as QuizStore["profile"];
  }
  return store;
}

/** 版本升级链：v1 → v2 → v3 → v4 → v5（幂等；已是最新版本原样返回） */
function migrateIfNeeded(store: QuizStore | null): QuizStore {
  if (!store) return emptyStore();
  let s = store;
  if ((Number(s.version) || 0) < 2) {
    s = migrateV1toV2(s as unknown as LegacyStore, null);
  }
  if ((Number(s.version) || 0) < 3) {
    s = migrateV2toV3(s, null);
  }
  if ((Number(s.version) || 0) < 4) {
    s = migrateV3toV4(s);
  }
  if ((Number(s.version) || 0) < 5) {
    s = migrateV4toV5(s);
  }
  return s;
}

const bankPrefixOf = (id: string): string => (id.includes("-") ? id.split("-")[0] : "");

/**
 * 剔除无效记录：既不在「已加载题库」中、前缀也不是已知题库的条目。
 * 前缀是已知题库时一定保留 —— 否则未勾选某库（未加载）会误删该库历史记录。
 */
function prune(store: QuizStore): QuizStore {
  if (!validIds) return store;
  const keep = (id: string): boolean => validIds!.has(id) || bankPrefixes.has(bankPrefixOf(id));
  const filter = <T>(map: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(map)) if (keep(k)) out[k] = v;
    return out;
  };
  return { ...store, records: filter(store.records), wrongbook: filter(store.wrongbook), favorites: filter(store.favorites) };
}

/** 归一化 + 迁移 + 清理（云端读取与导入共用的入口） */
function revive(raw: unknown): QuizStore {
  return prune(migrateIfNeeded(normalize(raw)));
}

/** 注入题库 id 集与题库前缀；须在 initStorage() 之前调用 */
export function setValidIds(ids: string[], prefixes: string[] = []): void {
  validIds = new Set(ids);
  bankPrefixes = new Set(prefixes);
}

/* ---------------- 云端读写 ---------------- */

async function loadStoreFromCloud(): Promise<QuizStore> {
  if (!isLoggedIn()) return emptyStore();
  try {
    const data = await apiFetch<{ store: QuizStore | null; updatedAt: number | null }>("/api/store");
    if (data && data.store) {
      const migrated = revive(data.store);
      baseUpdatedAt = data.updatedAt || migrated.updatedAt || 0;
      setSync("ok");
      return migrated;
    }
    // 云端无数据：检查本地是否有旧 v1 数据，首次上云迁移
    const localStore = tryReadLocalLegacy();
    if (localStore) {
      const migrated = revive(localStore);
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
          const merged = mergeWithRemote(revive(remote.store));
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

/** 远端 store 与本地 cache 按「各自的时间戳」新者胜合并 */
function mergeWithRemote(remote: QuizStore): QuizStore {
  const cur = cache ?? emptyStore();
  const merged = emptyStore();
  merged.updatedAt = Math.max(cur.updatedAt || 0, remote.updatedAt || 0);
  // profile 无逐条时间戳：整体取较新的一端
  merged.profile = (remote.updatedAt || 0) > (cur.updatedAt || 0)
    ? { ...(remote.profile ?? {}) }
    : { ...(cur.profile ?? {}) };
  for (const key of ["records", "wrongbook", "favorites"] as const) {
    const out: Record<string, RecordEntry | WrongbookEntry | FavoriteEntry> = { ...(cur[key] || {}) };
    for (const [qid, entry] of Object.entries(remote[key] || {})) {
      const mine = out[qid] as (RecordEntry & WrongbookEntry & FavoriteEntry) | undefined;
      const myTime = mine?.lastAt ?? mine?.lastWrongAt ?? mine?.addedAt ?? 0;
      const e = entry as RecordEntry & WrongbookEntry & FavoriteEntry;
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
  const isEmpty = Object.keys(cache.records).length === 0
    && Object.keys(cache.wrongbook).length === 0
    && Object.keys(cache.favorites).length === 0
    && !cache.profile?.nickname;
  if (isEmpty) return;
  try {
    const body = JSON.stringify({ store: cache, baseUpdatedAt });
    const headers = {
      "Content-Type": "application/json",
      ...getTokenHeader(),
    };
    if (body.length > KEEPALIVE_MAX_BYTES) {
      // 题量/记录变多后 body 可能超过 keepalive 的 64KB 上限（Chrome）：
      // 降级为普通请求，交给常规 debounce PUT 兜底。
      fetch("/api/store", { method: "PUT", headers, body }).catch(() => {});
    } else {
      // keepalive:true 允许页面卸载后请求仍发出
      fetch("/api/store", { method: "PUT", headers, body, keepalive: true }).catch(() => {});
    }
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

  if (!isCorrect) {
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

/* ---------------- 我的收藏 ---------------- */

export const isFavorite = (questionId: string): boolean => !!getStore().favorites[questionId];

export function addFavorite(questionId: string): boolean {
  const store = getStore();
  if (store.favorites[questionId]) return false;
  store.favorites[questionId] = { addedAt: Date.now() };
  saveStore(store);
  return true;
}

export function removeFavorite(questionId: string): boolean {
  const store = getStore();
  if (!store.favorites[questionId]) return false;
  delete store.favorites[questionId];
  saveStore(store);
  return true;
}

/** 切换收藏态，返回切换后的状态（true = 已收藏） */
export function toggleFavorite(questionId: string): boolean {
  return isFavorite(questionId) ? (removeFavorite(questionId), false) : (addFavorite(questionId), true);
}

/* ---------------- 个人资料（昵称） ---------------- */

/** 昵称长度上限（字符） */
export const NICKNAME_MAX = 12;

/** 当前昵称（未设置返回空串；视图层回退为用户名） */
export function getNickname(): string {
  const n = getStore().profile?.nickname;
  return typeof n === "string" ? n.trim() : "";
}

/** 设置昵称：去空白 + 截断；空串 = 清除。返回生效的昵称。 */
export function setNickname(name: string): string {
  const store = getStore();
  const nick = String(name ?? "").trim().slice(0, NICKNAME_MAX);
  store.profile = { ...(store.profile ?? {}) };
  if (nick) store.profile.nickname = nick;
  else delete store.profile.nickname;
  saveStore(store);
  return nick;
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
  summary?: { records: number; wrongbook: number; favorites: number };
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
  for (const key of ["records", "wrongbook", "favorites", "profile"]) {
    const v = raw[key];
    if (v !== undefined && (typeof v !== "object" || v === null || Array.isArray(v))) {
      return { ok: false, reason: `${key} 字段格式应为对象` };
    }
  }
  const store = revive(raw);
  return { ok: true, store, summary: summarize(raw) };
}

function summarize(raw: any): { records: number; wrongbook: number; favorites: number } {
  return {
    records: Object.keys(raw.records ?? {}).length,
    wrongbook: Object.keys(raw.wrongbook ?? {}).length,
    favorites: Object.keys(raw.favorites ?? {}).length,
  };
}

/** 导入应用：mode = 'replace' | 'merge'（merge 按各自时间戳新者胜） */
export function applyImport(store: QuizStore, mode: "replace" | "merge" = "replace"): QuizStore {
  if (mode === "replace") {
    cache = store;
    baseUpdatedAt = 0;
    saveStore(cache);
    return cache;
  }
  const cur = getStore();
  for (const key of ["records", "wrongbook", "favorites"] as const) {
    for (const [qid, entry] of Object.entries(store[key] ?? {})) {
      const mine = cur[key][qid] as { lastAt?: number } | undefined;
      const myTime = mine?.lastAt ?? 0;
      const e = entry as RecordEntry & WrongbookEntry & FavoriteEntry;
      const theirTime = e?.lastAt ?? e?.lastWrongAt ?? e?.addedAt ?? 0;
      if (!mine || theirTime > myTime) cur[key][qid] = entry as never;
    }
  }
  // 昵称：本机未设置时才采纳导入值（避免覆盖本机偏好）
  if (!cur.profile?.nickname && store.profile?.nickname) {
    cur.profile = { ...(cur.profile ?? {}), nickname: store.profile.nickname };
  }
  saveStore(cur);
  return cur;
}
