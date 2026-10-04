/**
 * localStorage v1 → v2 迁移。
 *
 * 背景：题库 v2 把 16 道填空题改写为单选题（F01-F16 → S25-S40），
 * 并删除了简答题（SA*）、S02/S05/S06/J04。v2 store 结构移除 recite 表。
 *
 * 迁移规则：
 *  - records / wrongbook 的 key 按 ID_MIGRATION 重映射（保留统计，丢弃旧的 lastUserAnswer）
 *  - 重映射后仍不在题库中的条目（已删除题、孤儿 id）丢弃；validIds 未注入时只映射不剔除
 *  - recite 表不拷贝
 */

export const ID_MIGRATION = {
  F01: "S25", F02: "S26", F03: "S27", F04: "S28",
  F05: "S29", F06: "S30", F07: "S31", F08: "S32",
  F09: "S33", F10: "S34", F11: "S35", F12: "S36",
  F13: "S37", F14: "S38", F15: "S39", F16: "S40",
};

/**
 * @param {object} old v1 store（含 records/wrongbook/recite）
 * @param {Set<string>|null} validIds 当前题库 id 集；null 时只映射不剔除
 * @returns {object} v2 store
 */
export function migrateV1toV2(old, validIds = null) {
  const keep = (nid) => !validIds || validIds.has(nid);
  const out = { version: 2, records: {}, wrongbook: {}, updatedAt: old?.updatedAt ?? 0 };

  for (const [qid, rec] of Object.entries(old?.records ?? {})) {
    const nid = ID_MIGRATION[qid] ?? qid;
    if (!keep(nid)) continue;
    const prev = out.records[nid];
    if (prev && (prev.lastAt ?? 0) >= (rec?.lastAt ?? 0)) continue;   // 冲突新者胜
    out.records[nid] = {
      attempts: rec?.attempts ?? 0,
      wrongAttempts: rec?.wrongAttempts ?? 0,
      lastCorrect: !!rec?.lastCorrect,
      firstAt: rec?.firstAt ?? 0,
      lastAt: rec?.lastAt ?? 0,
      // lastUserAnswer 故意丢弃：填空旧值是数组，迁移后无法回显
    };
  }

  for (const [qid, w] of Object.entries(old?.wrongbook ?? {})) {
    const nid = ID_MIGRATION[qid] ?? qid;
    if (!keep(nid)) continue;
    const prev = out.wrongbook[nid];
    if (prev && (prev.lastWrongAt ?? 0) >= (w?.lastWrongAt ?? 0)) continue;
    out.wrongbook[nid] = {
      wrongCount: w?.wrongCount ?? 1,
      addedAt: w?.addedAt ?? 0,
      lastWrongAt: w?.lastWrongAt ?? 0,
    };
  }

  return out;
}
