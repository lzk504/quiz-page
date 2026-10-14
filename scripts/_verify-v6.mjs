/**
 * v6 主门禁：真实浏览器端到端验证（Puppeteer + 本机 Chrome）。
 *
 * 前置：起一个独立沙箱实例（全新 D1，首用户可直接注册）
 *   npx wrangler dev --port 8788 --persist-to .wrangler/_verify
 *
 * 用法：node scripts/_verify-v6.mjs [baseUrl] [outDir]
 *
 * 覆盖：标题口径 / 4 tab 壳层 / 首页（今日目标·快捷入口·备考科目·推荐复习）/
 *       题库 tab（单选选库=刷题范围·章节联动·去编号·简介去重）/ 练习（收藏星标·退出续刷草稿）/
 *       考试模式（倒计时·零反馈·弹窗交卷·仅按已作答计分·弹窗退出出分）/
 *       错题本（三数字·题型 chips·答案对照·重做）/ 收藏页（不展示答案）/ 设置（昵称）/
 *       v3 备份迁移 / 响应式不溢出 / 控制台无错误。
 */
import path from "node:path";
import fs from "node:fs";
import puppeteer from "puppeteer";

const BASE = process.argv[2] || process.env.E2E_TARGET || "http://127.0.0.1:8788";
const OUT = process.argv[3] || path.join(process.cwd(), "scripts", "_shots");
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP_NAME = "考点精编";

const errors = [];
const results = [];
const ok = (name, pass, extra = "") => {
  results.push({ name, pass, extra });
  console.log(`${pass ? "  ✓" : "  ✗"} ${name}${extra ? "  " + extra : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2, 10);
const ADMIN = `v6admin_${rnd()}`;
const ADMIN_PW = `Pass${rnd()}1`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await fetch(`${BASE}/api/dev/reset`, { method: "POST" }).catch(() => {});

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setDefaultTimeout(15000);
  page.on("console", (m) => {
    const t = m.type();
    if (t === "error" && /Failed to load resource/i.test(m.text())) return;
    if (t === "error") errors.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    if (r.failure()?.errorText === "net::ERR_ABORTED" && /\/(api\/store|data\/)/.test(r.url())) return;
    errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  });

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

  /* ---------------- 工具 ---------------- */

  const go = async (hash, wait = 250) => {
    const cur = await page.evaluate(() => location.hash);
    // 同 hash 导航浏览器不产生任何事件 → 先挪到占位锚点强制触发重渲染
    if (cur === `#/${hash}`) {
      await page.evaluate(() => { location.hash = "#/__reload__"; });
      await sleep(80);
    }
    await page.goto(`${BASE}/#/${hash}`, { waitUntil: "networkidle2" });
    await sleep(wait);
  };
  const txt = (sel) => page.$eval(sel, (n) => n.textContent.trim()).catch(() => null);
  const count = (sel) => page.$$eval(sel, (n) => n.length).catch(() => 0);
  const domClick = (sel) => page.$eval(sel, (n) => n.click());
  /** 自定义确认弹窗交互（替代原生 confirm） */
  const modalConfirm = () => page.$eval("#modalOk", (n) => n.click());
  const modalCancel = () => page.$eval("#modalCancel", (n) => n.click());
  const DRAFT_KEY = `quizapp.draft.v1.${ADMIN}`;
  const hasDraft = () => page.evaluate((k) => !!localStorage.getItem(k), DRAFT_KEY);
  const clearDraft = () => page.evaluate((k) => localStorage.removeItem(k), DRAFT_KEY);
  /** 进入普通练习页；若弹出续刷提示则选「重新开始」（清草稿 + 重抽） */
  const enterPracticeFresh = async (wait = 400) => {
    await go("practice", wait);
    if ((await count(".modal")) === 1) { await modalCancel(); await sleep(300); }
  };
  const session = () => page.evaluate(() => window.__quiz.practice.session());
  const examSnap = () => page.evaluate(() => window.__quiz.practice.exam());
  const store = () => page.evaluate(() => window.__quiz.storage.getStore());
  const display = (sel) => page.$eval(sel, (n) => getComputedStyle(n).display).catch(() => null);
  const shot = (name) => page.screenshot({ path: path.join(OUT, `v6-${name}.png`), fullPage: true });
  /** 题目 meta（按 id 前缀找库文件） */
  const qMeta = (id) =>
    page.evaluate(async (qid) => {
      const file = `data/bank-${qid[0].toLowerCase()}.json`;
      const d = await (await fetch(file)).json();
      return d.questions.find((q) => q.id === qid) ?? null;
    }, id);

  /** 在当前题上故意作答错误（练习/考试通用，不做提交动作） */
  const answerWrong = async (q) => {
    if (q.type === "single") {
      const wrong = ["A", "B", "C", "D", "E"].find((l) => l !== String(q.answer));
      await domClick(`.opt[data-letter="${wrong}"]`);
    } else if (q.type === "multiple") {
      const want = new Set((q.answer || []).map(String));
      const pick = ["A", "B", "C", "D"].filter((l) => !want.has(l));
      if (pick.length) await domClick(`.opt[data-letter="${pick[0]}"]`);
      else await domClick('.opt[data-letter="A"]');
    } else if (q.type === "judge") {
      await domClick(`.judge__btn[data-judge="${q.answer ? "false" : "true"}"]`);
    } else if (q.type === "fill") {
      await page.$eval(".blank-input", (n) => { n.value = "错误答案"; });
    } else {
      await page.$eval("#shortInput", (n) => { n.value = "错误答案"; });
    }
  };

  /** 练习模式下把「答错」提交掉：多选要点确认，填空/简答要确认+自判「我答错了」 */
  const commitWrongPractice = async (q) => {
    if (q.type === "multiple") {
      await domClick("#pConfirm");
      await sleep(250);
    } else if (q.type === "fill" || q.type === "short") {
      await domClick("#pConfirm");
      await sleep(300);
      if (await page.$("#pJudgeBad")) { await domClick("#pJudgeBad"); await sleep(300); }
    }
  };

  /* ---------- [1] 登录页 + 注册首用户 ---------- */
  console.log("\n[1] 登录与标题口径");
  await page.goto(`${BASE}/#/home`, { waitUntil: "networkidle2" });
  await sleep(250);
  ok("未登录重定向 #/login", (await page.evaluate(() => location.hash)) === "#/login");
  ok(`文档标题固定「${APP_NAME}」`, (await page.title()) === APP_NAME, `实际 ${await page.title()}`);

  await page.click('.auth__tab[data-tab="register"]');
  await sleep(100);
  await page.type('input[name="username"]', ADMIN);
  await page.type('input[name="password"]', ADMIN_PW);
  await page.click("#authSubmit");
  await page.waitForSelector(".hero", { timeout: 15000 });
  ok("注册后进入首页", (await page.evaluate(() => location.hash)) === "#/home");

  /* ---------- [2] 首页 ---------- */
  console.log("\n[2] 首页");
  ok(`顶栏品牌名 = ${APP_NAME}`, (await txt(".topbar__title")) === APP_NAME);
  ok(`首页蓝卡大标题 = ${APP_NAME}`, (await txt("h1.hero__title")) === APP_NAME, `实际 ${await txt("h1.hero__title")}`);
  ok("文档标题不随视图变化", (await page.title()) === APP_NAME);
  ok("首页隐藏顶栏（自带标题区）", (await display(".topbar")) === "none");
  ok("问候语含用户名", ((await txt(".greet__hello")) || "").includes(ADMIN), `${await txt(".greet__hello")}`);
  ok("今日目标条 0 / 100", /0\s*\/\s*100/.test((await txt(".goal__num")) || ""), `${await txt(".goal__num")}`);
  ok("备考横幅含真实三库", /3 库|3000/.test((await txt(".exam-banner__sub")) || ""), `${await txt(".exam-banner__sub")}`);
  ok("快捷入口 4 个", (await count(".quick")) === 4);
  ok("我的备考科目 3 行", (await count(".subject")) === 3);
  ok("今日推荐复习初始为空态", ((await txt(".card .about")) || "").includes("暂无高频错题"));
  await shot("01-home");

  /* ---------- [3] 壳层：4 tab ---------- */
  console.log("\n[3] 壳层 4 tab");
  const tabs = await page.$$eval(".tab", (ns) => ns.map((n) => ({ t: n.dataset.tab, label: n.querySelector("span").textContent.trim() })));
  ok("底部 4 个 tab", tabs.length === 4, tabs.map((t) => `${t.t}:${t.label}`).join(" | "));
  ok("tab 文案：首页/题库/错题本/我的", tabs.map((t) => t.label).join(",") === "首页,题库,错题本,我的");
  ok("首页 tab 高亮", (await page.$eval('.tab[data-tab="home"]', (n) => n.classList.contains("is-active"))) === true);

  /* ---------- [4] 题库 tab ---------- */
  console.log("\n[4] 题库 tab");
  await go("banks", 400);
  ok("题库 tab 高亮", (await page.$eval('.tab[data-tab="banks"]', (n) => n.classList.contains("is-active"))) === true);
  ok("顶栏品牌名仍在（列表页）", (await display(".topbar")) !== "none");
  ok("库 pills 3 个", (await count(".bank-pill")) === 3);
  const pillTexts = await page.$$eval(".bank-pill", (ns) => ns.map((n) => n.textContent.trim()));
  ok("pill 文案隐藏题库编号（无 G/P/Y 前缀）",
    pillTexts.every((t) => !/^[GPY]/.test(t) && !t.includes("·")), pillTexts.join(" | "));
  ok("已移除「我的刷题范围」开关卡", (await count(".scope-row")) === 0 && (await count(".switch")) === 0);
  const overviewTitle = (await txt(".card .card__title")) || "";
  ok("题库简介来源去重（书名只出现一次）",
    (overviewTitle.match(/指南/g) || []).length === 1, overviewTitle);

  const chapBefore = await count(".chapter");
  const titleBefore = await txt(".card__title");
  const pillBefore = await page.$$eval(".bank-pill", (ns) => ns.findIndex((n) => n.classList.contains("is-on")));
  ok("默认选中第 1 个库（G，6 领域）", chapBefore === 6 && pillBefore === 0, `${chapBefore} 章 / pill#${pillBefore}`);
  await domClick('.bank-pill:nth-child(2)');
  await sleep(600);
  const chapAfter = await count(".chapter");
  const titleAfter = await txt(".card__title");
  const pillAfter = await page.$$eval(".bank-pill", (ns) => ns.findIndex((n) => n.classList.contains("is-on")));
  ok("切库后章节数与书名变化", chapBefore !== chapAfter && titleBefore !== titleAfter,
    `${chapBefore}章「${titleBefore}」→ ${chapAfter}章「${titleAfter}」`);
  ok("切库后第 2 个 pill 高亮", pillAfter === 1, `pill#${pillAfter}`);
  const storedScope = await page.evaluate(() => localStorage.getItem("quizapp.banks.v1"));
  ok("选库同时设为刷题范围（单选，写 localStorage）", storedScope === '["P"]', `${storedScope}`);
  const chapterCount = chapAfter;
  ok("章节行数 = 该库领域数（P=5）", chapterCount === 5, `实际 ${chapterCount}`);
  const typeCardCount = await count(".type-card");
  ok("题型说明 4 格", typeCardCount === 4);
  await shot("04-banks");

  // 章节行进入练习（domain 过滤生效）
  const firstChapterLabel = await txt(".chapter .chapter__title");
  await domClick(".chapter");
  await page.waitForSelector(".practice-head", { timeout: 10000 });
  await sleep(300);
  const practiceTitle = await txt(".practice-head__title");
  ok("点章节进入该领域练习", !!practiceTitle && practiceTitle.includes(firstChapterLabel), `${practiceTitle}`);
  await shot("05-practice");

  /* ---------- [5] 练习模式：星标收藏 ---------- */
  console.log("\n[5] 收藏星标");
  const curId = (await session()).current;
  ok("练习会话有当前题", !!curId, `${curId}`);
  ok("星标初始未选中", !(await page.$eval("#pStar", (n) => n.classList.contains("is-on"))));
  await domClick("#pStar");
  await sleep(300);
  ok("点星标后为已收藏", (await page.$eval("#pStar", (n) => n.classList.contains("is-on"))) === true);
  const favs = await page.evaluate(() => window.__quiz.storage.favorites());
  ok("收藏已落库", !!favs[curId], JSON.stringify(favs));

  // 收藏页：不展示答案
  await go("favorites", 400);
  ok("收藏页出现该题", (await count(".fav-card")) === 1);
  const favHtml = await page.$eval(".fav-list", (n) => n.innerHTML);
  const favMeta = await qMeta(curId);
  const answerText = String(favMeta.answer);
  ok("收藏列表不展示答案", !favHtml.includes(answerText) || answerText.length < 2,
    `answer="${answerText}"`);
  ok("收藏页无 topbar 隐藏（列表页显示品牌栏）", (await display(".topbar")) !== "none");
  await shot("06-favorites");

  // 取消收藏
  await domClick('[data-act="unfav2"]');
  await sleep(400);
  ok("取消收藏后列表为空态", (await count(".fav-card")) === 0 && ((await txt(".empty h3")) || "").includes("还没有收藏"));
  await enterPracticeFresh(400);
  await domClick("#pStar");
  await sleep(300);
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(600);
  const favs2 = await page.evaluate(() => window.__quiz.storage.favorites());
  ok("收藏刷新后仍存在（落库）", Object.keys(favs2).length === 1, JSON.stringify(favs2));

  /* ---------- [6] 考试模式 ---------- */
  console.log("\n[6] 考试模式");
  await go("practice?mode=exam", 800);
  const snap0 = await examSnap();
  ok("考试题量 100", snap0.total === 100, `实际 ${snap0.total}`);
  ok("考试倒计时显示", /⏱\s*\d{2}:\d{2}/.test((await txt("#examTimer")) || ""), `${await txt("#examTimer")}`);
  ok("考试进度显示", /\/ 100/.test((await txt(".exam-progress")) || ""), `${await txt(".exam-progress")}`);
  ok("已答 0 题时交卷按钮禁用", (await page.$eval("#examSubmit2", (n) => n.disabled)) === true);
  await shot("07-exam");

  // 判断题 UI：与选择题一致的行式选项（.opt 结构），选中态边框高亮
  const examIds = (await session()).ids;
  let judgeIdx = -1;
  for (let i = 0; i < examIds.length; i++) {
    if ((await qMeta(examIds[i])).type === "judge") { judgeIdx = i; break; }
  }
  ok("考试卷含判断题", judgeIdx >= 0, `judgeIdx=${judgeIdx}`);
  for (let i = 0; i < judgeIdx; i++) { await domClick("#examNext"); await sleep(120); }
  ok("判断题为行式选项（.opt.judge__btn ×2，含 key 徽标）",
    (await count(".judge .opt.judge__btn")) === 2 && (await count(".judge__btn .opt__key")) === 2,
    `btn=${await count(".judge .opt.judge__btn")} key=${await count(".judge__btn .opt__key")}`);
  ok("判断题未选中时无高亮", (await count(".judge__btn.is-sel")) === 0, `实际 ${await count(".judge__btn.is-sel")}`);
  await domClick('.judge__btn[data-judge="true"]');
  await sleep(300);
  ok("判断题选中后 is-sel 唯一高亮", (await count(".judge__btn.is-sel")) === 1, `实际 ${await count(".judge__btn.is-sel")}`);
  const selBorder = await page.$eval(".judge__btn.is-sel", (n) => getComputedStyle(n).borderColor);
  ok("判断题选中边框为主色高亮", selBorder === "rgb(107, 92, 231)", selBorder);
  await shot("07c-exam-judge-sel");
  for (let i = 0; i < judgeIdx; i++) { await domClick("#examPrev"); await sleep(120); }

  // 前 6 题故意答错（覆盖客观题错误落库），其余留空
  for (let i = 0; i < 6; i++) {
    const id = (await session()).current;
    const q = await qMeta(id);
    await answerWrong(q);
    await sleep(150);
    await domClick("#examNext");
    await sleep(250);
  }
  ok("已作答后交卷按钮可用", (await page.$eval("#examSubmit2", (n) => n.disabled)) === false);
  const peek = await page.$eval(".card", (n) => n.innerHTML);
  ok("考试作答中无反馈/无解析", !/verdict|answer-line|analysis/.test(peek));
  ok("考试作答中不出现「正确答案」", !peek.includes("正确答案"));

  // 交卷：先点弹窗「取消」→ 仍在作答；再点「交卷」→ 进入自评 / 出分
  await domClick("#examSubmit2");
  await sleep(400);
  ok("点交卷弹出确认弹窗", (await count(".modal")) === 1, `modal=${await count(".modal")}`);
  await shot("07b-exam-submit-modal");
  await modalCancel();
  await sleep(300);
  ok("取消交卷仍在作答（phase=answer）", (await examSnap()).phase === "answer", `phase=${(await examSnap()).phase}`);

  await domClick("#examSubmit2");
  await sleep(400);
  await modalConfirm();
  await sleep(800);
  const answeredNow = (await examSnap()).answered;   // 判断题 1 题 + 故意答错 6 题
  const skippedNow = 100 - answeredNow;
  let snap = await examSnap();
  ok("交卷后进入自评 / 出分", snap.phase === "judging" || snap.phase === "result", `phase=${snap.phase}`);
  if (snap.phase === "judging") {
    ok("自评首屏显示 1 / N", /1\s*\/\s*\d+/.test((await txt(".exam-progress")) || ""), `${await txt(".exam-progress")}`);
  } else {
    ok("自评首屏显示 1 / N", true, "本次作答无自判题，直接出分");
  }

  // 逐题自评：第 1 题判错，其余判对
  let guard = 0;
  while ((await examSnap()).phase === "judging" && guard < 30) {
    await domClick(guard === 0 ? "#ejBad" : "#ejOk");
    await sleep(250);
    guard++;
  }
  ok("自评完成进入出分页", (await examSnap()).phase === "result", `judged=${(await examSnap()).judged}`);
  ok("出分页显示分数", (await count(".exam-score")) === 1, `${await txt(".exam-score")}`);
  ok("出分页含逐题清单 100 行", (await count(".exam-row")) === 100, `实际 ${await count(".exam-row")}`);
  ok(`提前交卷：未作答 ${skippedNow} 题标「未作答」`, (await count(".exam-row--skip")) === skippedNow, `实际 ${await count(".exam-row--skip")}`);
  ok("分母 = 已作答题数（文案含未作答不计分）",
    new RegExp(`未作答\\s*${skippedNow}\\s*题不计分`).test((await txt(".exam-score__label")) || ""), `${await txt(".exam-score__label")}`);
  ok("出分页含分题型得分", (await count(".kpi")) >= 1, `实际 ${await count(".kpi")}`);
  const finalScore = (await examSnap()).score;
  ok("分数在 0-100（按已作答计分）", typeof finalScore === "number" && finalScore >= 0 && finalScore <= 100, `${finalScore}`);
  await shot("08-exam-result");

  // 退出考试：取消 → 继续作答；确认 → 按已作答提前交卷出分
  await go("practice?mode=exam", 600);
  ok("考试初始已答 0 题 → 交卷禁用", (await page.$eval("#examSubmit2", (n) => n.disabled)) === true);
  const eq = await qMeta((await session()).current);
  await answerWrong(eq);
  await sleep(300);
  await domClick("#examExit");
  await sleep(400);
  await modalCancel();
  await sleep(300);
  ok("取消退出仍在作答（hash 不变）",
    (await examSnap()).phase === "answer" && (await page.evaluate(() => location.hash)).startsWith("#/practice"),
    `${(await examSnap()).phase} / ${await page.evaluate(() => location.hash)}`);
  await domClick("#examExit");
  await sleep(400);
  await modalConfirm();
  await sleep(800);
  // 若已作答题恰好含填空/简答，会先进入统一自评，判完后才出分
  let exitPhase = (await examSnap()).phase;
  let exitGuard = 0;
  while (exitPhase === "judging" && exitGuard < 10) {
    await domClick("#ejOk");
    await sleep(250);
    exitPhase = (await examSnap()).phase;
    exitGuard++;
  }
  ok("确认退出 → 按已作答提前交卷出分", exitPhase === "result", `phase=${exitPhase}`);

  /* ---------- [6.5] 练习模式：退出续刷草稿 ---------- */
  console.log("\n[6.5] 练习退出续刷");
  await clearDraft();
  await go("practice", 500);
  const s0 = await session();
  const ids0 = s0.ids.join(",");
  ok("初始进入练习无续刷提示", (await count(".modal")) === 0, `modal=${await count(".modal")}`);
  ok("练习会话题量 ≤ 100", s0.ids.length > 0 && s0.ids.length <= 100, `${s0.ids.length}`);
  const q0 = await qMeta(s0.current);
  await answerWrong(q0);
  await sleep(200);
  await commitWrongPractice(q0);
  await sleep(300);
  await domClick("#pNext");
  await sleep(400);
  ok("练习前进到第 2 题", (await session()).index === 1, `index=${(await session()).index}`);

  await go("home", 400);
  ok("中途退出后写入本地草稿", (await hasDraft()) === true);

  // 路径 A：继续上次
  await go("practice", 500);
  ok("再次进入弹出续刷提示", (await count(".modal")) === 1, `modal=${await count(".modal")}`);
  ok("提示含进度文案", /第 \d+ 题（共 \d+ 题）/.test((await txt(".modal__msg")) || ""), `${await txt(".modal__msg")}`);
  await shot("06c-resume-modal");
  await modalConfirm();
  await sleep(400);
  const s1 = await session();
  ok("继续刷题还原原题序", s1.ids.join(",") === ids0, `${s1.ids.length} 题`);
  ok("继续刷题还原答题进度", s1.index === 1, `index=${s1.index}`);

  // 路径 B：重新开始
  await go("home", 400);
  await go("practice", 500);
  await modalCancel();
  await sleep(400);
  const s2 = await session();
  ok("重新开始后重新抽题（题序不同）", s2.ids.join(",") !== ids0);
  ok("重新开始后清除本地草稿", (await hasDraft()) === false);
  ok("重新开始后从第 1 题开始", s2.index === 0, `index=${s2.index}`);
  await shot("06b-practice-resume");

  /* ---------- [7] 错题本 ---------- */
  console.log("\n[7] 错题本");
  await go("wrongbook", 500);
  const kpiCells = await count(".wb-kpi__cell");
  ok("错题本三数字概览", kpiCells === 3, `实际 ${kpiCells}`);
  const wbItems = await count(".wb-item");
  ok("考试答错的题已收录（≥6）", wbItems >= 6, `实际 ${wbItems}`);
  const itemHtml = await page.$eval(".wb-item", (n) => n.innerHTML);
  ok("卡片含「我的答案」", itemHtml.includes("我的答案"));
  ok("卡片含「正确答案」", itemHtml.includes("正确答案"));
  ok("卡片含错误次数角标", /错 \d+ 次/.test(itemHtml));
  const chipsN = await count("#wbTypeChips .chip");
  ok("题型 chips 6 个（含全部）", chipsN === 6, `实际 ${chipsN}`);
  await domClick('#wbTypeChips .chip[data-type="single"]');
  await sleep(300);
  const singleCount = await count(".wb-item");
  ok("按单选筛选后条数 ≤ 全部", singleCount <= wbItems, `${singleCount} / ${wbItems}`);
  await shot("09-wrongbook");

  // 重做本题两次 → 累计错 ≥3 → 红标 + 首页推荐复习出现 ❗
  const targetId = await page.$eval(".wb-item", (n) => n.dataset.id);
  const targetQ = await qMeta(targetId);
  ok("定位到待重刷错题", !!targetQ, `${targetId} (${targetQ?.type})`);
  for (let i = 0; i < 2; i++) {
    await go(`practice?mode=wrong&qid=${targetId}`, 500);
    const cur = (await session()).current;
    if (!cur) break;
    const q = await qMeta(cur);
    await answerWrong(q);
    await sleep(200);
    await commitWrongPractice(q);
    await sleep(300);
    await domClick("#pNext");
    await sleep(400);
  }
  await go("wrongbook", 500);
  const badge = await page.$$eval(".wb-badge", (ns) => ns.map((n) => ({ t: n.textContent.trim(), cls: n.className })));
  const hasHigh = badge.some((b) => /错 [3-9] 次|错 \d{2,} 次/.test(b.t) && /wb-badge--red|wb-badge--amber/.test(b.cls));
  ok("累计错 ≥3 出现红/黄角标", hasHigh, JSON.stringify(badge.slice(0, 3)));

  await go("home", 500);
  const recs = await count(".rec");
  ok("首页今日推荐复习出现高频错题组", recs >= 1, `实际 ${recs}`);
  ok("推荐组含「累计错 N 次」", /累计错 \d+ 次/.test((await txt(".rec__meta")) || ""), `${await txt(".rec__meta")}`);
  await shot("10-home-recommend");

  /* ---------- [8] 我的 / 设置 ---------- */
  console.log("\n[8] 我的与设置");
  await go("me", 500);
  ok("我的 tab 高亮", (await page.$eval('.tab[data-tab="me"]', (n) => n.classList.contains("is-active"))) === true);
  ok("我的页隐藏顶栏", (await display(".topbar")) === "none");
  ok("紫卡含「个人中心」", ((await txt(".profile-hero__title")) || "").includes("个人中心"));
  ok("打卡徽章存在", (await count(".badge")) >= 1);
  ok("入口列表 4 行", (await count(".list-row")) >= 4, `实际 ${await count(".list-row")}`);
  ok("本周学习小结非空", ((await txt("#weekText")) || "").length > 6);
  await shot("11-me");

  await go("stats", 500);
  ok("数据报告有返回箭头", (await count(".page-head__back")) === 1);
  ok("数据报告含近 7 天", ((await page.$eval("body", (n) => n.textContent)) || "").includes("近 7 天做题"));
  await shot("12-stats");

  await go("settings", 500);
  ok("设置页有返回箭头", (await count(".page-head__back")) === 1);
  ok("设置页标题为「功能设置」", ((await txt(".page-head__title")) || "").trim() === "功能设置", `${await txt(".page-head__title")}`);
  const settingsText = (await page.$eval("body", (n) => n.textContent)) || "";
  ok("备考设置盒子已移除", !settingsText.includes("备考设置") && (await count("#setExamDate")) === 0);

  // 昵称：设置 → 保存 → 首页问候语生效 → 刷新后仍在（云端持久化）
  ok("昵称输入框存在", (await count("#setNickname")) === 1);
  await page.$eval("#setNickname", (n) => { n.value = "小老师"; });
  await domClick("#btnSaveNick");
  await sleep(600);
  const nick1 = await page.evaluate(() => window.__quiz.storage.nickname());
  ok("昵称已写入 store", nick1 === "小老师", `${nick1}`);
  await shot("13-settings");
  await sleep(1200);   // 等 800ms 防抖 PUT 上云
  await go("home", 500);
  ok("首页问候语使用昵称", ((await txt(".greet__hello")) || "").includes("小老师"), `${await txt(".greet__hello")}`);
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(800);
  const nick2 = await page.evaluate(() => window.__quiz.storage.nickname());
  ok("昵称刷新后仍在（云端同步）", nick2 === "小老师", `${nick2}`);
  ok("刷新后问候语仍用昵称", ((await txt(".greet__hello")) || "").includes("小老师"), `${await txt(".greet__hello")}`);

  /* ---------- [9] v3 备份迁移 ---------- */
  console.log("\n[9] 数据迁移 v3 → v5");
  const legacy = {
    version: 3,
    records: { "G-S001": { attempts: 2, wrongAttempts: 1, lastCorrect: false, firstAt: 1, lastAt: 2 } },
    wrongbook: { "G-S001": { wrongCount: 1, addedAt: 1, lastWrongAt: 2 } },
    updatedAt: 3,
  };
  const check = await page.evaluate((raw) => {
    const r = window.__quiz.storage.validateImport(JSON.stringify(raw));
    return { ok: r.ok, version: r.store?.version, hasFav: !!(r.store && "favorites" in r.store), hasProfile: !!(r.store && "profile" in r.store), records: Object.keys(r.store?.records ?? {}).length, summary: r.summary };
  }, legacy);
  ok("v3 备份校验通过", check.ok === true, JSON.stringify(check));
  ok("迁移后 version = 5", check.version === 5, `实际 ${check.version}`);
  ok("迁移后存在 favorites 字段", check.hasFav === true);
  ok("迁移后存在 profile 字段", check.hasProfile === true);
  ok("原 records 保留", check.records === 1, `${check.records}`);

  const applied = await page.evaluate((raw) => {
    const r = window.__quiz.storage.validateImport(JSON.stringify(raw));
    window.__quiz.storage.applyImport(r.store, "merge");
    return window.__quiz.storage.getStore();
  }, legacy);
  ok("合并导入后收藏字段可用", !!(applied && applied.favorites), JSON.stringify(Object.keys(applied ?? {})));

  /* ---------- [10] 响应式 ---------- */
  console.log("\n[10] 响应式（无横向溢出）");
  const widths = [320, 375, 390, 480, 768, 1024];
  const pages = ["home", "banks", "wrongbook", "me", "favorites", "stats", "settings"];
  for (const w of widths) {
    await page.setViewport({ width: w, height: 900, deviceScaleFactor: 1 });
    const bad = [];
    for (const p of pages) {
      await go(p, 250);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) bad.push(`${p}:+${overflow}`);
    }
    ok(`${w}px 无横向溢出（7 页）`, bad.length === 0, bad.join(" "));
  }
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await go("home", 400);
  await shot("14-width390");

  /* ---------- [11] 控制台 ---------- */
  console.log("\n[11] 控制台");
  ok("无 console.error / pageerror / 失败请求", errors.length === 0, errors.slice(0, 5).join(" | "));

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${"=".repeat(56)}`);
  console.log(`通过 ${results.length - failed.length}　失败 ${failed.length}`);
  if (failed.length) {
    for (const f of failed) console.log(`  ✗ ${f.name}  ${f.extra}`);
    process.exitCode = 1;
  }
})().catch((e) => {
  console.error("验证脚本异常：", e);
  process.exitCode = 1;
});
