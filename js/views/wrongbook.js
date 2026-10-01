/** 错题本：列表 · 手动移除 · 错题重刷入口 */

import { getQuestions } from "../state.js";
import { getStore, removeFromWrongbook } from "../storage.js";
import { displayAnswer } from "../scoring.js";
import { esc, fmtTime } from "../utils.js";
import { navigate } from "../router.js";
import { domainTag, typeTag, emptyState, toast } from "../ui.js";

function shortAnswer(q, max = 40) {
  const text = displayAnswer(q) ?? "";
  return esc(text.length > max ? text.slice(0, max) + "…" : text);
}

function render(root) {
  const store = getStore();
  const wrongIds = new Set(Object.keys(store.wrongbook));
  const questions = getQuestions();
  const items = questions.filter((q) => wrongIds.has(q.id));

  if (!items.length) {
    root.innerHTML = emptyState({
      icon: "✅",
      title: "错题本是空的",
      desc: wrongIds.size
        ? "错题本中的记录已不在当前题库内。"
        : "刷题时答错的题目会自动收进这里，错题重刷答对一次后自动移出。",
      action: `<button class="btn btn--primary" id="wPractice">去刷题</button>`,
    });
    root.querySelector("#wPractice")?.addEventListener("click", () => navigate("practice"));
    return;
  }

  root.innerHTML = `
    <section class="card">
      <h2 class="card__title">错题本 <small>${items.length} 题在册</small></h2>
      <div class="about">
        <p>答错自动收录，<b>错题重刷答对一次即自动移出</b>；也可以逐题手动移除。</p>
      </div>
      <div class="actions" style="margin-top:14px">
        <button class="btn btn--primary btn--block" id="wRedo">错题重刷（${items.length} 题）</button>
      </div>
    </section>

    <div class="list">
      ${items.map((q) => {
        const w = store.wrongbook[q.id] ?? {};
        return `<article class="item" data-id="${esc(q.id)}">
          <div class="item__body">
            <div class="item__tags">${typeTag(q.type)}${domainTag(q.domain)}
              <span class="tag tag--general">错 ${w.wrongCount ?? 1} 次</span>
            </div>
            <div class="item__stem">${esc(q.stem)}</div>
            <div class="item__meta">
              正确答案：${shortAnswer(q)}${w.lastWrongAt ? `　·　最近 ${esc(fmtTime(w.lastWrongAt))}` : ""}
            </div>
            <div class="actions" style="margin-top:10px">
              <button class="btn btn--sm" data-act="redo">重做这题</button>
              <button class="btn btn--sm btn--danger" data-act="remove">移出错题本</button>
            </div>
          </div>
        </article>`;
      }).join("")}
    </div>

    <div class="actions" style="margin-top:16px">
      <button class="btn btn--block" id="wHome">返回首页</button>
    </div>
  `;

  root.querySelector("#wRedo")?.addEventListener("click", () => navigate("practice", { mode: "wrong" }));
  root.querySelector("#wHome")?.addEventListener("click", () => navigate("home"));

  root.querySelectorAll(".item").forEach((node) => {
    const id = node.dataset.id;
    node.querySelector('[data-act="redo"]')?.addEventListener("click", () => {
      navigate("practice", { mode: "wrong" });
    });
    node.querySelector('[data-act="remove"]')?.addEventListener("click", () => {
      removeFromWrongbook(id);
      toast("已移出错题本", "ok");
      render(root);
    });
  });
}

export default { render };
