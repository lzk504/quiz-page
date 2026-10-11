/**
 * KV 存储实现（KV 模式 / D1 模式的迁移源）。
 *
 * ⚠️ KV key 命名是「公开契约」，与既有线上数据一一对应，逐字不可改：
 *   users          用户表（{version,count,byUsername}）
 *   user:<u>:auth  单用户凭证（含密码哈希）
 *   invite:<code>  一次性邀请码
 *   store:<u>      单用户刷题数据（与前端 v2 schema 同形）
 *
 * 注意：registerUser 在此模式下是「三次独立写」，非原子（与历史行为一致）；
 * D1 模式用事务保证原子性。
 */

import type {
  AuthRecord, BackupData, Invite, NewUserRec, QuizStore,
  RegisterResult, Role, Store, UsersTable,
} from "../types";

export class KvStore implements Store {
  constructor(private kv: KVNamespace) {}

  /* ---------------- 用户 ---------------- */

  async getUserCount(): Promise<number> {
    const users = await this.getUsers();
    return users.count;
  }

  async getUserAuth(username: string): Promise<AuthRecord | null> {
    return (await this.kv.get(`user:${username}:auth`, { type: "json" })) as AuthRecord | null;
  }

  async putUserAuth(username: string, rec: AuthRecord): Promise<void> {
    await this.kv.put(`user:${username}:auth`, JSON.stringify(rec));
  }

  /** 内部用：读用户索引表 */
  private async getUsers(): Promise<UsersTable> {
    const raw = await this.kv.get("users", { type: "json" });
    if (raw && typeof raw === "object") return raw as UsersTable;
    return { version: 1, count: 0, byUsername: {} };
  }

  private async putUsers(users: UsersTable): Promise<void> {
    await this.kv.put("users", JSON.stringify(users));
  }

  async registerUser(rec: NewUserRec, inviteCode?: string): Promise<RegisterResult> {
    const users = await this.getUsers();
    const isFirst = users.count === 0;

    // 先查重（与历史 409 优先级一致）
    if (users.byUsername[rec.username]) return { ok: false, reason: "conflict" };

    let invite: Invite | null = null;
    if (!isFirst) {
      if (!inviteCode) return { ok: false, reason: "invite_required" };
      invite = await this.getInvite(inviteCode);
      if (!invite) return { ok: false, reason: "invite_invalid" };
      if (invite.usedBy) return { ok: false, reason: "invite_used" };
    }

    const role: Role = isFirst ? "admin" : "user";
    await this.putUserAuth(rec.username, { ...rec, role });

    users.count += 1;
    users.byUsername[rec.username] = { id: rec.id, role, createdAt: rec.createdAt };
    await this.putUsers(users);

    if (invite) {
      invite.usedBy = rec.username;
      invite.usedAt = Date.now();
      await this.putInvite(invite);
    }
    return { ok: true, role };
  }

  /* ---------------- 邀请码 ---------------- */

  async getInvite(code: string): Promise<Invite | null> {
    return (await this.kv.get(`invite:${code}`, { type: "json" })) as Invite | null;
  }

  async createInvite(invite: Invite): Promise<void> {
    await this.putInvite(invite);
  }

  async putInvite(invite: Invite): Promise<void> {
    await this.kv.put(`invite:${invite.code}`, JSON.stringify(invite));
  }

  async listInvites(): Promise<Invite[]> {
    const list = await this.kv.list({ prefix: "invite:" });
    const out: Invite[] = [];
    for (const k of list.keys || []) {
      const v = (await this.kv.get(k.name, { type: "json" })) as Invite | null;
      if (v) out.push(v);
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
  }

  /* ---------------- 刷题数据 ---------------- */

  async getStore(username: string): Promise<QuizStore | null> {
    const raw = await this.kv.get(`store:${username}`);
    if (!raw) return null;
    try { return JSON.parse(raw) as QuizStore; } catch { return null; }
  }

  async putStore(username: string, store: QuizStore): Promise<void> {
    await this.kv.put(`store:${username}`, JSON.stringify(store));
  }

  async deleteStore(username: string): Promise<void> {
    await this.kv.delete(`store:${username}`);
  }

  /* ---------------- 备份 ---------------- */

  async exportAll(): Promise<BackupData> {
    const users: BackupData["users"] = [];
    const userList = await this.kv.list({ prefix: "user:" });
    for (const k of userList.keys || []) {
      const rec = (await this.kv.get(k.name, { type: "json" })) as AuthRecord | null;
      if (rec) {
        users.push({
          username: rec.username, id: rec.id, role: rec.role,
          createdAt: rec.createdAt, passwordHash: rec.passwordHash,
        });
      }
    }

    const stores: Record<string, QuizStore> = {};
    const storeList = await this.kv.list({ prefix: "store:" });
    for (const k of storeList.keys || []) {
      const raw = await this.kv.get(k.name);
      if (!raw) continue;
      try { stores[k.name.slice("store:".length)] = JSON.parse(raw) as QuizStore; } catch { /* skip */ }
    }

    return { version: 1, exportedAt: Date.now(), users, invites: await this.listInvites(), stores };
  }
}
