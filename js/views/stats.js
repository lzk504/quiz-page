/** 统计页：整体正确率 + 分领域/分题型 */

import { getQuestions } from "../state.js";
import { getStore } from "../storage.js";
import { computeStats } from "../stats.js";
import { esc } from "../utils.js";
import { navigate } from "../router.js";
import { bar, emptyState } from "../ui.js";

const BAR_BY_DOMAIN = {
  health: "bar--green", language: "bar--blue", society: "bar--amber",
  science: "bar--blue", art: "bar--amber", general: "bar--grey",
};

function rateRows(list, barKey) {
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

export default {
  async render(root) {
    const questions = getQuestions();
    const store = getStore();
    const s = computeStats(questions, store);

    if (!questions.length) {
      root.innerHTML = emptyState({ icon: "📊", title: "暂无可统计的数据" });
      return;
    }

    if (!s.answered) {
      root.innerHTML = emptyState({
        icon: "📊",
        title: "还没有答题记录",
        desc: "刷几道题之后，这里会显示正确率、分领域与分题型的掌握情况。",
        action: `<button class="btn btn--primary" id="sPractice">去刷题</button>`,
      });
      root.querySelector("#sPractice")?.addEventListener("click", () => navigate("practice"));
      return;
    }

    const totalPct = s.progress.percent;

    root.innerHTML = `
      <div class="stat-grid" style="margin-bottom:14px">
        <div class="stat stat--rate"><b>${s.rate}%</b><span>正确率</span></div>
        <div class="stat"><b>${s.answered}</b><span>已答题数</span></div>
        <div class="stat"><b style="color:${s.wrongCount ? "var(--bad)" : "inherit"}">${s.wrongCount}</b><span>错题在册</span></div>
      </div>

      <section class="card">
        <h2 class="card__title">学习进度</h2>
        <div class="rate-row">
          <div class="rate-row__head">
            <span>总进度（单选/多选/判断）</span>
            <span>${s.progress.answered}/${s.progress.total}　<b>${totalPct}%</b></span>
          </div>
          ${bar(totalPct, "bar--blue")}
        </div>
      </section>

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
          <p>· <b>总进度</b> = 已作答题数 ÷ 题库总题数。</p>
          <p>· 所有记录保存在本机浏览器中，清除浏览器数据会丢失，可在设置页导出备份。</p>
        </div>
        <div class="actions" style="margin-top:14px">
          <button class="btn btn--block" id="sWrong">查看错题本（${s.wrongCount}）</button>
        </div>
      </section>
    `;

    root.querySelector("#sWrong")?.addEventListener("click", () => navigate("wrongbook"));
  },
};
