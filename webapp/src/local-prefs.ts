/**
 * 本机偏好（localStorage，不入 store、不上云）。
 *
 * 与 store 的区别：这些是「这台设备的个人设置」，换设备不同步是预期行为。
 *   lastScope 上次练习范围（首页「继续上次练习」只记范围，不记题序）
 */

const LAST_SCOPE_KEY = "quizapp.lastScope.v1";

const read = (key: string): string | null => {
  try { return localStorage.getItem(key); }
  catch { return null; }
};
const write = (key: string, value: string | null): void => {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
  catch { /* 隐私模式：忽略 */ }
};

/* ---------------- 上次练习范围 ---------------- */

export interface LastScope {
  /** 题库 id 集合（= 当时的刷题范围） */
  banks: string[];
  domain?: string;
  type?: string;
  /** 记录时间，用于判断「是否仍有进度」的兜底 */
  at: number;
}

export function getLastScope(): LastScope | null {
  const raw = read(LAST_SCOPE_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LastScope>;
    if (!v || !Array.isArray(v.banks)) return null;
    const banks = v.banks.filter((x): x is string => typeof x === "string");
    if (!banks.length) return null;
    return {
      banks,
      domain: typeof v.domain === "string" && v.domain ? v.domain : undefined,
      type: typeof v.type === "string" && v.type ? v.type : undefined,
      at: Number(v.at) || 0,
    };
  } catch { return null; }
}

export function setLastScope(scope: Omit<LastScope, "at"> | null): void {
  if (!scope || !scope.banks?.length) { write(LAST_SCOPE_KEY, null); return; }
  const value: LastScope = {
    banks: scope.banks,
    domain: scope.domain,
    type: scope.type,
    at: Date.now(),
  };
  write(LAST_SCOPE_KEY, JSON.stringify(value));
}
