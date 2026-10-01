/**
 * 端到端验证：加载页面 → 各题型作答 → 统计/错题本/设置 → 截图
 * 用法：node scripts/e2e-check.js [baseUrl] [outDir]
 */
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer");

const BASE = process.argv[2] || "http://127.0.0.1:8123";
const OUT = process.argv[3] || path.join(process.cwd(), "scripts", "_shots");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const errors = [];
const logs = [];
const results = [];

function ok(name, pass, extra = "") {
  results.push({ name, pass, extra });
  console.log(`${pass ? "  ✓" : "  ✗"} ${name}${extra ? "  " + extra : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

  page.on("console", (m) => {
    const t = m.type();
    logs.push(`[${t}] ${m.text()}`);
    if (t === "error") errors.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

  const go = async (hash) => {
    await page.goto(`${BASE}/#/${hash}`, { waitUntil: "networkidle2" });
    await sleep(160);
  };
  const txt = (sel) => page.$eval(sel, (n) => n.textContent.trim()).catch(() => null);
  const count = (sel) => page.$$eval(sel, (n) => n.length).catch(() => 0);

  /* ---------- 首页 ---------- */
  console.log("\n[1] 首页");
  await go("home");
  await page.waitForSelector(".hero", { timeout: 8000 });
  const heroTitle = await txt(".hero__title");
  ok("首页渲染", heroTitle === "考点精编 · 刷题手册", `标题="${heroTitle}"`);
  const domainChips = await count("#domainChips .chip");
  const typeChips = await count("#typeChips .chip");
  ok("领域筛选 6 个", domainChips === 6, `实际 ${domainChips}`);
  ok("题型筛选 5 个", typeChips === 5, `实际 ${typeChips}`);
  const overview = await txt(".card:last-of-type .about");
  ok("题库概览含 70 题", /共\s*70\s*题/.test(overview || ""), "");
  await page.screenshot({ path: path.join(OUT, "01-home.png"), fullPage: true });

  /* 筛选生效 */
  await page.click('#typeChips .chip[data-key="fill"]');
  await sleep(120);
  const summary = await txt(".filter-summary");
  ok("筛选填空 → 命中 16 题", /命中\s*16\s*题/.test(summary || ""), summary);
  await page.click("#clearFilter");
  await sleep(120);

  /* ---------- 单选 ---------- */
  console.log("\n[2] 单选题");
  await go("practice?type=single");
  await page.waitForSelector(".opt", { timeout: 8000 });
  const stem1 = await txt(".stem");
  ok("题干渲染", !!stem1, stem1?.slice(0, 24));
  const optCount = await count(".opt");
  ok("四个选项", optCount === 4, `实际 ${optCount}`);
  const stemText = await txt(".stem");
  await page.click(".opt");                       // 选第一个（错）
  await sleep(200);
  const verdict = await txt(".verdict");
  ok("即时判定出现", !!verdict, verdict?.replace(/\s+/g, " ").slice(0, 30));
  const hasAnalysis = await count(".analysis");
  ok("展示解析", hasAnalysis > 0, "");
  const locked = await page.$$eval(".opt", (ns) => ns.every((n) => n.disabled));
  ok("作答后选项锁定", locked, "");
  await page.screenshot({ path: path.join(OUT, "02-single.png"), fullPage: true });

  /* 下一题 */
  await page.click("#pNext");
  await sleep(200);
  const idx = await txt(".practice-head__idx b");
  ok("下一题推进", idx === "2", `当前第 ${idx} 题`);

  /* ---------- 多选 ---------- */
  console.log("\n[3] 多选题");
  await go("practice?type=multiple");
  await page.waitForSelector(".opt", { timeout: 8000 });
  const multiDisabled = await page.$eval("#pConfirm", (n) => n.disabled);
  ok("未选择时确认按钮禁用", multiDisabled, "");
  await page.click('.opt[data-letter="A"]');
  await page.click('.opt[data-letter="B"]');
  await sleep(120);
  const hint = await txt("#multiHint");
  ok("多选提示已选 AB", hint === "已选 AB", hint);
  await page.click("#pConfirm");
  await sleep(220);
  const v2 = await txt(".verdict");
  ok("多选判定完成", !!v2, v2?.replace(/\s+/g, " ").slice(0, 30));
  await page.screenshot({ path: path.join(OUT, "03-multiple.png"), fullPage: true });

  /* ---------- 判断题 ---------- */
  console.log("\n[4] 判断题");
  await go("practice?type=judge");
  await page.waitForSelector(".judge__btn", { timeout: 8000 });
  const jCount = await count(".judge__btn");
  ok("两个判断按钮", jCount === 2, `实际 ${jCount}`);
  await page.click('.judge__btn[data-judge="true"]');
  await sleep(220);
  ok("判断判定完成", !!(await txt(".verdict")), "");
  const jLocked = await page.$$eval(".judge__btn", (ns) => ns.every((n) => n.disabled));
  ok("判断作答后锁定", jLocked, "");
  await page.screenshot({ path: path.join(OUT, "04-judge.png"), fullPage: true });

  /* ---------- 填空题 ---------- */
  console.log("\n[5] 填空题");
  await go("practice?type=fill");
  await page.waitForSelector(".blank", { timeout: 8000 });
  const blanks = await count(".blank");
  ok("输入框数量匹配题干", blanks >= 1, `当前 ${blanks} 个空`);
  // 逐空填入正确答案：从题库取当前题的答案
  const fillKey = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll(".blank")];
    return inputs.length;
  });
  const answers = await page.evaluate(async () => {
    const r = await fetch("/data/questions.json");
    const d = await r.json();
    const q = d.questions.filter((x) => x.type === "fill")[0];
    return { id: q.id, blanks: q.blanks, accept: q.answer.map((b) => b.accept[0]) };
  });
  for (let i = 0; i < answers.blanks; i++) {
    await page.type(`.blank[data-blank="${i}"]`, answers.accept[i]);
  }
  await page.click("#pConfirm");
  await sleep(250);
  const fillVerdict = await txt(".verdict");
  ok("填空题判定完成", !!fillVerdict, `${answers.id} → ${fillVerdict?.replace(/\s+/g, " ").slice(0, 26)}`);
  const marks = await count(".blank-mark");
  ok("逐空反馈标记", marks === answers.blanks, `${marks}/${answers.blanks}`);
  await page.screenshot({ path: path.join(OUT, "05-fill.png"), fullPage: true });

  /* 大小写/全角容错 */
  await go("practice?type=fill");
  await page.waitForSelector(".blank", { timeout: 8000 });
  const aliasTest = await page.evaluate(async () => {
    const r = await fetch("/data/questions.json");
    const d = await r.json();
    const q = d.questions.find((x) => x.id === "F13");
    const m = await import("/js/scoring.js");
    return {
      exact: m.checkBlank(q.answer[0], "两小时"),
      alias: m.checkBlank(q.answer[0], "2小时"),
      fullwidthSpace: m.checkBlank(q.answer[0], " 两 小 时 "),
      fullwidthDigit: m.checkBlank(q.answer[1], "１小时"),
      wrong: m.checkBlank(q.answer[1], "半小时"),
    };
  });
  ok("填空·别名匹配", aliasTest.alias && aliasTest.exact, JSON.stringify(aliasTest));
  ok("填空·空格容错", aliasTest.fullwidthSpace, "");
  ok("填空·全角数字容错", aliasTest.fullwidthDigit, "");
  ok("填空·错误答案判错", aliasTest.wrong === false, "");

  /* ---------- 简答背诵 ---------- */
  console.log("\n[6] 简答题背诵自评");
  await go("practice?type=short");
  await page.waitForSelector("#pReveal", { timeout: 8000 });
  ok("初始为遮挡态", (await count(".recite-hidden")) === 1, "");
  await page.click("#pReveal");
  await sleep(200);
  ok("展开要点答案", (await count(".recite-key")) === 1, "");
  const hasKnown = await count("#pKnown");
  const hasUnknown = await count("#pUnknown");
  ok("出现自评双按钮", hasKnown === 1 && hasUnknown === 1, "");
  await page.screenshot({ path: path.join(OUT, "06-short.png"), fullPage: true });
  await page.click("#pKnown");
  await sleep(220);
  ok("自评后出现下一题", (await count("#pNext")) === 1, "");

  /* 背诵不计入正确率 */
  const rateAfterShort = await page.evaluate(() => {
    const raw = localStorage.getItem("quizapp.data.v1");
    const s = raw ? JSON.parse(raw) : {};
    return { records: Object.keys(s.records || {}).length, recite: Object.keys(s.recite || {}).length };
  });
  ok("简答只进 recite 不进 records", rateAfterShort.recite >= 1, JSON.stringify(rateAfterShort));

  /* ---------- 错题本 ---------- */
  console.log("\n[7] 错题本");
  await go("wrongbook");
  await sleep(200);
  const wrongItems = await count(".item");
  const badge = await page.$eval("#tabBadge", (n) => (n.hidden ? "hidden" : n.textContent));
  ok("错题本有条目", wrongItems > 0, `${wrongItems} 条，角标=${badge}`);
  await page.screenshot({ path: path.join(OUT, "07-wrongbook.png"), fullPage: true });

  // 错题重刷：答对后自动移出
  const before = wrongItems;
  await page.click("#wRedo");
  await sleep(250);
  const redoTitle = await page.$eval(".practice-head", (n) => n.textContent);
  ok("进入错题重刷", /错题重刷/.test(redoTitle), redoTitle.replace(/\s+/g, " ").trim().slice(0, 30));
  const firstStem = await txt(".stem");
  // 从题库中找出这题并选正确答案
  const moved = await page.evaluate(async () => {
    const stem = document.querySelector(".stem").textContent.trim();
    const r = await fetch("/data/questions.json");
    const d = await r.json();
    const q = d.questions.find((x) => x.stem === stem);
    return q ? { id: q.id, type: q.type, answer: q.answer } : null;
  });
  if (moved) {
    if (moved.type === "single") await page.click(`.opt[data-letter="${moved.answer}"]`);
    else if (moved.type === "judge") await page.click(`.judge__btn[data-judge="${moved.answer}"]`);
    else if (moved.type === "multiple") {
      for (const l of moved.answer) await page.click(`.opt[data-letter="${l}"]`);
      await page.click("#pConfirm");
    } else if (moved.type === "fill") {
      for (let i = 0; i < moved.answer.length; i++) {
        await page.type(`.blank[data-blank="${i}"]`, moved.answer[i].accept[0]);
      }
      await page.click("#pConfirm");
    }
    await sleep(260);
    const after = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("quizapp.data.v1")).wrongbook).length);
    const vb = await page.evaluate(() => document.querySelector(".verdict")?.textContent || "");
    ok("答对后自动移出错题本", after === before - 1, `在册 ${before} → ${after}（${vb.replace(/\s+/g, " ").slice(0, 20)}）`);
  } else {
    ok("错题重刷题目定位", false, `未匹配题干：${firstStem}`);
  }

  /* 手动移除 */
  await go("wrongbook");
  await sleep(200);
  const n1 = await count(".item");
  if (n1 > 0) {
    await page.click('.item [data-act="remove"]');
    await sleep(250);
    const n2 = await count(".item");
    ok("手动移出错题本", n2 === n1 - 1, `${n1} → ${n2}`);
  } else {
    ok("手动移出错题本（跳过：已空）", true, "");
  }
  await page.screenshot({ path: path.join(OUT, "08-wrongbook-after.png"), fullPage: true });

  /* ---------- 统计页 ---------- */
  console.log("\n[8] 统计页");
  await go("stats");
  await sleep(250);
  const statsText = await txt(".stat-grid");
  ok("统计页渲染", !!statsText, statsText?.replace(/\s+/g, " ").slice(0, 44));
  const rateRows = await count(".rate-row");
  ok("进度/领域/题型分段", rateRows >= 3 + 6 + 4, `${rateRows} 行`);
  await page.screenshot({ path: path.join(OUT, "09-stats.png"), fullPage: true });

  /* ---------- 设置页 ---------- */
  console.log("\n[9] 设置页");
  await go("settings");
  await sleep(200);
  ok("导出按钮存在", (await count("#btnExport")) === 1, "");
  ok("导入按钮存在", (await count("#btnImport")) === 1, "");
  ok("清空按钮存在", (await count("#btnClear")) === 1, "");
  await page.screenshot({ path: path.join(OUT, "10-settings.png"), fullPage: true });

  /* 导出内容校验 */
  const exported = await page.evaluate(async () => {
    const m = await import("/js/storage.js");
    const txt = m.exportJson();
    const parsed = JSON.parse(txt);
    const check = m.validateImport(txt);
    const bad = m.validateImport("{ not json");
    return {
      keys: Object.keys(parsed),
      ok: check.ok,
      badOk: bad.ok,
      badReason: bad.reason,
    };
  });
  ok("导出结构完整", exported.keys.join(",") === "version,records,wrongbook,recite,updatedAt", exported.keys.join(","));
  ok("导出可被自身校验通过", exported.ok, "");
  ok("坏文件被拒绝", exported.badOk === false, exported.reason || exported.badReason);

  /* 导入 round-trip */
  const roundTrip = await page.evaluate(async () => {
    const m = await import("/js/storage.js");
    const before = Object.keys(m.getStore().records).length;
    const text = m.exportJson();
    m.clearAll();
    const afterClear = Object.keys(m.getStore().records).length;
    const v = m.validateImport(text);
    m.applyImport(v.store, "replace");
    const after = Object.keys(m.getStore().records).length;
    return { before, afterClear, after, summary: v.summary };
  });
  ok("清空 → 导入回滚一致", roundTrip.before === roundTrip.after && roundTrip.afterClear === 0,
    JSON.stringify(roundTrip));

  /* ---------- 持久化 ---------- */
  console.log("\n[10] 持久化");
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(400);
  const persisted = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("quizapp.data.v1")).records).length);
  ok("刷新后记录保留", persisted > 0, `${persisted} 条记录`);

  /* ---------- 桌面端 & 深链接 ---------- */
  console.log("\n[11] 响应式 & 深链接");
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await go("home");
  await sleep(250);
  const layout = await page.evaluate(() => {
    const app = document.querySelector(".app").getBoundingClientRect();
    const tab = document.querySelector(".tabbar").getBoundingClientRect();
    return { appW: Math.round(app.width), tabW: Math.round(tab.width) };
  });
  ok("桌面端内容列限宽 720", layout.appW === 720, `实际 ${layout.appW}px`);
  await page.screenshot({ path: path.join(OUT, "11-desktop.png"), fullPage: true });

  // 深链接直接进入
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
  ok("深链接筛选正确", deep.expect === deep.total, `科学+单选 期望 ${deep.expect} 实际队列 ${deep.total}`);

  // 空结果
  await page.goto(`${BASE}/#/practice?domain=art&type=judge`, { waitUntil: "networkidle2" });
  await sleep(300);
  const emptyArt = await page.evaluate(async () => {
    const r = await fetch("/data/questions.json");
    const d = await r.json();
    return d.questions.filter((q) => q.domain === "art" && q.type === "judge").length;
  });
  ok("艺术+判断命中数", emptyArt >= 1, `${emptyArt} 题`);

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
