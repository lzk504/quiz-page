# 《3-6岁儿童学习与发展指南》刷题手册

纯静态答题网页应用。题库来自《3-6 岁儿童学习与发展指南 · 考点精编与刷题手册》，
题目与解析存放在独立的 JSON 文件中，全部在前端加载与判分，**无需后端服务**，
可直接部署到 Cloudflare Pages 等静态托管平台。

## 功能

- **70 题完整题库**：单选 24 / 多选 10 / 填空 16 / 判断 12 / 简答 8
- **四种客观题即时判分**：单选、多选（全对才算对）、判断、填空（宽松匹配 + 别名容错）
- **简答题背诵自评**：显示题目 → 展开要点答案 → 自评「已记住 / 没记住」，单独统计背诵进度，不计入正确率
- **双维度筛选**：领域（健康 / 语言 / 社会 / 科学 / 艺术 / 综合）× 题型，可任意组合
- **正确率统计**：整体、分领域、分题型三组口径，另有总进度与背诵进度
- **错题本**：答错自动收录并记录错误次数，错题重刷答对一次即自动移出，也支持手动移除
- **本地持久化**：答题记录保存在浏览器本机，设置页可导出 / 导入 JSON 备份
- **响应式**：移动优先，桌面端内容列限宽 720px 居中，底部导航跨端一致

## 目录结构

```
index.html                     入口页面
css/style.css                  全部样式
js/
  main.js                      启动：初始化存储 → 加载题库 → 注册视图 → 启路由
  router.js                    hash 路由
  state.js                     题库加载与内存状态 + 发布订阅
  storage.js                   localStorage 读写、降级、导入导出
  scoring.js                   判分核心（归一化 / 单选 / 多选 / 填空 / 判断）
  stats.js                     统计口径计算
  ui.js                        复用展示片段与 toast
  utils.js                     通用工具
  views/
    home.js                    首页：进度总览 + 筛选 + 入口
    practice.js                刷题页：五种题型渲染与交互
    wrongbook.js               错题本
    stats.js                   统计页
    settings.js                设置页
data/questions.json            题库（唯一数据文件）
scripts/
  extract_questions.py         从手册 HTML 提取题库（一次性，不部署）
  validate_questions.py        题库结构与完整性校验
  review_report.md             领域打标复核报告（由提取脚本生成）
  e2e-check.js                 端到端浏览器测试（Puppeteer）
3-6岁儿童学习与发展指南_考点精编与刷题手册.html    题库源文件
3-6岁儿童学习与发展指南_考点精编与刷题手册.docx   题库源文件
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
| `id` | string | 全部 | 全局唯一，`S01`~`S24` / `M01`~`M10` / `F01`~`F16` / `J01`~`J12` / `SA01`~`SA08` |
| `type` | string | 全部 | `single` / `multiple` / `fill` / `judge` / `short` |
| `domain` | string | 全部 | `health` / `language` / `society` / `science` / `art` / `general` |
| `stem` | string | 全部 | 题干。选择题保留 `（　　）` 占位；填空题用 `________` 标记空位 |
| `options` | string[] | 选择 | 选项文本（不含 `A.` 前缀）；其他题型为 `null` |
| `answer` | 见下 | 判分题 | 按题型结构不同 |
| `blanks` | number | 填空 | 空的数量，须与题干中 `________` 个数一致 |
| `analysis` | string \| null | 全部 | 解析；填空与简答为 `null` |

`answer` 结构：

```jsonc
// single
"B"

// multiple —— 全对才算对
["A", "B", "C"]

// fill —— 外层数组顺序 = 第几个空
[
  { "accept": ["两小时", "2小时", "两小时以上"], "display": "两小时" },
  { "accept": ["1小时", "一小时"], "display": "1小时" }
]

// judge
false

// short —— 要点式文本，\n 分行
"（1）健康：……；\n（2）语言：……"
```

### 新增题目

直接编辑 `data/questions.json`，追加到 `questions` 数组即可，同时更新 `meta.counts`。
答题记录以 `id` 为键，新增题目不会影响已有记录。

填空答案的 `accept` 是别名数组：大小写、空格、全半角由归一化自动处理，
但**同义不同词**（如「两小时」与「2小时」）必须写进 `accept`。

### 重新提取题库

如果修改了源手册 HTML，可以重跑提取脚本：

```bash
python scripts/extract_questions.py     # 重新生成 questions.json + review_report.md
python scripts/validate_questions.py    # 校验结构完整性（失败返回非零退出码）
```

领域标签是自动打标 + 人工覆盖：先看 `scripts/review_report.md` 的复核表，
需要修正的题目写进 `scripts/extract_questions.py` 的 `DOMAIN_OVERRIDES`，再重跑，保证可复现。

### 端到端测试

需要本机有 Chrome 与 `puppeteer`：

```bash
python -m http.server 8123 &
node scripts/e2e-check.js
```

覆盖 46 项断言：首页筛选、四种题型判分、填空容错、简答自评、错题本自动移出与手动移除、
统计口径、导入导出回滚、刷新持久化、响应式布局、深链接筛选。截图输出到 `scripts/_shots/`。

## 数据说明

答题记录、错题本和背诵进度保存在浏览器 `localStorage` 的 `quizapp.data.v1` 键下。
清除浏览器数据会丢失，建议定期在设置页导出备份。
浏览器禁用 localStorage 时（如隐私模式），应用会自动降级为纯内存模式并在顶部提示。

## 更新日志

- v1（2026-10-01）：首版。70 题题库、四种客观题判分、简答背诵自评、双维度筛选、
  错题本、统计、导入导出、响应式布局。
