/**
 * 错题统一管理类（WrongbookManager）
 *
 * 核心职责：
 * 1. 确保所有题库元数据完整加载（解决延迟按需加载导致的跨库错题被过滤失真问题）；
 * 2. 作为单一事实源（Single Source of Truth），提供错题列表提取、动态题库筛选与计数统计；
 * 3. 统计完全根据用户当前的真实数据计算（不写死任何题库和数字）。
 *
 * 口径说明：
 * - 列表展示的「错 N 次」= 错题本条目的本轮在册次数（wrongCount，移出后重置）；
 * - KPI 概览的「错题总数/已订正」= records 终身累计（wrongAttempts），历史统计不失真。
 */

import { getBanks, getLoadedQuestions, ensureAllBanks, bankShortName } from "../../state";
import { getStore, removeFromWrongbook } from "../../storage";
import { wrongLevel } from "../../goal";
import type { Question, WrongbookEntry } from "../../types";

export interface WrongItem {
  q: Question;
  w: WrongbookEntry;
  wrongAttempts: number;
}

export interface WrongbookFilter {
  bankId?: string;
  type?: string;
}

export interface WrongbookSummary {
  /** 历史累计错题总数 */
  total: number;
  /** 已订正数（最近一次已答对） */
  corrected: number;
  /** 当前待复习数（在册错题） */
  pending: number;
}

export interface BankWrongCount {
  bankId: string;
  bankName: string;
  count: number;
}

export class WrongbookManager {
  /** 确保全部已知题库加载完成 */
  static async ensureReady(): Promise<void> {
    await ensureAllBanks();
  }

  /**
   * 获取按题库/题型过滤后的真实错题列表
   * 排序口径：错误次数降序，上次错误时间降序
   * 次数口径：本条错题「本轮在册」的答错次数（w.wrongCount）——移出错题本后再次答错会从 1 重新计；
   *           不用 records.wrongAttempts（终身累计，永不重置），以免「错 N 次」徽标与档位无法重置。
   */
  static getItems(filter?: WrongbookFilter): WrongItem[] {
    const store = getStore();
    const wrongbook = store?.wrongbook ?? {};
    const allQuestions = getLoadedQuestions();

    const items: WrongItem[] = [];
    for (const q of allQuestions) {
      const w = wrongbook[q.id];
      if (!w) continue;

      // 题库筛选
      if (filter?.bankId && filter.bankId !== "all") {
        const qBank = q.id.split("-")[0];
        if (qBank !== filter.bankId) continue;
      }

      // 题型筛选
      if (filter?.type && filter.type !== "all") {
        if (q.type !== filter.type) continue;
      }

      const wrongAttempts = w.wrongCount ?? 1;
      items.push({ q, w, wrongAttempts });
    }

    return items.sort(
      (a, b) => b.wrongAttempts - a.wrongAttempts || (b.w.lastWrongAt ?? 0) - (a.w.lastWrongAt ?? 0),
    );
  }

  /**
   * 统计每个题库当前在册的错题数量（真实数据计算）
   */
  static getBankCounts(): BankWrongCount[] {
    const store = getStore();
    const wrongbook = store?.wrongbook ?? {};
    const allQuestions = getLoadedQuestions();
    const banks = getBanks();

    const countMap = new Map<string, number>();
    for (const b of banks) countMap.set(b.id, 0);

    for (const q of allQuestions) {
      if (wrongbook[q.id]) {
        const bankId = q.id.split("-")[0];
        if (countMap.has(bankId)) {
          countMap.set(bankId, (countMap.get(bankId) ?? 0) + 1);
        }
      }
    }

    return banks.map((b) => ({
      bankId: b.id,
      bankName: bankShortName(b.id),
      count: countMap.get(b.id) ?? 0,
    }));
  }

  /**
   * 统计错题指标（错题总数 / 已订正 / 待复习）
   */
  static getStats(bankId?: string): WrongbookSummary {
    const store = getStore();
    const records = store?.records ?? {};
    const wrongbook = store?.wrongbook ?? {};
    const allQuestions = getLoadedQuestions();

    let total = 0, corrected = 0, pending = 0;

    for (const q of allQuestions) {
      if (bankId && bankId !== "all") {
        const qBank = q.id.split("-")[0];
        if (qBank !== bankId) continue;
      }

      const rec = records[q.id];
      if ((rec?.wrongAttempts ?? 0) > 0) {
        total++;
        if (rec?.lastCorrect) corrected++;
      }
      if (wrongbook[q.id]) {
        pending++;
      }
    }

    return { total, corrected, pending };
  }

  /** 移出单道错题 */
  static async remove(qid: string): Promise<void> {
    await removeFromWrongbook(qid);
  }
}
