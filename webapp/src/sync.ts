/**
 * 跨设备进度同步（轮询实现）。
 *
 * 为什么轮询而非 WebSocket/Durable Object：
 *   Durable Objects 需要 Workers 付费计划（$5/月起），本项目跑在免费计划上。
 *   轮询 30s/次、仅标签页可见时进行，日请求量远低于免费额度，对刷题场景足够。
 *
 * 升级点：若账号升级为付费计划，可在此接入 Durable Object + WebSocket 实时推送
 *   （服务端新增 NotificationsHub DO，PUT /api/store 成功后推送 store-updated），
 *   前端把 tick 换成 WS onmessage 即可，applyRemoteStore 逻辑不变。
 */

import { apiFetch, isLoggedIn } from "./auth";
import { applyRemoteStore } from "./storage";
import { toast } from "./ui";
import type { QuizStore } from "./types";

const POLL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let visibilityBound = false;
let stopped = true;

async function tick(): Promise<void> {
  if (stopped || !isLoggedIn()) return;
  if (document.visibilityState !== "visible") return;   // 隐藏标签页不轮询
  try {
    const data = await apiFetch<{ store: QuizStore | null; updatedAt: number | null }>("/api/store");
    if (data?.store) {
      const changed = applyRemoteStore(data.store, data.updatedAt ?? 0);
      if (changed) toast("已在其他设备更新，数据已同步", "ok");
    }
  } catch {
    // 静默失败：轮询不可用不打扰用户，写入路径的 PUT/409 合并仍兜底
  }
}

/** 登录后启动轮询同步（幂等，可重复调用） */
export function startSync(): void {
  if (!isLoggedIn()) return;
  stopped = false;
  if (!timer) timer = setInterval(() => { void tick(); }, POLL_MS);
  if (!visibilityBound) {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void tick();
    });
    visibilityBound = true;
  }
}

/** 登出或离开时停止轮询 */
export function stopSync(): void {
  stopped = true;
  if (timer) { clearInterval(timer); timer = null; }
}
