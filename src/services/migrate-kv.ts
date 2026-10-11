/**
 * KV → D1 迁移（一次性切换用）。
 *
 * 两种路径：
 *  1) 批量一次性：users 索引 + user:*:auth + invite:*（首用户触发，meta.kv_migration_done 防重）
 *  2) 懒读穿：quiz_stores 按用户名在首次访问时迁移（避免一次性扫全部大对象）
 *
 * 全部操作幂等（INSERT OR IGNORE / upsert），先写 D1 成功再删 KV 源键，
 * 因此切换窗口内新旧部署并行或不中断都不会丢数据。
 */

import { ensureSchema, getMeta, setMeta } from "./storage-schema";
import type { AuthRecord, QuizStore } from "../types";

const FLAG = "kv_migration_done";

interface LegacyAuthRec {
  id: string;
  username: string;
  passwordHash?: { saltHex?: string; hashHex?: string };
  role?: string;
  createdAt?: number;
}

interface LegacyInvite {
  code: string;
  createdBy: string;
  createdAt: number;
  usedBy?: string | null;
  usedAt?: number | null;
}

let bulkDone: Promise<void> | null = null;

/** 批量一次性迁移（幂等；无 KV 绑定时直接返回） */
export function ensureBulkMigrated(db: D1Database, kv?: KVNamespace): Promise<void> {
  if (!kv) return Promise.resolve();
  if (!bulkDone) {
    bulkDone = doBulk(db, kv).catch((e) => {
      bulkDone = null;   // 失败允许下次重试
      throw e;
    });
  }
  return bulkDone;
}

async function doBulk(db: D1Database, kv: KVNamespace): Promise<void> {
  await ensureSchema(db);
  if ((await getMeta(db, FLAG)) === "1") return;

  const usersRaw = (await kv.get("users", { type: "json" })) as
    | { byUsername?: Record<string, unknown> }
    | null;
  const usernames = usersRaw?.byUsername ? Object.keys(usersRaw.byUsername) : [];

  const stmts: D1PreparedStatement[] = [];
  const sourceKeys: string[] = [];

  for (const username of usernames) {
    const key = `user:${username}:auth`;
    const rec = (await kv.get(key, { type: "json" })) as LegacyAuthRec | null;
    if (!rec) continue;
    stmts.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO users (username, id, password_salt_hex, password_hash_hex, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          rec.username, rec.id,
          rec.passwordHash?.saltHex ?? "", rec.passwordHash?.hashHex ?? "",
          rec.role ?? "user", rec.createdAt ?? Date.now(),
        ),
    );
    sourceKeys.push(key);
  }

  const inviteList = await kv.list({ prefix: "invite:" });
  for (const k of inviteList.keys || []) {
    const inv = (await kv.get(k.name, { type: "json" })) as LegacyInvite | null;
    if (!inv) continue;
    stmts.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO invites (code, created_by, created_at, used_by, used_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(inv.code, inv.createdBy, inv.createdAt, inv.usedBy ?? null, inv.usedAt ?? null),
    );
    sourceKeys.push(k.name);
  }

  if (stmts.length) await db.batch(stmts);

  await setMeta(db, FLAG, "1");

  // 清理源键（D1 已写入）
  await kv.delete("users");
  for (const key of sourceKeys) await kv.delete(key);
  if (sourceKeys.length || usernames.length) {
    console.info(`[migrate] KV→D1 批量迁移完成：users=${usernames.length} invites=${sourceKeys.length - usernames.length}`);
  }
}

/** 懒读穿：D1 缺失时从 KV 迁一条刷题数据 */
export async function readThroughStore(
  db: D1Database,
  kv: KVNamespace | undefined,
  username: string,
): Promise<QuizStore | null> {
  if (!kv) return null;
  const raw = await kv.get(`store:${username}`);
  if (!raw) return null;
  let store: QuizStore;
  try { store = JSON.parse(raw) as QuizStore; } catch { return null; }

  await ensureSchema(db);
  await db
    .prepare(
      "INSERT INTO quiz_stores (username, data, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(username) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
    )
    .bind(username, raw, store.updatedAt ?? Date.now())
    .run();
  await kv.delete(`store:${username}`);
  console.info(`[migrate] 读穿迁移 store:${username}`);
  return store;
}

/** 懒读穿：D1 缺失时从 KV 迁一条用户凭证（兜底批量迁移漏网） */
export async function readThroughUserAuth(
  db: D1Database,
  kv: KVNamespace | undefined,
  username: string,
): Promise<AuthRecord | null> {
  if (!kv) return null;
  const key = `user:${username}:auth`;
  const rec = (await kv.get(key, { type: "json" })) as LegacyAuthRec | null;
  if (!rec) return null;

  await ensureSchema(db);
  await db
    .prepare(
      "INSERT OR IGNORE INTO users (username, id, password_salt_hex, password_hash_hex, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      rec.username, rec.id,
      rec.passwordHash?.saltHex ?? "", rec.passwordHash?.hashHex ?? "",
      rec.role ?? "user", rec.createdAt ?? Date.now(),
    )
    .run();
  await kv.delete(key);
  console.info(`[migrate] 读穿迁移 user:${username}`);
  return {
    id: rec.id,
    username: rec.username,
    passwordHash: { saltHex: rec.passwordHash?.saltHex ?? "", hashHex: rec.passwordHash?.hashHex ?? "" },
    role: (rec.role === "admin" ? "admin" : "user"),
    createdAt: rec.createdAt ?? Date.now(),
  };
}
