#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一次性重建脚本：题库 v1(70题/5题型) -> v2(68题/3题型)。

变更内容（已批准的方案）：
- 删除：SA01-SA08（简答）、S02、S05、S06、J04、F01-F16（原填空）
- 改写：F01-F16 -> S25-S40（A/B/C 三选一单选）
- 修复：M01（加干扰项）、M08（解析笔误）、S16（domain -> science）
- 新增：S41-S47（四选一单选）、J13-J15（判断）
- meta：version=2, counts={total:68,single:44,multiple:10,judge:14}, types 删 fill/short
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "questions.json"

REMOVE_IDS = {f"SA{i:02d}" for i in range(1, 9)} | {"S02", "S05", "S06", "J04"} | {f"F{i:02d}" for i in range(1, 17)}

# ---------- 改写题（原填空 F01-F16 -> S25-S40，三选一）----------
CONVERTED = [
    dict(id="S25", domain="general",
         stem="《指南》以促进幼儿体、智、德、美各方面的（　　）发展为核心。",
         options=["全面", "均衡", "协调"], answer="C",
         analysis="说明第二条原文：“以促进幼儿体、智、德、美各方面的协调发展为核心”。"),
    dict(id="S26", domain="general",
         stem="幼儿的学习是以（　　）为基础，在游戏和日常生活中进行的。",
         options=["直接经验", "间接经验", "书本知识"], answer="A",
         analysis="说明第四条：“幼儿的学习是以直接经验为基础，在游戏和日常生活中进行的”。"),
    dict(id="S27", domain="general",
         stem="要珍视游戏和生活的独特价值，严禁“（　　）”式的超前教育和强化训练。",
         options=["填鸭灌输", "超前强化", "拔苗助长"], answer="C",
         analysis="说明原文：“严禁‘拔苗助长’式的超前教育和强化训练”。"),
    dict(id="S28", domain="general",
         stem="要充分理解和尊重幼儿发展进程中的个别差异，切忌用一把“（　　）”衡量所有幼儿。",
         options=["标尺", "模子", "尺子"], answer="C",
         analysis="说明原文：“切忌用一把‘尺子’衡量所有幼儿”。"),
    dict(id="S29", domain="health",
         stem="健康领域分为身心状况、动作发展、（　　）三个方面。",
         options=["安全知识与自我保护", "生活习惯与生活能力", "情绪与动作发展"], answer="B",
         analysis="健康领域三方面为“身心状况、动作发展、生活习惯与生活能力”；“安全知识与自我保护”是第三方面下的目标3，不是方面。"),
    dict(id="S30", domain="health",
         stem="健康领域“身心状况”方面的三个目标是：具有健康的体态、（　　）、具有一定的适应能力。",
         options=["情绪安定愉快", "性格开朗活泼", "情感丰富细腻"], answer="A",
         analysis="“身心状况”目标2原文为“情绪安定愉快”。"),
    dict(id="S31", domain="health",
         stem="健康领域“动作发展”方面的三个目标是：具有一定的平衡能力，动作协调、灵敏；具有一定的（　　）；手的动作灵活协调。",
         options=["速度和力量", "力量和耐力", "柔韧和灵敏"], answer="B",
         analysis="“动作发展”目标2原文为“具有一定的力量和耐力”。"),
    dict(id="S32", domain="health",
         stem="健康领域“生活习惯与生活能力”方面的三个目标是：具有良好的生活与卫生习惯、具有基本的生活自理能力、具备基本的（　　）和自我保护能力。",
         options=["生活常识", "安全知识", "科学常识"], answer="B",
         analysis="目标3原文为“具备基本的安全知识和自我保护能力”。"),
    dict(id="S33", domain="language",
         stem="语言领域分为倾听与表达、（　　）两个方面。",
         options=["识字与写字", "阅读与理解", "阅读与书写准备"], answer="C",
         analysis="语言领域两方面为“倾听与表达、阅读与书写准备”；幼儿阶段不强调识字写字。"),
    dict(id="S34", domain="society",
         stem="社会领域分为（　　）、社会适应两个方面。",
         options=["人际交往", "社会交往", "群体交往"], answer="A",
         analysis="“人际交往和社会适应是幼儿社会学习的主要内容”。"),
    dict(id="S35", domain="science",
         stem="科学领域分为科学探究、（　　）两个方面。",
         options=["数学学习", "数理逻辑", "数学认知"], answer="C",
         analysis="科学领域两方面为“科学探究、数学认知”。"),
    dict(id="S36", domain="art",
         stem="艺术领域分为感受与欣赏、（　　）两个方面。",
         options=["表现与创造", "表现与表达", "创作与表现"], answer="A",
         analysis="艺术领域两方面为“感受与欣赏、表现与创造”。"),
    dict(id="S37", domain="health",
         stem="幼儿每天的户外活动时间一般不少于（　　），其中体育活动时间不少于1小时。",
         options=["1小时", "两小时", "3小时"], answer="B",
         analysis="教育建议原文：“幼儿每天的户外活动时间一般不少于两小时，其中体育活动时间不少于1小时”。"),
    dict(id="S38", domain="health",
         stem="应保证幼儿每天睡眠（　　），其中午睡一般应达到2小时左右。",
         options=["9～10小时", "10～11小时", "11～12小时"], answer="C",
         analysis="教育建议原文：“保证幼儿每天睡11～12小时，其中午睡一般应达到2小时左右”。"),
    dict(id="S39", domain="health",
         stem="5～6岁幼儿能连续行走（　　）以上（途中可适当停歇）。",
         options=["1.5公里", "1公里", "2.5公里"], answer="A",
         analysis="“动作发展”目标2：5～6岁“能连续行走1.5公里以上（途中可适当停歇）”。"),
    dict(id="S40", domain="health",
         stem="幼儿在公共场所走失时，能向警察或有关人员说出自己和家长的（　　）等简单信息。",
         options=["名字和电话号码", "姓名和家庭住址", "年龄和家庭住址"], answer="A",
         analysis="目标3：3～4岁“能向警察或有关人员说出自己和家长的名字、电话号码等简单信息”。“家庭住址”出自教育建议而非目标条文，故为干扰项。"),
]

# ---------- 新编题（S41-S47 四选一；J13-J15 判断）----------
NEW_SINGLES = [
    dict(id="S41", domain="language",
         stem="4～5岁幼儿在“愿意讲话并能清楚地表达”方面的发展期望是（　　）。",
         options=["能基本完整地讲述自己的所见所闻和经历的事情",
                  "能有序、连贯、清楚地讲述一件事情",
                  "能口齿清楚地说儿歌、童谣或复述简短的故事",
                  "讲述时能使用常见的形容词、同义词等，语言比较生动"],
         answer="A",
         analysis="语言·倾听与表达·目标2：A 为 4～5 岁期望；B、D 为 5～6 岁期望，C 为 3～4 岁期望。"),
    dict(id="S42", domain="language",
         stem="3～4岁幼儿“具有初步的阅读理解能力”的表现是（　　）。",
         options=["会看画面，能根据画面说出图中有什么，发生了什么事等",
                  "能大体讲出所听故事的主要内容",
                  "能根据故事的部分情节猜想故事情节的发展",
                  "对看过的图书、听过的故事能说出自己的看法"],
         answer="A",
         analysis="语言·阅读与书写准备·目标2：A 为 3～4 岁期望；B 为 4～5 岁，C、D 为 5～6 岁。"),
    dict(id="S43", domain="art",
         stem="4～5岁幼儿在“喜欢自然界与生活中美的事物”方面的表现是（　　）。",
         options=["喜欢观看花草树木、日月星空等大自然中美的事物",
                  "在欣赏自然界和生活环境中美的事物时，关注其色彩、形态等特征",
                  "乐于收集美的物品或向别人介绍所发现的美的事物",
                  "乐于模仿自然界和生活环境中有特点的声音，并产生相应的联想"],
         answer="B",
         analysis="艺术·感受与欣赏·目标1：B 为 4～5 岁期望；A 为 3～4 岁，C、D 为 5～6 岁。"),
    dict(id="S44", domain="society",
         stem="4～5岁幼儿“具有初步的归属感”的表现是（　　）。",
         options=["知道和自己一起生活的家庭成员及与自己的关系",
                  "喜欢自己所在的幼儿园和班级，积极参加集体活动",
                  "愿意为集体做事，为集体的成绩感到高兴",
                  "知道自己的民族，知道中国是一个多民族的大家庭"],
         answer="B",
         analysis="社会·社会适应·目标3：B 为 4～5 岁期望；A 为 3～4 岁，C、D 为 5～6 岁。"),
    dict(id="S45", domain="society",
         stem="5～6岁幼儿“具有自尊、自信、自主的表现”包括（　　）。",
         options=["能根据自己的兴趣选择游戏或其它活动",
                  "自己的事情尽量自己做，不愿意依赖别人",
                  "主动承担任务，遇到困难能够坚持而不轻易求助",
                  "喜欢承担一些小任务"],
         answer="C",
         analysis="社会·人际交往·目标3：C 为 5～6 岁期望；A、D 为 3～4 岁，B 为 4～5 岁。"),
    dict(id="S46", domain="science",
         stem="4～5岁幼儿“具有初步的探究能力”的表现是（　　）。",
         options=["对感兴趣的事物能仔细观察，发现其明显特征",
                  "能根据观察结果提出问题，并大胆猜测答案",
                  "能用一定的方法验证自己的猜测",
                  "在成人的帮助下能制定简单的调查计划并执行"],
         answer="B",
         analysis="科学·科学探究·目标2：B 为 4～5 岁期望；A 为 3～4 岁，C、D 为 5～6 岁。"),
    dict(id="S47", domain="science",
         stem="5～6岁幼儿“感知形状与空间关系”的发展期望是（　　）。",
         options=["能感知物体基本的空间位置与方位，理解上下、前后、里外等方位词",
                  "能使用上下、前后、里外、中间、旁边等方位词描述物体的位置和运动方向",
                  "能辨别自己的左右",
                  "能感知和发现常见几何图形的基本特征，并能进行分类"],
         answer="C",
         analysis="科学·数学认知·目标3：C 为 5～6 岁期望；A 为 3～4 岁，B、D 为 4～5 岁。"),
]

NEW_JUDGES = [
    dict(id="J13", domain="language",
         stem="5～6岁幼儿懂得按次序轮流讲话，不随意打断别人。",
         answer=True,
         analysis="语言·倾听与表达·目标3：5～6岁“懂得按次序轮流讲话，不随意打断别人”。"),
    dict(id="J14", domain="art",
         stem="3～4岁幼儿欣赏艺术作品时会产生相应的联想和情绪反应。",
         answer=False,
         analysis="“欣赏艺术作品时会产生相应的联想和情绪反应”是 4～5 岁期望；3～4 岁为“喜欢听音乐或观看舞蹈、戏剧等表演”“乐于观看绘画、泥塑或其它艺术形式的作品”。"),
    dict(id="J15", domain="society",
         stem="4～5岁幼儿知道说谎是不对的，知道接受了的任务要努力完成。",
         answer=True,
         analysis="社会·社会适应·目标2：4～5岁“知道说谎是不对的”“知道接受了的任务要努力完成”。"),
]

# ---------- 既有题修复 ----------
M01_PATCH = dict(
    stem="《指南》描述的幼儿学习与发展领域包括（　　）。",
    options=["健康", "数学", "语言", "科学", "艺术"],
    answer=["A", "C", "D", "E"],
    analysis="五大领域为健康、语言、社会、科学、艺术。“数学”只是科学领域下“数学认知”方面，不构成领域，为干扰项。",
)
M08_ANALYSIS = "“人际交往”方面共4个目标：愿意与人交往／能与同伴友好相处／具有自尊、自信、自主的表现／关心尊重他人，故全选。"

TYPE_ORDER = {"single": 0, "multiple": 1, "judge": 2}


def sort_key(q):
    return (TYPE_ORDER[q["type"]], int(q["id"][1:]))


def main():
    data = json.loads(SRC.read_text(encoding="utf-8"))
    kept = []
    for q in data["questions"]:
        if q["id"] in REMOVE_IDS:
            continue
        if q["id"] == "M01":
            q.update(M01_PATCH)
        elif q["id"] == "M08":
            q["analysis"] = M08_ANALYSIS
        elif q["id"] == "S16":
            q["domain"] = "science"
        kept.append(q)

    for c in CONVERTED + NEW_SINGLES:
        kept.append(dict(id=c["id"], type="single", domain=c["domain"], stem=c["stem"],
                         options=c["options"], answer=c["answer"], analysis=c["analysis"]))
    for j in NEW_JUDGES:
        kept.append(dict(id=j["id"], type="judge", domain=j["domain"], stem=j["stem"],
                         options=None, answer=j["answer"], analysis=j["analysis"]))

    kept.sort(key=sort_key)

    # 自检
    ids = [q["id"] for q in kept]
    assert len(ids) == len(set(ids)) == 68, f"题量或 id 重复异常: {len(ids)}"
    counts = {"single": 0, "multiple": 0, "judge": 0}
    for q in kept:
        counts[q["type"]] += 1
    assert counts == {"single": 44, "multiple": 10, "judge": 14}, counts

    out = {
        "meta": {
            "title": "《3-6岁儿童学习与发展指南》考点精编与刷题手册 · 题库",
            "source": "教育部 2012年9月颁布《3-6岁儿童学习与发展指南》",
            "version": 2,
            "generatedAt": "2026-10-04",
            "counts": {"total": 68, **counts},
            "domains": ["health", "language", "society", "science", "art", "general"],
            "domainLabels": {"health": "健康", "language": "语言", "society": "社会",
                             "science": "科学", "art": "艺术", "general": "综合"},
            "types": ["single", "multiple", "judge"],
        },
        "questions": kept,
    }
    SRC.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"OK: 重建完成 {len(kept)} 题 {counts}")


if __name__ == "__main__":
    main()
