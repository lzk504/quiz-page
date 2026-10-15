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
/** Vant Circle 环形进度条组件 */
export interface CircleOptions {
  rate: number;         // 0 ~ 100
  size?: number;        // 像素尺寸，默认 76
  strokeWidth?: number; // 轨道宽度，默认 6
  color?: string;       // 进度颜色，默认 var(--van-primary-color)
  layerColor?: string;  // 底圈颜色，默认 var(--van-border-color)
  text?: string;        // 环内文字
}

export function circleProgress({
  rate,
  size = 76,
  strokeWidth = 6,
  color = "var(--primary)",
  layerColor = "var(--line-2)",
  text = "",
}: CircleOptions): string {
  const r = 50 - strokeWidth / 2;
  const perimeter = 2 * Math.PI * r;
  const pctVal = Math.max(0, Math.min(100, Math.round(rate || 0)));
  const offset = perimeter * (1 - pctVal / 100);

  return `
    <div class="van-circle" style="width:${size}px;height:${size}px;" role="progressbar" aria-valuenow="${pctVal}" aria-valuemin="0" aria-valuemax="100">
      <svg viewBox="0 0 100 100">
        <circle class="van-circle__layer" cx="50" cy="50" r="${r}" stroke="${layerColor}" stroke-width="${strokeWidth}"></circle>
        <circle class="van-circle__hover" cx="50" cy="50" r="${r}" stroke="${color}" stroke-width="${strokeWidth}"
          stroke-dasharray="${perimeter.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
          stroke-linecap="round"></circle>
      </svg>
      <div class="van-circle__text">${text ? esc(text) : `<b>${pctVal}</b><small>%</small>`}</div>
    </div>`;
}

/* ---------------- 通用确认弹窗 (Vant Dialog 规范) ----------------
 * 替代 window.confirm：16px 圆角卡片，文字居中，底部等分单线无边框按钮组
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
      <div class="modal van-dialog" role="dialog" aria-modal="true">
        <h3 class="modal__title van-dialog__header">${esc(opts.title)}</h3>
        <div class="modal__msg van-dialog__content">${esc(opts.message)}</div>
        <div class="modal__btns van-dialog__footer">
          <button class="van-dialog__btn van-dialog__cancel" id="modalCancel">${esc(opts.cancelText ?? "取消")}</button>
          <button class="van-dialog__btn van-dialog__confirm ${opts.danger ? "van-dialog__confirm--danger" : ""}" id="modalOk">${esc(opts.confirmText ?? "确认")}</button>
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

/** 全局 toast (Vant Toast 风格：居中圆角、半透明深色) */
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
  toastTimer = setTimeout(() => node!.classList.remove("is-on"), 2200);
}

