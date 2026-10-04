/**
 * 本地存储层：localStorage 单 key 持久化 + 降级 + 导入导出。
 *
 * store 结构（v2）：
 * {
 *   version: 2,
 *   records:  { [qid]: { attempts, wrongAttempts, lastCorrect, lastUserAnswer, firstAt, lastAt } },
 *   wrongbook:{ [qid]: { wrongCount, addedAt, lastUserAnswer, lastWrongAt } },
 *   updatedAt: number
 * }
 *
 * v1 → v2：题库重构（填空改单选、删简答）后的自动迁移，见 js/migrate.js。
 * STORE_KEY 保持 "quizapp.data.v1" 不变：就地升级，避免新旧两份数据并存。
 */

import { emit } from "./state.js";
import { migrateV1toV2 } from "./migrate.js";

export const STORE_KEY = "quizapp.data.v1";   // key 名不变（历史原因带 v1 后缀）
export const SCHEMA_VERSION = 2;

let available = true;
let memory = null;   // localStorage 不可用时的会话内降级存储
let validIds = null; // 当前题库 id 集（main.js 在题库加载后注入，用于迁移时剔除孤儿记录）

/** 注入题库 id 集；须在 initStorage() 之前调用，否则迁移只映射 id 不剔除孤儿 */
export function setValidIds(ids) {
  validIds = new Set(ids);
}

const emptyStore = () => ({
  version: SCHEMA_VERSION,
  records: {},
  wrongbook: {},
  updatedAt: 0,
});

/* ---------------- 可用性 & 读写 ---------------- */

function probe() {
  try {
    const k = "__quizapp_probe__";
    localStorage.setItem(k, "1");
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

/** 结构校验与修补：脏数据不静默吞掉，而是补齐字段并告警 */
function normalize(raw) {
  if (!raw || typeof raw !== "object") return null;
  const store = emptyStore();
  store.version = Number(raw.version) || SCHEMA_VERSION;
  store.updatedAt = Number(raw.updatedAt) || 0;
  for (const key of ["records", "wrongbook"]) {
    const src = raw[key];
    if (src && typeof src === "object" && !Array.isArray(src)) store[key] = src;
  }
  return store;
}

/** 旧版本数据就地迁移（v1 → v2） */
function migrateIfNeeded(store) {
  if (!store || store.version >= SCHEMA_VERSION) return store;
  return migrateV1toV2(store, validIds);
}

export function loadStore() {
  if (!available) {
    if (!memory) memory = emptyStore();
    return memory;
  }
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return emptyStore();
    const parsed = normalize(JSON.parse(raw));
    if (!parsed) {
      console.warn("[storage] 数据格式异常，已重置");
      return emptyStore();
    }
    const migrated = migrateIfNeeded(parsed);
    if (migrated !== parsed) {
      console.info("[storage] 已从 v1 迁移到 v2（填空题记录已映射为新 id，背诵记录已移除）");
      saveStore(migrated, { silent: true });
    }
    return migrated;
  } catch (e) {
    console.warn("[storage] 读取失败，已重置", e);
    return emptyStore();
  }
}

let cache = null;

export function getStore() {
  if (!cache) cache = loadStore();
  return cache;
}

export function saveStore(store = getStore(), { silent = false } = {}) {
  store.updatedAt = Date.now();
  cache = store;
  if (!available) {
    memory = store;
    if (!silent) emit("store-changed", store);
    return true;
  }
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
    if (!silent) emit("store-changed", store);
    return true;
  } catch (e) {
    // 配额超限或被禁用：切到内存模式并提示
    console.warn("[storage] 写入失败，切换为内存模式", e);
    available = false;
    memory = store;
    emit("storage-broken", e);
    return false;
  }
}

export const isPersistent = () => available;

export function initStorage() {
  available = probe();
  if (!available) emit("storage-broken", new Error("localStorage 不可用"));
  cache = loadStore();
  return available;
}

/* ---------------- 业务写入 ---------------- */

/**
 * 记录一次作答。答对时若在错题本中则移出；答错则收录进错题本。
 * @returns {{isCorrect:boolean, enteredWrongbook:boolean, leftWrongbook:boolean}}
 */
export function recordAnswer(question, userAnswer, isCorrect) {
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

export function removeFromWrongbook(questionId) {
  const store = getStore();
  if (!store.wrongbook[questionId]) return false;
  delete store.wrongbook[questionId];
  saveStore(store);
  return true;
}

export function clearAll() {
  cache = emptyStore();
  memory = cache;
  if (available) {
    try {
      localStorage.removeItem(STORE_KEY);
    } catch { /* ignore */ }
  }
  emit("store-changed", cache);
  return true;
}

/** 导出：返回可下载的 JSON 文本 */
export function exportJson() {
  return JSON.stringify(getStore(), null, 2);
}

/**
 * 导入校验：返回 { ok, store?, reason? }
 * 只做结构与类型校验，不触碰现有数据。v1 旧备份会自动迁移为 v2。
 */
export function validateImport(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "不是合法的 JSON 文件" };
  }
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

function summarize(raw) {
  return {
    records: Object.keys(raw.records ?? {}).length,
    wrongbook: Object.keys(raw.wrongbook ?? {}).length,
    legacyRecite: Object.keys(raw.recite ?? {}).length,   // v1 背诵记录，导入后丢弃
  };
}

/** 导入应用：mode = 'replace' | 'merge'（merge 按 lastAt 新者胜） */
export function applyImport(store, mode = "replace") {
  if (mode === "replace") {
    cache = store;
    saveStore(cache);
    return cache;
  }
  const cur = getStore();
  for (const key of ["records", "wrongbook"]) {
    for (const [qid, entry] of Object.entries(store[key] ?? {})) {
      const mine = cur[key][qid];
      const myTime = mine?.lastAt ?? 0;
      const theirTime = entry?.lastAt ?? entry?.lastWrongAt ?? entry?.addedAt ?? 0;
      if (!mine || theirTime > myTime) cur[key][qid] = entry;
    }
  }
  saveStore(cur);
  return cur;
}
