/**
 * 我的收藏（v6 新建）：列表不展示答案（避免“看答案背题”），点「再做一遍」进入单题练习。
 */

import { getLoadedQuestions, getBanks } from "../state";
import { getStore, toggleFavorite } from "../storage";
import { favoriteQuestions } from "../goal";
import { esc, fmtTime } from "../utils";
import { navigate } from "../router";
import { typeTag, questionDomainTag, bankTag, emptyState, toast } from "../ui";
import type { View } from "../types";

/** 题库筛选（模块级保留） */
let favBank = "all";

const view: View = {
  async render(root) {
    const all = favoriteQuestions(getLoadedQuestions(), getStore());
    const banks = getBanks();

    // 筛选值失效则回退到全部
    if (favBank !== "all" && !banks.some((b) => b.id === favBank)) favBank = "all";
    const items = favBank === "all" ? all : all.filter((it) => it.q.id.startsWith(favBank + "-"));

    root.innerHTML = `
      <div class="page-head">
        <button class="page-head__back" id="favBack" title="返回">‹</button>
        <h1 class="page-head__title">我的收藏</h1>
        <span class="page-head__right">共 ${all.length} 题</span>
      </div>
      ${all.length ? `
        <div class="chips" id="favChips">
          <button class="chip${favBank === "all" ? " is-on" : ""}" data-bank="all">全部题库<span class="chip__n">${all.length}</span></button>
          ${banks.map((b) => {
            const n = all.filter((it) => it.q.id.startsWith(b.id + "-")).length;
            return `<button class="chip${favBank === b.id ? " is-on" : ""}" data-bank="${esc(b.id)}">
              ${esc(b.id)}<span class="chip__n">${n}</span></button>`;
          }).join("")}
        </div>
        <div class="fav-list" id="favList" style="margin-top:12px"></div>
      ` : ""}
      <div id="favEmpty"></div>
    `;

    const listBox = root.querySelector<HTMLElement>("#favList");
    const emptyBox = root.querySelector<HTMLElement>("#favEmpty")!;

    if (!all.length) {
      root.querySelector("#favChips")?.remove();
      emptyBox.innerHTML = emptyState({
        icon: "★",
        title: "还没有收藏的题目",
        desc: "刷题时点右上角的 ☆ 就能收藏，收藏的题目不会展示答案，方便反复重做。",
        action: `<button class="btn btn--primary" id="favGo">去刷题</button>`,
      });
      emptyBox.querySelector("#favGo")?.addEventListener("click", () => navigate("practice", { fresh: "1" }));
      root.querySelector("#favBack")?.addEventListener("click", () => navigate("me"));
      return;
    }

    const paint = (): void => {
      listBox!.innerHTML = items.length
        ? items.map((it) => `
          <div class="fav-card" data-id="${esc(it.q.id)}">
            <div class="fav-card__top">
              <div class="fav-card__tags">${typeTag(it.q.type)}${questionDomainTag(it.q)}${bankTag(it.q)}</div>
              <button class="star-btn is-on" data-act="unfav" title="取消收藏">★</button>
            </div>
            <div class="fav-card__stem">${esc(it.q.stem)}</div>
            <div class="fav-card__foot">
              <span>${esc(fmtTime(it.f.addedAt))} 收藏</span>
              <span class="wb-item__act">
                <button class="btn btn--sm btn--ghost" data-act="again" style="padding:0 8px">▷ 再做一遍</button>
                <button class="btn btn--sm btn--danger" data-act="unfav2" style="padding:0 8px">取消收藏</button>
              </span>
            </div>
          </div>`).join("")
        : emptyState({ icon: "🔍", title: "该题库下暂无收藏", desc: "切换到「全部题库」查看。" });

      listBox!.querySelectorAll<HTMLElement>(".fav-card").forEach((node) => {
        const id = node.dataset.id!;
        node.querySelector('[data-act="again"]')?.addEventListener("click", () => {
          navigate("practice", { mode: "fav", qid: id });
        });
        const unfav = (): void => {
          toggleFavorite(id);
          toast("已取消收藏", "ok");
          void view.render(root);
        };
        node.querySelector('[data-act="unfav"]')?.addEventListener("click", unfav);
        node.querySelector('[data-act="unfav2"]')?.addEventListener("click", unfav);
      });
    };

    paint();

    root.querySelector("#favChips")?.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".chip");
      if (!btn?.dataset.bank) return;
      favBank = btn.dataset.bank;
      void view.render(root);
    });

    root.querySelector("#favBack")?.addEventListener("click", () => navigate("me"));
  },
};

export default view;
