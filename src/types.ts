/** 后端共享类型定义 */

/** 用户角色 */
export type Role = "admin" | "user";

/** 单用户凭证记录（KV: user:<u>:auth） */
export interface AuthRecord {
  id: string;
  username: string;
  passwordHash: { saltHex: string; hashHex: string };
  role: Role;
  createdAt: number;
}

/** 邀请码（KV: invite:<code>） */
export interface Invite {
  code: string;
  createdBy: string;
  createdAt: number;
  usedBy: string | null;
  usedAt: number | null;
}

/** 用户表（KV: users）—— blob 式用户索引 */
export interface UsersTable {
  version: number;
  count: number;
  byUsername: Record<string, { id: string; role: Role; createdAt: number }>;
}

/** 单用户刷题数据（KV: store:<u>），与前端 v2 schema 同形 */
export interface QuizStore {
  version: number;
  records: Record<string, unknown>;
  wrongbook: Record<string, unknown>;
  updatedAt: number;
}

/** JWT payload */
export interface JwtPayload {
  sub: string;
  role: Role;
  iat: number;
  exp: number;
}

/** Worker 环境绑定 */
export interface Env {
  /** D1 存储绑定（唯一存储后端） */
  DB?: D1Database;
  /** KV 绑定（每日访问限额计数，24h TTL；可选，未绑定时限频静默放行） */
  RATE_LIMITS?: KVNamespace;
  /** 静态资产绑定 */
  ASSETS: Fetcher;
  /** 30+ 字符随机串，runtime secret 注入 */
  JWT_SECRET: string;
  /** "1" 时隐藏 Web 前端（非 /api 路径返回 404） */
  HIDE_WEB_VAULT?: string;
  /** "1" 时启用 POST /__dev/reset（仅本地 .dev.vars 开启） */
  ALLOW_DEV_RESET?: string;
}

/** 新用户建档入参（role 由存储层按首用户判定，密码哈希由调用方算好传入） */
export interface NewUserRec {
  id: string;
  username: string;
  passwordHash: { saltHex: string; hashHex: string };
  createdAt: number;
}

/** registerUser 结果：错误原因与 HTTP 状态一一映射 */
export type RegisterResult =
  | { ok: true; role: Role }
  | { ok: false; reason: "conflict" | "invite_required" | "invite_invalid" | "invite_used" };

/** 全量备份数据（admin 导出用） */
export interface BackupData {
  version: 1;
  exportedAt: number;
  users: Array<{
    username: string;
    id: string;
    role: Role;
    createdAt: number;
    passwordHash: { saltHex: string; hashHex: string };
  }>;
  invites: Invite[];
  stores: Record<string, QuizStore>;
}

/**
 * 存储接口：业务代码只依赖本接口，不触碰 D1 原语。
 * 实现：D1Store（D1 模式）
 */
export interface Store {
  // 用户
  /** 用户总数（bootstrap 判首用户用） */
  getUserCount(): Promise<number>;
  getUserAuth(username: string): Promise<AuthRecord | null>;
  /**
   * 原子建号：内部判定首用户角色、校验邀请码、查重。
   * 错误优先级与历史行为一致：conflict(409) → invite_required(400) → invite_invalid/invite_used(403)
   */
  registerUser(rec: NewUserRec, inviteCode?: string): Promise<RegisterResult>;
  // 邀请码
  getInvite(code: string): Promise<Invite | null>;
  createInvite(invite: Invite): Promise<void>;
  listInvites(): Promise<Invite[]>;
  // 刷题数据
  getStore(username: string): Promise<QuizStore | null>;
  putStore(username: string, store: QuizStore): Promise<void>;
  deleteStore(username: string): Promise<void>;
  // 备份
  exportAll(): Promise<BackupData>;
}

/** 请求上下文 */
export interface Ctx {
  request: Request;
  env: Env;
  store: Store;
  url: URL;
  method: string;
  path: string;
  user: JwtPayload | null;
}
