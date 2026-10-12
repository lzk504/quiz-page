/** 错题本：归类汇总 · 领域/题库两级嵌套折叠 · 筛选与重刷入口 */

import { getQuestions, getBanks, getBank } from "../state";
import { getStore, removeFromWrongbook } from "../storage";
import { displayAnswer } from "../scoring";
import { esc, fmtTime } from "../utils";
import { navigate } from "../router";
import { typeTag, questionDomainTag, bankTag, emptyState, toast } from "../ui";
import type { Question, View, WrongbookEntry } from "../types";

function shortAnswer(q: Question, max = 120): string {
  const text = displayAnswer(q) ?? "";
  return esc(text.length > max ? text.slice(0, max) + "…" : text);
}

// 筛选状态保留
let selectedBankFilter = "all";   // "all" | bankId
let selectedDomainFilter = "all"; // "all" | domainId
let groupMode = "bank-domain";    // "bank-domain" | "domain" | "flat"

interface DomainGroup {
  domain: string;
  domainLabel: string;
  items: Array<{ q: Question; w: WrongbookEntry }>;
}

interface BankGroup {
  bankId: string;
  bankTitle: string;
  domains: DomainGroup[];
  totalCount: number;
}

function renderItem(q: Question, w: WrongbookEntry): string {
  return `<div class="wb-item" data-id="${esc(q.id)}">
    <div class="wb-item__top">
      <div class="wb-item__tags">
        ${typeTag(q.type)}${questionDomainTag(q)}${bankTag(q)}
        <span class="tag tag--general">错 ${w.wrongCount ?? 1} 次</span>
      </div>
      <div class="wb-item__time">${w.lastWrongAt ? esc(fmtTime(w.lastWrongAt)) : ""}</div>
    </div>
    <div class="wb-item__stem">${esc(q.stem)}</div>
    <div class="wb-item__ans">
      正确答案：<b>${shortAnswer(q)}</b>
    </div>
    <div class="wb-item__actions">
      <button class="btn btn--sm btn--ghost" data-act="redo" style="padding:0 8px">重做这题</button>
      <button class="btn btn--sm btn--danger" data-act="remove" style="padding:0 8px">移出错题本</button>
    </div>
  </div>`;
}

function render(root: HTMLElement): void {
  const store = getStore();
  const wrongIds = new Set(Object.keys(store.wrongbook));
  const questions = getQuestions();
  const allWrongQuestions = questions.filter((q) => wrongIds.has(q.id));

  if (!allWrongQuestions.length) {
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

  // 根据当前已收录错题收集可用的题库与领域
  const availableBanks = new Set<string>();
  const availableDomains = new Set<string>();
  for (const q of allWrongQuestions) {
    availableBanks.add(q.id.split("-")[0]);
    availableDomains.add(q.domain);
  }

  // 校验当前选中的筛选项
  if (selectedBankFilter !== "all" && !availableBanks.has(selectedBankFilter)) {
    selectedBankFilter = "all";
  }
  if (selectedDomainFilter !== "all" && !availableDomains.has(selectedDomainFilter)) {
    selectedDomainFilter = "all";
  }

  // 按选择过滤
  let filteredItems = allWrongQuestions;
  if (selectedBankFilter !== "all") {
    filteredItems = filteredItems.filter((q) => q.id.startsWith(selectedBankFilter + "-"));
  }
  if (selectedDomainFilter !== "all") {
    filteredItems = filteredItems.filter((q) => q.domain === selectedDomainFilter);
  }

  // 默认策略：题目总数 <= 20 全展开，> 20 则按需折叠
  const shouldOpenAll = filteredItems.length <= 20;

  // 题库与领域选项
  const banksList = getBanks().filter((b) => availableBanks.has(b.id));

  // 获取领域中文名映射
  const domainLabelMap: Record<string, string> = {};
  for (const b of getBanks()) {
    Object.assign(domainLabelMap, b.domainLabels);
  }

  // 构造分组数据：Bank -> Domain -> items
  const bankGroupsMap = new Map<string, Map<string, Array<{ q: Question; w: WrongbookEntry }>>>();
  for (const q of filteredItems) {
    const bId = q.id.split("-")[0];
    const w = store.wrongbook[q.id] ?? { wrongCount: 1, addedAt: 0, lastWrongAt: 0 };
    if (!bankGroupsMap.has(bId)) bankGroupsMap.set(bId, new Map());
    const dMap = bankGroupsMap.get(bId)!;
    if (!dMap.has(q.domain)) dMap.set(q.domain, []);
    dMap.get(q.domain)!.push({ q, w });
  }

  const bankGroups: BankGroup[] = [];
  for (const [bId, dMap] of bankGroupsMap) {
    const bank = getBank(bId);
    const domains: DomainGroup[] = [];
    let bTotal = 0;
    for (const [dom, items] of dMap) {
      domains.push({
        domain: dom,
        domainLabel: bank?.domainLabels[dom] ?? domainLabelMap[dom] ?? dom,
        items,
      });
      bTotal += items.length;
    }
    bankGroups.push({
      bankId: bId,
      bankTitle: bank?.title ?? bId,
      domains,
      totalCount: bTotal,
    });
  }

  // 按领域平铺（当 groupMode 为 "domain"）
  const domainGroupsMap = new Map<string, Array<{ q: Question; w: WrongbookEntry }>>();
  if (groupMode === "domain") {
    for (const q of filteredItems) {
      const w = store.wrongbook[q.id] ?? { wrongCount: 1, addedAt: 0, lastWrongAt: 0 };
      if (!domainGroupsMap.has(q.domain)) domainGroupsMap.set(q.domain, []);
      domainGroupsMap.get(q.domain)!.push({ q, w });
    }
  }

  root.innerHTML = `
    <section class="card">
      <h2 class="card__title">
        错题本
        <small>共 ${allWrongQuestions.length} 题 · 当前筛选 ${filteredItems.length} 题</small>
      </h2>
      <div class="about">
        <p>答错自动收录，<b>错题重刷答对一次即自动移出</b>；支持按题库与领域两级归类查看。</p>
      </div>

      <!-- 筛选与分组控制 -->
      <div class="wb-controls">
        <div class="wb-filter-row">
          <span class="wb-filter-label">分组查看</span>
          <select class="wb-select" id="groupSelect">
            <option value="bank-domain" ${groupMode === "bank-domain" ? "selected" : ""}>题库 → 领域 (两级嵌套)</option>
            <option value="domain" ${groupMode === "domain" ? "selected" : ""}>按领域分组</option>
            <option value="flat" ${groupMode === "flat" ? "selected" : ""}>不分组平铺</option>
          </select>
        </div>

        <div class="wb-filter-row">
          <span class="wb-filter-label">筛选范围</span>
          <select class="wb-select" id="bankFilter">
            <option value="all" ${selectedBankFilter === "all" ? "selected" : ""}>全部题库 (${allWrongQuestions.length})</option>
            ${banksList.map((b) => {
              const count = allWrongQuestions.filter((q) => q.id.startsWith(b.id + "-")).length;
              return `<option value="${esc(b.id)}" ${selectedBankFilter === b.id ? "selected" : ""}>${esc(b.title)} (${count})</option>`;
            }).join("")}
          </select>
          <select class="wb-select" id="domainFilter">
            <option value="all" ${selectedDomainFilter === "all" ? "selected" : ""}>全部领域</option>
            ${[...availableDomains].map((d) => {
              const label = domainLabelMap[d] ?? d;
              const count = allWrongQuestions.filter((q) => q.domain === d).length;
              return `<option value="${esc(d)}" ${selectedDomainFilter === d ? "selected" : ""}>${esc(label)} (${count})</option>`;
            }).join("")}
          </select>
        </div>
      </div>

      <!-- 错题重刷入口联动按钮群 -->
      <div class="wb-redo-buttons">
        <button class="btn btn--primary" id="wRedoAll">全量重刷 (${allWrongQuestions.length})</button>
        ${selectedBankFilter !== "all" ? `
          <button class="btn btn--primary" id="wRedoBank">重刷当前题库 (${filteredItems.length})</button>
        ` : ""}
        ${selectedDomainFilter !== "all" ? `
          <button class="btn btn--primary" id="wRedoDomain">重刷当前领域 (${filteredItems.length})</button>
        ` : ""}
      </div>
    </section>

    <!-- 错题内容展示区 -->
    <div id="wrongListContainer">
      ${filteredItems.length === 0 ? `
        <div class="empty">
          <div class="empty__icon">🔍</div>
          <h3>该筛选条件下无错题</h3>
          <p>尝试切换筛选选项或选择全部题库/领域。</p>
        </div>
      ` : groupMode === "bank-domain" ? `
        <!-- 两级嵌套折叠：题库 -> 领域 -->
        ${bankGroups.map((bg, bIdx) => `
          <details class="wb-group" ${shouldOpenAll || bIdx === 0 ? "open" : ""}>
            <summary class="wb-group__head">
              <span><b>${esc(bg.bankTitle)}</b> <small style="color:var(--text-3);font-weight:normal">(${bg.totalCount} 题)</small></span>
              <span class="wb-group__arrow">▶</span>
            </summary>
            ${bg.domains.map((dg) => `
              <details class="wb-subgroup" ${shouldOpenAll ? "open" : ""}>
                <summary class="wb-subgroup__head">
                  <span>${esc(dg.domainLabel)} <small style="color:var(--text-3);font-weight:normal">(${dg.items.length} 题)</small></span>
                  <span class="wb-group__arrow">▶</span>
                </summary>
                <div class="wb-items">
                  ${dg.items.map((it) => renderItem(it.q, it.w)).join("")}
                </div>
              </details>
            `).join("")}
          </details>
        `).join("")}
      ` : groupMode === "domain" ? `
        <!-- 单级折叠：按领域 -->
        ${[...domainGroupsMap.entries()].map(([dom, items], dIdx) => {
          const domLabel = domainLabelMap[dom] ?? dom;
          return `
            <details class="wb-group" ${shouldOpenAll || dIdx === 0 ? "open" : ""}>
              <summary class="wb-group__head">
                <span><b>${esc(domLabel)}</b> <small style="color:var(--text-3);font-weight:normal">(${items.length} 题)</small></span>
                <span class="wb-group__arrow">▶</span>
              </summary>
              <div class="wb-items">
                ${items.map((it) => renderItem(it.q, it.w)).join("")}
              </div>
            </details>
          `;
        }).join("")}
      ` : `
        <!-- 平铺列表 -->
        <section class="card" style="padding:10px 14px">
          <div class="wb-items">
            ${filteredItems.map((q) => {
              const w = store.wrongbook[q.id] ?? { wrongCount: 1, addedAt: 0, lastWrongAt: 0 };
              return renderItem(q, w);
            }).join("")}
          </div>
        </section>
      `}
    </div>

    <div class="actions" style="margin-top:16px">
      <button class="btn btn--block" id="wHome">返回首页</button>
    </div>
  `;

  // 绑定重刷入口
  root.querySelector("#wRedoAll")?.addEventListener("click", () => {
    navigate("practice", { mode: "wrong" });
  });

  root.querySelector("#wRedoBank")?.addEventListener("click", () => {
    navigate("practice", { mode: "wrong", bank: selectedBankFilter });
  });

  root.querySelector("#wRedoDomain")?.addEventListener("click", () => {
    navigate("practice", { mode: "wrong", domain: selectedDomainFilter });
  });

  root.querySelector("#wHome")?.addEventListener("click", () => navigate("home"));

  // 筛选器与分组下拉切换
  root.querySelector("#groupSelect")?.addEventListener("change", (e) => {
    groupMode = (e.target as HTMLSelectElement).value;
    render(root);
  });

  root.querySelector("#bankFilter")?.addEventListener("change", (e) => {
    selectedBankFilter = (e.target as HTMLSelectElement).value;
    render(root);
  });

  root.querySelector("#domainFilter")?.addEventListener("change", (e) => {
    selectedDomainFilter = (e.target as HTMLSelectElement).value;
    render(root);
  });

  // 单题重做与移除
  root.querySelectorAll<HTMLElement>(".wb-item").forEach((node) => {
    const id = node.dataset.id!;
    node.querySelector('[data-act="redo"]')?.addEventListener("click", () => {
      navigate("practice", { mode: "wrong", qid: id });
    });
    node.querySelector('[data-act="remove"]')?.addEventListener("click", () => {
      removeFromWrongbook(id);
      toast("已移出错题本", "ok");
      render(root);
    });
  });
}

const view: View = { render };
export default view;
