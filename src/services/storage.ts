/**
 * 存储工厂：按 binding 存在性选择后端（对齐 nodewarden 的 build-time 双配置切换）。
 *
 *   wrangler.toml    → 绑定 DB（D1）→ D1Store（默认模式）
 *   wrangler.kv.toml → 绑定 KV        → KvStore（KV 回退模式）
 */

import { D1Store } from "./storage-d1";
import { KvStore } from "./storage-kv";
import type { Env, Store } from "../types";

export function createStore(env: Env): Store {
  if (env.DB) return new D1Store(env.DB, env.KV);
  if (env.KV) return new KvStore(env.KV);
  throw new Error("未配置存储绑定（D1 或 KV）");
}

export { D1Store, KvStore };
