#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从《3-6岁儿童学习与发展指南_考点精编与刷题手册.html》提取全部 70 题，
生成 data/questions.json 与 scripts/review_report.md。

零第三方依赖（仅标准库 re / html / json / pathlib）。

用法：
    python scripts/extract_questions.py            # 生成 JSON + 复核报告
    python scripts/extract_questions.py --check    # 只跑校验，不写文件
"""

from __future__ import annotations

import argparse
import html as html_mod
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "3-6岁儿童学习与发展指南_考点精编与刷题手册.html"
OUT_JSON = ROOT / "data" / "questions.json"
OUT_REPORT = ROOT / "scripts" / "review_report.md"

# --------------------------------------------------------------------------
# 领域标签
# --------------------------------------------------------------------------
DOMAIN_LABELS = {
    "health": "健康",
    "language": "语言",
    "society": "社会",
    "science": "科学",
    "art": "艺术",
    "general": "综合",
}

# 关键词规则表：按顺序匹配，首个命中即定。命中值 = (domain, 命中词)
DOMAIN_RULES: list[tuple[str, list[str]]] = [
    ("health", [
        "健康", "体态", "动作发展", "身心状况", "睡眠", "午睡", "户外活动", "看电视",
        "投掷", "沙包", "单脚", "快跑", "悬空", "吊起", "筷子", "勺子", "剪刀", "安全",
        "卫生", "自理", "生活习惯", "走失", "热水瓶", "阳台", "逃生", "演习", "体质",
    ]),
    ("science", [
        "科学", "探究", "数学认知", "点数", "加减", "数量", "形状", "空间",
        "数概念", "实物操作", "具体形象思维",
    ]),
    ("language", [
        "语言", "倾听", "表达", "阅读", "书写", "文字", "识字", "故事", "图书",
        "名字",
    ]),
    ("society", [
        "社会", "人际交往", "社会适应", "同伴", "归属感", "行为规范", "说谎", "自尊",
        "自信", "群体", "说教", "榜样", "比较", "尊重他人",
    ]),
    ("art", [
        "艺术", "绘画", "范画", "审美", "唱歌", "律动", "表演", "创作", "作品",
        "表现与创造", "感受与欣赏",
    ]),
]

# 人工复核后的领域覆盖表（优先级最高）。键 = 题目 id。
# 复核依据：参见 scripts/review_report.md 的打标结果。
DOMAIN_OVERRIDES: dict[str, str] = {
    # 全书框架 / "说明"部分（四原则、学习品质、学习方式）→ 综合
    "S03": "general",    # 《指南》的五个领域是
    "M01": "general",    # 描述的领域包括
    "S16": "general",    # 幼儿的思维特点（学习方式与特点）
    "J04": "general",    # 幼儿的思维特点（同上）
    "S23": "general",    # 学习以直接经验为基础
    "M09": "general",    # 良好的学习品质
    "SA05": "general",   # 幼儿学习的方式和特点
    # 领域归属修正
    "S22": "art",        # 关于幼儿绘画的做法（原误判 language）
    "J07": "health",     # 户外环境连续活动时长（原误判 science）
    "F15": "health",     # 5～6岁连续行走里程（原兜底 general）
}

# 填空别名补丁表：id -> [每空的 accept 列表]；display 仍取手册原文。
FILL_ALIASES: dict[str, list[list[str]]] = {
    "F13": [
        ["两小时", "2小时", "两小时以上", "2小时以上"],
        ["1小时", "一小时", "1个小时", "1小时以上"],
    ],
    "F14": [
        ["11～12", "11-12", "11~12", "11到12", "11、12", "11至12"],
        ["2", "两", "2小时", "两小时", "2个小时"],
    ],
    "F15": [
        ["1.5", "1.5公里", "一公里半", "1.5km"],
    ],
    "F16": [
        ["名字", "姓名"],
        ["电话号码", "电话", "手机号", "手机号码", "家庭住址", "住址", "地址"],
    ],
}

# 填空题 display 答案的清洗补丁（手册原文含括号说明，展示时精简）
FILL_DISPLAY_FIX = {
    ("F16", 1): "电话号码（或家庭住址）",
    ("F15", 0): "1.5",
    ("F13", 0): "两小时",
    ("F13", 1): "1小时",
}

# --------------------------------------------------------------------------
# HTML 工具
# --------------------------------------------------------------------------
TAG_RE = re.compile(r"<[^>]+>")


def strip_tags(s: str) -> str:
    """剥离标签并解码实体，保留纯文本。"""
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = TAG_RE.sub("", s)
    s = html_mod.unescape(s)
    s = s.replace("\u3000", " ")          # 全角空格 → 普通空格
    s = re.sub(r"[ \t]+", " ", s)
    return s.strip()


def section_text(raw: str, start_marker: str, end_marker: str | None) -> str:
    """按标记切出正文区段（rfind 取最后一次，跳过目录/封面提及）。"""
    i = raw.rfind(start_marker)
    if i < 0:
        raise SystemExit(f"未找到标记：{start_marker}")
    if end_marker is None:
        return raw[i:]
    j = raw.find(end_marker, i + len(start_marker))
    if j < 0:
        raise SystemExit(f"未找到结束标记：{end_marker}")
    return raw[i:j]


def split_by_h3(block: str) -> dict[str, str]:
    """把区段按 <h3> 切成 {小节标题: 该节正文}。"""
    parts = re.split(r"<h3>(.*?)</h3>", block, flags=re.S)
    out: dict[str, str] = {}
    # parts = [前置, 标题1, 正文1, 标题2, 正文2, ...]
    for k in range(1, len(parts) - 1, 2):
        title = strip_tags(parts[k])
        out[title] = parts[k + 1]
    return out


def h3_matching(sections: dict[str, str], keyword: str) -> str:
    for title, body in sections.items():
        if keyword in title:
            return body
    raise SystemExit(f"未找到小节：{keyword}")


# --------------------------------------------------------------------------
# 题目区解析
# --------------------------------------------------------------------------
Q_RE = re.compile(r'<p class="q">(.*?)</p>', re.S)
OPT_RE = re.compile(r'<p class="opt">(.*?)</p>', re.S)
BLANK_RE = re.compile(r"[_＿]{2,}")


def normalize_stem(s: str) -> str:
    """还原题干中的作答占位符（提取时全角空格被折叠）。"""
    s = re.sub(r"[（(]\s*[）)]", "（　　）", s)
    return s.strip()


def parse_question_block(block: str) -> list[dict]:
    """把一个小节切成 [{num, stem, options[]}]。"""
    out: list[dict] = []
    # 用 finditer 拿到每个 <p class="q"> 的位置，其后到下一个 q 之间的 <p class="opt"> 属于该题
    anchors = list(Q_RE.finditer(block))
    for idx, m in enumerate(anchors):
        end = anchors[idx + 1].start() if idx + 1 < len(anchors) else len(block)
        body = block[m.end():end]
        raw_stem = strip_tags(m.group(1))
        num_m = re.match(r"^(\d+)\s*[．.、]\s*", raw_stem)
        if not num_m:
            raise SystemExit(f"题干缺题号：{raw_stem[:40]}")
        num = int(num_m.group(1))
        stem = normalize_stem(raw_stem[num_m.end():])

        options: list[str] = []
        for om in OPT_RE.finditer(body):
            options.append(strip_tags(om.group(1)))

        out.append({"num": num, "stem": stem, "raw_options": options})
    return out


def split_options(raw_chunks: list[str]) -> list[str]:
    """把可能折行/同行多选项的原始片段切成干净选项数组。"""
    merged = " ".join(raw_chunks)
    merged = re.sub(r"[ ]{2,}", " ", merged)
    # 在 "A．" / "B." / "C、" 等标记处切分
    marks = list(re.finditer(r"([A-E])\s*[．.、]", merged))
    if not marks:
        raise SystemExit(f"选项无法切分：{merged[:60]}")
    opts: list[str] = []
    for i, mk in enumerate(marks):
        start = mk.end()
        stop = marks[i + 1].start() if i + 1 < len(marks) else len(merged)
        text = merged[start:stop].strip().strip("、．. ").strip()
        opts.append(text)
    return opts


# --------------------------------------------------------------------------
# 答案区解析
# --------------------------------------------------------------------------
ROW_RE = re.compile(r"<tr>(.*?)</tr>", re.S)
TD_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.S)


def parse_answer_table(block: str) -> dict[int, list[str]]:
    """解析答案表格 → {题号: [单元格文本, ...]}（不含解析列的原始文本）。"""
    out: dict[int, list[str]] = {}
    for row in ROW_RE.finditer(block):
        cells = [strip_tags(c) for c in TD_RE.findall(row.group(1))]
        if len(cells) < 2:
            continue
        head = cells[0]
        if not head.isdigit():
            continue          # 跳过表头 <th>
        out[int(head)] = cells
    return out


def parse_short_answers(block: str) -> dict[int, str]:
    """解析简答题参考答案区：<p class="q"><strong>N．题干</strong></p> + 后续 <p>。"""
    anchors = list(Q_RE.finditer(block))
    out: dict[int, str] = {}
    for idx, m in enumerate(anchors):
        title = strip_tags(m.group(1))
        num_m = re.match(r"^(\d+)\s*[．.、]\s*", title)
        if not num_m:
            continue
        num = int(num_m.group(1))
        end = anchors[idx + 1].start() if idx + 1 < len(anchors) else len(block)
        body = block[m.end():end]
        paras = [strip_tags(p) for p in re.findall(r"<p[^>]*>(.*?)</p>", body, re.S)]
        text = "\n".join(p for p in paras if p)
        out[num] = text
    return out


def clean_short_answer(text: str) -> str:
    """整理简答要点：源文档中每个 <br> 段即一个完整要点，逐段成行。"""
    lines: list[str] = []
    for raw_line in text.split("\n"):
        line = re.sub(r"[ \t\u3000]+", " ", raw_line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


# --------------------------------------------------------------------------
# 领域打标
# --------------------------------------------------------------------------
def guess_domain(qid: str, stem: str, analysis: str) -> tuple[str, str]:
    """返回 (domain, 命中说明)。规则命中取首个；无命中兜底 general。"""
    if qid in DOMAIN_OVERRIDES:
        return DOMAIN_OVERRIDES[qid], f"人工覆盖"
    haystack = stem + " " + (analysis or "")
    hits: list[tuple[str, str]] = []
    for domain, words in DOMAIN_RULES:
        for w in words:
            if w in haystack:
                hits.append((domain, w))
                break
    if not hits:
        return "general", "无规则命中→兜底综合"
    first = hits[0]
    note = first[1] + (f" ⚠冲突:{','.join(d for d, _ in hits[1:])}" if len(hits) > 1 else "")
    return first[0], note


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def build() -> tuple[dict, list[str]]:
    raw = SRC.read_text(encoding="utf-8")

    q_block = section_text(raw, "第四部分", "第五部分")
    a_block = section_text(raw, "第五部分", None)

    q_sec = split_by_h3(q_block)
    a_sec = split_by_h3(a_block)

    singles = parse_question_block(h3_matching(q_sec, "单项选择题"))
    multiples = parse_question_block(h3_matching(q_sec, "多项选择题"))
    fills = parse_question_block(h3_matching(q_sec, "填空题"))
    judges = parse_question_block(h3_matching(q_sec, "判断题"))
    shorts = parse_question_block(h3_matching(q_sec, "简答题"))

    a_single = parse_answer_table(h3_matching(a_sec, "单项选择题答案"))
    a_multi = parse_answer_table(h3_matching(a_sec, "多项选择题答案"))
    a_fill = parse_answer_table(h3_matching(a_sec, "填空题答案"))
    a_judge = parse_answer_table(h3_matching(a_sec, "判断题答案"))
    a_short = parse_short_answers(h3_matching(a_sec, "简答题参考答案"))

    warnings: list[str] = []
    questions: list[dict] = []
    report: list[str] = []

    # ---- 单选题 ----
    for q in singles:
        qid = f"S{q['num']:02d}"
        row = a_single.get(q["num"])
        if not row or len(row) < 3:
            raise SystemExit(f"{qid} 答案缺失")
        ans = row[1].strip().upper()
        analysis = row[2].strip()
        domain, note = guess_domain(qid, q["stem"], analysis)
        questions.append({
            "id": qid, "type": "single", "domain": domain,
            "stem": q["stem"],
            "options": split_options(q["raw_options"]),
            "answer": ans,
            "analysis": analysis or None,
        })
        report.append(f"| {qid} | 单选 | {DOMAIN_LABELS[domain]} | {note} | {q['stem'][:38]} |")

    # ---- 多选题 ----
    for q in multiples:
        qid = f"M{q['num']:02d}"
        row = a_multi.get(q["num"])
        if not row or len(row) < 3:
            raise SystemExit(f"{qid} 答案缺失")
        letters = re.findall(r"[A-E]", row[1])
        analysis = row[2].strip()
        domain, note = guess_domain(qid, q["stem"], analysis)
        questions.append({
            "id": qid, "type": "multiple", "domain": domain,
            "stem": q["stem"],
            "options": split_options(q["raw_options"]),
            "answer": sorted(set(letters)),
            "analysis": analysis or None,
        })
        report.append(f"| {qid} | 多选 | {DOMAIN_LABELS[domain]} | {note} | {q['stem'][:38]} |")

    # ---- 填空题 ----
    for q in fills:
        qid = f"F{q['num']:02d}"
        row = a_fill.get(q["num"])
        if not row or len(row) < 2:
            raise SystemExit(f"{qid} 答案缺失")
        blanks = len(BLANK_RE.findall(q["stem"]))
        parts = [p.strip() for p in re.split(r"[；;]", row[1]) if p.strip()]
        if blanks != len(parts):
            warnings.append(f"{qid}: 题干空数={blanks} 但答案段数={len(parts)} → {parts}")
        answers = []
        for bi in range(max(blanks, len(parts))):
            display = parts[bi] if bi < len(parts) else ""
            display = FILL_DISPLAY_FIX.get((qid, bi), display)
            accept = list(FILL_ALIASES.get(qid, [[]] * (bi + 1))[bi]) if qid in FILL_ALIASES and bi < len(FILL_ALIASES[qid]) else []
            if not accept:
                accept = [display]
            # 去重保序
            seen, uniq = set(), []
            for a in accept:
                if a and a not in seen:
                    seen.add(a)
                    uniq.append(a)
            answers.append({"accept": uniq, "display": display})
        domain, note = guess_domain(qid, q["stem"], "")
        questions.append({
            "id": qid, "type": "fill", "domain": domain,
            "stem": q["stem"],
            "options": None,
            "answer": answers,
            "blanks": blanks,
            "analysis": None,
        })
        report.append(f"| {qid} | 填空 | {DOMAIN_LABELS[domain]} | {note} | {q['stem'][:38]} |")

    # ---- 判断题 ----
    for q in judges:
        qid = f"J{q['num']:02d}"
        row = a_judge.get(q["num"])
        if not row or len(row) < 3:
            raise SystemExit(f"{qid} 答案缺失")
        mark = row[1].strip()
        analysis = row[2].strip()
        stem = re.sub(r"[（(]\s*[）)]\s*$", "", q["stem"]).strip()
        domain, note = guess_domain(qid, stem, analysis)
        questions.append({
            "id": qid, "type": "judge", "domain": domain,
            "stem": stem,
            "options": None,
            "answer": mark in ("√", "✓", "对", "正确"),
            "analysis": analysis or None,
        })
        report.append(f"| {qid} | 判断 | {DOMAIN_LABELS[domain]} | {note} | {stem[:38]} |")

    # ---- 简答题 ----
    for q in shorts:
        qid = f"SA{q['num']:02d}"
        text = a_short.get(q["num"])
        if not text:
            raise SystemExit(f"{qid} 参考答案缺失")
        domain, note = guess_domain(qid, q["stem"], "")
        questions.append({
            "id": qid, "type": "short", "domain": domain,
            "stem": q["stem"],
            "options": None,
            "answer": clean_short_answer(text),
            "analysis": None,
        })
        report.append(f"| {qid} | 简答 | {DOMAIN_LABELS[domain]} | {note} | {q['stem'][:38]} |")

    counts = Counter(q["type"] for q in questions)
    data = {
        "meta": {
            "title": "《3-6岁儿童学习与发展指南》考点精编与刷题手册 · 题库",
            "source": "教育部 2012年9月颁布《3-6岁儿童学习与发展指南》",
            "version": 1,
            "generatedAt": "2026-10-01",
            "counts": {
                "total": len(questions),
                "single": counts["single"],
                "multiple": counts["multiple"],
                "fill": counts["fill"],
                "judge": counts["judge"],
                "short": counts["short"],
            },
            "domains": list(DOMAIN_LABELS.keys()),
            "domainLabels": DOMAIN_LABELS,
            "types": ["single", "multiple", "fill", "judge", "short"],
        },
        "questions": questions,
    }
    return data, report, warnings


def write_report(report: list[str], warnings: list[str], data: dict) -> None:
    c = data["meta"]["counts"]
    lines = [
        "# 题库复核报告",
        "",
        f"生成时间：{data['meta']['generatedAt']}　|　题量：{c['total']}",
        f"（单选 {c['single']} / 多选 {c['multiple']} / 填空 {c['fill']} / 判断 {c['judge']} / 简答 {c['short']}）",
        "",
        "## 领域打标结果（人工复核用）",
        "",
        "| ID | 题型 | 领域 | 命中规则 | 题干摘要 |",
        "|---|---|---|---|---|",
        *report,
        "",
        "## 自动告警",
        "",
    ]
    lines += [f"- ⚠ {w}" for w in warnings] or ["- 无"]
    lines += [
        "",
        "## 如何修正领域标签",
        "",
        "在 `scripts/extract_questions.py` 的 `DOMAIN_OVERRIDES` 常量中加 `\"题号\": \"领域key\"`，再重跑脚本即可。",
        "",
    ]
    OUT_REPORT.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只校验已生成的 JSON，不重新提取")
    args = ap.parse_args()

    if args.check:
        from validate_questions import validate  # type: ignore
        sys.exit(0 if validate(OUT_JSON) else 1)

    data, report, warnings = build()
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    write_report(report, warnings, data)

    c = data["meta"]["counts"]
    print(f"✓ 已生成 {OUT_JSON.relative_to(ROOT)}")
    print(f"  题量：{c['total']}（单选{c['single']} 多选{c['multiple']} 填空{c['fill']} 判断{c['judge']} 简答{c['short']}）")
    print(f"✓ 已生成 {OUT_REPORT.relative_to(ROOT)}")
    if warnings:
        print(f"⚠ {len(warnings)} 条告警：")
        for w in warnings:
            print("   -", w)
    else:
        print("  无告警")


if __name__ == "__main__":
    main()
