# 《3-6岁儿童学习与发展指南》刷题手册

刷题网页应用。**TypeScript 全栈**：后端 Cloudflare Workers + **D1**，
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

- **68 题完整题库**：单选 44 / 多选 10 / 判断 14，全部对照指南原文编写与校订
- **三种题型即时判分**、选项选中态、判定后展示解析
- **双维度筛选**：领域 × 题型任意组合；**正确率/进度统计**（整体、分领域、分题型）
- **错题本**：答错自动收录，重刷答对自动移出，支持手动移除
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
webapp/                      前端（TypeScript）
  index.html                 Vite 入口
  vite.config.ts             构建配置（outDir=../dist）
  public/data/questions.json 题库（构建时原样进 dist）
  src/
    main.ts / router.ts / state.ts / auth.ts / storage.ts / sync.ts
    migrate.ts / scoring.ts / stats.ts / ui.ts / utils.ts / types.ts
    views/{login,home,practice,wrongbook,stats,settings}.ts
dist/                        Vite 构建产物（gitignore；wrangler assets 目录）
wrangler.toml                Worker 配置（D1 + assets）
scripts/
  api-test.ts                API 冒烟测试（tsx 运行，42 断言，MockStore）
  e2e-check.js               端到端测试（Puppeteer，58 断言，需 wrangler dev）
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

首次部署前创建 D1 数据库并填入 `wrangler.toml`：

```bash
npx wrangler d1 create quiz-page-db
# 把返回的 database_id 填入 wrangler.toml 的 [[d1_databases]] database_id
# （或部署后在 Dashboard → Bindings 绑定 D1 database，变量名 DB）
```

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

## 测试

```bash
npm test                # API 冒烟测试（tsx + MockStore，42 断言，无需起服务）
npm run dev &           # 起 wrangler dev（本地 D1 模拟）
node scripts/e2e-check.js   # 端到端（58 断言，Puppeteer + 本机 Chrome）
```

e2e 覆盖：未登录重定向、首用户注册（自动 admin）、题库结构、三种题型判分、错题本、
统计、设置页账号/邀请码、刷新持久化（云端拉回）、360px/桌面端布局、深链接筛选、
v1→v2 首次上云迁移、登出登录 round-trip、数据隔离、邀请码一次性、重复用户名 409、
无 token 401、token 篡改跳登录。

e2e 默认打 `http://127.0.0.1:8787`，也可用 `E2E_TARGET=https://... node scripts/e2e-check.js`
指向任意部署做验证。

## 维护题库

题库文件是 `webapp/public/data/questions.json`，顶层为 `meta` + `questions` 数组。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 全局唯一。`S`单选 / `M`多选 / `J`判断 + 两位序号（v2 起允许缺口） |
| `type` | string | `single` / `multiple` / `judge` |
| `domain` | string | `health` / `language` / `society` / `science` / `art` / `general` |
| `stem` | string | 题干，保留 `（　　）` 占位 |
| `options` | string[] | 选项文本（判断题为 `null`） |
| `answer` | 见下 | 单选 `"B"` / 多选 `["A","B"]`（全对才算对）/ 判断 `false` |
| `analysis` | string | 解析，引用指南原文 |

直接编辑 JSON 追加题目即可，同时更新 `meta.counts`。**不要复用已删除的 id**
（S02/S05/S06、J04、F01-F16、SA01-SA08），避免与老用户历史记录错位。

## 更新日志

- v4（2026-10-11）：**架构重构**——后端迁移至 TypeScript（`src/`）、前端迁移至 TypeScript + Vite
  （`webapp/` → `dist/`）；存储确定为 **Cloudflare D1**（唯一后端，`Store` 接口抽象，schema 首次请求
  自动初始化，表：`users` / `invites` / `quiz_stores` / `meta`）；新增跨设备轮询同步、
  管理员全量备份导出、`HIDE_WEB_VAULT` 前端隐藏开关；api-test 42 断言、e2e 58 断言。
- v3（2026-10-08）：存储迁移至 Cloudflare Workers KV + JWT 用户体系（首用户自动管理员、
  邀请码注册）、多设备云同步（乐观锁 + 合并）；架构思想对齐 nodewarden：可插拔存储层、
  路由中间件化、内置限流。
- v2（2026-10-04）：题库重构为 68 题 + UI 现代化精修 + 数据 v1→v2 迁移。
- v1（2026-10-01）：首版。
