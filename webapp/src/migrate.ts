/**
 * 旧版数据迁移。
 *
 * v1 → v2：题库 v2 把 16 道填空题改写为单选题（F01-F16 → S25-S40），
 *          并删除简答题（SA*）、S02/S05/S06/J04。v2 store 结构移除 recite 表。
 * v2 → v3：题库拆为三个库，旧 68 题并入指南库 G，id 加库前缀并统一三位序号
 *          （S01 → G-S001）。编号不变（跳号不复活），只重映射 key，不动作答数据。
 * v3 → v4：新增 favorites（我的收藏），表为空；records / wrongbook 原样保留。
 * v4 → v5：新增 profile（个人资料：昵称等），缺省补空对象。
 *
 * 迁移规则：
 *  - records / wrongbook 的 key 按映射表重命名，统计口径（attempts/lastCorrect）原样保留
 *  - 重映射后仍不在题库中的条目（已删除题、孤儿 id）丢弃；validIds 未注入时只映射不剔除
 *  - v1→v2 丢弃旧的 lastUserAnswer（填空旧值是数组，重映射后无法回显）；v2→v3 保留
 */

import type { QuizStore, RecordEntry, WrongbookEntry } from "./types";

export const ID_MIGRATION: Record<string, string> = {
  F01: "S25", F02: "S26", F03: "S27", F04: "S28",
  F05: "S29", F06: "S30", F07: "S31", F08: "S32",
  F09: "S33", F10: "S34", F11: "S35", F12: "S36",
  F13: "S37", F14: "S38", F15: "S39", F16: "S40",
};

/** v2 旧 id 段中已删除的编号（跳号不复活） */
const V2_SINGLE_SKIPPED = new Set(["02", "05", "06"]);
const V2_JUDGE_SKIPPED = new Set(["04"]);

/**
 * v2 → v3：旧 68 题并入指南库 G。
 * 规则：旧号段编号保持不变，位数统一补零为三位（S01 → G-S001）。
 * 覆盖号段：S01-S47（44 题，缺 02/05/06）、M01-M10（10 题）、J01-J15（14 题，缺 04）。
 */
export const ID_MIGRATION_V3: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  const pad3 = (n: number): string => String(n).padStart(3, "0");
  const pad2 = (n: number): string => String(n).padStart(2, "0");

  for (let n = 1; n <= 47; n++) {
    const two = pad2(n);
    if (!V2_SINGLE_SKIPPED.has(two)) map[`S${two}`] = `G-S${pad3(n)}`;
  }
  for (let n = 1; n <= 10; n++) {
    map[`M${pad2(n)}`] = `G-M${pad3(n)}`;
  }
  for (let n = 1; n <= 15; n++) {
    const two = pad2(n);
    if (!V2_JUDGE_SKIPPED.has(two)) map[`J${two}`] = `G-J${pad3(n)}`;
  }
  return map;
})();

interface LegacyEntry {
  attempts?: number;
  wrongAttempts?: number;
  lastCorrect?: boolean;
  lastUserAnswer?: unknown;
  firstAt?: number;
  lastAt?: number;
  wrongCount?: number;
  addedAt?: number;
  lastWrongAt?: number;
}

export interface LegacyStore {
  version?: number;
  records?: Record<string, LegacyEntry>;
  wrongbook?: Record<string, LegacyEntry>;
  favorites?: Record<string, LegacyEntry>;
  profile?: { nickname?: string };
  recite?: Record<string, unknown>;
  updatedAt?: number;
}

/**
 * @param old v1 store（含 records/wrongbook/recite）
 * @param validIds 当前题库 id 集；null 时只映射不剔除
 */
export function migrateV1toV2(old: LegacyStore | null | undefined, validIds: Set<string> | null = null): QuizStore {
  const keep = (nid: string): boolean => !validIds || validIds.has(nid);
  const out: QuizStore = { version: 2, records: {}, wrongbook: {}, favorites: {}, profile: {}, updatedAt: old?.updatedAt ?? 0 };

  for (const [qid, rec] of Object.entries(old?.records ?? {})) {
    const nid = ID_MIGRATION[qid] ?? qid;
    if (!keep(nid)) continue;
    const prev = out.records[nid];
    if (prev && (prev.lastAt ?? 0) >= (rec?.lastAt ?? 0)) continue;   // 冲突新者胜
    const entry: RecordEntry = {
      attempts: rec?.attempts ?? 0,
      wrongAttempts: rec?.wrongAttempts ?? 0,
      lastCorrect: !!rec?.lastCorrect,
      firstAt: rec?.firstAt ?? 0,
      lastAt: rec?.lastAt ?? 0,
      // lastUserAnswer 故意丢弃：填空旧值是数组，迁移后无法回显
    };
    out.records[nid] = entry;
  }

  for (const [qid, w] of Object.entries(old?.wrongbook ?? {})) {
    const nid = ID_MIGRATION[qid] ?? qid;
    if (!keep(nid)) continue;
    const prev = out.wrongbook[nid];
    if (prev && (prev.lastWrongAt ?? 0) >= (w?.lastWrongAt ?? 0)) continue;
    const entry: WrongbookEntry = {
      wrongCount: w?.wrongCount ?? 1,
      addedAt: w?.addedAt ?? 0,
      lastWrongAt: w?.lastWrongAt ?? 0,
    };
    out.wrongbook[nid] = entry;
  }

  return out;
}

/**
 * v2 → v3：旧 id 加库前缀（S01 → G-S001）。
 *
 * @param old v2 store
 * @param validIds 当前题库 id 集；null 时只映射不剔除
 */
export function migrateV2toV3(old: QuizStore | null | undefined, validIds: Set<string> | null = null): QuizStore {
  const keep = (nid: string): boolean => !validIds || validIds.has(nid);
  const out: QuizStore = { version: 3, records: {}, wrongbook: {}, favorites: {}, profile: {}, updatedAt: old?.updatedAt ?? 0 };
  const src = old as unknown as LegacyStore | null | undefined;

  for (const [qid, rec] of Object.entries(src?.records ?? {})) {
    // 已是新格式（含库前缀）的 id 原样保留，只对旧段做映射
    const nid = ID_MIGRATION_V3[qid] ?? qid;
    if (!keep(nid)) continue;
    const prev = out.records[nid];
    if (prev && (prev.lastAt ?? 0) >= (rec?.lastAt ?? 0)) continue;   // 冲突新者胜
    const entry: RecordEntry = {
      attempts: rec?.attempts ?? 0,
      wrongAttempts: rec?.wrongAttempts ?? 0,
      lastCorrect: !!rec?.lastCorrect,
      firstAt: rec?.firstAt ?? 0,
      lastAt: rec?.lastAt ?? 0,
    };
    if (rec && "lastUserAnswer" in rec) entry.lastUserAnswer = rec.lastUserAnswer;
    out.records[nid] = entry;
  }

  for (const [qid, w] of Object.entries(src?.wrongbook ?? {})) {
    const nid = ID_MIGRATION_V3[qid] ?? qid;
    if (!keep(nid)) continue;
    const prev = out.wrongbook[nid];
    if (prev && (prev.lastWrongAt ?? 0) >= (w?.lastWrongAt ?? 0)) continue;
    const entry: WrongbookEntry = {
      wrongCount: w?.wrongCount ?? 1,
      addedAt: w?.addedAt ?? 0,
      lastWrongAt: w?.lastWrongAt ?? 0,
    };
    if (w && "lastUserAnswer" in w) entry.lastUserAnswer = w.lastUserAnswer;
    out.wrongbook[nid] = entry;
  }

  return out;
}

/**
 * v3 → v4：新增 favorites（我的收藏）。
 * 只补空表，records / wrongbook 原样保留；已有的 favorites（如跨端回灌 v4）原样透传。
 */
export function migrateV3toV4(old: QuizStore | null | undefined): QuizStore {
  const src = (old ?? {}) as Partial<QuizStore>;
  const favorites: QuizStore["favorites"] = {};
  for (const [qid, f] of Object.entries(src.favorites ?? {})) {
    if (!f || typeof f !== "object") continue;
    favorites[qid] = { addedAt: Number((f as { addedAt?: number }).addedAt) || 0 };
  }
  return {
    version: 4,
    records: (src.records ?? {}) as QuizStore["records"],
    wrongbook: (src.wrongbook ?? {}) as QuizStore["wrongbook"],
    favorites,
    profile: {},
    updatedAt: Number(src.updatedAt) || 0,
  };
}

/**
 * v4 → v5：新增 profile（个人资料：昵称等）。
 * 只补空对象；已有的 profile（如跨端回灌 v5）原样透传。
 */
export function migrateV4toV5(old: QuizStore | null | undefined): QuizStore {
  const src = (old ?? {}) as Partial<QuizStore>;
  const profile: QuizStore["profile"] = {};
  const nick = src.profile?.nickname;
  if (typeof nick === "string" && nick.trim()) profile.nickname = nick.trim();
  return {
    version: 5,
    records: (src.records ?? {}) as QuizStore["records"],
    wrongbook: (src.wrongbook ?? {}) as QuizStore["wrongbook"],
    favorites: (src.favorites ?? {}) as QuizStore["favorites"],
    profile,
    updatedAt: Number(src.updatedAt) || 0,
  };
}
