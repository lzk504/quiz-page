/**
 * 存储工厂：D1 唯一后端（v4 起移除 KV 回退模式与 KV→D1 迁移）。
 */

import { D1Store } from "./storage-d1";
import type { Env, Store } from "../types";

export function createStore(env: Env): Store {
  if (env.DB) return new D1Store(env.DB);
  throw new Error("未配置 D1 存储绑定（DB）");
}

export { D1Store };
