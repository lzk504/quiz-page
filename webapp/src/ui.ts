/** 跨视图复用的展示片段 */

import { domainLabels, typeLabels, getBankOf, questionDomainLabel, bankShortName } from "./state";
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

/** 题目所属题库标签（v6.1：显示题库短名，不带 G/P/Y 编号） */
export function bankTag(q: Question | string): string {
  const bank = getBankOf(q);
  if (!bank) return "";
  return `<span class="tag tag--bank" title="${esc(bank.title)}">${esc(bankShortName(bank.id))}</span>`;
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

/* ---------------- 通用确认弹窗 ----------------
 * 替代 window.confirm：原生 confirm 在部分环境（WebView / 自动化浏览器）会被
 * 静默吞掉，表现为「点了没反应」。这里统一用自定义弹窗，Promise<boolean> 语义不变。
 */

let activeDialog: HTMLElement | null = null;

interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** 确认按钮用危险色（删除 / 交卷 / 退出等不可逆操作） */
  danger?: boolean;
}

/** 关闭当前活动弹窗（视图卸载兜底），等价于点「取消」 */
export function closeActiveDialog(): void {
  const node = activeDialog;
  if (!node) return;
  node.dispatchEvent(new Event("modal-cancel"));
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3 class="modal__title">${esc(opts.title)}</h3>
        <p class="modal__msg">${esc(opts.message)}</p>
        <div class="modal__btns">
          <button class="btn" id="modalCancel">${esc(opts.cancelText ?? "取消")}</button>
          <button class="btn ${opts.danger ? "btn--danger-solid" : "btn--primary"}" id="modalOk">${esc(opts.confirmText ?? "确定")}</button>
        </div>
      </div>`;

    const done = (val: boolean): void => {
      if (activeDialog === mask) activeDialog = null;
      document.removeEventListener("keydown", onKey);
      mask.remove();
      resolve(val);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") done(false); };

    mask.querySelector("#modalOk")?.addEventListener("click", () => done(true));
    mask.querySelector("#modalCancel")?.addEventListener("click", () => done(false));
    mask.addEventListener("click", (e) => { if (e.target === mask) done(false); });
    mask.addEventListener("modal-cancel", () => done(false));
    document.addEventListener("keydown", onKey);

    document.body.append(mask);
    activeDialog = mask;
    mask.querySelector<HTMLElement>("#modalCancel")?.focus();
  });
}

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
