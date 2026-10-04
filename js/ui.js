/** 跨视图复用的展示片段 */

import { domainLabels, typeLabels } from "./state.js";
import { esc } from "./utils.js";

export const DOMAIN_CLASS = {
  health: "tag--health",
  language: "tag--language",
  society: "tag--society",
  science: "tag--science",
  art: "tag--art",
  general: "tag--general",
};

export const TYPE_CLASS = {
  single: "tag--general",
  multiple: "tag--general",
  judge: "tag--general",
};

export function domainTag(domain) {
  const label = domainLabels()[domain] ?? domain;
  return `<span class="tag ${DOMAIN_CLASS[domain] ?? "tag--general"}">${esc(label)}</span>`;
}

export function typeTag(type) {
  const label = typeLabels()[type] ?? type;
  return `<span class="tag tag--type">${esc(label)}</span>`;
}

export function questionTags(q) {
  return `<div class="item__tags">${typeTag(q.type)}${domainTag(q.domain)}</div>`;
}

/** 进度条 */
export function bar(percent, cls = "bar--blue") {
  const p = Math.max(0, Math.min(100, Math.round(percent ?? 0)));
  return `<div class="rate-row__bar"><i class="${cls}" style="width:${p}%"></i></div>`;
}

/** 空态块 */
export function emptyState({ icon = "📭", title = "暂无内容", desc = "", action = "" } = {}) {
  return `<div class="empty">
    <div class="empty__icon">${icon}</div>
    <h3>${esc(title)}</h3>
    ${desc ? `<p>${desc}</p>` : ""}
    ${action}
  </div>`;
}

/** 题型图标（用于列表前缀，可选） */
export const TYPE_ICON = {
  single: "①", multiple: "②", judge: "③",
};

/** 全局 toast */
let toastTimer = null;
export function toast(message, kind = "info") {
  let node = document.getElementById("toast");
  if (!node) {
    node = document.createElement("div");
    node.id = "toast";
    node.className = "toast";
    document.body.append(node);
  }
  node.className = `toast toast--${kind} is-on`;
  node.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("is-on"), 2400);
}
