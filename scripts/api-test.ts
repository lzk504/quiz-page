/**
 * API 端点冒烟测试（直接调 handleApi，无需起服务）。
 * 运行时生成随机用户名/密码/邀请码，命令行与输出均不含真实凭据。
 *   npx tsx scripts/api-test.ts      （或 npm test）
 */

import { handleApi, _resetRateLimitForTest } from "../src/routes";
import type {
  AuthRecord, BackupData, Env, Invite, NewUserRec, QuizStore, RegisterResult, Role, Store,
} from "../src/types";

const JWT_SECRET = "test-secret-30-chars-minimum-aaaaaaaaaaaaa";

/** 内存 mock Store（实现 Store 接口；业务 handler 跑真实逻辑，仅替换持久化） */
class MockStore implements Store {
  private users = new Map<string, AuthRecord>();
  private invites = new Map<string, Invite>();
  private stores = new Map<string, QuizStore>();

  async getUserCount(): Promise<number> {
    return this.users.size;
  }

  async getUserAuth(username: string): Promise<AuthRecord | null> {
    return this.users.get(username) ?? null;
  }

  async registerUser(rec: NewUserRec, inviteCode?: string): Promise<RegisterResult> {
    if (this.users.has(rec.username)) return { ok: false, reason: "conflict" };
    const isFirst = this.users.size === 0;

    let invite: Invite | null = null;
    if (!isFirst) {
      if (!inviteCode) return { ok: false, reason: "invite_required" };
      invite = this.invites.get(inviteCode) ?? null;
      if (!invite) return { ok: false, reason: "invite_invalid" };
      if (invite.usedBy) return { ok: false, reason: "invite_used" };
    }

    const role: Role = isFirst ? "admin" : "user";
    this.users.set(rec.username, { ...rec, role });
    if (invite) {
      invite.usedBy = rec.username;
      invite.usedAt = Date.now();
    }
    return { ok: true, role };
  }

  async getInvite(code: string): Promise<Invite | null> {
    return this.invites.get(code) ?? null;
  }

  async createInvite(invite: Invite): Promise<void> {
    this.invites.set(invite.code, invite);
  }

  async listInvites(): Promise<Invite[]> {
    return [...this.invites.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  async getStore(username: string): Promise<QuizStore | null> {
    return this.stores.get(username) ?? null;
  }

  async putStore(username: string, store: QuizStore): Promise<void> {
    this.stores.set(username, store);
  }

  async deleteStore(username: string): Promise<void> {
    this.stores.delete(username);
  }

  async exportAll(): Promise<BackupData> {
    return {
      version: 1,
      exportedAt: Date.now(),
      users: [...this.users.values()].map((u) => ({
        username: u.username, id: u.id, role: u.role, createdAt: u.createdAt, passwordHash: u.passwordHash,
      })),
      invites: await this.listInvites(),
      stores: Object.fromEntries(this.stores),
    };
  }
}

const store = new MockStore();
const env = { JWT_SECRET } as Env;

let passed = 0;
let failed = 0;
function ok(name: string, cond: unknown, detail = ""): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}  ${detail}`); }
}

interface CallOpts {
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
}

async function call(method: string, path: string, { body, token, headers = {} }: CallOpts = {}): Promise<{ status: number; data: any }> {
  const h = new Headers({ "content-type": "application/json", ...headers });
  if (token) h.set("Authorization", `Bearer ${token}`);
  const init: RequestInit = { method, headers: h };
  if (body !== undefined) init.body = JSON.stringify(body);
  const req = new Request(`http://x${path}`, init);
  const res = await handleApi(req, env, {} as ExecutionContext, store);
  let data: any = null;
  try {
    const text = await res.text();
    if (text) data = JSON.parse(text);
  } catch { /* ignore */ }
  return { status: res.status, data };
}

const rnd = (): string => Math.random().toString(36).slice(2, 10);
const adminUser = `admin_${rnd()}`;
const adminPw = `Pass${rnd()}1`; // 含字母+数字，≥8 位
const userB = `user_${rnd()}`;
const userBPw = `Pass${rnd()}2`;

console.log("=== [1] 注册首用户（应 201, role=admin）===");
let r = await call("GET", "/api/bootstrap");
ok("注册前 initialized=false", r.data?.initialized === false, `实际 ${JSON.stringify(r.data)}`);
r = await call("POST", "/api/register", { body: { username: adminUser, password: adminPw } });
ok("状态 201", r.status === 201, `实际 ${r.status} ${JSON.stringify(r.data)}`);
ok("返回 role=admin", r.data?.user?.role === "admin");
ok("返回 token", !!r.data?.token);
const adminToken: string = r.data?.token;
r = await call("GET", "/api/bootstrap");
ok("注册后 initialized=true", r.data?.initialized === true, `实际 ${JSON.stringify(r.data)}`);

console.log("\n=== [2] 重复用户名（应 409）===");
r = await call("POST", "/api/register", { body: { username: adminUser, password: adminPw } });
ok("状态 409", r.status === 409, `实际 ${r.status}`);

console.log("\n=== [3] 密码规则：仅要求大写字母 ===");
r = await call("POST", "/api/register", { body: { username: `x_${rnd()}`, password: "abc1" } });
ok("无大写字母 → 400", r.status === 400 && /大写字母/.test(r.data?.message || ""), `实际 ${r.status} ${r.data?.message}`);
r = await call("POST", "/api/register", { body: { username: `y_${rnd()}`, password: "A" } });
ok("短密码含大写字母通过密码校验", r.status === 400 && /邀请码/.test(r.data?.message || ""), `实际 ${r.status} ${r.data?.message}`);

console.log("\n=== [4] 未带邀请码注册（非首用户，应 400）===");
r = await call("POST", "/api/register", { body: { username: userB, password: userBPw } });
ok("状态 400 需邀请码", r.status === 400, `实际 ${r.status}`);

console.log("\n=== [5] 错误密码登录（应 401）===");
r = await call("POST", "/api/login", { body: { username: adminUser, password: "wrongPass99" } });
ok("状态 401", r.status === 401, `实际 ${r.status}`);

console.log("\n=== [6] 正确登录（应 200, role=admin）===");
r = await call("POST", "/api/login", { body: { username: adminUser, password: adminPw } });
ok("状态 200", r.status === 200, `实际 ${r.status}`);
ok("role=admin", r.data?.user?.role === "admin");
const adminToken2: string = r.data?.token;
// token 含 iat（秒级），跨秒重签会不同 —— 比较 payload 的 sub/role 而非原始串
const jwtPayload = (t: string): any => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
ok("登录 token payload 与注册一致",
  jwtPayload(adminToken).sub === jwtPayload(adminToken2).sub && jwtPayload(adminToken).role === jwtPayload(adminToken2).role);

console.log("\n=== [7] /api/me 校验 token（应 200）===");
r = await call("GET", "/api/me", { token: adminToken });
ok("状态 200", r.status === 200, `实际 ${r.status}`);
ok("用户名匹配", r.data?.username === adminUser);

console.log("\n=== [8] /api/me 无 token（应 401）===");
r = await call("GET", "/api/me");
ok("状态 401", r.status === 401);

console.log("\n=== [9] GET store 云端无数据（应 200, store=null）===");
r = await call("GET", "/api/store", { token: adminToken });
ok("状态 200", r.status === 200);
ok("store 为 null", r.data?.store === null && r.data?.updatedAt === null);

console.log("\n=== [10] PUT store 写入（应 200, 返回 updatedAt）===");
r = await call("PUT", "/api/store", { token: adminToken, body: { store: { version: 5, records: { "G-S001": { lastAt: 1000 } }, wrongbook: {}, favorites: { "G-S001": { addedAt: 1000 } }, profile: { nickname: "小老师" }, updatedAt: 1000 }, baseUpdatedAt: 0 } });
ok("状态 200", r.status === 200, `实际 ${r.status}`);
ok("返回 updatedAt", typeof r.data?.updatedAt === "number");

console.log("\n=== [11] GET store 读回（应 200, 有数据）===");
r = await call("GET", "/api/store", { token: adminToken });
ok("状态 200", r.status === 200);
ok("store 非空", !!r.data?.store);
ok("records.G-S001 存在", !!r.data?.store?.records?.["G-S001"]);
ok("store 原样透传（v5 三段式 id 不被改写）", r.data?.store?.version === 5 && "G-S001" in (r.data?.store?.records ?? {}));
ok("favorites 原样透传（v4 新增字段）", !!r.data?.store?.favorites?.["G-S001"]);
ok("profile.nickname 原样透传（v5 新增字段）", r.data?.store?.profile?.nickname === "小老师");

console.log("\n=== [12] PUT 乐观锁冲突（baseUpdatedAt 旧，应 409）===");
r = await call("PUT", "/api/store", { token: adminToken, body: { store: { version: 4, records: {}, wrongbook: {}, favorites: {}, updatedAt: 1 }, baseUpdatedAt: 1 } });
ok("状态 409", r.status === 409, `实际 ${r.status}`);
ok("返回 serverUpdatedAt", typeof r.data?.serverUpdatedAt === "number");

console.log("\n=== [13] DELETE store（应 204）===");
r = await call("DELETE", "/api/store", { token: adminToken });
ok("状态 204", r.status === 204, `实际 ${r.status}`);
r = await call("GET", "/api/store", { token: adminToken });
ok("删除后 store 为 null", r.data?.store === null);

console.log("\n=== [14] 管理员生成邀请码（应 201）===");
r = await call("POST", "/api/invites", { token: adminToken });
ok("状态 201", r.status === 201, `实际 ${r.status}`);
ok("返回 16 字符邀请码", typeof r.data?.code === "string" && r.data.code.length === 16);
const inviteCode: string = r.data?.code;
ok("createdBy=admin", r.data?.createdBy === adminUser);

console.log("\n=== [15] 管理员列出邀请码（应 200, 1 条）===");
r = await call("GET", "/api/invites", { token: adminToken });
ok("状态 200", r.status === 200);
ok("列表 1 条", Array.isArray(r.data) && r.data.length === 1, `实际 ${r.data?.length}`);
ok("未使用 usedBy=null", r.data?.[0]?.usedBy === null);

console.log("\n=== [16] 非管理员调 /api/invites（应 403）===");
r = await call("POST", "/api/register", { body: { username: userB, password: userBPw, inviteCode } });
ok("B 注册成功 201", r.status === 201, `实际 ${r.status} ${JSON.stringify(r.data)}`);
const userBToken: string = r.data?.token;
ok("B role=user", r.data?.user?.role === "user");
r = await call("GET", "/api/invites", { token: userBToken });
ok("状态 403", r.status === 403, `实际 ${r.status}`);

console.log("\n=== [17] 邀请码不可复用（应 403）===");
r = await call("POST", "/api/register", { body: { username: `dup_${rnd()}`, password: `Pass${rnd()}3`, inviteCode } });
ok("状态 403 已被使用", r.status === 403, `实际 ${r.status}`);

console.log("\n=== [18] 数据隔离：B 的 store 与 A 隔离 ===");
await call("PUT", "/api/store", { token: adminToken, body: { store: { version: 4, records: { ADMIN: { lastAt: 1 } }, wrongbook: {}, updatedAt: 1 }, baseUpdatedAt: 0 } });
await call("PUT", "/api/store", { token: userBToken, body: { store: { version: 4, records: { USERB: { lastAt: 2 } }, wrongbook: {}, updatedAt: 2 }, baseUpdatedAt: 0 } });
r = await call("GET", "/api/store", { token: adminToken });
ok("A store 含 ADMIN 不含 USERB", !!r.data?.store?.records?.ADMIN && !r.data?.store?.records?.USERB);
r = await call("GET", "/api/store", { token: userBToken });
ok("B store 含 USERB 不含 ADMIN", !!r.data?.store?.records?.USERB && !r.data?.store?.records?.ADMIN);

console.log("\n=== [19] 限流（10 次/分钟/IP，第 11 次 429）===");
_resetRateLimitForTest();
const rlIp = "203.0.113.77";
let lastStatus = 0;
for (let i = 1; i <= 10; i++) {
  lastStatus = (await call("POST", "/api/login", {
    body: { username: adminUser, password: "wrongPass99" },
    headers: { "CF-Connecting-IP": rlIp },
  })).status;
}
ok("第 10 次仍未 429", lastStatus !== 429, `实际 ${lastStatus}`);
r = await call("POST", "/api/login", {
  body: { username: adminUser, password: "wrongPass99" },
  headers: { "CF-Connecting-IP": rlIp },
});
ok("第 11 次 429", r.status === 429 && r.data?.error === "rate_limited", `实际 ${r.status} ${JSON.stringify(r.data)}`);
r = await call("POST", "/api/login", {
  body: { username: adminUser, password: "wrongPass99" },
  headers: { "CF-Connecting-IP": "198.51.100.9" },
});
ok("不同 IP 不受限", r.status === 401, `实际 ${r.status}`);

console.log(`\n========================================================`);
console.log(`通过 ${passed}　失败 ${failed}`);
process.exit(failed ? 1 : 0);
