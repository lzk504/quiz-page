# 考点精编

学前教育备考刷题应用。**TypeScript 全栈**：后端 Cloudflare Workers + **D1**，
前端 TypeScript + **Vite** 构建。参考 [nodewarden](https://github.com/shuaiplus/nodewarden)
的分层架构：可插拔存储、路由中间件、JWT 用户体系、D1 schema 首次请求自动初始化。

> 当前形态：后端 `src/` 11 个 `.ts`（**零运行时依赖**，单 Worker、无 Durable Object）；
> 前端 `webapp/src/` 32 个 `.ts`（约 7069 行，vanilla TS + Vite，构建产物到 `../dist`）。

**快速索引**：[项目逻辑说明](#项目逻辑说明) ｜ [目录结构](#目录结构) ｜ [本地开发](#本地开发) ｜
[构建与部署](#构建与部署) ｜ [API](#api) ｜ [测试](#测试) ｜ [维护题库](#维护题库) ｜ [更新日志](#更新日志)

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
- **考试模式**：60 分钟 100 题，作答过程零反馈，交卷后统一自评、出分、查看逐题清单与分题型得分；
  支持提前交卷（仅按已作答题计分，未作答不计分），中途退出即按已作答出分
- **练习续刷**：普通练习中途退出自动保存本地草稿，下次进入可选择「继续上次」或「重新开始」
- **章节断点续做**：章节练习不走本地草稿，改用云端 `records` 定位第一道未做题（跨设备有效）；
  头部显示「已完成 X / N」与可视化进度条，口径与练习/考试完全隔离
- **记忆模式**：普通 / 章节 / 错题三种练习均支持「上一题」回看与答题状态记忆（复习态不重复写记录）
- **练习算法**：按掌握度与错题权重排序抽题（`smartPracticeSort`），章节按「未做题优先」排序（`chapterResumeSort`）
- **答题卡**：通用半模态答题卡 `ExamCardSheet`，四种练习场景共用，支持跳题、已答/未答标记、当前题高亮
- **考试结算看板**：Vant 风格结算页（总分、用时、分题型正确率进度条、逐题解析清单）
- **视觉风格**：对齐 Vant（`@vant/icons`）风格，纯手写 CSS、无组件库依赖
- **我的收藏**：题目卡片可星标收藏，收藏列表隐藏参考答案，支持取消收藏与单题重做
- **题库 tab**：选库（单选，即刷题范围，章节/简介联动）、章节（领域）目录、题型说明；点击章节或题型直接进入练习
- **错题本**：按题型筛选，展示「我的答案 / 正确答案 / 解析」，显示错因次数角标（≥2 次黄、≥3 次红），
  支持重做本题与批量移出；首页「今日推荐复习」自动列出高频错题
- **个人中心**：累计做题、正确率、错题在册；本周学习小结；齿轮入口进入功能设置页
- **功能设置**：昵称设置（云端同步，首页问候语个性化）、数据导入/导出、邀请码管理；固定标题「考点精编」
- **单库刷题**：在题库 tab 选定一个库作为刷题范围，每次随机抽题**上限 100 题**；结束页支持
  「再刷一遍」（同一批重新打乱）与「换一批」（重新抽题）
- **双维度筛选**：领域 × 题型任意组合；**正确率/进度统计**（整体、分题库、分领域、分题型）
- **用户体系**：注册需邀请码（一次性），**首个注册用户自动成为管理员**
- **云端同步**：数据按用户隔离存于 D1，多设备登录自动同步（乐观锁 + lastAt 新者胜合并）
- **管理员能力**：生成/管理邀请码；导出全站全量备份（JSON）
- **可选隐藏前端**：`HIDE_WEB_VAULT=1` 时前端 404，仅保留 API
- **响应式**：移动优先（≤380px 优化），桌面端内容列限宽 720px

## 项目逻辑说明

> 这一章是给「接手开发」用的速查：搞清分层、模块职责、主链路与数据契约，
> 就能直接定位要改的文件。细节契约仍以 [API](#api) 与 [维护题库](#维护题库) 两章为准（避免双写）。

### 1. 分层与请求链路

```
浏览器
  └─ src/index.ts        先判 HIDE_WEB_VAULT（非 /api 可整体 404）→ /api/* → ASSETS 静态兜底
       └─ src/router.ts  注册式路由表 + requireAuth / requireAdmin 中间件 + 响应助手
            └─ src/routes.ts   11 个 handler，register/login 额外包两层限流
                 └─ src/services/storage*.ts   Store 工厂 → D1Store（唯一实现）
                      └─ D1（users / invites / quiz_stores / meta）
```

- 后端只有一条链，**无 Durable Object、无队列**，全部逻辑在单 Worker 内同步 await。
- 前端不直连 D1，只通过 `/api/*`；静态资源由平台直接服务（`dist/`）。
- 前端壳层由 `webapp/src/router.ts` 的 **hash 路由** 驱动（无 history pushState），
  未登录访问非 `login` 页会被重定向到 `#/login`。

### 2. 前端模块地图

| 层 | 文件 | 职责 |
|---|---|---|
| 引导 | `main.ts` | 启动引导、注册全部路由、`window.__quiz` 调试钩子、`flushStore` 生命周期 |
| 路由/壳层 | `router.ts` | hash 路由、登录守卫、顶栏/底栏 class 切换、视图挂载与卸载 |
| 题库状态 | `state.ts` | 读 `banks.json` 清单、**按需加载**分库、选库（单选即刷题范围）、发布订阅 |
| 存储同步 | `storage.ts` | 云端 store 内存 cache、`PUT` 800ms 防抖、`baseUpdatedAt` 乐观锁、409 合并、`flushStore` |
| 跨设备同步 | `sync.ts` | 30s 轮询（仅页面可见时） |
| 计算层 | `scoring.ts` / `stats.ts` / `goal.ts` | 判分（填空/简答返回 `null` 由用户自判）/ 统计口径 / 学习节奏与抽题排序 |
| 本地偏好 | `local-prefs.ts` | 不上云的偏好（上次练习范围、主题） |
| 迁移 | `migrate.ts` | store **v1 → v5** 迁移链与 id 重映射 |
| UI 原子 | `ui.ts` / `utils.ts` | tag / 进度条 / 空态 / toast / `confirmDialog`；`APP_NAME = 考点精编` |
| 页面视图 | `views/{home,banks,wrongbook,me,favorites,stats,settings,login}.ts` | 8 个页面，底部 4 tab = 首页/题库/错题本/我的 |
| **刷题核心** | `views/practice-hub/`（9 个模块） | 见下表 |

**`views/practice-hub/`**（原 `views/practice.ts` 1329 行**已删除**，拆分而来）：

| 模块 | 职责 |
|---|---|
| `index.ts` | 统一出口 |
| `quiz-card.ts` | 题干/选项/反馈渲染与答案采集（五种题型共用） |
| `draft.ts` | 草稿读写，`general` / `chapter` / `wrong` 三键隔离 |
| `general-practice.ts` | 普通练习（抽题上限 100、续刷、收藏、自判） |
| `chapter-practice.ts` | 章节练习（按 `records` 断点续做、章节进度口径独立） |
| `wrong-practice.ts` | 错题重做（进入时剪枝已移出错题） |
| `exam.ts` | 考试模式（100 题 / 60 分钟、零反馈、交卷自评与出分） |
| `exam-card.ts` | 通用答题卡半模态 `ExamCardSheet`（四种练习场景复用） |
| `wrongbook-manager.ts` | 错题本单一事实源（统计、批量操作、角标） |

刷题路由由 `router.ts` 代理分发：`practice?mode=exam` → exam、`mode=wrong` → wrong-practice、
`from=chapter|domain` → chapter-practice，其余 → general-practice。

### 3. 核心业务流程

**① 抽题与排序**
`banks.json` → `ensureBank()` 按需加载分库 → `state.getQuestions()` 取当前库题目 →
按场景排序：普通练习 `smartPracticeSort`（截 100 题）、章节 `chapterResumeSort`（未做题在前、
已做题在后，全量入队）、考试 `examPick` + `examBlueprint`（单选 50 / 多选 20 / 判断 17 / 填空 10 / 简答 3 = 100）。

**② 作答与落库**
`recordAnswer` → `grade()` 判分（单选/多选/判断自动；填空/简答返回 `null`，由用户在页面上自判）→
写 `store.records` → **800ms 防抖** `PUT /api/store {store, baseUpdatedAt}` →
云端较新返回 409 时拉远端 `mergeWithRemote`（按条目 `lastAt`/`addedAt` 新者胜）后重推 →
页面隐藏/卸载前 `flushStore()` 兜底。

**③ 草稿与断点续做**
草稿键 `quizapp.draft.<general|chapter|wrong>.v1.<username>`，存 `{params, ids, index, settled}`。
普通练习中途退出写草稿，再次进入弹「继续上次 / 重新开始」；**章节练习不走草稿**，
改用云端 `records` 定位第一道未做题（跨设备有效）；错题草稿进入前会剪掉已移出错题本的题目。

### 4. 数据模型与关键接口

| 层 | 内容 |
|---|---|
| 云端 store（**v5**） | `records`（做题记录、`lastCorrect` 为最近一次结果）/ `wrongbook` / `favorites` / `profile.nickname`；迁移链 v1→v5 见 `migrate.ts` |
| D1 | 四表与建表方式见 [D1 Schema](#d1-schema)，`ensureSchema` 首次请求幂等建表 |
| KV（绑定 `RATE_LIMITS`） | **仅用于每日限额计数**：`UNAUTH:<ip>:<日期>`、`AUTH:<userId>:<日期>`，24h TTL |
| localStorage | `quizapp.token.v1`、`quizapp.banks.v1`（选中库）、`quizapp.lastScope.v1`、`quizapp.theme.v1`、`quizapp.data.v1`（仅旧版上云迁移用）、`quizapp.draft.*` |
| 接口清单 | 11 个端点见 [API](#api)；store 为 **纯 JSON 透传**（后端不解析业务字段，schema 由前端定义） |

两条容易踩的口径：**正确率只取每题最近一次作答**（`records[id].lastCorrect`）；
**错题本只增不减**（`recordAnswer` 只负责加入，移出只能由用户手动操作或批量清理）。

### 5. 题库数据契约

| 约定 | 说明 |
|---|---|
| 入口 | `webapp/public/data/banks.json`（清单）→ `bank-g/p/y.json`（按需加载） |
| id | `<库前缀>-<题型字母><三位序号>`，如 `G-S001` / `P-M012`；库前缀 `G`/`P`/`Y`，题型字母 `S`单选 / `M`多选 / `J`判断 / `F`填空 / `A`简答 |
| 规模 | 三库各 1000 题：单选 400 / 多选 200 / 判断 200 / 填空 100 / 简答 100 |
| 领域 | **各库自治**：G → `health`/`language`/`society`/`science`/`art`/`general`；P → `A1`–`A5`；Y → `zongze`/`neirong`/`zuzhi`/`pingjia`（标签在清单 `domainLabels`） |
| 填空 | 题干用 `____`（4 个下划线）标空，**空数必须等于 `answer` 项数**；`answer` 为参考答案数组，判定由用户自判 |
| 禁区 | 不要复用已删除的 id（`S02/S05/S06`、`J04`、`F01-F16`、`SA01-SA08`），否则老用户历史记录会错位 |

完整字段说明、加题步骤与校验命令见 [维护题库](#维护题库)。

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
    rate-limit-daily.ts      KV 每日限额（未登录 30 次/登录 64 次，24h TTL）
webapp/                      前端（TypeScript）
  index.html                 Vite 入口
  vite.config.ts             构建配置（outDir=../dist）
  public/data/banks.json     题库清单（唯一数据入口）
  public/data/bank-*.json    各题库文件（G/P/Y，按需加载，构建时原样进 dist）
    src/
      main.ts / router.ts                 入口与 hash 路由（登录守卫 + 4 tab 壳层）
      state.ts                            题库清单 + 按需加载 + 选中库偏好
      auth.ts / storage.ts / sync.ts       鉴权 / 云端 store 同步（乐观锁+防抖）/ 30s 轮询
      migrate.ts / scoring.ts / stats.ts   数据迁移 v1→v2→v3→v4→v5 / 判分 / 统计口径
      goal.ts / local-prefs.ts            学习节奏计算 / 本机偏好（上次练习范围等）
      ui.ts / utils.ts / types.ts
      views/{login,home,banks,me,wrongbook,stats,settings,favorites}.ts   8 个页面视图
      views/practice-hub/                刷题核心（原 views/practice.ts 已删除，拆分而来）
        index.ts                           统一出口
        quiz-card.ts                       题干/选项/反馈渲染与答案采集（五题型共用）
        draft.ts                           草稿读写（general/chapter/wrong 三键隔离）
        general-practice.ts                普通练习
        chapter-practice.ts                章节练习（按 records 断点续做）
        wrong-practice.ts                  错题重做
        exam.ts                            考试模式（100 题/60 分钟）
        exam-card.ts                       通用答题卡半模态 ExamCardSheet
        wrongbook-manager.ts               错题单一事实源
dist/                        Vite 构建产物（gitignore；wrangler assets 目录）
wrangler.toml                Worker 配置（D1 + KV 限额计数 + assets）
scripts/
  api-test.ts                API 冒烟测试（tsx + MockStore，无需起服务）
  e2e-check.js               端到端测试入口（spawn `_verify-v6.mjs`）
  _verify-v6.mjs             v6 真实浏览器端到端验证（Puppeteer + 本机 Chrome，需 wrangler dev）
  test-sorting.ts            goal.ts 抽题排序单测（tsx 运行）
  verify-chapter-plan.mjs    章节练习专项 e2e（打 8788，Windows 本机专用）
  review_report.md           题库校对报告
  *.py                       题库生成/校验脚本（本地工具链，已 gitignore，不入库）
```

> 各脚本的命令与期望输出见 [测试](#测试)。
> ⚠️ `.gitignore` 含 `scripts/` 整目录规则：已跟踪的脚本仍在库内，但**新增脚本须 `git add -f`**。

## 本地开发

```bash
npm install

# 配置本地 secrets（.dev.vars 已 gitignore）
#   JWT_SECRET="...30+ 字符随机串..."
#   ALLOW_DEV_RESET="1"        # 仅本地：启用 POST /api/dev/reset 清库
#   DEV_UNLIMITED="1"          # 仅本地：跳过登录/注册限频（本地所有请求共用 127.0.0.1 限额桶，调试易撞满）
echo 'JWT_SECRET="local-dev-secret-please-change-to-30-plus-random-chars-xxxxx"' > .dev.vars
echo 'ALLOW_DEV_RESET="1"' >> .dev.vars
echo 'DEV_UNLIMITED="1"' >> .dev.vars

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
| 每日级（控用量） | `rate-limit-daily.ts` + KV 计数 | 未登录 IP **30 次/天**；登录用户 **64 次/天**（北京时间按天，24h TTL 自动回收） |

> 本地调试：`.dev.vars` 里 `DEV_UNLIMITED="1"`（需配合 `ALLOW_DEV_RESET="1"`）可同时跳过两层限频，
> 因为本地所有请求的 clientIp 都是 `127.0.0.1`，共用同一个限额桶，反复登录调试很容易撞满 429。

- 每日计数存 KV（绑定 `RATE_LIMITS`，key 形如 `UNAUTH:<ip>:<日期>` / `AUTH:<userId>:<日期>`）
- KV 未绑定时每日限频**静默放行**（限频是增强能力，不因缺绑定阻塞业务）
- 触发时返回 `429` + 中文提示

## 测试

```bash
npm test                # API 冒烟（tsx + MockStore，50 断言，无需起服务）
npm run e2e             # 端到端（Puppeteer + 本机 Chrome，128 处 ok()，运行时约 132 条，需先起服务）

# 抽题排序单测（goal.ts 的 smartPracticeSort / chapterOrderSort）
npx tsx scripts/test-sorting.ts

# 章节练习专项 e2e（打 8788 沙箱，Windows 本机专用，截图落 scripts/_shots/）
node scripts/verify-chapter-plan.mjs

# 题库结构与配比校验（本地工具链，已 gitignore）
C:/Users/lzk_7/miniconda3/python.exe scripts/validate_questions.py --quiet
```

e2e 默认打 `http://127.0.0.1:8787`，也可用 `E2E_TARGET=https://... npm run e2e`
指向任意部署做验证。**推荐用独立沙箱**避免污染本地调试数据：

```bash
npx wrangler dev --port 8788 --persist-to .wrangler/_verify   # 另开一个终端
E2E_TARGET=http://127.0.0.1:8788 npm run e2e
```

> ⚠️ **不要裸跑 `npm run e2e` 直连你自己的 8787 dev 实例**：`_verify-v6.mjs` 第一步就是
> `POST /api/dev/reset`，会清空本地 `users` / `invites` / `quiz_stores` / `meta`。

e2e 覆盖：未登录重定向、首用户注册（自动 admin）、标题固定「考点精编」、四 tab 壳层、
首页（今日目标/快捷入口/备考科目/今日推荐复习）、题库 tab（单选选库即刷题范围/章节/题型/隐藏库编号）、
练习收藏星标、练习退出续刷（继续/重开两路径）、考试模式（100 题/60 分钟/零反馈/自评/出分/
提前交卷仅按已作答计分/退出按已作答出分）、错题本（题型筛选/重做/高频角标）、
个人中心/功能设置/昵称（设置·首页问候语·云端同步）、数据报告、响应式 6 档宽度、控制台零错误、
v3→v5 迁移（补 `favorites` 与 `profile` 字段）。

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

### 进行中 / 未提交（工作区快照，HEAD = `3be9ece`）

- （未提交）**考试模式 Vant 化下半场**：新增 `views/practice-hub/exam-card.ts`（134 行，
  通用答题卡半模态 `ExamCardSheet`，普通/章节/错题/考试四类场景复用，支持跳题、已答标记与交卷）；
  `views/practice-hub/exam.ts` 重写 +338/-116（`exam-v2` 头部与进度条、`#examOpenSheet` 答题卡入口、
  `exam-result-hero` 深色结算看板、`exam-review-item` 逐题解析清单）；
  `webapp/src/style.css` +534（Vant 视觉 token 与上述组件样式）。
  ⚠️ 尚未提交，**不要基于这些 DOM 写新断言**。

### 已发布版本

- v6.4（2026-10-15/16）：**章节断点续做与刷题内核拆分**——章节练习改用云端 `records` 定位第一道
  未做题（跨设备有效，进度显示「已完成 X / N」，与普通练习的题位式口径隔离）；修复「接着做题」题目定位、
  章节无法继续做题、章节进度条计数（提交 `51a0b1d` / `abef2cc` / `b797ec6` / `b061bd6`）；
  抽题排序算法调整并新增 `scripts/test-sorting.ts` 与 `scripts/verify-chapter-plan.mjs`（`df28aac`）；
  修复考试模式判断题选项不高亮（`33d7334`）。
- v6.3（2026-10-16）：**practice-hub 拆分 + Vant 视觉**——删除 1329 行的 `views/practice.ts`，
  拆为 `views/practice-hub/` 9 个模块（general / chapter / wrong 三种练习 + exam +
  共享 `quiz-card` / `draft` / `wrongbook-manager` / `exam-card`），旧路由 `practice` 由 `router.ts`
  向前兼容代理；UI 视觉风格改为 Vant；「记忆模式」覆盖普通/章节/错题练习（提交 `3be9ece`）。
  api-test 50 断言、`_verify-v6.mjs` 128 处 `ok()`（运行时约 132 条）。
- v6.2（2026-10-14）：**功能设置与昵称**——移除「设置考试日期」与「备考设置」盒子（含首页开考
  倒计时、`local-prefs` 考试日期存储、`goal.daysUntil`）；「学习设置」更名**功能设置**；
  账号区新增**昵称**（云端同步，首页问候语与头像优先使用，未设置回退用户名）；数据升到 **v5**
  （新增 `profile` 字段，迁移链 v1→…→v5）；api-test 45 断言、e2e 110 断言。
- v6.1（2026-10-14）：**考试与刷题范围修订**——修复考试交卷无响应（自定义 `confirmDialog` 弹窗
  替代 `window.confirm`，`submitExam` 先判分后切阶段、异常不锁死）；考试**提前交卷仅按已作答
  计分**（未作答不计分/不落库/不进错题本，逐题清单灰显）；考试中途退出按已作答出分；普通练习
  支持**中途退出续刷**（localStorage 草稿，继续/重开两路径）；题库 pill 单选与刷题范围**合并为
  统一入口**（删「我的刷题范围」开关卡，放弃多库合并刷题）；全局隐藏题库编号 G/P/Y（新增
  `bankShortName`），修简介卡书名重复拼接；e2e 105 断言。
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

### 待办与技术债

- [ ] **修复 `scripts/_verify-v6.mjs` 考试结算段的选择器漂移**：脚本第 249/281/287/295/317/318/319/321/329 行
      仍断言 `#examSubmit2` / `.exam-score` / `.exam-score__label` / `.exam-row` / `.exam-row--skip`，
      而当前 `exam.ts` 只有 `#examSubmit`，结算页改用 `.exam-v2-*` / `.exam-result-*` / `.exam-review-item*`——
      **该段 e2e 当前必然失败**，需按新 DOM 同步更新（改视图前先 grep 这个脚本）。
- [ ] `views/practice-hub/` 缺独立单元测试，目前只有 `scripts/test-sorting.ts` 覆盖抽题排序。
- [ ] `.gitignore` 含 `scripts/` 整目录规则，新增脚本入库须 `git add -f`。
- [ ] `scripts/verify-chapter-plan.mjs` 硬编码本机 Chrome 路径与 8788 端口，仅 Windows 本机可用，非 CI 可移植。
