/**
 * D1 schema：DDL 常量 + 幂等初始化。
 *
 * 首次请求自动建表（对齐 nodewarden 的 storage-schema 模式）：
 *   - DDL 全部 IF NOT EXISTS，天然幂等
 *   - module 级 Promise 缓存，每个 isolate 只执行一次
 *   - 失败时清空缓存，下次请求重试
 */

/** D1 建表语句（顺序敏感：无外键依赖，但保持可读性） */
export const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    username           TEXT PRIMARY KEY,
    id                 TEXT NOT NULL,
    password_salt_hex  TEXT NOT NULL,
    password_hash_hex  TEXT NOT NULL,
    role               TEXT NOT NULL CHECK (role IN ('admin','user')),
    created_at         INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS invites (
    code       TEXT PRIMARY KEY,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used_by    TEXT,
    used_at    INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_invites_created_at ON invites(created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS quiz_stores (
    username   TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

let schemaReady: Promise<void> | null = null;

/** 幂等初始化 D1 schema（每 isolate 只跑一次 DDL） */
export function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = db
      .batch(DDL.map((sql) => db.prepare(sql)))
      .then(() => undefined)
      .catch((e) => {
        schemaReady = null;   // 失败允许下次重试
        throw e;
      });
  }
  return schemaReady;
}

/** meta 表读写助手 */
export async function getMeta(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setMeta(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}
