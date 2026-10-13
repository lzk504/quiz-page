/**
 * 我的（v6 新建）：个人信息紫卡 + 我的题库 + 入口列表 + 本周学习小结 + 反馈
 *
 * 统计口径：一律基于「全部已加载库」（getLoadedQuestions），否则跨库数据会被漏算。
 */

import { getBanks, getLoadedQuestions, getSelectedBanks, bankQuestionCount, getBank } from "../state";
import { getStore } from "../storage";
import { computeStats } from "../stats";
import { streakDays, recentAnswered, weekSummary, dailyGoal, favoriteQuestions } from "../goal";
import { getExamDate } from "../local-prefs";
import { getCurrentUser } from "../auth";
import { esc, pct } from "../utils";
import { navigate } from "../router";
import { toast } from "../ui";
import type { View } from "../types";

const ISSUES_URL = "https://github.com/lzk504/quiz-page/issues";

function shortTitle(title: string): string {
  const m = title.match(/《(.+?)》/);
  return m ? m[1] : title;
}

function bankRows(): string {
  const records = getStore().records ?? {};
  const all = getLoadedQuestions();
  return `<section class="card">
    <h2 class="card__title">我的题库
      <small><button class="btn btn--sm btn--ghost" id="meGoBanks" style="padding:0 8px">进入题库 ›</button></small>
    </h2>
    ${getBanks().map((b) => {
      const qs = all.filter((q) => q.id.startsWith(b.id + "-"));
      const answered = qs.filter((q) => records[q.id]).length;
      const correct = qs.filter((q) => records[q.id]?.lastCorrect).length;
      const total = qs.length || Object.values(b.typeCounts ?? {}).reduce((a, c) => a + c, 0);
      const mastery = answered ? pct(correct, answered) : 0;
      const inScope = getSelectedBanks().includes(b.id);
      return `<button class="list-row" data-bank="${esc(b.id)}" style="padding-left:0;padding-right:0">
        <span class="list-row__icon">${esc(b.id)}</span>
        <span class="list-row__body">
          <span class="list-row__label">${esc(b.title)}</span>
          <span class="list-row__desc">
            ${inScope ? "刷题范围内 · " : ""}已解锁 ${total} 题 · 掌握度 ${answered ? mastery + "%" : "—"}
          </span>
        </span>
        <span class="list-row__arrow">›</span>
      </button>`;
    }).join("")}
  </section>`;
}

const view: View = {
  async render(root) {
    const store = getStore();
    const user = getCurrentUser();
    const username = user?.username ?? "同学";
    const all = getLoadedQuestions();
    const s = computeStats(all, store);
    const streak = streakDays(store);
    const week = weekSummary(all, store);
    const goal = dailyGoal(store);
    const recent = recentAnswered(store, 7);
    const favCount = favoriteQuestions(all, store).length;
    const prev = Object.keys(store.records ?? {}).length;
    const payLoad = "备考：2026 教师资格证（笔试）";
    const examDate = getExamDate();

    const weekText = week.count
      ? `本周已刷 <b>${week.count}</b> 题，正确率 <b>${week.rate}%</b>${
          week.prevCount > 0 ? `（较上周 ${week.delta >= 0 ? "+" : ""}${week.delta} 题）` : ""
        }。${week.weakest ? `建议加强「<b>${esc(week.weakest.label)}</b>」（本周正确率 ${week.weakest.rate}%）。` : "各领域表现均衡，继续保持！"}`
      : "本周还没有刷题记录，从一个章节开始吧 — 每天 100 题的目标还差不少。";

    root.innerHTML = `
      <section class="profile-hero">
        <div class="profile-hero__top">
          <h1 class="profile-hero__title">个人中心</h1>
          <button class="profile-hero__gear" id="meSettings" title="学习设置">⚙</button>
        </div>
        <div class="profile-hero__me">
          <div class="profile-hero__avatar">${esc(username.slice(0, 1))}</div>
          <div>
            <h2 class="profile-hero__name">${esc(username)}</h2>
            <p class="profile-hero__sub">${esc(payLoad)}</p>
          </div>
        </div>
        <div class="badges">
          ${streak > 0 ? `<span class="badge">🔥 连续打卡 ${streak} 天</span>` : ""}
          <span class="badge">今日已刷 ${goal.done} / ${goal.goal} 题</span>
        </div>
        <div class="profile-stats">
          <div class="profile-stat"><b>${prev}</b><span>累计做题</span></div>
          <div class="profile-stat"><b>${s.answered ? s.rate + "%" : "—"}</b><span>正确率</span></div>
          <div class="profile-stat"><b>${s.wrongCount}</b><span>错题在册</span></div>
        </div>
      </section>

      ${bankRows()}

      <section class="card list-card">
        <button class="list-row" id="meStats">
          <span class="list-row__icon">▥</span>
          <span class="list-row__body">
            <span class="list-row__label">做题记录</span>
            <span class="list-row__desc">正确率、分领域 / 分题型掌握度</span>
          </span>
          <span class="list-row__value">近 7 天 ${recent} 题</span>
          <span class="list-row__arrow">›</span>
        </button>
        <button class="list-row" id="meWrong">
          <span class="list-row__icon list-row__icon--red">✎</span>
          <span class="list-row__body">
            <span class="list-row__label">错题本</span>
            <span class="list-row__desc">答错自动收录，重刷答对即移出</span>
          </span>
          <span class="list-row__value ${s.wrongCount ? "list-row__value--bad" : ""}">${s.wrongCount} 道待复习</span>
          <span class="list-row__arrow">›</span>
        </button>
        <button class="list-row" id="meFav">
          <span class="list-row__icon list-row__icon--gold">★</span>
          <span class="list-row__body">
            <span class="list-row__label">我的收藏</span>
            <span class="list-row__desc">收藏的题目不展示答案，可随时重做</span>
          </span>
          <span class="list-row__value">${favCount} 道好题</span>
          <span class="list-row__arrow">›</span>
        </button>
        <button class="list-row" id="meSettingsRow">
          <span class="list-row__icon list-row__icon--green">⚙</span>
          <span class="list-row__body">
            <span class="list-row__label">学习设置</span>
            <span class="list-row__desc">考试日期、数据导入导出、邀请码</span>
          </span>
          <span class="list-row__value">${examDate ? esc(examDate) : "未设置"}</span>
          <span class="list-row__arrow">›</span>
        </button>
      </section>

      <section class="card">
        <h2 class="card__title">本周学习小结</h2>
        <p class="week-text" id="weekText">${weekText}</p>
        <div class="actions" style="margin-top:14px">
          <button class="btn btn--primary btn--block" id="meReport">▥ 查看完整数据报告</button>
        </div>
      </section>

      <section class="card">
        <h2 class="card__title">其他</h2>
        <div class="setting-row" style="padding-top:0">
          <div class="setting-row__text">
            <b>意见反馈与帮助</b>
            <span>遇到问题或想提建议，欢迎到项目仓库留言。</span>
          </div>
          <button class="btn btn--sm" id="meFeedback">反馈</button>
        </div>
      </section>
    `;

    /* ---------- 事件 ---------- */
    root.querySelector("#meSettings")?.addEventListener("click", () => navigate("settings"));
    root.querySelector("#meSettingsRow")?.addEventListener("click", () => navigate("settings"));
    root.querySelector("#meGoBanks")?.addEventListener("click", () => navigate("banks"));
    root.querySelectorAll<HTMLButtonElement>(".list-row[data-bank]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.bank;
        navigate("banks", id && getBank(id) ? { bank: id } : undefined);
      });
    });
    root.querySelector("#meStats")?.addEventListener("click", () => navigate("stats"));
    root.querySelector("#meReport")?.addEventListener("click", () => navigate("stats"));
    root.querySelector("#meWrong")?.addEventListener("click", () => navigate("wrongbook"));
    root.querySelector("#meFav")?.addEventListener("click", () => navigate("favorites"));
    root.querySelector("#meFeedback")?.addEventListener("click", () => {
      toast("正在打开项目仓库的 Issues 页面…", "info");
      window.open(ISSUES_URL, "_blank", "noopener");
    });
  },
};

export default view;
