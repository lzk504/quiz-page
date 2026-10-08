/**
 * 存储抽象层：对齐 nodewarden 的 R2/KV 可切换模式。
 *
 * 业务代码（routes.js）只依赖本模块暴露的「逻辑操作」接口，不直接触碰 KV 原语；
 * 将来新增 R2 后端，只需：
 *   1) 实现一个 R2Store（同样的方法签名）
 *   2) 在 createStore() 里加一个分支
 *   3) 新增 wrangler.r2.toml 配置文件
 * 业务代码零改动。
 *
 * ⚠️ KV key 命名是「公开契约」，与既有线上数据一一对应，逐字不可改：
 *   users          用户表（{version,count,byUsername}）
 *   user:<u>:auth  单用户凭证（含密码哈希）
 *   invite:<code>  一次性邀请码
 *   store:<u>      单用户刷题数据（与前端 v2 schema 同形）
 */

export class KvStore {
  constructor(kv) {
    this.kv = kv;
  }

  /* ---------------- 用户 ---------------- */

  /** @returns {Promise<object|null>} 反序列化后的凭证记录 */
  async getUserAuth(username) {
    return this.kv.get(`user:${username}:auth`, { type: "json" });
  }

  /** @returns {Promise<void>} */
  async putUserAuth(username, rec) {
    await this.kv.put(`user:${username}:auth`, JSON.stringify(rec));
  }

  /** @returns {Promise<object>} 缺失时返回空用户表 {version:1,count:0,byUsername:{}} */
  async getUsers() {
    const raw = await this.kv.get("users", { type: "json" });
    if (raw && typeof raw === "object") return raw;
    return { version: 1, count: 0, byUsername: {} };
  }

  /** @returns {Promise<void>} */
  async putUsers(users) {
    await this.kv.put("users", JSON.stringify(users));
  }

  /* ---------------- 邀请码 ---------------- */

  /** @returns {Promise<object|null>} */
  async getInvite(code) {
    return this.kv.get(`invite:${code}`, { type: "json" });
  }

  /** @returns {Promise<void>} */
  async putInvite(invite) {
    await this.kv.put(`invite:${invite.code}`, JSON.stringify(invite));
  }

  /** @returns {Promise<object[]>} 已按 createdAt 降序 */
  async listInvites() {
    const list = await this.kv.list({ prefix: "invite:" });
    const out = [];
    for (const k of list.keys || []) {
      const v = await this.kv.get(k.name, { type: "json" });
      if (v) out.push(v);
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
  }

  /* ---------------- 刷题数据 ---------------- */

  /** @returns {Promise<object|null>} 已 parse 的对象；解析失败视为 null */
  async getStore(username) {
    const raw = await this.kv.get(`store:${username}`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  /** @returns {Promise<void>} */
  async putStore(username, store) {
    await this.kv.put(`store:${username}`, JSON.stringify(store));
  }

  /** @returns {Promise<void>} */
  async deleteStore(username) {
    await this.kv.delete(`store:${username}`);
  }
}

/**
 * 存储工厂：按 binding 存在性选择后端（对齐 nodewarden 的 build-time 双配置切换）。
 * 未来加 R2：
 *   if (env.R2) return new R2Store(env.R2);
 */
export function createStore(env) {
  if (env.KV) return new KvStore(env.KV);
  throw new Error("未配置存储绑定（KV 或 R2）");
}
