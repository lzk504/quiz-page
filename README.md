# 《3-6岁儿童学习与发展指南》刷题手册

纯静态答题网页应用。题库来自《3-6 岁儿童学习与发展指南 · 考点精编与刷题手册》，
题目与解析存放在独立的 JSON 文件中，全部在前端加载与判分，**无需后端服务**，
可直接部署到 Cloudflare Pages 等静态托管平台。

## 功能

- **68 题完整题库**：单选 44 / 多选 10 / 判断 14，全部对照指南原文编写与校订
- **三种题型即时判分**：单选（含 3 选项与 4 选项）、多选（全对才算对）、判断
- **清晰作答反馈**：选项选中态高亮，判定后逐条揭示对错并展示解析
- **双维度筛选**：领域（健康 / 语言 / 社会 / 科学 / 艺术 / 综合）× 题型，可任意组合
- **正确率统计**：整体、分领域、分题型三组口径，另有总进度
- **错题本**：答错自动收录并记录错误次数，错题重刷答对一次即自动移出，也支持手动移除
- **本地持久化**：答题记录保存在浏览器本机，设置页可导出 / 导入 JSON 备份（兼容 v1 旧备份，自动迁移）
- **响应式**：移动优先（含 ≤380px 小屏优化、触控目标 ≥40px、无横向滚动），桌面端内容列限宽 720px 居中

## 目录结构

```
index.html                     入口页面
css/style.css                  全部样式
js/
  main.js                      启动：加载题库 → 注入 id 集 → 初始化存储 → 注册视图 → 启路由
  router.js                    hash 路由
  state.js                     题库加载与内存状态 + 发布订阅
  storage.js                   localStorage 读写、降级、导入导出（v2 schema）
  migrate.js                   localStorage v1→v2 迁移（F→S id 映射、剔除已删题记录）
  scoring.js                   判分核心（单选 / 多选 / 判断）
  stats.js                     统计口径计算
  ui.js                        复用展示片段与 toast
  utils.js                     通用工具
  views/
    home.js                    首页：进度总览 + 筛选 + 入口
    practice.js                刷题页：三种题型渲染与交互
    wrongbook.js               错题本
    stats.js                   统计页
    settings.js                设置页
data/questions.json            题库（唯一数据文件）
scripts/
  extract_questions.py         从手册 HTML 提取题库 v1（一次性，不部署）
  rebuild_questions_v2.py      题库 v1→v2 重建（删简答/填空改单选/修错/补题）
  validate_questions.py        题库结构与完整性校验
  review_report.md             领域打标复核报告（由提取脚本生成）
  e2e-check.js                 端到端浏览器测试（Puppeteer）
3-6岁儿童学习与发展指南_考点精编与刷题手册.html    题库源文件
3-6岁儿童学习与发展指南_考点精编与刷题手册.docx   题库源文件
MinerU_markdown_3-6岁儿童学习与发展指南_*.md     指南原文（题目校订依据）
```

## 本地预览

因为使用 ES modules + `fetch`，**不能直接双击打开 `index.html`**（`file://` 会被浏览器拦截），
需要跑一个静态服务器：

```bash
cd quiz-page
python -m http.server 8000
# 然后浏览器访问 http://localhost:8000
```

或者用 Node：

```bash
npx serve .
```

## 部署到 Cloudflare Pages

1. 把整个目录推到 GitHub 仓库
2. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git
3. 构建设置留空：
   - **Build command**：（留空）
   - **Build output directory**：`/`
   - **Framework preset**：`None`
4. 保存并部署

不需要任何环境变量。`data/questions.json` 会作为静态资源随站点发布，
注意确认服务器返回的 MIME 类型是 `application/json`。

其他静态托管平台（Netlify、Vercel、GitHub Pages、对象存储 + CDN）同理。

## 维护题库

题库文件是 `data/questions.json`，顶层为 `meta` + `questions` 数组。

### 字段说明

| 字段 | 类型 | 适用题型 | 说明 |
|---|---|---|---|
| `id` | string | 全部 | 全局唯一。`S`=单选 / `M`=多选 / `J`=判断 + 两位序号（v2 起允许缺口：S02/S05/S06、J04 已删除） |
| `type` | string | 全部 | `single` / `multiple` / `judge` |
| `domain` | string | 全部 | `health` / `language` / `society` / `science` / `art` / `general` |
| `stem` | string | 全部 | 题干，保留 `（　　）` 占位 |
| `options` | string[] | 选择 | 选项文本（不含 `A.` 前缀）。单选 3~4 项、多选 4~5 项；判断题为 `null` |
| `answer` | 见下 | 全部 | 按题型结构不同 |
| `analysis` | string | 全部 | 解析，引用指南原文 |

`answer` 结构：

```jsonc
// single
"B"

// multiple —— 全对才算对
["A", "B", "C"]

// judge
false
```

### 新增题目

直接编辑 `data/questions.json`，追加到 `questions` 数组即可，同时更新 `meta.counts`。
答题记录以 `id` 为键，新增题目不会影响已有记录。**不要复用已删除的 id**
（S02/S05/S06、J04、F01-F16、SA01-SA08），避免与老用户的历史记录错位。

### 校验与测试

```bash
python scripts/validate_questions.py    # 题库结构硬断言（失败返回非零退出码）

python -m http.server 8123 &            # 端到端测试需要本地服务
node scripts/e2e-check.js               # Puppeteer + 本机 Chrome
```

e2e 覆盖 56 项断言：题库结构、三种题型判分、选中态反馈、错题本自动移出与手动移除、
统计口径、导入导出回滚、刷新持久化、360px 窄屏无横向溢出、桌面端限宽、深链接筛选、
v1→v2 数据迁移（自动迁移 / 旧备份导入兼容 / 幂等）。截图输出到 `scripts/_shots/`。

## 数据说明

答题记录与错题本保存在浏览器 `localStorage` 的 `quizapp.data.v1` 键下（v2 schema）。
v1 旧数据在首次打开时自动迁移：填空题记录按 F→S id 映射保留统计，
已删除题目的记录与背诵自评数据会被清理。
清除浏览器数据会丢失，建议定期在设置页导出备份。
浏览器禁用 localStorage 时（如隐私模式），应用会自动降级为纯内存模式并在顶部提示。

## 更新日志

- v2（2026-10-04）：题库重构——填空题全部改写为 A/B/C 单选（S25-S40），移除简答题，
  删除重复考点（S02/S05/S06/J04），修复 M01/M08/S16，按指南原文新编 10 题（S41-S47/J13-J15），
  共 68 题；UI 蓝色系现代化精修 + 小屏适配强化；本地数据 v1→v2 自动迁移。
- v1（2026-10-01）：首版。70 题题库、四种客观题判分、简答背诵自评、双维度筛选、
  错题本、统计、导入导出、响应式布局。
