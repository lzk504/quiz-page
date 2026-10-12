/** 跨视图复用的展示片段 */

import { domainLabels, typeLabels, getBankOf, questionDomainLabel } from "./state";
import { esc } from "./utils";
import type { Question } from "./types";

export const DOMAIN_CLASS: Record<string, string> = {
  health: "tag--health",
  language: "tag--language",
  society: "tag--society",
  science: "tag--science",
  art: "tag--art",
  general: "tag--general",
};

export const TYPE_CLASS: Record<string, string> = {
  single: "tag--general",
  multiple: "tag--general",
  judge: "tag--general",
  fill: "tag--general",
  short: "tag--general",
};

export function domainTag(domain: string): string {
  const label = domainLabels()[domain] ?? domain;
  return `<span class="tag ${DOMAIN_CLASS[domain] ?? "tag--general"}">${esc(label)}</span>`;
}

/** 题目的领域标签（按题目所属库解析标签，各库领域自治） */
export function questionDomainTag(q: Question): string {
  return `<span class="tag ${DOMAIN_CLASS[q.domain] ?? "tag--general"}">${esc(questionDomainLabel(q))}</span>`;
}

/** 题目所属题库标签 */
export function bankTag(q: Question | string): string {
  const bank = getBankOf(q);
  if (!bank) return "";
  return `<span class="tag tag--bank" title="${esc(bank.title)}">${esc(bank.title)}</span>`;
}

export function typeTag(type: string): string {
  const label = typeLabels()[type] ?? type;
  return `<span class="tag tag--type">${esc(label)}</span>`;
}

export function questionTags(q: Question): string {
  return `<div class="item__tags">${typeTag(q.type)}${questionDomainTag(q)}${bankTag(q)}</div>`;
}

/** 进度条 */
export function bar(percent: number, cls = "bar--blue"): string {
  const p = Math.max(0, Math.min(100, Math.round(percent ?? 0)));
  return `<div class="rate-row__bar"><i class="${cls}" style="width:${p}%"></i></div>`;
}

interface EmptyStateOpts {
  icon?: string;
  title?: string;
  desc?: string;
  action?: string;
}

/** 空态块 */
export function emptyState({ icon = "📭", title = "暂无内容", desc = "", action = "" }: EmptyStateOpts = {}): string {
  return `<div class="empty">
    <div class="empty__icon">${icon}</div>
    <h3>${esc(title)}</h3>
    ${desc ? `<p>${desc}</p>` : ""}
    ${action}
  </div>`;
}

/** 题型图标（用于列表前缀，可选） */
export const TYPE_ICON: Record<string, string> = {
  single: "①", multiple: "②", judge: "③", fill: "④", short: "⑤",
};

/** 全局 toast */
let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(message: string, kind: "info" | "ok" | "bad" = "info"): void {
  let node = document.getElementById("toast");
  if (!node) {
    node = document.createElement("div");
    node.id = "toast";
    node.className = "toast";
    document.body.append(node);
  }
  node.className = `toast toast--${kind} is-on`;
  node.textContent = message;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node!.classList.remove("is-on"), 2400);
}
