/**
 * 端到端验证（需先启动 `npm run dev`，即 wrangler dev，默认 127.0.0.1:8787）。
 * 可用 E2E_TARGET 指向任意部署（如 https://quiz-page.xxx.workers.dev）。
 *
 * 流程：未登录重定向 → 注册首用户 admin → 三题库清单与多选 → 五种题型作答
 *       （含填空/简答的用户自判）→ 错题本/统计/设置 → 抽题上限与「再刷一遍/换一批」
 *       → 持久化 → 响应式/深链接 → v1→v3 与 v2→v3 迁移 → 登出/登录 → 隔离/鉴权 → 截图。
 *
 * 用法：node scripts/e2e-check.js [baseUrl] [outDir]
 */
import path from "node:path";
import fs from "node:fs";
import puppeteer from "puppeteer";

const BASE = process.argv[2] || process.env.E2E_TARGET || "http://127.0.0.1:8787";
const OUT = process.argv[3] || path.join(process.cwd(), "scripts", "_shots");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

/** 每库目标题量（与 data/banks.json 的 typeCounts 一致） */
const TARGET_PER_BANK = 1000;
const MAX_PER_SESSION = 100;

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

  // 重置后端数据（仅 ALLOW_DEV_RESET=1 时生效），保证本次运行是「首用户」场景
  await fetch(`${BASE}/api/dev/reset`, { method: "POST" }).catch(() => {});

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setDefaultTimeout(10000);
  page.on("dialog", (d) => d.accept().catch(() => {}));
  page.on("console", (m) => {
    const t = m.type();
    // 过滤网络状态噪音（错误路径测试会触发 401/403/404/409，Chrome 记为 console.error 但非 JS 错误）
    if (t === "error" && /Failed to load resource/i.test(m.text())) return;
    if (t === "error") errors.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    // 过滤导航/刷新时被中断的请求（keepalive PUT、按需加载的题库文件）
    if (r.failure()?.errorText === "net::ERR_ABORTED" && /\/(api\/store|data\/)/.test(r.url())) return;
    errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  });

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

  /* ---------------- 工具 ---------------- */

  const go = async (hash) => {
    await page.goto(`${BASE}/#/${hash}`, { waitUntil: "networkidle2" });
    await sleep(200);
  };
  const txt = (sel) => page.$eval(sel, (n) => n.textContent.trim()).catch(() => null);
  const count = (sel) => page.$$eval(sel, (n) => n.length).catch(() => 0);
  /**
   * DOM 直接点击（跳过鼠标命中测试）。
   * 页面底部的动作按钮（下一题/对照答案/我答对了…）在内容较短时会落在固定底栏
   * `.tabbar` 的覆盖范围内，page.click 的命中测试会点到导航上导致误跳转。
   */
  const domClick = (sel) => page.$eval(sel, (n) => n.click());
  /** 当前刷题会话快照（题序 / 当前题 id） */
  const session = () => page.evaluate(() => window.__quiz.practice.session());
  /** 当前用户 store 快照 */
  const store = () => page.evaluate(() => window.__quiz.storage.getStore());
  /** 已选中的题库 id 列表（按卡片顺序） */
  const selectedCards = () =>
    page.$$eval(".bank-card", (ns) => ns.filter((n) => n.classList.contains("is-on")).map((n) => n.dataset.bank));
  /** 首页「当前题池 N 题」 */
  const poolSize = async () => {
    const hint = (await txt(".hero__hint")) || "";
    return Number((hint.match(/当前题池\s*(\d+)\s*题/) || [])[1] || 0);
  };
  /** 当前题目的 meta（题目归属库文件，按 id 前缀推导） */
  const questionMeta = (id) =>
    page.evaluate(async (qid) => {
      const file = `data/bank-${qid[0].toLowerCase()}.json`;
      const d = await (await fetch(file)).json();
      return d.questions.find((q) => q.id === qid) ?? null;
    }, id);
  /** 读单选题的题库标签（题目卡片上的 tag--bank） */
  const bankTagText = () => txt(".tags .tag--bank");

  /* ---------- [1] 未登录重定向到 login ---------- */
  console.log("\n[1] 未登录重定向");
  await page.goto(`${BASE}/#/home`, { waitUntil: "networkidle2" });
  await sleep(200);
  const hash1 = await page.evaluate(() => location.hash);
  ok("未登录访问 home → 重定向 #/login", hash1 === "#/login", `实际 ${hash1}`);
  ok("登录表单渲染", (await count("#authForm")) === 1);
  await page.screenshot({ path: path.join(OUT, "01-login.png"), fullPage: true });

  /* ---------- [2] 注册首用户（admin）+ 首页三题库 ---------- */
  console.log("\n[2] 注册首用户 / 首页题库");
  await page.click('.auth__tab[data-tab="register"]');
  await sleep(100);
  await page.type('input[name="username"]', ADMIN);
  await page.type('input[name="password"]', ADMIN_PW);
  await page.click("#authSubmit");
  await page.waitForSelector(".hero", { timeout: 10000 });
  ok("注册后跳转 home", (await page.evaluate(() => location.hash)) === "#/home");
  ok("首页 hero 渲染", !!(await txt(".hero__title")));

  const me = await page.evaluate(async () => {
    const r = await fetch("/api/me", { headers: { Authorization: `Bearer ${localStorage.getItem("quizapp.token.v1")}` } });
    return r.ok ? r.json() : null;
  });
  ok("注册用户 role=admin", me?.role === "admin", JSON.stringify(me));

  const cards = await page.$$eval(".bank-card", (ns) =>
    ns.map((n) => ({ id: n.dataset.bank, on: n.classList.contains("is-on"), title: n.querySelector(".bank-card__title").textContent.trim() })));
  ok("首页题库卡片 3 个", cards.length === 3, cards.map((c) => `${c.id}:${c.title}`).join(" | "));
  ok("默认仅选中指南库 G", (await selectedCards()).join(",") === "G", `实际 ${(await selectedCards()).join(",")}`);
  ok(`默认题池 ${TARGET_PER_BANK} 题（仅 G 已加载）`, (await poolSize()) === TARGET_PER_BANK, `实际 ${await poolSize()}`);

  const domainChips = await count("#domainChips .chip");
  const typeLabels = await page.$$eval("#typeChips .chip", (ns) => ns.map((n) => n.childNodes[0].textContent.trim()));
  ok("领域筛选 6 个（G 库自治领域）", domainChips === 6, `实际 ${domainChips}`);
  ok("题型筛选 5 个（单选/多选/判断/填空/简答）", typeLabels.length === 5, typeLabels.join("/"));
  ok("题型含填空题与简答题", typeLabels.includes("填空题") && typeLabels.includes("简答题"), typeLabels.join("/"));
  await page.screenshot({ path: path.join(OUT, "02-home.png"), fullPage: true });

  /* ---------- [3] 题库清单与文件结构 ---------- */
  console.log("\n[3] 题库清单与结构");
  const manifest = await page.evaluate(async () => {
    const r = await fetch("/data/banks.json");
    const d = await r.json();
    return {
      status: r.status,
      version: d.version,
      banks: (d.banks ?? []).map((b) => ({
        id: b.id,
        file: b.file,
        domains: (b.domains ?? []).length,
        target: Object.values(b.typeCounts ?? {}).reduce((a, c) => a + c, 0),
      })),
    };
  });
  ok("banks.json 可访问且含 3 个库", manifest.status === 200 && manifest.banks.map((b) => b.id).join(",") === "G,P,Y",
    `HTTP ${manifest.status} / ${manifest.banks.map((b) => b.id).join(",")}`);
  ok(`每库目标 ${TARGET_PER_BANK} 题`, manifest.banks.every((b) => b.target === TARGET_PER_BANK),
    manifest.banks.map((b) => `${b.id}=${b.target}`).join(" "));

  const gBank = await page.evaluate(async () => {
    const d = await (await fetch("/data/bank-g.json")).json();
    const qs = d.questions;
    const byType = {};
    for (const q of qs) byType[q.type] = (byType[q.type] ?? 0) + 1;
    const ids = new Set(qs.map((q) => q.id));
    const has = (id) => ids.has(id);
    let legacyRange = true;
    for (let i = 1; i <= 47; i++) if (!has(`G-S${String(i).padStart(3, "0")}`)) legacyRange = false;
    for (let i = 1; i <= 10; i++) if (!has(`G-M${String(i).padStart(3, "0")}`)) legacyRange = false;
    for (let i = 1; i <= 15; i++) if (!has(`G-J${String(i).padStart(3, "0")}`)) legacyRange = false;
    return {
      total: qs.length,
      byType,
      idOk: qs.every((q) => /^[GPY]-[SMJFA]\d{3}$/.test(q.id)),
      legacy: qs.some((q) => /^(F|SA)\d/.test(q.id)),
      legacyRange,
      fillBad: qs.filter((q) => q.type === "fill" && String(q.stem).split("____").length - 1 !== (q.answer ?? []).length).length,
    };
  });
  const t = gBank.byType;
  ok(`G 库 ${TARGET_PER_BANK} 题`, gBank.total === TARGET_PER_BANK, `实际 ${gBank.total}`);
  ok("G 题型配比 400/200/200/100/100",
    t.single === 400 && t.multiple === 200 && t.judge === 200 && t.fill === 100 && t.short === 100, JSON.stringify(t));
  ok("全部 id 为「库-题型+三位序号」三段式", gBank.idOk);
  ok("旧 F/SA 前缀已清理", !gBank.legacy);
  ok("旧 68 题并入 G 且原编号段保留（S001-S047 / M001-M010 / J001-J015）", gBank.legacyRange);
  ok("填空题空数与答案项数一一对应", gBank.fillBad === 0, `不一致 ${gBank.fillBad} 题`);
  const obsolete = await page.evaluate(async () => (await fetch("/data/questions.json")).status);
  ok("旧 questions.json 已下线", obsolete !== 200, `HTTP ${obsolete}`);

  /* ---------- [4] 单选题 ---------- */
  console.log("\n[4] 单选题");
  await go("practice?type=single");
  await page.waitForSelector(".opt");
  ok("题干渲染", !!(await txt(".stem")));
  ok("四个选项", (await count(".opt")) === 4);
  ok("题目显示所属题库标签", (await bankTagText()) === "《3-6岁儿童学习与发展指南》", await bankTagText());
  await page.click(".opt");                       // 选第一个（多答错）
  await sleep(250);
  ok("即时判定出现", !!(await txt(".verdict")));
  ok("展示解析", (await count(".analysis")) > 0);
  ok("作答后选项锁定", await page.$$eval(".opt", (ns) => ns.every((n) => n.disabled)));
  ok("正确选项染色", (await count(".opt.is-ok")) === 1);
  await page.screenshot({ path: path.join(OUT, "03-single.png"), fullPage: true });
  await domClick("#pNext");
  await sleep(200);
  ok("下一题推进", (await txt(".practice-head__idx b")) === "2");

  /* ---------- [5] 多选题 ---------- */
  console.log("\n[5] 多选题");
  await go("practice?type=multiple");
  await page.waitForSelector(".opt");
  ok("未选时确认按钮禁用", await page.$eval("#pConfirm", (n) => n.disabled));
  await page.click('.opt[data-letter="A"]');
  await page.click('.opt[data-letter="B"]');
  await sleep(120);
  ok("多选提示已选 AB", (await txt("#multiHint")) === "已选 AB");
  ok("选中态视觉反馈", (await count(".opt.is-sel")) === 2);
  await domClick("#pConfirm");
  await sleep(250);
  ok("多选判定完成", !!(await txt(".verdict")));
  await page.screenshot({ path: path.join(OUT, "04-multiple.png"), fullPage: true });

  /* ---------- [6] 判断题 ---------- */
  console.log("\n[6] 判断题");
  await go("practice?type=judge");
  await page.waitForSelector(".judge__btn");
  ok("两个判断按钮", (await count(".judge__btn")) === 2);
  await page.click('.judge__btn[data-judge="true"]');
  await sleep(250);
  ok("判断判定完成", !!(await txt(".verdict")));
  ok("判断作答后锁定", await page.$$eval(".judge__btn", (ns) => ns.every((n) => n.disabled)));
  await page.screenshot({ path: path.join(OUT, "05-judge.png"), fullPage: true });

  /* ---------- [7] 填空题（用户自判）---------- */
  console.log("\n[7] 填空题自判");
  await go("practice?type=fill");
  await page.waitForSelector("#pConfirm");
  const fillInfo = await page.evaluate(() => ({
    inputs: document.querySelectorAll(".blank-input").length,
    hint: document.querySelector("#qBody .opt-hint")?.textContent ?? "",
  }));
  ok("题干渲染为多个输入框（≥2 空）", fillInfo.inputs >= 2, `${fillInfo.inputs} 空`);
  ok("提示空数与输入框数一致", new RegExp(`共\\s*${fillInfo.inputs}\\s*空`).test(fillInfo.hint), fillInfo.hint.trim());

  const fillId = (await session()).current;
  const fillMeta = await questionMeta(fillId);
  ok("空数 = 参考答案项数", (fillMeta?.answer ?? []).length === fillInfo.inputs,
    `${fillInfo.inputs} 空 / 答案 ${(fillMeta?.answer ?? []).length} 项`);
  ok("对照答案按钮在留空时可用", !(await page.$eval("#pConfirm", (n) => n.disabled)));

  // 第 1 空填正确答案，其余留空（Q13：允许留空）
  await page.evaluate((v) => { document.querySelector(".blank-input").value = v; }, fillMeta.answer[0]);
  await domClick("#pConfirm");
  await sleep(200);
  ok("提交后出现「我答对了 / 我答错了」", (await count("#pJudgeOk")) === 1 && (await count("#pJudgeBad")) === 1);
  ok("提交后展示参考答案", !!(await txt(".answer-line__block")));
  ok("锁定空为「你的作答 ／ 参考答案」双栏", (await count(".blank--locked")) === fillInfo.inputs);
  ok("留空的空显示「（未填）」", /（未填）/.test(await page.$eval("#qBody", (n) => n.textContent)));
  ok("未自判前不判对错（无 verdict）", (await count(".verdict")) === 0);
  const beforeJudge = await page.evaluate((id) => !!window.__quiz.storage.getStore().records[id], fillId);
  ok("未自判前不写记录", !beforeJudge, fillId);
  await page.screenshot({ path: path.join(OUT, "06-fill-compare.png"), fullPage: true });

  await domClick("#pJudgeOk");
  await sleep(250);
  ok("点「我答对了」→ 判定正确", (await count(".verdict--ok")) === 1);
  ok("自判染色：答对空 1 个 / 留空空 1 个",
    (await count(".blank--locked.is-ok")) === 1 && (await count(".blank--locked.is-bad")) === fillInfo.inputs - 1,
    `ok=${await count(".blank--locked.is-ok")} bad=${await count(".blank--locked.is-bad")}`);
  const fillRec = (await store()).records[fillId];
  ok("自判结果落库（attempts=1 / lastCorrect=true）", fillRec?.attempts === 1 && fillRec?.lastCorrect === true, JSON.stringify(fillRec));
  ok("填空题答对不进错题本", !(await store()).wrongbook[fillId]);

  // 下一题：全填乱写 + 自判为错
  await domClick("#pNext");
  await sleep(200);
  const fillId2 = (await session()).current;
  await page.evaluate(() => { document.querySelectorAll(".blank-input").forEach((i) => { i.value = "乱写的内容"; }); });
  await domClick("#pConfirm");
  await sleep(200);
  await domClick("#pJudgeBad");
  await sleep(250);
  ok("点「我答错了」→ 判定错误（用户判定优先于文本比对）", (await count(".verdict--bad")) === 1);
  const fillRec2 = (await store()).records[fillId2];
  ok("填空题判错落库并进错题本", fillRec2?.lastCorrect === false && !!(await store()).wrongbook[fillId2], fillId2);

  /* ---------- [8] 简答题（用户自判）---------- */
  console.log("\n[8] 简答题自判");
  await go("practice?type=short");
  await page.waitForSelector("#shortInput");
  ok("简答题渲染文本域", (await count("#shortInput")) === 1);
  await page.type("#shortInput", "这是简答题的自判测试作答");
  await domClick("#pConfirm");
  await sleep(200);
  ok("提交后展示我的作答", /自判测试作答/.test(await txt(".short-answer__text") ?? ""));
  ok("提交后展示参考答案", !!(await txt(".answer-line__block")));
  ok("提交后出现自判按钮", (await count("#pJudgeOk")) === 1);
  const shortId = (await session()).current;
  ok("简答题未自判前不写记录", !(await store()).records[shortId], shortId);
  await domClick("#pJudgeBad");
  await sleep(250);
  ok("简答自判为错", (await count(".verdict--bad")) === 1);
  const shortRec = (await store()).records[shortId];
  ok("简答题判错落库并进错题本", shortRec?.lastCorrect === false && !!(await store()).wrongbook[shortId], shortId);
  await page.screenshot({ path: path.join(OUT, "07-short.png"), fullPage: true });

  /* ---------- [9] 错题本 ---------- */
  console.log("\n[9] 错题本");
  await go("wrongbook");
  await sleep(200);
  const wrongItems = await count(".item");
  const badge = await page.$eval("#tabBadge", (n) => (n.hidden ? "hidden" : n.textContent));
  ok("错题本有条目（≥2，含填空与简答）", wrongItems >= 2, `${wrongItems} 条，角标=${badge}`);
  ok("错题条目带题库标签", (await count(".item .tag--bank")) === wrongItems, `${await count(".item .tag--bank")}/${wrongItems}`);
  await page.screenshot({ path: path.join(OUT, "08-wrongbook.png"), fullPage: true });

  /* ---------- [10] 统计页 ---------- */
  console.log("\n[10] 统计页");
  await go("stats");
  await sleep(250);
  ok("统计页渲染", !!(await txt(".stat-grid")));
  ok("进度/领域/题型分段", (await count(".rate-row")) >= 12, `${await count(".rate-row")} 行`);
  const statsAbout = await page.$$eval(".about", (ns) => ns.map((n) => n.textContent).join(""));
  ok("口径说明提到自判题计入统计", /自行判定/.test(statsAbout));
  ok("单库时不显示分题库板块", !/分题库掌握情况/.test(await page.$eval("#app", (n) => n.textContent)));
  await page.screenshot({ path: path.join(OUT, "09-stats.png"), fullPage: true });

  /* ---------- [11] 题库多选 / 切换 / 偏好持久化 ---------- */
  console.log("\n[11] 题库多选与切换");
  await go("home");
  await page.click('.bank-card[data-bank="P"]');
  await page.waitForFunction(() => document.querySelector('.bank-card[data-bank="P"]')?.classList.contains("is-on"), { timeout: 15000 });
  await sleep(200);
  ok("选中 P 后为 {G,P}", (await selectedCards()).join(",") === "G,P", (await selectedCards()).join(","));
  ok(`合并题池 ${TARGET_PER_BANK * 2} 题`, (await poolSize()) === TARGET_PER_BANK * 2, `实际 ${await poolSize()}`);
  ok("合并后领域 chips 去重合并（6+5=11）", (await count("#domainChips .chip")) === 11, `${await count("#domainChips .chip")}`);

  // 合并刷题：两库都会被抽到
  await go("practice");
  const mixIds = (await session()).ids;
  const gN = mixIds.filter((i) => i.startsWith("G-")).length;
  const pN = mixIds.filter((i) => i.startsWith("P-")).length;
  ok("合并刷题时两库均被抽到", gN > 0 && pN > 0, `G=${gN} P=${pN}`);

  // 多库时统计页出现「分题库掌握情况」
  await go("stats");
  const multiStats = await page.$eval("#app", (n) => n.textContent);
  ok("多库时显示「分题库掌握情况」并含两库标题",
    /分题库掌握情况/.test(multiStats) && /3-6岁儿童学习与发展指南/.test(multiStats) && /幼儿园保育教育质量评估/.test(multiStats));
  await go("home");
  await page.screenshot({ path: path.join(OUT, "10-home-multi.png"), fullPage: true });

  // 偏好持久化
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(400);
  ok("刷新后题库选择保持 {G,P}", (await selectedCards()).join(",") === "G,P", (await selectedCards()).join(","));
  ok(`刷新后题池仍为 ${TARGET_PER_BANK * 2} 题`, (await poolSize()) === TARGET_PER_BANK * 2, `实际 ${await poolSize()}`);

  // 取消 G → 仅 P
  await page.click('.bank-card[data-bank="G"]');
  await sleep(600);
  ok("取消 G 后仅剩 P", (await selectedCards()).join(",") === "P", (await selectedCards()).join(","));
  const pDomains = await page.$$eval("#domainChips .chip", (ns) => ns.map((n) => n.childNodes[0].textContent.trim()));
  ok("P 库领域自治（5 个方面）", pDomains.length === 5 && pDomains.includes("办园方向") && pDomains.includes("教师队伍"), pDomains.join("/"));
  await go("practice");
  const pSess = await session();
  ok("仅选 P 时抽题全部为 P- 前缀", pSess.ids.length === MAX_PER_SESSION && pSess.ids.every((i) => i.startsWith("P-")),
    `${pSess.ids.length} 题 / 首题 ${pSess.ids[0]}`);
  ok("题目显示 P 库标题", (await bankTagText()) === "幼儿园保育教育质量评估", await bankTagText());
  const pDomainTag = await txt(".tags .tag:not(.tag--type):not(.tag--bank)");
  ok("题目领域标签为 P 库自治标签", ["办园方向", "保育与安全", "教育过程", "环境创设", "教师队伍"].includes(pDomainTag ?? ""), pDomainTag);

  // 恢复为仅 G
  await go("home");
  await page.click('.bank-card[data-bank="G"]');
  await sleep(400);
  await page.click('.bank-card[data-bank="P"]');
  await sleep(400);
  ok("恢复为仅选中 G", (await selectedCards()).join(",") === "G", (await selectedCards()).join(","));
  ok("至少保留 1 个题库（唯一选中项不可取消）", await page.evaluate(async () => {
    const card = document.querySelector('.bank-card[data-bank="G"]');
    card.click();
    await new Promise((r) => setTimeout(r, 300));
    return document.querySelectorAll(".bank-card.is-on").length === 1;
  }));

  /* ---------- [12] 抽题上限 / 再刷一遍 / 换一批 ---------- */
  console.log("\n[12] 抽题上限与批次操作");
  await go("practice?type=single");
  await page.waitForSelector(".opt");
  ok(`单次抽题上限 ${MAX_PER_SESSION}（首页 1 / ${MAX_PER_SESSION}）`,
    /^1\s*\/\s*100$/.test((await txt(".practice-head__idx")) ?? ""), await txt(".practice-head__idx"));
  const idsA = (await session()).ids;
  ok("会话题序 100 条且不重复", idsA.length === MAX_PER_SESSION && new Set(idsA).size === MAX_PER_SESSION);

  // 同步连点答完（视图每次作答都是同步重绘，故无需等待）
  const answerAll = (n) => page.evaluate((total) => {
    let done = 0;
    for (let i = 0; i < total; i++) {
      const opt = document.querySelector(".opt");
      if (!opt) break;
      opt.click();
      done++;
      const next = document.querySelector("#pNext");
      if (!next) break;
      next.click();
    }
    return { done, atSummary: !!document.querySelector(".summary") };
  }, n);

  const runA = await answerAll(MAX_PER_SESSION);
  ok(`连续作答 ${MAX_PER_SESSION} 题后进入总结页`, runA.done === MAX_PER_SESSION && runA.atSummary, JSON.stringify(runA));
  ok("总结页有「再刷一遍」与「换一批」", (await count("#pAgain")) === 1 && (await count("#pShuffle")) === 1);
  await page.screenshot({ path: path.join(OUT, "11-summary.png"), fullPage: true });

  await domClick("#pAgain");
  await sleep(250);
  const idsB = (await session()).ids;
  ok("再刷一遍 = 同一批题（id 集合一致）",
    idsB.length === idsA.length && idsA.every((id) => idsB.includes(id)));
  ok("再刷一遍 = 重新打乱顺序", idsA.join() !== idsB.join());
  ok("再刷一遍后统计归零并回到第 1 题",
    /^1\s*\/\s*100$/.test((await txt(".practice-head__idx")) ?? ""), await txt(".practice-head__idx"));

  const runB = await answerAll(MAX_PER_SESSION);
  ok("再刷一遍的批次可完整作答", runB.done === MAX_PER_SESSION && runB.atSummary, JSON.stringify(runB));
  await domClick("#pShuffle");
  await sleep(250);
  const idsC = (await session()).ids;
  const overlap = idsC.filter((id) => idsB.includes(id)).length;
  ok("换一批 = 重新抽题（抽到新题，交集 < 批次大小）", idsC.length === MAX_PER_SESSION && overlap < MAX_PER_SESSION,
    `与上一批重合 ${overlap}/${MAX_PER_SESSION}`);
  ok("换一批后回到第 1 题", /^1\s*\/\s*100$/.test((await txt(".practice-head__idx")) ?? ""));

  /* ---------- [13] 设置页 / 导出 / 邀请码 ---------- */
  console.log("\n[13] 设置页 / 导出 / 邀请码");
  await go("settings");
  await sleep(200);
  const accountText = await txt(".card");
  ok("账号区显示用户名", accountText?.includes(ADMIN));
  ok("账号区显示管理员角色", /管理员/.test(accountText || ""));
  ok("退出登录按钮", (await count("#btnLogout")) === 1);
  ok("管理员邀请码区可见", (await count("#btnGenInvite")) === 1);
  ok("关于区列出 3 个题库", /共 3 个题库/.test(await page.$eval("#app", (n) => n.textContent)));

  const exported = await page.evaluate(() => {
    const m = window.__quiz.storage;
    const text = m.exportJson();
    const parsed = JSON.parse(text);
    return {
      keys: Object.keys(parsed).join(","),
      version: parsed.version,
      ok: m.validateImport(text).ok,
      sample: Object.keys(parsed.records)[0] ?? "",
    };
  });
  ok("导出结构 v3（version,records,wrongbook,updatedAt）",
    exported.keys === "version,records,wrongbook,updatedAt" && exported.version === 3, `${exported.keys} v${exported.version}`);
  ok("导出记录 id 为三段式", /^[GPY]-[SMJFA]\d{3}$/.test(exported.sample), exported.sample);
  ok("导出可被自身校验通过", exported.ok);
  await page.screenshot({ path: path.join(OUT, "12-settings.png"), fullPage: true });

  await page.click("#btnGenInvite");
  await sleep(400);
  const inviteCode = await page.evaluate(() => document.querySelector(".invite-item__code")?.textContent || "");
  ok("生成 16 字符邀请码", inviteCode.length === 16, `实际 ${inviteCode.length} "${inviteCode}"`);
  ok("邀请码未使用标记", /未使用/.test(await txt(".invite-item__state") ?? ""));
  await page.screenshot({ path: path.join(OUT, "13-invites.png"), fullPage: true });

  /* ---------- [14] 持久化（刷新后从云端拉回）---------- */
  console.log("\n[14] 持久化");
  await go("home");
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(600);
  ok("刷新后保持登录", (await page.evaluate(() => location.hash)) !== "#/login");
  const persisted = Object.keys((await store()).records).length;
  ok("刷新后记录从云端拉回", persisted > 0, `${persisted} 条记录`);

  /* ---------- [15] 响应式 / 深链接 ---------- */
  console.log("\n[15] 响应式 / 深链接");
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await go("home");
  const layout = await page.evaluate(() => ({ appW: Math.round(document.querySelector(".app").getBoundingClientRect().width) }));
  ok("桌面端内容列限宽 720", layout.appW === 720, `实际 ${layout.appW}px`);
  await page.screenshot({ path: path.join(OUT, "14-desktop.png"), fullPage: true });

  await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 2 });
  await go("home");
  const narrow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  ok("360px 无横向溢出", narrow.sw <= narrow.iw + 1, `scrollWidth=${narrow.sw} innerWidth=${narrow.iw}`);
  await page.screenshot({ path: path.join(OUT, "15-mobile360.png"), fullPage: true });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

  await page.goto(`${BASE}/#/practice?domain=science&type=single`, { waitUntil: "networkidle2" });
  await sleep(300);
  const deep = await page.evaluate(async () => {
    const d = await (await fetch("/data/bank-g.json")).json();
    const expect = d.questions.filter((q) => q.domain === "science" && q.type === "single").length;
    const head = document.querySelector(".practice-head__idx")?.textContent || "";
    const total = Number((head.match(/\/\s*(\d+)/) || [])[1] || 0);
    return { expect, total };
  });
  ok("深链接筛选正确", deep.expect === deep.total, `科学+单选 期望 ${deep.expect} 实际 ${deep.total}`);

  /* ---------- [16] v1 → v3 首次上云迁移 ---------- */
  console.log("\n[16] v1→v3 迁移（首次上云）");
  const token = await page.evaluate(() => localStorage.getItem("quizapp.token.v1"));
  await page.evaluate(async () => {
    const m = window.__quiz.storage;
    m.clearAll();
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
  await sleep(1000);
  const mig = await page.evaluate(async () => {
    const s = window.__quiz.storage.getStore();
    return {
      version: s.version,
      s25: s.records?.["G-S025"] ?? s.records?.["G-S025"],
      hasS02: !!s.records?.["S02"],
      hasGap: !!s.records?.["G-S002"],
      hasX99: !!s.records?.["X99"],
      hasS27: !!s.wrongbook?.["G-S027"],
      hasRecite: "recite" in s,
      localCleared: !localStorage.getItem("quizapp.data.v1"),
    };
  });
  ok("迁移后 version=3", mig.version === 3, `version=${mig.version}`);
  ok("F01 → G-S025 且保留 attempts=3", mig.s25?.attempts === 3, JSON.stringify(mig.s25));
  ok("v1→v2 阶段丢弃的 lastUserAnswer 不回填", mig.s25 && !("lastUserAnswer" in mig.s25));
  ok("已删题 S02 剔除（不复活为新 G-S002）", !mig.hasS02 && !mig.hasGap);
  ok("孤儿 X99 剔除", !mig.hasX99);
  ok("错题本 F03 → G-S027", mig.hasS27);
  ok("recite 表移除", !mig.hasRecite);
  ok("本地旧数据已清源", mig.localCleared);

  const cloud = await page.evaluate(async (t) => {
    const r = await fetch("/api/store", { headers: { Authorization: `Bearer ${t}` } });
    return r.ok ? r.json() : null;
  }, token);
  ok("迁移已上云（云端含 G-S025）", !!cloud?.store?.records?.["G-S025"]);

  /* ---------- [17] v2 备份导入（迁移到 v3）---------- */
  console.log("\n[17] v2 备份导入");
  const imported = await page.evaluate(async () => {
    const m = window.__quiz.storage;
    m.clearAll();
    await fetch("/api/store", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${localStorage.getItem("quizapp.token.v1")}` },
    });
    const v2 = {
      version: 2,
      records: {
        S01: { attempts: 3, wrongAttempts: 1, lastCorrect: true, lastUserAnswer: "C", firstAt: 1000, lastAt: 2000 },
        J05: { attempts: 2, wrongAttempts: 0, lastCorrect: true, lastUserAnswer: true, firstAt: 900, lastAt: 1500 },
        S02: { attempts: 1, wrongAttempts: 0, lastCorrect: true, firstAt: 1, lastAt: 1 },
      },
      wrongbook: { M01: { wrongCount: 2, addedAt: 1000, lastWrongAt: 1500 } },
      updatedAt: 2000,
    };
    const text = JSON.stringify(v2);
    const check = m.validateImport(text);
    if (check.ok && check.store) m.applyImport(check.store, "replace");
    const s = m.getStore();
    return {
      ok: check.ok,
      reason: check.reason,
      version: check.store?.version,
      s001: check.store?.records?.["G-S001"]?.attempts,
      j005: check.store?.records?.["G-J005"]?.attempts,
      m001: check.store?.wrongbook?.["G-M001"]?.wrongCount,
      hasS02: !!check.store?.records?.["S02"],
      live: s.records?.["G-S001"]?.attempts,
      liveVersion: s.version,
    };
  });
  ok("v2 备份校验通过并升级为 v3", imported.ok && imported.version === 3, `${imported.reason ?? ""} v${imported.version}`);
  ok("S01 → G-S001 保留 attempts=3", imported.s001 === 3, `attempts=${imported.s001}`);
  ok("J05 → G-J005 保留 attempts=2", imported.j005 === 2, `attempts=${imported.j005}`);
  ok("错题本 M01 → G-M001", imported.m001 === 2, `wrongCount=${imported.m001}`);
  ok("非法旧 id S02 被剔除", !imported.hasS02);
  ok("导入后生效（version=3 且含 G-S001）", imported.live === 3 && imported.liveVersion === 3, `attempts=${imported.live}`);

  /* ---------- [18] 登出 / 登录 round-trip ---------- */
  console.log("\n[18] 登出 / 登录");
  await go("settings");
  await page.click("#btnLogout");
  await sleep(400);
  ok("登出后回到 login", (await page.evaluate(() => location.hash)) === "#/login");

  await page.click('.auth__tab[data-tab="login"]');
  await page.type('input[name="username"]', ADMIN);
  await page.type('input[name="password"]', "wrongPass99");
  await page.click("#authSubmit");
  await sleep(500);
  const errNote = await txt("#authNote");
  ok("错误密码提示", /用户名或密码错误|401/.test(errNote || ""), `note="${errNote?.slice(0, 30)}"`);

  await page.evaluate(() => document.querySelector("#authForm")?.reset());
  await page.type('input[name="username"]', ADMIN);
  await page.type('input[name="password"]', ADMIN_PW);
  await page.click("#authSubmit");
  await page.waitForSelector(".hero");
  ok("正确登录后回 home", (await page.evaluate(() => location.hash)) === "#/home");
  const back = await store();
  ok("登录后数据回来（含迁移的 G-S001）", Object.keys(back.records).length > 0 && back.records["G-S001"]?.attempts === 3,
    `${Object.keys(back.records).length} 条 / G-S001=${back.records["G-S001"]?.attempts}`);

  /* ---------- [19] 鉴权 / 隔离 ---------- */
  console.log("\n[19] 鉴权 / 数据隔离");
  const iso = await page.evaluate(async (t, invite, userB, pwB) => {
    const reg = await fetch("/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: userB, password: pwB, inviteCode: invite }),
    });
    const regData = reg.ok ? await reg.json() : null;
    if (!regData) return { regOk: false, regStatus: reg.status };

    await fetch("/api/store", {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${regData.token}` },
      body: JSON.stringify({ store: { version: 3, records: { "P-S001": { lastAt: 2 } }, wrongbook: {}, updatedAt: 2 }, baseUpdatedAt: 0 }),
    });

    const aRes = await fetch("/api/store", { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
    const bRes = await fetch("/api/store", { headers: { Authorization: `Bearer ${regData.token}` } }).then((r) => r.json());
    return {
      regOk: true,
      bRole: regData.user?.role,
      aHasG: !!aRes.store?.records?.["G-S001"],
      aHasP: !!aRes.store?.records?.["P-S001"],
      bHasP: !!bRes.store?.records?.["P-S001"],
      bHasG: !!bRes.store?.records?.["G-S001"],
    };
  }, token, inviteCode, USERB, USERB_PW);
  ok("B 注册成功（role=user）", iso.regOk && iso.bRole === "user", JSON.stringify(iso));
  ok("A store 含 G-S001 不含 B 的 P-S001", iso.aHasG && !iso.aHasP);
  ok("B store 含 P-S001 不含 A 的 G-S001", iso.bHasP && !iso.bHasG);

  const reuse = await page.evaluate(async (invite) => {
    const r = await fetch("/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: `dup_${Math.random().toString(36).slice(2, 8)}`, password: "Pass12345678", inviteCode: invite }),
    });
    return { status: r.status };
  }, inviteCode);
  ok("邀请码不可复用 403", reuse.status === 403, `实际 ${reuse.status}`);

  const dup = await page.evaluate(async (admin, pw) => {
    const r = await fetch("/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: admin, password: pw }),
    });
    return { status: r.status };
  }, ADMIN, ADMIN_PW);
  ok("重复用户名 409", dup.status === 409, `实际 ${dup.status}`);

  const noToken = await page.evaluate(async () => (await fetch("/api/invites")).status);
  ok("无 token 调 /api/invites 401", noToken === 401, `实际 ${noToken}`);

  await page.evaluate(() => localStorage.setItem("quizapp.token.v1", "garbage.token.here"));
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(600);
  ok("token 篡改后重定向 login", (await page.evaluate(() => location.hash)) === "#/login");

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
