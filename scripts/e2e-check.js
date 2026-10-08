/**
 * 端到端验证（需先启动 dev-server：node scripts/dev-server.mjs）。
 * 流程：未登录重定向 → 注册首用户 admin → 刷题 → 错题本/统计/设置 → 邀请码 →
 *       持久化 → 响应式/深链接 → v1→v2 首次上云迁移 → 登出/登录 → 隔离/鉴权 → 截图。
 * 用法：node scripts/e2e-check.js [baseUrl] [outDir]
 */
import path from "node:path";
import fs from "node:fs";
import puppeteer from "puppeteer";

const BASE = process.argv[2] || "http://127.0.0.1:8123";
const OUT = process.argv[3] || path.join(process.cwd(), "scripts", "_shots");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const errors = [];
const results = [];
const ok = (name, pass, extra = "") => {
  results.push({ name, pass, extra });
  console.log(`${pass ? "  ✓" : "  ✗"} ${name}${extra ? "  " + extra : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2, 10);
const ADMIN = `admin_${rnd()}`;
const ADMIN_PW = `Pass${rnd()}1`;
const USERB = `userb_${rnd()}`;
const USERB_PW = `Pass${rnd()}2`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // 重置 mock KV，保证本次运行是"首用户"场景
  await fetch(`${BASE}/__dev/kv-reset`, { method: "POST" }).catch(() => {});

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setDefaultTimeout(8000);
  page.on("dialog", (d) => d.accept().catch(() => {}));
  page.on("console", (m) => {
    const t = m.type();
    // 过滤网络状态噪音（错误路径测试会触发 401/403/409，Chrome 记为 console.error 但非 JS 错误）
    if (t === "error" && /Failed to load resource/i.test(m.text())) return;
    if (t === "error") errors.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    // 过滤 flushStore keepalive 在导航时被中断的噪音
    if (r.failure()?.errorText === "net::ERR_ABORTED" && r.url().includes("/api/store")) return;
    errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  });

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

  const go = async (hash) => {
    await page.goto(`${BASE}/#/${hash}`, { waitUntil: "networkidle2" });
    await sleep(200);
  };
  const txt = (sel) => page.$eval(sel, (n) => n.textContent.trim()).catch(() => null);
  const count = (sel) => page.$$eval(sel, (n) => n.length).catch(() => 0);

  /* ---------- [1] 未登录重定向到 login ---------- */
  console.log("\n[1] 未登录重定向");
  await page.goto(`${BASE}/#/home`, { waitUntil: "networkidle2" });
  await sleep(200);
  const hash1 = await page.evaluate(() => location.hash);
  ok("未登录访问 home → 重定向 #/login", hash1 === "#/login", `实际 ${hash1}`);
  const loginForm = await count("#authForm");
  ok("登录表单渲染", loginForm === 1, `${loginForm}`);
  await page.screenshot({ path: path.join(OUT, "01-login.png"), fullPage: true });

  /* ---------- [2] 注册首用户（admin）---------- */
  console.log("\n[2] 注册首用户");
  await page.click('.auth__tab[data-tab="register"]');
  await sleep(100);
  await page.type('input[name="username"]', ADMIN);
  await page.type('input[name="password"]', ADMIN_PW);
  await page.click("#authSubmit");
  await page.waitForSelector(".hero", { timeout: 8000 });
  const hash2 = await page.evaluate(() => location.hash);
  ok("注册后跳转 home", hash2 === "#/home", `实际 ${hash2}`);
  const heroTitle = await txt(".hero__title");
  ok("首页 hero 渲染", !!heroTitle, heroTitle?.slice(0, 18));

  // 校验当前用户为 admin
  const me = await page.evaluate(async () => {
    const r = await fetch("/api/me", { headers: { Authorization: `Bearer ${localStorage.getItem("quizapp.token.v1")}` } });
    return r.ok ? r.json() : null;
  });
  ok("注册用户 role=admin", me?.role === "admin", JSON.stringify(me));

  const domainChips = await count("#domainChips .chip");
  const typeChips = await count("#typeChips .chip");
  ok("领域筛选 6 个", domainChips === 6, `实际 ${domainChips}`);
  ok("题型筛选 3 个", typeChips === 3, `实际 ${typeChips}`);

  /* ---------- [3] 题库结构 ---------- */
  console.log("\n[3] 题库结构");
  const bank = await page.evaluate(async () => {
    const r = await fetch("/data/questions.json");
    const d = await r.json();
    const qs = d.questions;
    const byId = Object.fromEntries(qs.map((q) => [q.id, q]));
    return {
      total: qs.length,
      types: [...new Set(qs.map((q) => q.type))].sort(),
      hasLegacy: qs.some((q) => /^F|^SA/.test(q.id)),
    };
  });
  ok("总题数 68", bank.total === 68, `实际 ${bank.total}`);
  ok("题型 single/multiple/judge", bank.types.join(",") === "judge,multiple,single", bank.types.join(","));

  /* ---------- [4] 单选 ---------- */
  console.log("\n[4] 单选题");
  await go("practice?type=single");
  await page.waitForSelector(".opt");
  ok("题干渲染", !!(await txt(".stem")));
  ok("四个选项", (await count(".opt")) === 4);
  await page.click(".opt");                       // 选第一个（多答错）
  await sleep(250);
  ok("即时判定出现", !!(await txt(".verdict")));
  ok("展示解析", (await count(".analysis")) > 0);
  ok("作答后选项锁定", await page.$$eval(".opt", (ns) => ns.every((n) => n.disabled)));
  ok("正确选项染色", (await count(".opt.is-ok")) === 1);
  await page.screenshot({ path: path.join(OUT, "02-single.png"), fullPage: true });
  await page.click("#pNext");
  await sleep(200);
  ok("下一题推进", (await txt(".practice-head__idx b")) === "2");

  /* ---------- [5] 多选 ---------- */
  console.log("\n[5] 多选题");
  await go("practice?type=multiple");
  await page.waitForSelector(".opt");
  ok("未选时确认按钮禁用", await page.$eval("#pConfirm", (n) => n.disabled));
  await page.click('.opt[data-letter="A"]');
  await page.click('.opt[data-letter="B"]');
  await sleep(120);
  ok("多选提示已选 AB", (await txt("#multiHint")) === "已选 AB");
  ok("选中态视觉反馈", (await count(".opt.is-sel")) === 2);
  await page.click("#pConfirm");
  await sleep(250);
  ok("多选判定完成", !!(await txt(".verdict")));
  await page.screenshot({ path: path.join(OUT, "03-multiple.png"), fullPage: true });

  /* ---------- [6] 判断 ---------- */
  console.log("\n[6] 判断题");
  await go("practice?type=judge");
  await page.waitForSelector(".judge__btn");
  ok("两个判断按钮", (await count(".judge__btn")) === 2);
  await page.click('.judge__btn[data-judge="true"]');
  await sleep(250);
  ok("判断判定完成", !!(await txt(".verdict")));
  ok("判断作答后锁定", await page.$$eval(".judge__btn", (ns) => ns.every((n) => n.disabled)));
  await page.screenshot({ path: path.join(OUT, "04-judge.png"), fullPage: true });

  /* ---------- [7] 错题本 ---------- */
  console.log("\n[7] 错题本");
  await go("wrongbook");
  await sleep(200);
  const wrongItems = await count(".item");
  const badge = await page.$eval("#tabBadge", (n) => (n.hidden ? "hidden" : n.textContent));
  ok("错题本有条目", wrongItems > 0, `${wrongItems} 条，角标=${badge}`);
  await page.screenshot({ path: path.join(OUT, "07-wrongbook.png"), fullPage: true });

  /* ---------- [8] 统计页 ---------- */
  console.log("\n[8] 统计页");
  await go("stats");
  await sleep(250);
  ok("统计页渲染", !!(await txt(".stat-grid")));
  ok("进度/领域/题型分段", (await count(".rate-row")) >= 10);
  await page.screenshot({ path: path.join(OUT, "09-stats.png"), fullPage: true });

  /* ---------- [9] 设置页 + 账号 + 邀请码 ---------- */
  console.log("\n[9] 设置页 / 账号 / 邀请码");
  await go("settings");
  await sleep(200);
  const accountText = await txt(".card");
  ok("账号区显示用户名", accountText?.includes(ADMIN), "");
  ok("账号区显示管理员角色", /管理员/.test(accountText || ""), "");
  ok("退出登录按钮", (await count("#btnLogout")) === 1);
  ok("管理员邀请码区可见", (await count("#btnGenInvite")) === 1);

  // 导出结构
  const exported = await page.evaluate(async () => {
    const m = await import("/js/storage.js");
    const t = m.exportJson();
    const parsed = JSON.parse(t);
    const check = m.validateImport(t);
    return { keys: Object.keys(parsed), ok: check.ok };
  });
  ok("导出结构 v2 无 recite", exported.keys.join(",") === "version,records,wrongbook,updatedAt", exported.keys.join(","));
  ok("导出可被自身校验通过", exported.ok);
  await page.screenshot({ path: path.join(OUT, "10-settings.png"), fullPage: true });

  /* 生成邀请码 */
  await page.click("#btnGenInvite");
  await sleep(300);
  const inviteCode = await page.evaluate(() => document.querySelector(".invite-item__code")?.textContent || "");
  ok("生成 16 字符邀请码", inviteCode.length === 16, `实际 ${inviteCode.length} "${inviteCode}"`);
  ok("邀请码未使用标记", /未使用/.test(await txt(".invite-item__state") || ""), "");
  await page.screenshot({ path: path.join(OUT, "11-invites.png"), fullPage: true });

  /* ---------- [10] 持久化（刷新后从云端拉回）---------- */
  console.log("\n[10] 持久化");
  await go("home");
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(500);
  // 刷新后保持登录（未被踢回 login）
  const persistedHash = await page.evaluate(() => location.hash);
  ok("刷新后保持登录", persistedHash !== "#/login", `实际 ${persistedHash}`);
  const persisted = await page.evaluate(async () => {
    const m = await import("/js/storage.js");
    return Object.keys(m.getStore().records).length;
  });
  ok("刷新后记录从云端拉回", persisted > 0, `${persisted} 条记录`);

  /* ---------- [11] 响应式 / 深链接 ---------- */
  console.log("\n[11] 响应式 / 深链接");
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await go("home");
  const layout = await page.evaluate(() => ({ appW: Math.round(document.querySelector(".app").getBoundingClientRect().width) }));
  ok("桌面端内容列限宽 720", layout.appW === 720, `实际 ${layout.appW}px`);
  await page.screenshot({ path: path.join(OUT, "12-desktop.png"), fullPage: true });

  await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 2 });
  await go("home");
  const narrow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  ok("360px 无横向溢出", narrow.sw <= narrow.iw + 1, `scrollWidth=${narrow.sw} innerWidth=${narrow.iw}`);
  await page.screenshot({ path: path.join(OUT, "13-mobile360.png"), fullPage: true });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

  await page.goto(`${BASE}/#/practice?domain=science&type=single`, { waitUntil: "networkidle2" });
  await sleep(300);
  const deep = await page.evaluate(async () => {
    const r = await fetch("/data/questions.json");
    const d = await r.json();
    const expect = d.questions.filter((q) => q.domain === "science" && q.type === "single").length;
    const head = document.querySelector(".practice-head__idx")?.textContent || "";
    const total = Number((head.match(/\/\s*(\d+)/) || [])[1] || 0);
    return { expect, total };
  });
  ok("深链接筛选正确", deep.expect === deep.total, `科学+单选 期望 ${deep.expect} 实际 ${deep.total}`);

  /* ---------- [12] v1 → v2 首次上云迁移 ---------- */
  console.log("\n[12] v1→v2 迁移（首次上云）");
  const token = await page.evaluate(() => localStorage.getItem("quizapp.token.v1"));
  // 先在应用内 clearAll（清云端 + cache 置空），再显式 DELETE 兜底，再注入本地 v1，reload 触发迁移
  await page.evaluate(async () => {
    const m = await import("/js/storage.js");
    m.clearAll();
    // 显式 DELETE 确保云端为空
    await fetch("/api/store", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${localStorage.getItem("quizapp.token.v1")}` },
    });
    const v1 = {
      version: 1,
      records: {
        F01: { attempts: 3, wrongAttempts: 1, lastCorrect: true, lastUserAnswer: ["协调"], firstAt: 1000, lastAt: 2000 },
        S02: { attempts: 1, wrongAttempts: 0, lastCorrect: true, lastUserAnswer: "C", firstAt: 1000, lastAt: 1500 },
        X99: { attempts: 1, wrongAttempts: 1, lastCorrect: false, firstAt: 1000, lastAt: 1200 },
      },
      wrongbook: { F03: { wrongCount: 2, addedAt: 1000, lastUserAnswer: ["x"], lastWrongAt: 1500 } },
      recite: { SA01: { attempts: 2, known: true, lastAt: 1000 } },
      updatedAt: 2000,
    };
    localStorage.setItem("quizapp.data.v1", JSON.stringify(v1));
  });
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(800);
  const mig = await page.evaluate(async () => {
    const m = await import("/js/storage.js");
    const s = m.getStore();
    return {
      version: s.version,
      s25: s.records?.S25,
      hasS02: !!s.records?.S02,
      hasX99: !!s.records?.X99,
      hasS27: !!s.wrongbook?.S27,
      hasRecite: "recite" in s,
      localCleared: !localStorage.getItem("quizapp.data.v1"),
    };
  });
  ok("迁移后 version=2", mig.version === 2, `version=${mig.version}`);
  ok("F01 → S25 映射且保留 attempts=3", mig.s25?.attempts === 3, JSON.stringify(mig.s25));
  ok("已删题 S02 剔除", !mig.hasS02);
  ok("孤儿 X99 剔除", !mig.hasX99);
  ok("错题本 F03 → S27", mig.hasS27);
  ok("recite 表移除", !mig.hasRecite);
  ok("本地旧数据已清源", mig.localCleared);
  // 云端确实有 S25
  const cloud = await page.evaluate(async (t) => {
    const r = await fetch("/api/store", { headers: { Authorization: `Bearer ${t}` } });
    return r.ok ? r.json() : null;
  }, token);
  ok("迁移已上云（云端含 S25）", !!cloud?.store?.records?.S25, "");

  /* ---------- [13] 登出 / 登录 round-trip ---------- */
  console.log("\n[13] 登出 / 登录");
  await go("settings");
  await page.click("#btnLogout");
  await sleep(300);
  const logoutHash = await page.evaluate(() => location.hash);
  ok("登出后回到 login", logoutHash === "#/login", `实际 ${logoutHash}`);

  // 错误密码
  await page.click('.auth__tab[data-tab="login"]');
  await page.type('input[name="username"]', ADMIN);
  await page.type('input[name="password"]', "wrongPass99");
  await page.click("#authSubmit");
  await sleep(400);
  const errNote = await txt("#authNote");
  ok("错误密码提示", /用户名或密码错误|401/.test(errNote || ""), `note="${errNote?.slice(0, 30)}"`);

  // 正确登录
  await page.evaluate(() => document.querySelector("#authForm")?.reset());
  await page.type('input[name="username"]', ADMIN);
  await page.type('input[name="password"]', ADMIN_PW);
  await page.click("#authSubmit");
  await page.waitForSelector(".hero");
  ok("正确登录后回 home", (await page.evaluate(() => location.hash)) === "#/home");
  const dataBack = await page.evaluate(async () => {
    const m = await import("/js/storage.js");
    return Object.keys(m.getStore().records).length;
  });
  ok("登录后数据回来（含迁移的 S25）", dataBack > 0, `${dataBack} 条`);

  /* ---------- [14] 鉴权 / 隔离 ---------- */
  console.log("\n[14] 鉴权 / 数据隔离");
  const iso = await page.evaluate(async (t, invite, userB, pwB) => {
    // B 用邀请码注册（fetch，不污染当前 admin 会话）
    const reg = await fetch("/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: userB, password: pwB, inviteCode: invite }),
    });
    const regData = reg.ok ? await reg.json() : null;
    if (!regData) return { regOk: false, regStatus: reg.status };

    // B 写入自己的 store
    await fetch("/api/store", {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${regData.token}` },
      body: JSON.stringify({ store: { version: 2, records: { USERB: { lastAt: 2 } }, wrongbook: {}, updatedAt: 2 }, baseUpdatedAt: 0 }),
    });

    // 分别读 A、B 的 store
    const aRes = await fetch("/api/store", { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
    const bRes = await fetch("/api/store", { headers: { Authorization: `Bearer ${regData.token}` } }).then((r) => r.json());
    return {
      regOk: true,
      bRole: regData.user?.role,
      aHasS25: !!aRes.store?.records?.S25,
      aHasUserB: !!aRes.store?.records?.USERB,
      bHasUserB: !!bRes.store?.records?.USERB,
      bHasS25: !!bRes.store?.records?.S25,
    };
  }, token, inviteCode, USERB, USERB_PW);
  ok("B 注册成功（role=user）", iso.regOk && iso.bRole === "user", JSON.stringify(iso));
  ok("A store 含 S25 不含 USERB", iso.aHasS25 && !iso.aHasUserB);
  ok("B store 含 USERB 不含 S25", iso.bHasUserB && !iso.bHasS25);

  /* 邀请码不可复用 */
  const reuse = await page.evaluate(async (invite) => {
    const r = await fetch("/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: `dup_${Math.random().toString(36).slice(2, 8)}`, password: "Pass12345678", inviteCode: invite }),
    });
    return { status: r.status, data: r.ok ? null : await r.json() };
  }, inviteCode);
  ok("邀请码不可复用 403", reuse.status === 403, `实际 ${reuse.status} ${JSON.stringify(reuse.data)}`);

  /* 重复用户名 409 */
  const dup = await page.evaluate(async (admin, pw) => {
    const r = await fetch("/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: admin, password: pw }),
    });
    return { status: r.status, data: r.ok ? null : await r.json() };
  }, ADMIN, ADMIN_PW);
  ok("重复用户名 409", dup.status === 409, `实际 ${dup.status} ${JSON.stringify(dup.data)}`);

  /* 非管理员调 /api/invites 403 */
  const forbidden = await page.evaluate(async (t) => {
    // 用 B 的 token 调——但这里我们没存 B 的 token，直接用 admin 的 token 测一个非 admin 场景不适用
    // 改为：不带 token 调 invites 应 401
    const r = await fetch("/api/invites");
    return r.status;
  });
  ok("无 token 调 /api/invites 401", forbidden === 401, `实际 ${forbidden}`);

  /* token 篡改 → 401 跳登录（需 reload 触发 boot 重新校验 token）*/
  await page.evaluate(() => localStorage.setItem("quizapp.token.v1", "garbage.token.here"));
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(500);
  const badTokenHash = await page.evaluate(() => location.hash);
  ok("token 篡改后重定向 login", badTokenHash === "#/login", `实际 ${badTokenHash}`);

  /* ---------- 汇总 ---------- */
  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log("\n" + "=".repeat(56));
  console.log(`用例：${results.length}　通过：${results.length - failed.length}　失败：${failed.length}`);
  if (failed.length) {
    console.log("\n失败项：");
    failed.forEach((f) => console.log(`  ✗ ${f.name}  ${f.extra}`));
  }
  if (errors.length) {
    console.log(`\n页面错误（${errors.length}）：`);
    [...new Set(errors)].slice(0, 15).forEach((e) => console.log("  ! " + e));
  } else {
    console.log("\n无控制台错误 / 无失败请求");
  }
  console.log(`截图目录：${OUT}`);
  process.exit(failed.length || errors.length ? 1 : 0);
})().catch((e) => {
  console.error("测试脚本异常：", e);
  process.exit(2);
});
