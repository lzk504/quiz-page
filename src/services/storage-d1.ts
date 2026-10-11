/**
 * D1 存储实现（唯一后端）。
 *
 * 关键设计：
 *   - registerUser 用 `db.batch()` 事务保证「建号 + 核销邀请码」原子性
 *   - 用户名唯一约束兜底并发注册竞态
 *   - 邀请码核销 UPDATE 带 `used_by IS NULL` 守卫，changes=0 即判定被并发抢用
 */

import { ensureSchema } from "./storage-schema";
import type {
  AuthRecord, BackupData, Invite, NewUserRec, QuizStore,
  RegisterResult, Role, Store,
} from "../types";

interface UserRow {
  username: string;
  id: string;
  password_salt_hex: string;
  password_hash_hex: string;
  role: Role;
  created_at: number;
}

interface InviteRow {
  code: string;
  created_by: string;
  created_at: number;
  used_by: string | null;
  used_at: number | null;
}

function rowToAuth(row: UserRow): AuthRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: { saltHex: row.password_salt_hex, hashHex: row.password_hash_hex },
    role: row.role,
    createdAt: row.created_at,
  };
}

function rowToInvite(row: InviteRow): Invite {
  return {
    code: row.code,
    createdBy: row.created_by,
    createdAt: row.created_at,
    usedBy: row.used_by,
    usedAt: row.used_at,
  };
}

export class D1Store implements Store {
  constructor(private db: D1Database) {}

  /** schema 初始化（module 级缓存，首次调用后零开销） */
  private async ready(): Promise<void> {
    await ensureSchema(this.db);
  }

  /* ---------------- 用户 ---------------- */

  async getUserCount(): Promise<number> {
    await this.ready();
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    return row?.n ?? 0;
  }

  async getUserAuth(username: string): Promise<AuthRecord | null> {
    await this.ready();
    const row = await this.db
      .prepare("SELECT * FROM users WHERE username = ?")
      .bind(username)
      .first<UserRow>();
    return row ? rowToAuth(row) : null;
  }

  async registerUser(rec: NewUserRec, inviteCode?: string): Promise<RegisterResult> {
    await this.ready();

    const countRow = await this.db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    const isFirst = (countRow?.n ?? 0) === 0;

    // 查重先于邀请码校验（保持与原 409 优先级一致）
    const dup = await this.db.prepare("SELECT 1 AS x FROM users WHERE username = ?").bind(rec.username).first();
    if (dup) return { ok: false, reason: "conflict" };

    let invite: Invite | null = null;
    if (!isFirst) {
      if (!inviteCode) return { ok: false, reason: "invite_required" };
      invite = await this.getInvite(inviteCode);
      if (!invite) return { ok: false, reason: "invite_invalid" };
      if (invite.usedBy) return { ok: false, reason: "invite_used" };
    }

    const role: Role = isFirst ? "admin" : "user";
    const stmts: D1PreparedStatement[] = [
      this.db
        .prepare(
          "INSERT INTO users (username, id, password_salt_hex, password_hash_hex, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(rec.username, rec.id, rec.passwordHash.saltHex, rec.passwordHash.hashHex, role, rec.createdAt),
    ];
    if (invite) {
      stmts.push(
        this.db
          .prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL")
          .bind(rec.username, Date.now(), invite.code),
      );
    }

    let results: D1Result[];
    try {
      results = await this.db.batch(stmts);
    } catch {
      // 唯一约束兜底并发注册
      return { ok: false, reason: "conflict" };
    }

    if (invite) {
      const changes = results[1]?.meta?.changes ?? 0;
      if (changes === 0) {
        // 并发抢用同一邀请码的极端窗口：回滚刚建的号
        await this.db.prepare("DELETE FROM users WHERE username = ?").bind(rec.username).run();
        return { ok: false, reason: "invite_used" };
      }
    }
    return { ok: true, role };
  }

  /* ---------------- 邀请码 ---------------- */

  async getInvite(code: string): Promise<Invite | null> {
    await ensureSchema(this.db);
    const row = await this.db
      .prepare("SELECT * FROM invites WHERE code = ?")
      .bind(code)
      .first<InviteRow>();
    return row ? rowToInvite(row) : null;
  }

  async createInvite(invite: Invite): Promise<void> {
    await this.putInvite(invite);
  }

  async putInvite(invite: Invite): Promise<void> {
    await ensureSchema(this.db);
    await this.db
      .prepare(
        "INSERT INTO invites (code, created_by, created_at, used_by, used_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(code) DO UPDATE SET used_by = excluded.used_by, used_at = excluded.used_at",
      )
      .bind(invite.code, invite.createdBy, invite.createdAt, invite.usedBy, invite.usedAt)
      .run();
  }

  async listInvites(): Promise<Invite[]> {
    await ensureSchema(this.db);
    const { results } = await this.db
      .prepare("SELECT * FROM invites ORDER BY created_at DESC")
      .all<InviteRow>();
    return (results ?? []).map(rowToInvite);
  }

  /* ---------------- 刷题数据 ---------------- */

  async getStore(username: string): Promise<QuizStore | null> {
    await this.ready();
    const row = await this.db
      .prepare("SELECT data FROM quiz_stores WHERE username = ?")
      .bind(username)
      .first<{ data: string }>();
    if (!row) return null;
    try { return JSON.parse(row.data) as QuizStore; } catch { return null; }
  }

  async putStore(username: string, store: QuizStore): Promise<void> {
    await ensureSchema(this.db);
    await this.db
      .prepare(
        "INSERT INTO quiz_stores (username, data, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(username) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
      )
      .bind(username, JSON.stringify(store), store.updatedAt ?? Date.now())
      .run();
  }

  async deleteStore(username: string): Promise<void> {
    await ensureSchema(this.db);
    await this.db.prepare("DELETE FROM quiz_stores WHERE username = ?").bind(username).run();
  }

  /* ---------------- 备份 ---------------- */

  async exportAll(): Promise<BackupData> {
    await ensureSchema(this.db);

    const usersRes = await this.db.prepare("SELECT * FROM users ORDER BY created_at").all<UserRow>();
    const users: BackupData["users"] = (usersRes.results ?? []).map((row) => ({
      username: row.username,
      id: row.id,
      role: row.role,
      createdAt: row.created_at,
      passwordHash: { saltHex: row.password_salt_hex, hashHex: row.password_hash_hex },
    }));

    const invitesRes = await this.db.prepare("SELECT * FROM invites ORDER BY created_at DESC").all<InviteRow>();
    const invites = (invitesRes.results ?? []).map(rowToInvite);

    const storesRes = await this.db.prepare("SELECT username, data FROM quiz_stores").all<{ username: string; data: string }>();
    const stores: Record<string, QuizStore> = {};
    for (const row of storesRes.results ?? []) {
      try { stores[row.username] = JSON.parse(row.data) as QuizStore; } catch { /* skip */ }
    }

    return { version: 1, exportedAt: Date.now(), users, invites, stores };
  }
}
