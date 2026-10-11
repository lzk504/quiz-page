/** 通用工具函数 */

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null =>
  root.querySelector<T>(sel);

export const $$ = (sel: string, root: ParentNode = document): Element[] =>
  Array.from(root.querySelectorAll(sel));

/** HTML 转义，所有用户/题库文本进入 innerHTML 前必须过一遍 */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface ElProps {
  class?: string;
  html?: string;
  text?: string;
  dataset?: Record<string, string>;
  [key: string]: unknown;
}

/** 创建元素并设置属性/子节点 */
export function el<T extends keyof HTMLElementTagNameMap>(
  tag: T,
  props: ElProps = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[T] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v as string;
    else if (k === "html") node.innerHTML = v as string;
    else if (k === "text") node.textContent = v as string;
    else if (k === "dataset") Object.assign(node.dataset, v as Record<string, string>);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (v !== null && v !== undefined && v !== false) {
      node.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const c of [].concat(children as never)) {
    if (c) node.append(c);
  }
  return node;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait = 300): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));
export const pct = (a: number, b: number): number => (b > 0 ? Math.round((a / b) * 100) : 0);

/** 日期时间：2026-10-01 12:34 */
export function fmtTime(ts?: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 日期：2026-10-01 */
export function fmtDate(ts = Date.now()): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 把多行文本渲染为 <p> 段落（已转义） */
export function linesToHtml(text: unknown): string {
  return String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `<p>${esc(l)}</p>`)
    .join("");
}

/** 触发文件下载 */
export function download(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
