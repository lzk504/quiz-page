/**
 * 端到端验证：加载页面 → 各题型作答 → 统计/错题本/设置 → v1→v2 迁移 → 截图
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
  ok("题型筛选 3 个", typeChips === 3, `实际 ${typeChips}`);
  const overview = await txt(".card:last-of-type .about");
  ok("题库概览含 68 题", /共\s*68\s*题/.test(overview || ""), "");
  await page.screenshot({ path: path.join(OUT, "01-home.png"), fullPage: true });

  /* 筛选生效 */
  await page.click('#typeChips .chip[data-key="judge"]');
  await sleep(120);
  const summary = await txt(".filter-summary");
  ok("筛选判断 → 命中 14 题", /命中\s*14\s*题/.test(summary || ""), summary);
  await page.click("#clearFilter");
  await sleep(120);

  /* ---------- 题库结构（v2 重构断言） ---------- */
  console.log("\n[2] 题库结构");
  const bank = await page.evaluate(async () => {
    const r = await fetch("/data/questions.json");
    const d = await r.json();
    const qs = d.questions;
    const byId = Object.fromEntries(qs.map((q) => [q.id, q]));
    const converted = qs.filter((q) => /^S(2[5-9]|3[0-9]|40)$/.test(q.id));
    return {
      total: qs.length,
      types: [...new Set(qs.map((q) => q.type))].sort(),
      hasLegacy: qs.some((q) => /^F|^SA/.test(q.id)),
      removed: ["S02", "S05", "S06", "J04"].some((id) => byId[id]),
      convertedCount: converted.length,
      convertedAll3Opts: converted.every((q) => q.options?.length === 3 && /^[ABC]$/.test(q.answer)),
      m01: byId.M01 ? { opts: byId.M01.options.length, ans: byId.M01.answer } : null,
      s16domain: byId.S16?.domain,
      newSingles: ["S41", "S47"].every((id) => byId[id]?.options?.length === 4),
      newJudges: ["J13", "J14", "J15"].every((id) => typeof byId[id]?.answer === "boolean"),
    };
  });
  ok("总题数 68", bank.total === 68, `实际 ${bank.total}`);
  ok("题型只剩 single/multiple/judge", bank.types.join(",") === "judge,multiple,single", bank.types.join(","));
  ok("无 F/SA 遗留 id", bank.hasLegacy === false, "");
  ok("S02/S05/S06/J04 已删除", bank.removed === false, "");
  ok("16 道改写题均为 3 选项单选", bank.convertedCount === 16 && bank.convertedAll3Opts, `改写题 ${bank.convertedCount} 道`);
  ok("M01 修复（5 选项含干扰项）", bank.m01?.opts === 5 && bank.m01?.ans?.join("") === "ACDE", JSON.stringify(bank.m01));
  ok("S16 改标科学", bank.s16domain === "science", bank.s16domain);
  ok("新单选 S41-S47 为 4 选项", bank.newSingles, "");
  ok("新判断 J13-J15 为布尔答案", bank.newJudges, "");

  /* ---------- 单选 ---------- */
  console.log("\n[3] 单选题");
  await go("practice?type=single");
  await page.waitForSelector(".opt", { timeout: 8000 });
  const stem1 = await txt(".stem");
  ok("题干渲染", !!stem1, stem1?.slice(0, 24));
  const optCount = await count(".opt");
  ok("四个选项", optCount === 4, `实际 ${optCount}`);
  await page.click(".opt");                       // 选第一个（错）
  await sleep(200);
  const verdict = await txt(".verdict");
  ok("即时判定出现", !!verdict, verdict?.replace(/\s+/g, " ").slice(0, 30));
  const hasAnalysis = await count(".analysis");
  ok("展示解析", hasAnalysis > 0, "");
  const locked = await page.$$eval(".opt", (ns) => ns.every((n) => n.disabled));
  ok("作答后选项锁定", locked, "");
  const okMarked = await count(".opt.is-ok");
  ok("正确选项染色标记", okMarked === 1, `${okMarked} 个 is-ok`);
  await page.screenshot({ path: path.join(OUT, "02-single.png"), fullPage: true });

  /* 下一题 */
  await page.click("#pNext");
  await sleep(200);
  const idx = await txt(".practice-head__idx b");
  ok("下一题推进", idx === "2", `当前第 ${idx} 题`);

  /* ---------- 多选 ---------- */
  console.log("\n[4] 多选题");
  await go("practice?type=multiple");
  await page.waitForSelector(".opt", { timeout: 8000 });
  const multiDisabled = await page.$eval("#pConfirm", (n) => n.disabled);
  ok("未选择时确认按钮禁用", multiDisabled, "");
  await page.click('.opt[data-letter="A"]');
  await page.click('.opt[data-letter="B"]');
  await sleep(120);
  const hint = await txt("#multiHint");
  ok("多选提示已选 AB", hint === "已选 AB", hint);
  const selCount = await count(".opt.is-sel");
  ok("选中态视觉反馈", selCount === 2, `${selCount} 个 is-sel`);
  await page.click("#pConfirm");
  await sleep(220);
  const v2 = await txt(".verdict");
  ok("多选判定完成", !!v2, v2?.replace(/\s+/g, " ").slice(0, 30));
  await page.screenshot({ path: path.join(OUT, "03-multiple.png"), fullPage: true });

  /* ---------- 判断题 ---------- */
  console.log("\n[5] 判断题");
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

  /* ---------- 错题本 ---------- */
  console.log("\n[6] 错题本");
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
  console.log("\n[7] 统计页");
  await go("stats");
  await sleep(250);
  const statsText = await txt(".stat-grid");
  ok("统计页渲染", !!statsText, statsText?.replace(/\s+/g, " ").slice(0, 44));
  const rateRows = await count(".rate-row");
  ok("进度/领域/题型分段（1+6+3）", rateRows >= 10, `${rateRows} 行`);
  await page.screenshot({ path: path.join(OUT, "09-stats.png"), fullPage: true });

  /* ---------- 设置页 ---------- */
  console.log("\n[8] 设置页");
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
  ok("导出结构完整（v2 无 recite）", exported.keys.join(",") === "version,records,wrongbook,updatedAt", exported.keys.join(","));
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
    return { before, afterClear, after };
  });
  ok("清空 → 导入回滚一致", roundTrip.before === roundTrip.after && roundTrip.afterClear === 0,
    JSON.stringify(roundTrip));

  /* ---------- 持久化 ---------- */
  console.log("\n[9] 持久化");
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(400);
  const persisted = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("quizapp.data.v1")).records).length);
  ok("刷新后记录保留", persisted > 0, `${persisted} 条记录`);

  /* ---------- 响应式 & 深链接 ---------- */
  console.log("\n[10] 响应式 & 深链接");
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await go("home");
  await sleep(250);
  const layout = await page.evaluate(() => {
    const app = document.querySelector(".app").getBoundingClientRect();
    return { appW: Math.round(app.width) };
  });
  ok("桌面端内容列限宽 720", layout.appW === 720, `实际 ${layout.appW}px`);
  await page.screenshot({ path: path.join(OUT, "11-desktop.png"), fullPage: true });

  /* 窄屏 360px：无横向溢出 */
  await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 2 });
  await go("home");
  await sleep(250);
  const narrow = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
  }));
  ok("360px 无横向溢出", narrow.sw <= narrow.iw + 1, `scrollWidth=${narrow.sw} innerWidth=${narrow.iw}`);
  await go("stats");
  await sleep(250);
  const narrowStats = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
  }));
  ok("360px 统计页无横向溢出", narrowStats.sw <= narrowStats.iw + 1, `scrollWidth=${narrowStats.sw}`);
  await page.screenshot({ path: path.join(OUT, "12-mobile360.png"), fullPage: true });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

  /* 深链接直接进入 */
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

  /* ---------- v1 → v2 数据迁移 ---------- */
  console.log("\n[11] v1→v2 迁移");
  await go("home");
  await page.evaluate(() => {
    const v1 = {
      version: 1,
      records: {
        F01: { attempts: 3, wrongAttempts: 1, lastCorrect: true, lastUserAnswer: ["协调"], firstAt: 1000, lastAt: 2000 },
        S02: { attempts: 1, wrongAttempts: 0, lastCorrect: true, lastUserAnswer: "C", firstAt: 1000, lastAt: 1500 },
        X99: { attempts: 1, wrongAttempts: 1, lastCorrect: false, firstAt: 1000, lastAt: 1200 },
      },
      wrongbook: {
        F03: { wrongCount: 2, addedAt: 1000, lastUserAnswer: ["x"], lastWrongAt: 1500 },
      },
      recite: { SA01: { attempts: 2, known: true, lastAt: 1000 } },
      updatedAt: 2000,
    };
    localStorage.setItem("quizapp.data.v1", JSON.stringify(v1));
  });
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(500);
  const mig = await page.evaluate(() => JSON.parse(localStorage.getItem("quizapp.data.v1")));
  ok("版本升到 v2", mig.version === 2, `version=${mig.version}`);
  ok("F01 → S25 映射且保留统计", mig.records?.S25?.attempts === 3 && mig.records?.S25?.lastCorrect === true, JSON.stringify(mig.records?.S25));
  ok("迁移丢弃旧作答记录", !("lastUserAnswer" in (mig.records?.S25 ?? {})), "");
  ok("已删题 S02 记录剔除", !mig.records?.S02, "");
  ok("孤儿 id X99 剔除", !mig.records?.X99, "");
  ok("错题本 F03 → S27 映射", mig.wrongbook?.S27?.wrongCount === 2, JSON.stringify(mig.wrongbook?.S27));
  ok("recite 表移除", !("recite" in mig), "");

  /* v1 备份导入兼容 */
  const importV1 = await page.evaluate(async () => {
    const m = await import("/js/storage.js");
    const v1text = JSON.stringify({
      version: 1,
      records: { F01: { attempts: 2, lastCorrect: true, lastUserAnswer: ["a"], firstAt: 1, lastAt: 2 } },
      wrongbook: {},
      recite: { SA01: { attempts: 1, known: true, lastAt: 1 } },
      updatedAt: 2,
    });
    const check = m.validateImport(v1text);
    return {
      ok: check.ok,
      version: check.store?.version,
      hasS25: !!check.store?.records?.S25,
      hasRecite: "recite" in (check.store || {}),
      noLua: !("lastUserAnswer" in (check.store?.records?.S25 || {})),
      legacyRecite: check.summary?.legacyRecite,
    };
  });
  ok("v1 备份导入自动迁移", importV1.ok && importV1.version === 2 && importV1.hasS25 && !importV1.hasRecite && importV1.noLua,
    JSON.stringify(importV1));
  ok("导入摘要提示旧背诵记录", importV1.legacyRecite === 1, `legacyRecite=${importV1.legacyRecite}`);

  /* 迁移幂等：再次刷新不二次迁移、不丢数据 */
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(400);
  const mig2 = await page.evaluate(() => JSON.parse(localStorage.getItem("quizapp.data.v1")));
  ok("迁移幂等", mig2.version === 2 && mig2.records?.S25?.attempts === 3 && Object.keys(mig2.records).length === Object.keys(mig.records).length, "");

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
