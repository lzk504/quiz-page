/** 前端共享类型 */

export type QuestionType = "single" | "multiple" | "judge" | "fill" | "short";

export interface Question {
  id: string;
  type: QuestionType;
  domain: string;
  stem: string;
  /** 选择题为选项数组；fill / short / judge 为 null */
  options: string[] | null;
  /** single=字母 · multiple=字母数组 · judge=布尔 · fill=逐空参考答案 · short=参考答案全文 */
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

/** 题库清单条目（banks.json 的 banks[] 元素） */
export interface BankMeta {
  /** 库前缀：G / P / Y，同时是题目 id 的前缀 */
  id: string;
  title: string;
  /** 相对站点根的题库文件路径，如 data/bank-g.json */
  file: string;
  source?: string;
  domains: string[];
  domainLabels: Record<string, string>;
  /** 目标题量（按题型） */
  typeCounts: Record<string, number>;
  /** 已加载库文件 meta 里的实际计数 */
  counts?: Record<string, number>;
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

/** 收藏条目（v4 新增） */
export interface FavoriteEntry {
  addedAt: number;
}

/** 个人资料（v5 新增）：昵称等随云端同步的个人设置 */
export interface UserProfile {
  nickname?: string;
}

/** 刷题数据（与后端 store schema 同形：v5；后端纯透传，不做校验） */
export interface QuizStore {
  version: number;
  records: Record<string, RecordEntry>;
  wrongbook: Record<string, WrongbookEntry>;
  /** 我的收藏：qid → { addedAt } */
  favorites: Record<string, FavoriteEntry>;
  /** 个人资料（昵称等） */
  profile: UserProfile;
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
