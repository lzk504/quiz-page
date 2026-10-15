/** 统计页（数据报告）：整体正确率 + 分领域/分题型 + 近 7 天节奏 */

import { getLoadedQuestions } from "../state";
import { getStore } from "../storage";
import { computeStats, type RateRow } from "../stats";
import { recentAnswered, dailyGoal, streakDays } from "../goal";
import { esc } from "../utils";
import { navigate } from "../router";
import { bar, emptyState, circleProgress } from "../ui";
import type { View } from "../types";

const BAR_BY_DOMAIN: Record<string, string> = {
  health: "bar--green", language: "bar--blue", society: "bar--amber",
  science: "bar--blue", art: "bar--amber", general: "bar--grey",
};

function rateRows(list: RateRow[], barKey?: (row: RateRow) => string): string {
  if (!list.length) return `<p class="rate-row__head"><span>暂无数据</span></p>`;
  return list.map((row) => `
    <div class="rate-row">
      <div class="rate-row__head">
        <span>${esc(row.label)}</span>
        <span>已答 ${row.answered}/${row.total}　<b>${row.answered ? row.rate + "%" : "—"}</b></span>
      </div>
      ${bar(row.answered ? row.rate : 0, barKey ? barKey(row) : "bar--blue")}
    </div>
  `).join("");
}

const view: View = {
  async render(root) {
    const questions = getLoadedQuestions();
    const store = getStore();
    const s = computeStats(questions, store);
    const recent = recentAnswered(store, 7);
    const goal = dailyGoal(store);
    const streak = streakDays(store);

    const head = `
      <div class="page-head">
        <button class="page-head__back" id="sBack" title="返回">‹</button>
        <h1 class="page-head__title">数据报告</h1>
      </div>`;

    const bindHead = (): void => {
      root.querySelector("#sBack")?.addEventListener("click", () => navigate("me"));
    };

    if (!questions.length) {
      root.innerHTML = head + emptyState({ icon: "📊", title: "暂无可统计的数据" });
      bindHead();
      return;
    }

    if (!s.answered) {
      root.innerHTML = head + emptyState({
        icon: "📊",
        title: "还没有答题记录",
        desc: "刷几道题之后，这里会显示正确率、分领域与分题型的掌握情况。",
        action: `<button class="btn btn--primary" id="sPractice">去刷题</button>`,
      });
      bindHead();
      root.querySelector("#sPractice")?.addEventListener("click", () => navigate("general-practice", { fresh: "1" }));
      return;
    }

    const totalPct = s.progress.percent;

    root.innerHTML = head + `
      <section class="card" style="display:flex;align-items:center;justify-content:space-around;padding:16px 12px;margin-bottom:14px">
        <div style="text-align:center">
          ${circleProgress({ rate: s.rate, size: 76, strokeWidth: 7, color: "var(--primary)" })}
          <span style="display:block;font-size:12px;color:var(--text-2);margin-top:4px">综合正确率</span>
        </div>
        <div style="height:48px;width:1px;background:var(--line)"></div>
        <div style="text-align:center">
          <b style="display:block;font-size:22px;font-variant-numeric:tabular-nums;line-height:1.2">${s.answered}</b>
          <span style="font-size:12px;color:var(--text-2)">已答题数</span>
        </div>
        <div style="height:48px;width:1px;background:var(--line)"></div>
        <div style="text-align:center">
          <b style="display:block;font-size:22px;font-variant-numeric:tabular-nums;line-height:1.2;color:${s.wrongCount ? "var(--bad)" : "inherit"}">${s.wrongCount}</b>
          <span style="font-size:12px;color:var(--text-2)">错题在册</span>
        </div>
      </section>

      <section class="card">
        <h2 class="card__title">学习节奏</h2>
        <div class="rate-row">
          <div class="rate-row__head">
            <span>今日目标</span>
            <span>${goal.done}/${goal.goal} 题　<b>${goal.percent}%</b></span>
          </div>
          ${bar(goal.percent, "bar--blue")}
        </div>
        <div class="rate-row">
          <div class="rate-row__head">
            <span>总进度（全部已加载题库）</span>
            <span>${s.progress.answered}/${s.progress.total}　<b>${totalPct}%</b></span>
          </div>
          ${bar(totalPct, "bar--blue")}
        </div>
        <div class="about" style="margin-top:12px">
          <p>· 近 7 天做题 <b>${recent}</b> 题　·　连续打卡 <b>${streak}</b> 天</p>
        </div>
      </section>

      ${s.byBank.length > 1 ? `
        <section class="card">
          <h2 class="card__title">分题库掌握情况 <small>按最近一次作答</small></h2>
          ${rateRows(s.byBank, () => "bar--blue")}
        </section>
      ` : ""}

      <section class="card">
        <h2 class="card__title">分领域掌握情况 <small>按最近一次作答</small></h2>
        ${rateRows(s.byDomain, (row) => BAR_BY_DOMAIN[row.key] ?? "bar--blue")}
      </section>

      <section class="card">
        <h2 class="card__title">分题型掌握情况</h2>
        ${rateRows(s.byType, () => "bar--blue")}
      </section>

      <section class="card">
        <h2 class="card__title">口径说明</h2>
        <div class="about">
          <p>· <b>正确率</b> = 最近一次答对的题数 ÷ 已作答题数。同一题重复作答只按最后一次计入。</p>
          <p>· <b>总进度</b> = 已作答题数 ÷ 全部已加载题库的题数。</p>
          <p>· <b>今日目标 / 连续打卡 / 近 7 天</b> 按本机日期与每题的「最近一次作答时间」统计。</p>
          <p>· 填空题与简答题由你对照参考答案自行判定，判定结果同样计入统计与错题本。</p>
          <p>· 所有记录保存在云端（Cloudflare D1），可在「我的 → 功能设置」导出备份。</p>
        </div>
        <div class="actions" style="margin-top:14px">
          <button class="btn btn--block" id="sWrong">查看错题本（${s.wrongCount}）</button>
        </div>
      </section>
    `;

    bindHead();
    root.querySelector("#sWrong")?.addEventListener("click", () => navigate("wrongbook"));
  },
};

export default view;
