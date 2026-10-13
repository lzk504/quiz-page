# 考点精编

学前教育备考刷题应用。**TypeScript 全栈**：后端 Cloudflare Workers + **D1**，
前端 TypeScript + **Vite** 构建。参考 [nodewarden](https://github.com/shuaiplus/nodewarden)
的分层架构：可插拔存储、路由中间件、JWT 用户体系、D1 schema 首次请求自动初始化。

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | Cloudflare Workers，**TypeScript**（`src/`，wrangler 用 esbuild 编译），零运行时依赖 |
| 存储 | **Cloudflare D1**（唯一后端）；通过 `Store` 接口抽象 |
| 前端 | **TypeScript** + Vite 构建（vanilla DOM，无框架），构建产物到 `./dist` |
| 鉴权 | 自实现 JWT(HS256) + PBKDF2-SHA256 密码哈希（Web Crypto，无第三方库） |
| 同步 | 跨设备进度轮询同步（30s，仅可见标签页）；预留 Durable Object 实时推送升级点 |

## 功能

- **四栏导航：首页 / 题库 / 错题本 / 我的**
- **三库 3000 题**：《3-6岁儿童学习与发展指南》/《幼儿园保育教育质量评估》/《幼儿园教育指导纲要》各 1000 题
  （每库单选 400 / 多选 200 / 判断 200 / 填空 100 / 简答 100），全部对照原文编写与校订
- **五种题型**：客观题即时判分并展示解析；**填空/简答题由用户对照参考答案自行判定**（不做文本自动判分）
- **今日目标**：每日 100 题目标，首页进度条与打卡提示
- **考试模式**：60 分钟 100 题，作答过程零反馈，交卷后统一自评、出分、查看逐题清单与分题型得分
- **我的收藏**：题目卡片可星标收藏，收藏列表隐藏参考答案，支持取消收藏与单题重做
- **题库 tab**：选库、章节（领域）目录、题型说明、刷题范围设置；点击章节或题型直接进入练习
- **错题本**：按题型筛选，展示「我的答案 / 正确答案 / 解析」，显示错因次数角标（≥2 次黄、≥3 次红），
  支持重做本题与批量移出；首页「今日推荐复习」自动列出高频错题
- **个人中心**：累计做题、正确率、错题在册；本周学习小结；齿轮入口进入学习设置页
- **学习设置**：备考日期设置、数据导入/导出、邀请码管理；固定标题「考点精编」
- **题库多选/合并刷题**：可单库也可多库合并出题，每次随机抽题**上限 100 题**；结束页支持
  「再刷一遍」（同一批重新打乱）与「换一批」（重新抽题）
- **双维度筛选**：领域 × 题型任意组合；**正确率/进度统计**（整体、分题库、分领域、分题型）
- **用户体系**：注册需邀请码（一次性），**首个注册用户自动成为管理员**
- **云端同步**：数据按用户隔离存于 D1，多设备登录自动同步（乐观锁 + lastAt 新者胜合并）
- **管理员能力**：生成/管理邀请码；导出全站全量备份（JSON）
- **可选隐藏前端**：`HIDE_WEB_VAULT=1` 时前端 404，仅保留 API
- **响应式**：移动优先（≤380px 优化），桌面端内容列限宽 720px

## 目录结构

```
src/                         后端（TypeScript）
  index.ts                   Worker 入口：HIDE_WEB_VAULT → /api/* → ASSETS 兜底
  types.ts                   Env / Store 接口 / 领域类型
  router.ts                  注册式路由表 + requireAuth/requireAdmin 中间件 + 响应助手
  routes.ts                  11 个 handler + 路由装配
  auth.ts                    PBKDF2 密码哈希 / HS256 JWT / 邀请码
  ratelimit.ts               内存固定窗口限流（register/login 防爆破）
  web-vault-visibility.ts    HIDE_WEB_VAULT 判定与 404 响应
  services/
    storage.ts               Store 接口工厂（env.DB→D1Store）
    storage-schema.ts        D1 DDL + ensureSchema（首次请求幂等建表）
    storage-d1.ts            D1Store（registerUser 事务化）
    rate-limit-daily.ts      KV 每日限额（未登录 9 次/登录 64 次，24h TTL）
webapp/                      前端（TypeScript）
  index.html                 Vite 入口
  vite.config.ts             构建配置（outDir=../dist）
  public/data/banks.json     题库清单（唯一数据入口）
  public/data/bank-*.json    各题库文件（G/P/Y，按需加载，构建时原样进 dist）
    src/
      main.ts / router.ts                 入口与 hash 路由（登录守卫 + 4 tab 壳层）
      state.ts                            题库清单 + 按需加载 + 选中库偏好
      auth.ts / storage.ts / sync.ts       鉴权 / 云端 store 同步（乐观锁+防抖）/ 30s 轮询
      migrate.ts / scoring.ts / stats.ts   数据迁移 v1→v2→v3→v4 / 判分 / 统计口径
      goal.ts / local-prefs.ts            学习节奏计算 / 本机偏好（考试日期等）
      ui.ts / utils.ts / types.ts
      views/{login,home,banks,me,practice,wrongbook,stats,settings,favorites}.ts
dist/                        Vite 构建产物（gitignore；wrangler assets 目录）
wrangler.toml                Worker 配置（D1 + KV 限额计数 + assets）
scripts/
  api-test.ts                API 冒烟测试（tsx 运行，44 断言，MockStore）
  e2e-check.js               端到端测试入口（运行 `_verify-v6.mjs`）
  _verify-v6.mjs             v6 真实浏览器端到端验证（Puppeteer，82 断言，需 wrangler dev）
  *.py                       题库生成/校验脚本（本地工具链，已 gitignore，不入库）
```

## 本地开发

```bash
npm install

# 配置本地 secrets（.dev.vars 已 gitignore）
#   JWT_SECRET="...30+ 字符随机串..."
#   ALLOW_DEV_RESET="1"        # 仅本地：启用 POST /api/dev/reset 清库
echo 'JWT_SECRET="local-dev-secret-please-change-to-30-plus-random-chars-xxxxx"' > .dev.vars
echo 'ALLOW_DEV_RESET="1"' >> .dev.vars

npm run dev            # wrangler dev（本地 D1 模拟），http://127.0.0.1:8787
npm run dev:frontend   # 仅前端 Vite dev server（API 需另起）
```

首个注册用户自动成为管理员，无需邀请码。

## 构建与部署

### 构建

```bash
npm run build          # vite build webapp（产出 ./dist）+ tsc 类型检查（前后端）
```

### 部署（Cloudflare Workers）

Cloudflare 构建配置：

- **构建命令**：`npm run build`
- **部署命令**：`npm run deploy`

`wrangler.toml` 的 D1/KV 段**不写 id**，绑定由 Cloudflare Dashboard 注入——无需先
`wrangler d1 create`，也不在配置里暴露任何 uuid。

部署后在 Dashboard 配置两个绑定（**跨 redeploy 持久**，仓库无需硬编码 id）：

1. **D1 绑定**：Dashboard → 存储和数据库 → D1 → 创建数据库，名称填 **`quiz-page-db`**；
   再到 Workers & Pages → `quiz-page` → 设置 → 绑定 → 添加 → D1 database →
   变量名填 **`DB`** → 选 `quiz-page-db`
2. **KV 绑定**：Dashboard → 存储和数据库 → KV → 创建命名空间，名称填 **`quiz-page-kv`**；
   再到 Workers → 设置 → 绑定 → 添加 → KV 命名空间 → 变量名填 **`RATE_LIMITS`** → 选 `quiz-page-kv`

设置运行时密钥（正式环境必须 30+ 字符随机串，禁止示例值）：

```bash
npx wrangler secret put JWT_SECRET
# 或 Dashboard → 该 Worker → Settings → Variables and Secrets → 添加 Runtime Secret
```

**D1 schema 首次请求自动初始化**，无需手动上传 SQL。

> ⚠️ `JWT_SECRET` 必须配在 **Runtime variables and secrets**，不能配成 Build variable
> （Build 阶段变量运行时读不到，页面会一直提示缺少）。

### 隐藏 Web 前端（可选）

在 Workers 的 Settings → Variables and Secrets 添加文本变量 `HIDE_WEB_VAULT` 并设为 `1`。
启用后非 `/api` 路径统一返回 404，API 保持可用；删除该变量或改为非 `1` 即恢复。

> ⚠️ 开启时必须把 `wrangler.toml` 的 `run_worker_first` 改为 `true`，
> 否则非 `/api` 请求不进入 Worker，拦截不生效。

## API

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/bootstrap` | 无 | `{initialized}` 系统是否已有用户 |
| `POST /api/register` | 无 | 首用户免邀请码且 role=admin；返回 `{token, user}` |
| `POST /api/login` | 无 | 返回 `{token, user}`（JWT，7 天有效） |
| `GET /api/me` | Bearer | 当前用户信息 |
| `GET /api/store` | Bearer | `{store, updatedAt}`；无数据时 `store: null` |
| `PUT /api/store` | Bearer | `{store, baseUpdatedAt}`；乐观锁，云端较新时 409 + `serverUpdatedAt` |
| `DELETE /api/store` | Bearer | 清空当前用户数据 |
| `POST /api/invites` | Bearer+admin | 生成一次性邀请码（16 字符） |
| `GET /api/invites` | Bearer+admin | 邀请码列表 |
| `GET /api/admin/backup` | Bearer+admin | 全站全量备份 JSON（含密码哈希，妥善保管） |
| `POST /api/dev/reset` | 无 | 清库（仅 `ALLOW_DEV_RESET=1` 时注册生效，生产保持关闭） |

错误格式：`{error: <code>, message: <zh>}`；状态码 400/401/403/404/409/429/500。

### D1 Schema

```sql
users        (username PK, id, password_salt_hex, password_hash_hex, role, created_at)
invites      (code PK, created_by, created_at, used_by, used_at)
quiz_stores  (username PK, data JSON, updated_at)
meta         (key PK, value)
```

`schema` 首次请求由 `ensureSchema` 自动建表（`CREATE TABLE IF NOT EXISTS`，幂等）。
`registerUser` 用 `db.batch()` 事务保证「建号 + 核销邀请码」原子性，用户名唯一约束
兜底并发注册；刷题进度存 `quiz_stores`（`data` 为前端 v2 schema 的 JSON 序列化）。

### 限频

两层限频叠加，保护 register / login 免遭爆破与滥用：

| 层 | 实现 | 规则 |
|---|---|---|
| 分钟级（防爆破） | `ratelimit.ts` 内存固定窗口 | register / login 各 **10 次/分钟/IP** |
| 每日级（控用量） | `rate-limit-daily.ts` + KV 计数 | 未登录 IP **9 次/天**；登录用户 **64 次/天**（北京时间按天，24h TTL 自动回收） |

- 每日计数存 KV（绑定 `RATE_LIMITS`，key 形如 `UNAUTH:<ip>:<日期>` / `AUTH:<userId>:<日期>`）
- KV 未绑定时每日限频**静默放行**（限频是增强能力，不因缺绑定阻塞业务）
- 触发时返回 `429` + 中文提示

## 测试

```bash
npm test                # API 冒烟测试（tsx + MockStore，44 断言，无需起服务）
npm run dev &           # 起 wrangler dev（本地 D1 模拟）
npm run e2e             # 端到端（Puppeteer + 本机 Chrome，82 断言）

# 题库结构与配比校验（本地工具链，已 gitignore）
C:/Users/lzk_7/miniconda3/python.exe scripts/validate_questions.py --quiet
```

e2e 覆盖：未登录重定向、首用户注册（自动 admin）、标题固定「考点精编」、四 tab 壳层、
首页（今日目标/快捷入口/备考科目/今日推荐复习）、题库 tab（选库/章节/题型/刷题范围）、
练习收藏星标、考试模式（100 题/60 分钟/零反馈/自评/出分）、错题本（题型筛选/重做/高频角标）、
个人中心/学习设置/考试日期、数据报告、响应式 6 档宽度、控制台零错误、
v3→v4 迁移（补 `favorites` 字段）。

e2e 默认打 `http://127.0.0.1:8787`，也可用 `E2E_TARGET=https://... npm run e2e`
指向任意部署做验证。

## 维护题库

题库拆成多个文件，由 `webapp/public/data/banks.json`（清单）统一索引：前端启动时先读清单、
恢复用户上次选中的库，再按需加载（未勾选的库不下载）。每库再加一个文件即多一个可选题库。

```
data/banks.json    清单：id / title / file / source / domains / domainLabels / typeCounts
data/bank-g.json   《3-6岁儿童学习与发展指南》
data/bank-p.json   《幼儿园保育教育质量评估》
data/bank-y.json   《幼儿园教育指导纲要》
```

每个库文件顶层为 `meta` + `questions` 数组。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 全局唯一。`<库前缀>-<题型字母><三位序号>`。库前缀 `G`/`P`/`Y`；题型字母 `S`单选 / `M`多选 / `J`判断 / `F`填空 / `A`简答，如 `G-S001` / `P-M012` / `Y-A010` |
| `type` | string | `single` / `multiple` / `judge` / `fill` / `short` |
| `domain` | string | **各库领域自治**：G → `health`/`language`/`society`/`science`/`art`/`general`；P → `A1`-`A5`；Y → `zongze`/`neirong`/`zuzhi`/`pingjia`。标签写在清单的 `domainLabels` |
| `stem` | string | 题干。选择题保留 `（　　）` 占位；**填空题用 `____`（4 个下划线）标记每个空**，空数必须与 `answer` 项数一致 |
| `options` | string[] \| null | 选项文本（判断/填空/简答为 `null`） |
| `answer` | 见下 | 单选 `"B"` / 多选 `["A","B"]`（全对才算对）/ 判断 `false` / **填空 `["第一空","第二空"]`（参考答案）/ 简答 `"参考答案文本"`** |
| `analysis` | string | 解析，引用原文 |

- **加题**：在对应库文件里追加，`id` 序号接在**该库该题型当前最大号之后**；同时更新该库的 `meta.counts`。
- **不要复用已删除的 id**（S02/S05/S06、J04、F01-F16、SA01-SA08）：老用户这些记录按 v2→v3 规则会被丢弃，复用会让历史记录错位到新题上。
- **填空/简答不自动判分**：前端只展示参考答案与解析，对错由用户点「我答对了 / 我答错了」决定，判定结果正常计入统计与错题本。
- **校验**：`C:/Users/lzk_7/miniconda3/python.exe scripts/validate_questions.py` 按 `banks.json` 驱动，
  检查结构与配比、id 规范（三段式）、跨库 id 唯一、跨库题干去重、领域键两两互斥；题库未完成时可加 `--allow-partial` 只校验已生成的题。

## 更新日志

- v6（2026-10-13）：**备考 App 升级**——底部导航改为 4 tab（首页/题库/错题本/我的），
  首页新增今日目标、考试模式快捷入口、我的备考科目、今日推荐复习；新增**题库 tab**（选库、
  章节目录、题型说明、刷题范围）；新增**考试模式**（60 分钟/100 题/零反馈/交卷自评/出分）；
  新增**我的收藏**（星标收藏、收藏列表隐藏答案）；新增**个人中心**与学习设置页；
  错题本支持按题型筛选、错误次数角标（≥2 黄/≥3 红）、批量移出；数据升到 **v4**（新增
  `favorites` 字段）；全站视觉改为紫色备考主题，浏览器标签与顶部品牌统一为「考点精编」；
  api-test 44 断言、v6 e2e 82 断言。
- v5（2026-10-12）：**三库 3000 题 + 两种自判题型**——题库拆为《指南》/《保育教育质量评估》/
  《教育指导纲要》三个各 1000 题的独立文件（清单 `banks.json` + 按需加载），首页支持多库勾选与
  合并刷题；新增**填空题（多空）**与**简答题**，均由用户对照参考答案自判（复用同一套 `recordAnswer`
  口径）；每次练习随机抽题上限 100 题，结束页新增「再刷一遍 / 换一批」；数据升到 **v3**
  （id 加库前缀并补零为三位，`S01 → G-S001`，旧 68 题并入 G）；修复「作答后 800ms 防抖未推送
  即登出导致丢数据」；api-test 43 断言、e2e 127 断言。
- v4（2026-10-11）：**架构重构**——后端迁移至 TypeScript（`src/`）、前端迁移至 TypeScript + Vite
  （`webapp/` → `dist/`）；存储确定为 **Cloudflare D1**（唯一后端，`Store` 接口抽象，schema 首次请求
  自动初始化，表：`users` / `invites` / `quiz_stores` / `meta`）；新增跨设备轮询同步、
  管理员全量备份导出、`HIDE_WEB_VAULT` 前端隐藏开关；api-test 42 断言、e2e 58 断言。
- v3（2026-10-08）：存储迁移至 Cloudflare Workers KV + JWT 用户体系（首用户自动管理员、
  邀请码注册）、多设备云同步（乐观锁 + 合并）；架构思想对齐 nodewarden：可插拔存储层、
  路由中间件化、内置限流。
- v2（2026-10-04）：题库重构为 68 题 + UI 现代化精修 + 数据 v1→v2 迁移。
- v1（2026-10-01）：首版。
