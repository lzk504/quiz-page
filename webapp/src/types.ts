/** 前端共享类型 */

export type QuestionType = "single" | "multiple" | "judge";

export interface Question {
  id: string;
  type: QuestionType;
  domain: string;
  stem: string;
  options: string[] | null;
  answer: string | string[] | boolean;
  analysis: string;
}

export interface Meta {
  title?: string;
  source?: string;
  version?: number;
  generatedAt?: string;
  counts?: Record<string, number>;
  domainLabels?: Record<string, string>;
}

/** 单题作答记录 */
export interface RecordEntry {
  attempts: number;
  wrongAttempts: number;
  lastCorrect: boolean;
  lastUserAnswer?: unknown;
  firstAt: number;
  lastAt: number;
}

/** 错题本条目 */
export interface WrongbookEntry {
  wrongCount: number;
  addedAt: number;
  lastUserAnswer?: unknown;
  lastWrongAt: number;
}

/** 刷题数据（与后端 v2 schema 同形） */
export interface QuizStore {
  version: number;
  records: Record<string, RecordEntry>;
  wrongbook: Record<string, WrongbookEntry>;
  updatedAt: number;
}

export interface AuthUser {
  id: string;
  username: string;
  role: "admin" | "user";
  createdAt: number;
}

/** 邀请码（后端 invite 记录的前端展示形态） */
export interface Invite {
  code: string;
  createdBy: string;
  createdAt: number;
  usedBy: string | null;
  usedAt: number | null;
}

export type SyncState = "idle" | "ok" | "pending" | "error";

export interface SyncStatus {
  status: SyncState;
  lastSyncAt: number;
  error: string | null;
}

/** 路由视图接口 */
export interface View {
  render(root: HTMLElement, params?: Record<string, string>): void | Promise<void>;
  unmount?(): void;
}

/** 题目答案的统一访问助手（answer 字段是联合类型） */
export const answerLetters = (q: Question): string[] =>
  Array.isArray(q.answer) ? q.answer.map((x) => String(x)) : [String(q.answer)];
