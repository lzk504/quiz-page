import path from "node:path";
import fs from "node:fs";
import puppeteer from "puppeteer";

const BASE = "http://127.0.0.1:8788";
const OUT = path.join(process.cwd(), "scripts", "_shots");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const errors = [];
const results = [];
const ok = (name, pass, extra = "") => {
  results.push({ name, pass, extra });
  console.log(`${pass ? "  ✓" : "  ✗"} ${name}${extra ? "  " + extra : ""}`);
  if (!pass) {
    console.error(`Assertion failed: ${name} ${extra}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2, 10);
const USER = `test_${rnd()}`;
const PW = `Pass${rnd()}1`;

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
    if (t === "error" && !/Failed to load resource/i.test(m.text())) {
      errors.push(`console.error: ${m.text()}`);
    }
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

  const domClick = async (sel) => {
    await page.waitForSelector(sel, { timeout: 8000 });
    await page.$eval(sel, (n) => n.click());
  };
  const txt = async (sel) => page.$eval(sel, (n) => n.textContent?.trim() || "").catch(() => null);
  const shot = (name) => page.screenshot({ path: path.join(OUT, `plan-${name}.png`), fullPage: true });

  console.log("=== 1. 用户注册与登录 ===");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/#/login`, { waitUntil: "networkidle2" });
  await page.waitForSelector('.auth__tab[data-tab="register"]');
  await page.click('.auth__tab[data-tab="register"]');
  await sleep(150);
  await page.type('input[name="username"]', USER);
  await page.type('input[name="password"]', PW);
  await page.click("#authSubmit");
  await page.waitForSelector(".hero", { timeout: 15000 });
  ok("注册并进入首页", (await page.evaluate(() => location.hash)) === "#/home");

  console.log("\n=== 2. 题库页：全库练习与全库模考按钮验证 ===");
  await page.goto(`${BASE}/#/banks`, { waitUntil: "networkidle2" });
  await page.waitForSelector("#startMode");

  const startModeText = await txt("#startMode");
  ok("练习模式按钮文案为「▷ 开始练习」", startModeText === "▷ 开始练习", `实际: ${startModeText}`);

  await domClick("#startMode");
  await sleep(500);
  const hash1 = await page.evaluate(() => location.hash);
  ok("点击「▷ 开始练习」进入全库练习", hash1.startsWith("#/practice"), `hash=${hash1}`);
  const qLen1 = await page.evaluate(() => window.__quiz.practice.session().ids.length);
  ok("全库练习题量截取为 100 题", qLen1 === 100, `实际: ${qLen1}`);
  await shot("01-full-bank-practice");

  await page.goto(`${BASE}/#/banks`, { waitUntil: "networkidle2" });
  await page.waitForSelector('.mode[data-mode="exam"]');
  await domClick('.mode[data-mode="exam"]');
  await sleep(300);
  const startExamText = await txt("#startMode");
  ok("切换为考试模式后按钮文案为「▷ 开始模拟考试」", startExamText === "▷ 开始模拟考试", `实际: ${startExamText}`);

  await domClick("#startMode");
  await sleep(500);
  const hash2 = await page.evaluate(() => location.hash);
  ok("进入考试模式", hash2.includes("mode=exam"), `hash=${hash2}`);
  const examLen = await page.evaluate(() => window.__quiz.practice.exam().total);
  ok("考试模式题量为 100 题", examLen === 100, `实际: ${examLen}`);

  console.log("\n=== 3. 章节目录练习：动态题量与题型排序验证 ===");
  await page.goto(`${BASE}/#/banks`, { waitUntil: "networkidle2" });
  await page.waitForSelector(".chapter");

  // 点击第 2 个章节（健康，共 262 题）
  const chapters = await page.$$eval(".chapter", (els) =>
    els.map((el) => ({
      domain: el.dataset.domain,
      title: el.querySelector(".chapter__title")?.textContent?.trim() || "",
      total: parseInt(el.querySelector(".chapter__meta b")?.textContent || "0", 10),
    }))
  );
  console.log("题库章节列表:", chapters);
  const healthChapter = chapters.find((c) => c.domain === "health") || chapters[1];
  console.log("测试选中章节:", healthChapter);

  await domClick(`.chapter[data-domain="${healthChapter.domain}"]`);
  await sleep(600);
  const chapterHash = await page.evaluate(() => location.hash);
  ok("进入章节练习带有 from=chapter 参数", chapterHash.includes("from=chapter"), `hash=${chapterHash}`);

  const chapterIds = await page.evaluate(() => window.__quiz.practice.session().ids);
  ok(
    `章节题量动态等于本章总题数 (${healthChapter.total} 题，不截断为 100)`,
    chapterIds.length === healthChapter.total,
    `实际: ${chapterIds.length}, 期望: ${healthChapter.total}`
  );

  // 验证题型排序：单选 -> 多选 -> 判断 -> 填空 -> 简答
  const questionTypes = await page.evaluate(async (ids) => {
    const file = `data/bank-${ids[0][0].toLowerCase()}.json`;
    const d = await (await fetch(file)).json();
    const map = new Map(d.questions.map((q) => [q.id, q.type]));
    return ids.map((id) => map.get(id));
  }, chapterIds);

  const typeOrder = ["single", "multiple", "judge", "fill", "short"];
  let prevRank = -1;
  let orderCorrect = true;
  for (const t of questionTypes) {
    const rank = typeOrder.indexOf(t);
    if (rank < prevRank) {
      orderCorrect = false;
      break;
    }
    prevRank = rank;
  }
  ok("章节内题目严格按题型顺序单选>多选>判断>填空>简答排列", orderCorrect);
  await shot("02-chapter-practice-order");

  console.log("\n=== 4. 章节全做完状态：答案展示与询问重做弹窗 ===");
  // 注入全做完记录
  await page.evaluate(async (ids) => {
    const store = window.__quiz.storage.getStore();
    for (const id of ids) {
      store.records[id] = {
        attempts: 1,
        wrongAttempts: 0,
        lastCorrect: true,
        lastUserAnswer: "A",
        firstAt: Date.now() - 100000,
        lastAt: Date.now() - 50000,
      };
    }
    window.__quiz.storage.saveStore(store);
  }, chapterIds);

  // 再次进入该章节练习
  await page.goto(`${BASE}/#/banks`, { waitUntil: "networkidle2" });
  await page.waitForSelector(`.chapter[data-domain="${healthChapter.domain}"]`);
  await domClick(`.chapter[data-domain="${healthChapter.domain}"]`);
  await sleep(800);

  // 检查是否弹窗
  const modalTitle = await txt(".modal__title");
  ok("弹出「本章已完成」确认弹窗", modalTitle === "本章已完成", `实际: ${modalTitle}`);
  const modalMsg = await txt(".modal__msg");
  ok("弹窗包含题数和重做提示", modalMsg.includes("已全部练习完成") && modalMsg.includes("是否选择重新作答"));
  await shot("03-chapter-alldone-modal");

  // 检查底层题目是否为已揭晓/答案展示态
  const hasFeedback = await page.$eval(".feedback", (el) => !!el).catch(() => false);
  ok("底层题目处于答案揭晓与解析展示态", hasFeedback);

  console.log("\n=== 5. 点击「查看解析」：逐题翻阅验证 ===");
  await domClick("#modalCancel");
  await sleep(400);

  const modalGone = (await page.$(".modal")) === null;
  ok("点击「查看解析」后弹窗关闭", modalGone);

  const prevBtnDisabled = await page.$eval("#pPrev", (el) => el.disabled);
  ok("第一题的「‹ 上一题」按钮置灰禁用", prevBtnDisabled);

  const nextBtnText = await txt("#pNext");
  ok("下一题按钮文案为「下一题 ›」", nextBtnText === "下一题 ›", `实际: ${nextBtnText}`);

  // 点击下一题
  await domClick("#pNext");
  await sleep(400);
  const idxText = await txt(".practice-head__idx");
  ok("翻到第 2 题", idxText?.startsWith("2 /"), `实际: ${idxText}`);
  const hasFeedback2 = await page.$eval(".feedback", (el) => !!el).catch(() => false);
  ok("第 2 题同样直接展示答案与解析", hasFeedback2);

  // 点击上一题
  await domClick("#pPrev");
  await sleep(400);
  const idxText2 = await txt(".practice-head__idx");
  ok("成功翻回第 1 题", idxText2?.startsWith("1 /"), `实际: ${idxText2}`);
  await shot("04-review-mode-flip");

  // 退出并检查草稿未污染
  await domClick("#pExit");
  await sleep(400);
  ok("退出返回首页", (await page.evaluate(() => location.hash)) === "#/home");

  const draftExists = await page.evaluate(() => {
    return Object.keys(localStorage).some((k) => k.startsWith("quizapp.draft.") && localStorage.getItem(k));
  });
  ok("查看解析模式离开后不写入未完成草稿", !draftExists);

  console.log("\n=== 6. 点击「重新作答」：重置会话从第 1 题重刷 ===");
  await page.goto(`${BASE}/#/banks`, { waitUntil: "networkidle2" });
  await page.waitForSelector(`.chapter[data-domain="${healthChapter.domain}"]`);
  await domClick(`.chapter[data-domain="${healthChapter.domain}"]`);
  await sleep(800);

  await page.waitForSelector("#modalOk");
  await domClick("#modalOk"); // 点击「重新作答」
  await sleep(400);

  const modalGone2 = (await page.$(".modal")) === null;
  ok("点击「重新作答」后弹窗关闭", modalGone2);

  const idxRedo = await txt(".practice-head__idx");
  ok("从第 1 题开始作答", idxRedo?.startsWith("1 /"), `实际: ${idxRedo}`);

  const hasFeedbackRedo = await page.$eval(".feedback", (el) => !!el).catch(() => false);
  ok("重新作答模式下未提交前不展示答案与反馈", !hasFeedbackRedo);
  await shot("05-redo-fresh-start");

  await browser.close();

  console.log("\n==========================================");
  const failed = results.filter((r) => !r.pass);
  console.log(`全部通过: ${results.length - failed.length} / ${results.length}`);
  if (failed.length > 0) {
    console.error("失败项:", failed);
    process.exit(1);
  }
  if (errors.length > 0) {
    console.warn("控制台警告/错误:", errors);
  }
  console.log("所有端到端功能测试全部成功！");
})();
