#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""校验 data/questions.json 的完整性与自洽性。

用法：
    python scripts/validate_questions.py            # 校验 + 抽样打印
    python scripts/validate_questions.py --quiet    # 只输出结论

退出码：0 = 全部通过；1 = 有断言失败。
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JSON_PATH = ROOT / "data" / "questions.json"

EXPECTED = {"single": 24, "multiple": 10, "fill": 16, "judge": 12, "short": 8}
DOMAINS = {"health", "language", "society", "science", "art", "general"}
BLANK_RE = re.compile(r"[_＿]{2,}")

errors: list[str] = []
notes: list[str] = []


def err(msg: str) -> None:
    errors.append(msg)


def check(cond: bool, msg: str) -> None:
    if not cond:
        err(msg)


def validate(path: Path = JSON_PATH, verbose: bool = True, seed: int = 7) -> bool:
    errors.clear()
    notes.clear()

    if not path.exists():
        print(f"✗ 未找到 {path}")
        return False

    data = json.loads(path.read_text(encoding="utf-8"))
    meta = data.get("meta", {})
    questions: list[dict] = data.get("questions", [])

    # ---- 1. 计数 ----
    counts = Counter(q.get("type") for q in questions)
    for t, n in EXPECTED.items():
        check(counts.get(t, 0) == n, f"题型 {t} 数量应为 {n}，实际 {counts.get(t, 0)}")
    total = len(questions)
    check(total == sum(EXPECTED.values()), f"总题数应为 70，实际 {total}")
    check(meta.get("counts", {}).get("total") == total, "meta.counts.total 与实际题数不一致")

    # ---- 2. id 唯一且命名规范 ----
    ids = [q.get("id") for q in questions]
    check(len(ids) == len(set(ids)), f"存在重复 id：{Counter(ids).most_common(3)}")
    prefixes = {"single": "S", "multiple": "M", "fill": "F", "judge": "J", "short": "SA"}
    for q in questions:
        p = prefixes[q["type"]]
        check(bool(re.fullmatch(rf"{p}\d{{2}}", q["id"] or "")),
              f"{q['id']}：id 命名不符合 {p}NN 规范")
    # 每种题型序号连续无缺口
    for t, p in prefixes.items():
        nums = sorted(int(q["id"][len(p):]) for q in questions if q["type"] == t)
        expected_nums = list(range(1, EXPECTED[t] + 1))
        check(nums == expected_nums, f"{t} 题号不连续：{nums}")

    # ---- 3. 通用字段 ----
    for q in questions:
        qid = q.get("id", "?")
        check(q.get("type") in EXPECTED, f"{qid}：type 非法")
        check(q.get("domain") in DOMAINS, f"{qid}：domain 非法（{q.get('domain')}）")
        check(bool((q.get("stem") or "").strip()), f"{qid}：stem 为空")

    # ---- 4. 分题型断言 ----
    for q in questions:
        qid, t = q["id"], q["type"]
        opts = q.get("options")
        ans = q.get("answer")

        if t in ("single", "multiple"):
            check(isinstance(opts, list) and len(opts) >= 4, f"{qid}：选项少于 4 项")
            if t == "single":
                check(isinstance(ans, str) and re.fullmatch(r"[A-E]", ans or ""),
                      f"{qid}：单选 answer 应为单个字母，实际 {ans!r}")
                check(ans in "ABCDE"[:len(opts)], f"{qid}：answer {ans} 超出选项范围（{len(opts)} 项）")
            else:
                check(isinstance(ans, list) and len(ans) >= 2,
                      f"{qid}：多选 answer 至少 2 项，实际 {ans!r}")
                check(all(a in "ABCDE"[:len(opts)] for a in ans or []),
                      f"{qid}：多选 answer {ans} 超出选项范围（{len(opts)} 项）")
                check(len(set(ans or [])) == len(ans or []), f"{qid}：多选 answer 有重复项")
            check(bool((q.get("analysis") or "").strip()), f"{qid}：{t} 缺解析")

        elif t == "fill":
            n_blank = len(BLANK_RE.findall(q.get("stem", "")))
            check(q.get("blanks") == n_blank,
                  f"{qid}：blanks={q.get('blanks')} 与题干下划线数 {n_blank} 不符")
            check(isinstance(ans, list) and len(ans) == n_blank,
                  f"{qid}：answer 空数 {len(ans) if isinstance(ans, list) else ans!r} 与题干 {n_blank} 不符")
            for bi, blank in enumerate(ans or []):
                check(isinstance(blank, dict), f"{qid} 第{bi+1}空：结构应为对象")
                accept = blank.get("accept")
                check(isinstance(accept, list) and len(accept) > 0,
                      f"{qid} 第{bi+1}空：accept 应为非空数组")
                check(all(isinstance(a, str) and a.strip() for a in accept or []),
                      f"{qid} 第{bi+1}空：accept 含空字符串")
                check(bool((blank.get("display") or "").strip()),
                      f"{qid} 第{bi+1}空：缺 display")

        elif t == "judge":
            check(isinstance(ans, bool), f"{qid}：判断题 answer 应为布尔值，实际 {ans!r}")
            check(bool((q.get("analysis") or "").strip()), f"{qid}：判断题缺解析")

        elif t == "short":
            check(isinstance(ans, str) and len(ans.strip()) >= 20,
                  f"{qid}：简答参考答案过短或缺失")

    # ---- 5. 无空答案兜底 ----
    for q in questions:
        if q["type"] != "short":
            check(q.get("answer") not in (None, "", [], {}), f"{q['id']}：答案缺失")

    # ---- 6. 输出 ----
    if verbose:
        print(f"题库文件：{path.relative_to(ROOT)}")
        print(f"总题数：{total}　|　" + "　".join(f"{t}:{n}" for t, n in counts.items()))
        print(f"领域分布：" + "　".join(f"{k}:{v}" for k, v in sorted(Counter(q['domain'] for q in questions).items())))
        print(f"\n--- 抽样比对（每题型随机 1 题，seed={seed}）---")
        rng = random.Random(seed)
        for t in EXPECTED:
            pool = [q for q in questions if q["type"] == t]
            q = rng.choice(pool)
            print(f"\n[{q['id']}] {t} / {q['domain']}")
            print(f"  题干：{q['stem']}")
            if q.get("options"):
                for i, o in enumerate(q["options"]):
                    print(f"    {'ABCDE'[i]}. {o}")
            ans = q["answer"]
            if t == "fill":
                print("  答案：" + " | ".join(
                    f"第{i+1}空={b['display']}（接受:{'/'.join(b['accept'])}）"
                    for i, b in enumerate(ans)))
            elif t == "judge":
                print("  答案：" + ("√ 正确" if ans else "× 错误"))
            else:
                print(f"  答案：{ans}")
            if q.get("analysis"):
                print(f"  解析：{q['analysis'][:100]}")

    print()
    if errors:
        print(f"✗ 校验失败，共 {len(errors)} 项：")
        for e in errors:
            print("  -", e)
        return False
    print("✓ 全部断言通过")
    return True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    ok = validate(verbose=not args.quiet)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
