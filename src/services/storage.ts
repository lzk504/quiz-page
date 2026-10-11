/**
 * 存储工厂：KV 唯一后端（v4.2 起从 D1 切回 KV）。
 */

import { KvStore } from "./storage-kv";
import type { Env, Store } from "../types";

export function createStore(env: Env): Store {
  if (env.KV) return new KvStore(env.KV);
  throw new Error("未配置 KV 存储绑定（KV）");
}

export { KvStore };
