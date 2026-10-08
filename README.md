# 《3-6岁儿童学习与发展指南》刷题手册

刷题网页应用。前端纯静态（原生 HTML+CSS+ES modules，无构建工具），后端为
**Cloudflare Workers + KV**（参考 [nodewarden](https://github.com/shuaiplus/nodewarden)
的存储分层模式）：JWT 用户体系，每用户数据隔离存储在 KV，多设备登录自动同步。

题库来自《3-6 岁儿童学习与发展指南 · 考点精编与刷题手册》，题目与解析存放在
独立的 JSON 文件中，全部在前端加载与判分。

## 功能

- **68 题完整题库**：单选 44 / 多选 10 / 判断 14，全部对照指南原文编写与校订
- **三种题型即时判分**：单选（含 3 选项与 4 选项）、多选（全对才算对）、判断
- **清晰作答反馈**：选项选中态高亮，判定后逐条揭示对错并展示解析
- **双维度筛选**：领域（健康 / 语言 / 社会 / 科学 / 艺术 / 综合）× 题型，可任意组合
- **正确率统计**：整体、分领域、分题型三组口径，另有总进度
- **错题本**：答错自动收录并记录错误次数，错题重刷答对一次即自动移出，也支持手动移除
- **用户体系（JWT）**：注册需邀请码，首个注册用户自动成为管理员；管理员可生成/管理邀请码
- **云端同步（KV）**：答题数据按用户隔离存于 Cloudflare KV，多设备登录自动同步；
  写入带乐观锁（409 冲突时按 lastAt 新者胜自动合并），本地旧 v1 数据首次登录自动迁移上云
- **导入导出**：设置页可导出 / 导入 JSON 备份（兼容 v1 旧备份，自动迁移）
- **响应式**：移动优先（含 ≤380px 小屏优化、触控目标 ≥40px、无横向滚动），桌面端内容列限宽 720px 居中

## 目录结构

```
index.html                     入口页面
wrangler.toml                  Cloudflare Workers 部署配置（assets + KV binding）
.assetsignore                  静态资产排除清单（防止 worker 源码/文档被部署）
css/style.css                  全部样式
js/
  main.js                      启动：加载题库 → 鉴权 → 拉云端数据 → 注册视图 → 启路由
  router.js                    hash 路由 + 登录守卫
  state.js                     题库加载与内存状态 + 发布订阅
  auth.js                      JWT token 存取、带鉴权 fetch、注册/登录/登出
  storage.js                   存储层：内存 cache + KV 同步（debounce 推送 + 乐观锁 + flush）
  migrate.js                   v1→v2 数据迁移（F→S id 映射、剔除已删题记录）
  scoring.js                   判分核心（单选 / 多选 / 判断）
  stats.js                     统计口径计算
  ui.js                        复用展示片段与 toast
  utils.js                     通用工具
  views/
    login.js                   登录/注册（双 tab，邀请码输入）
    home.js                    首页：进度总览 + 筛选 + 入口
    practice.js                刷题页：三种题型渲染与交互
    wrongbook.js               错题本
    stats.js                   统计页
    settings.js                设置页（账号 / 数据管理 / 管理员邀请码 / 关于）
worker/                        Cloudflare Worker 后端（纯 JS ES Module，零 npm 依赖）
  index.js                     fetch 入口：/api/* → routes，其余 → 静态资产
  auth.js                      JWT(HS256) 签发/校验、PBKDF2 密码哈希、邀请码生成
  routes.js                    /api 路由：register/login/me/store/invites + 鉴权中间件
data/questions.json            题库（唯一数据文件，静态资产）
scripts/
  dev-server.mjs               本地开发服务器（内存 mock KV + 静态资产 + /api 路由）
  api-test.mjs                 API 冒烟测试（36 断言，直接调 handleApi，无需起服务）
  e2e-check.js                 端到端浏览器测试（Puppeteer，58 断言，需 dev-server）
  extract_questions.py         从手册 HTML 提取题库 v1（一次性，不部署）
  rebuild_questions_v2.py      题库 v1→v2 重建（幂等）
  validate_questions.py        题库结构与完整性校验
  review_report.md             领域打标复核报告（由提取脚本生成）
```

## 本地开发

不需要 Cloudflare 账号，Node 22+ 即可：

```bash
# 1. 配置本地 JWT_SECRET（.dev.vars 已 gitignore）
echo 'JWT_SECRET="local-dev-secret-please-change-to-30-plus-random-chars-xxxxx"' > .dev.vars

# 2. 启动本地服务器（默认 http://127.0.0.1:8123）
npm run dev        # 等价于 node scripts/dev-server.mjs

# 3. 浏览器访问 http://127.0.0.1:8123 —— 首个注册用户自动成为管理员
```

dev-server 使用内存 mock KV（重启即清空），KV 接口与 Cloudflare 一致（get/put/delete/list）。
调试钩子：`POST /__dev/kv-reset` 清空数据，`GET /__dev/kv-dump` 列出全部 key。

也可以用真实的 `wrangler dev`（本地 miniflare KV 模拟，端口 8787），
需先完成下方部署配置中的 KV namespace 创建。

## 部署到 Cloudflare Workers

### 1. 创建 KV namespace

```bash
npx wrangler kv namespace create KV
# 把返回的 id 填入 wrangler.toml 的 [[kv_namespaces]] id
# 本地 wrangler dev 用 preview_id（可选）
```

### 2. 设置 JWT_SECRET（30+ 字符随机串，不要写进 wrangler.toml）

```bash
npx wrangler secret put JWT_SECRET
# 生成随机串：node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# 也可在 Dashboard → Workers → 该 Worker → Settings → Variables and Secrets 添加
```

### 3. 部署

**方式 A：Git 连接（推荐，同 nodewarden 的可视部署）**

1. 推送仓库到 GitHub
2. Cloudflare Dashboard → Workers & Pages → Create → Workers → Connect to Git
3. 构建命令留空（纯 JS ES Module，无构建）；wrangler.toml 定义绑定
4. 部署完成后在 dashboard 设置 JWT_SECRET（Git 路径无法预置 secret）

**方式 B：命令行**

```bash
npx wrangler deploy
```

### 4. 验证 .assetsignore 生效

部署后以下路径应返回 404（源码/文档未被当作静态资产公开）：

```
/worker/index.js  /README.md  /scripts/e2e-check.js  /wrangler.toml
```

注意：`run_worker_first = ["/api/*"]` 需要 Wrangler ≥ 4.20；旧环境改为
`run_worker_first = true`（worker/index.js 已有 `env.ASSETS.fetch` 兜底，功能不变）。

## API

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `POST /api/register` | 无 | `{username, password, inviteCode?}`；首用户免邀请码且 role=admin；返回 `{token, user}` |
| `POST /api/login` | 无 | `{username, password}`；返回 `{token, user}`（JWT，7 天有效） |
| `GET /api/me` | Bearer | 当前用户信息 |
| `GET /api/store` | Bearer | 当前用户刷题数据 `{store, updatedAt}`；无数据时 `store: null` |
| `PUT /api/store` | Bearer | `{store, baseUpdatedAt}`；乐观锁，云端较新时返回 409 + `serverUpdatedAt` |
| `DELETE /api/store` | Bearer | 清空当前用户数据 |
| `POST /api/invites` | Bearer+admin | 生成一次性邀请码（16 字符） |
| `GET /api/invites` | Bearer+admin | 邀请码列表 |

错误格式：`{error: <code>, message: <zh>}`；状态码 400/401/403/409/500。
KV Schema：`users`（用户表）/ `user:<username>:auth`（凭证）/ `invite:<code>`（邀请码）/ `store:<username>`（刷题数据，与前端 v2 schema 同形）。

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

node scripts/api-test.mjs               # API 冒烟测试（无需起服务，36 断言）
npm run dev &                           # 起本地 dev-server（8123）
node scripts/e2e-check.js               # 端到端（58 断言，含注册/邀请码/隔离/迁移）
```

e2e 覆盖 58 项断言：未登录重定向、首用户注册（自动 admin）、题库结构、三种题型判分、
选中态反馈、错题本、统计、设置页账号/邀请码区、刷新持久化（云端拉回）、
360px 窄屏 / 桌面端限宽、深链接筛选、v1→v2 首次上云迁移（F→S 映射 / 剔孤儿 / 清本地源）、
登出登录 round-trip、错误密码提示、数据隔离（A/B 互不可见）、邀请码一次性、
重复用户名 409、无 token 401、token 篡改跳登录。截图输出到 `scripts/_shots/`。

## 数据与安全说明

- 刷题数据按用户隔离存储在 Cloudflare KV（`store:<username>`），与前端 v2 schema 同形；
  多设备登录自动同步，写入带 `baseUpdatedAt` 乐观锁，冲突时按 lastAt 新者胜自动合并
- 密码以 PBKDF2-SHA256（100k 迭代 + 16 字节随机盐）存储，不存明文；
  JWT 用 HS256 签名，secret 由 `JWT_SECRET` 提供（30+ 字符）
- 浏览器仅保存 JWT token（`quizapp.token.v1`）；本地旧版 `quizapp.data.v1` 数据在
  首次登录后自动迁移上云并清源
- 注册/登录建议在 Cloudflare Dashboard 配置 Rate Limiting Rules 防爆破
- KV 为最终一致存储，单用户多设备极端并发写可能短暂覆盖，乐观锁 + 合并将影响降到最低

## 更新日志

- v3（2026-10-08）：存储迁移——localStorage 迁移至 Cloudflare Workers KV（参考 nodewarden
  模式），新增 JWT 用户体系（首用户自动管理员、邀请码注册）、多设备云同步（乐观锁 + 合并）、
  登录守卫与登录/注册视图；Worker 后端零 npm 依赖；本地 dev-server（mock KV）+ API 冒烟 +
  e2e 重构（58 断言）。
- v2（2026-10-04）：题库重构——填空题全部改写为 A/B/C 单选（S25-S40），移除简答题，
  删除重复考点（S02/S05/S06/J04），修复 M01/M08/S16，按指南原文新编 10 题（S41-S47/J13-J15），
  共 68 题；UI 蓝色系现代化精修 + 小屏适配强化；本地数据 v1→v2 自动迁移。
- v1（2026-10-01）：首版。70 题题库、四种客观题判分、简答背诵自评、双维度筛选、
  错题本、统计、导入导出、响应式布局。
