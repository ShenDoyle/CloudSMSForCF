# CloudSMSForCF 多平台部署

本项目除 Cloudflare Worker 主版本外，提供以下平台的移植版本。**五个平台功能完全一致**：
接口路径、鉴权逻辑、消息模型、管理页、飞书转发、每日定时清理（UTC 17:00）均与 Worker 版相同。

```
platforms/
├── vercel/    # Vercel Edge Function（api/[[...route]].js + app.js + db.js + vercel.json + schema.sql）
├── netlify/   # Netlify Functions v2（functions/{api,cron}.mjs + app.js + db.js + netlify.toml + schema.sql）
├── deno/      # Deno Deploy（main.js + app.js + db.js + schema.sql）
├── edgeone/   # 腾讯 EdgeOne Pages Functions（functions/[[default]].js + app.js + db.js + schema.sql）
├── node/      # Node.js 自托管（server.mjs + app.js + db.js + Dockerfile + schema.sql）
├── shared/    # 唯一源：app.js / db.js 的生成源（gen_app.py 由此同步到各平台目录）
└── gen_app.py # 生成器：从 src/worker.js 生成 app.js 并同步各平台副本
```

每个平台目录**完全自包含**：只引用本目录内的 `app.js`（核心应用）与 `db.js`（Turso 适配层），
零 npm 依赖、无需构建步骤，把单个目录作为独立项目即可部署，平台之间互不影响。

- **app.js** 由 `gen_app.py` 从 `src/worker.js` 生成，业务代码与 Worker 版**逐字节一致**，
  仅把 Workers 专属的 `export default` 替换为通用导出（`fetchApp` / `runCron` / `handleCronRequest`）
- **db.js** 是 Turso 适配层（纯 fetch 实现），对外提供与 Cloudflare D1 一致的
  `prepare().bind().first()/all()/run()` 接口，业务 SQL 零改动；
  项目根目录 [schema.sql](../schema.sql) 可直接用于建表（各平台目录内含同名副本）

> `src/worker.js` 有更新后：`python platforms/gen_app.py` 一键重新生成并同步五个平台。

---

## 一、平台选型对比

| 平台 | 运行时 | 定时清理 | 函数时长上限* | 特点与注意 |
|---|---|---|---|---|
| **Vercel** | Edge Function | 平台 cron（vercel.json） | 边缘函数较紧 | 部署体验好；Hobby 免费版 cron 仅支持每天一次（本项目每天一次，满足）；长轮询可能被提前截断 |
| **Deno Deploy** | Deno 原生 | `Deno.cron`（内置） | 较宽松 | 与 Worker 语义最接近；免费版每月 100 万次请求 |
| **Netlify** | Functions v2（Node） | Scheduled Function | 免费版 10s 级 | 长轮询 /api/wait 会被截断，前端自动重试不影响使用 |
| **EdgeOne Pages**（腾讯） | Functions | 无原生，用外部 cron | 较紧 | 国内访问体验好；需自备外部 cron 调 /api/cron |
| **Fly.io / Railway** | Docker（Node 20） | 进程内置每日清理 | 无（常驻进程） | 长轮询/实时性最佳；Fly 免费额度改版后按量，Railway 按用量计费 |

\* 长轮询说明：管理页通过 `GET /api/wait` 挂起最长 25 秒等待新消息。在执行时长较短的平台上，
该请求可能被平台提前截断——前端轮询循环会立即重试，**功能不受影响**，只是刷新稍不及时。

---

## 二、通用准备（所有平台共用，做一次即可）

### 1. 创建 Turso 数据库

安装 Turso CLI（或直接在 [turso.tech](https://turso.tech) 网页控制台创建）：

```bash
# macOS / Linux
curl -sSfL https://get.tur.so/install.sh | bash
# Windows（PowerShell）
irm https://get.tur.so/install.ps1 | iex

turso auth login
turso db create sms-gateway          # 创建数据库
turso db show sms-gateway --url      # 记下 URL，形如 libsql://sms-gateway-<你的组织>.turso.io
turso db tokens create sms-gateway   # 创建访问令牌（只显示一次，妥善保存）
```

### 2. 初始化表结构

```bash
turso db shell sms-gateway < schema.sql
```

或在 Turso 网页控制台 → 数据库 → Console 中，粘贴 schema.sql 全部内容执行。
（各平台目录内均含 schema.sql 副本；仓库根目录的 schema.sql 与之相同。）

### 3. 环境变量（各平台设置面板中配置，五个平台一致）

| 变量 | 必填 | 说明 |
|---|---|---|
| `TURSO_DATABASE_URL` | 是 | `libsql://sms-gateway-<组织>.turso.io` |
| `TURSO_AUTH_TOKEN` | 是 | 上一步创建的数据库令牌 |
| `RECEIVE_TOKEN` | 是 | 推送鉴权 token（接入端 Webhook URL 中携带，与 Worker 版同一个即可） |
| `ENABLE_AUTH` | 否 | `"true"` 管理页需登录；默认免登录 |
| `ADMIN_PASSWORD` | 否 | 登录密码（`ENABLE_AUTH="true"` 时必填） |
| `RETENTION_DAYS` | 否 | 数据保留天数，默认 30 |
| `FEISHU_WEBHOOK` | 否 | 飞书机器人 Webhook，配置后新消息自动转发飞书群 |
| `SITE_NAME` / `SITE_ICON` | 否 | 网站名 / 图标 URL，未设置用默认值 |
| `CRON_SECRET`（仅 Vercel） | 否 | 设为与 `RECEIVE_TOKEN` 相同值，供 Vercel Cron 调 /api/cron |

### 4. 切换接入端

手机端 SmsForwarder 与各平台推送脚本只需把 Webhook URL 的域名换成新平台分配的域名，
路径与 token 保持不变（`/api/receive`、`/api/push` 行为与 Worker 版完全一致，
消息模板与字段说明见根目录 [多平台接入部署指南](../docs/多平台接入部署指南.md)）。

---

## 三、各平台部署步骤

### Vercel

1. Dashboard → Add New → Project → Import 仓库时把 **Root Directory 设为 `platforms/vercel`**；
   或本地：`cd platforms/vercel && npx vercel`（首次创建项目，默认选项即可）
2. Dashboard → Settings → Environment Variables 配置第二节的环境变量
   （**另加** `CRON_SECRET` = 与 `RECEIVE_TOKEN` 相同的值，Vercel Cron 会自动附带
   `Authorization: Bearer $CRON_SECRET` 调用 /api/cron）
3. 重新部署后生效；定时清理已由 [vercel.json](vercel/vercel.json) 配置：每天 UTC 17:00（北京 01:00）

### Deno Deploy

1. Dashboard 创建项目并记下名称；Settings → Environment Variables 配置第二节变量
2. 关联 GitHub 仓库部署：Build Configuration 中
   **Root Directory 填 `platforms/deno`**，Entrypoint 填 `main.js`
3. 定时清理由 `Deno.cron` 自动注册，无需额外配置

### Netlify

1. Dashboard → Add new site → Import an existing project，选仓库后把
   **Base directory 设为 `platforms/netlify`**（netlify.toml 已在目录内）
2. Site configuration → Environment variables 配置第二节变量
3. 部署后生效；定时清理由 `functions/cron.mjs`（Scheduled Function，每天 UTC 17:00）自动注册

### EdgeOne Pages（腾讯）

1. 腾讯云控制台 → EdgeOne Pages → 创建项目，选择从 Git 仓库导入并把
   **根目录设为 `platforms/edgeone`**（或直接上传本目录全部文件）
2. 项目设置 → 环境变量，配置第二节变量
3. 部署完成后绑定域名即可访问
4. 定时清理：平台暂无原生定时任务，用任一外部 cron 服务（如 cron-job.org）每天定时
   `GET https://<你的域名>/api/cron?token=<RECEIVE_TOKEN>`
5. 备注：兜底路由文件为 `functions/[[default]].js`；若你的 EdgeOne 版本路由不生效，
   可将其改名为 `functions/[[path]].js`（与 Cloudflare Pages 写法一致）后重新部署

### Fly.io / Railway（Docker 自托管）

目录：`platforms/node`（Node 20 + 零 npm 依赖，进程常驻，内置每日 UTC 17:00 清理）。

**Fly.io：**

```bash
cd platforms/node
fly launch                 # 按提示创建应用（区域自选，不配置数据库——我们用 Turso）
fly secrets set TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... RECEIVE_TOKEN=...
fly secrets set ENABLE_AUTH=true ADMIN_PASSWORD=...   # 可选
fly deploy
fly status                 # 记下分配的域名 https://<app>.fly.dev
```

**Railway：**

1. Railway 控制台 → New Project → Deploy from GitHub repo，**Root Directory 设为 `platforms/node`**
2. Variables 面板配置第二节变量（`PORT` 平台自动注入，代码已适配）
3. Networking → Generate Domain 获得公网地址

也可用平台调度器（Fly Machines Cron / Railway Cron）替代内置清理：
`GET /api/cron?token=<RECEIVE_TOKEN>`。

---

## 四、从 Cloudflare Worker 迁移

1. 按第二节准备 Turso 库并初始化表结构
2. （可选）迁移历史数据：Dashboard 导出 D1 数据（SQLite 文件）→ `turso db shell <库> .import`
   或用 sqlite3 客户端把 `messages` / `devices` 两张表导入 Turso
3. 按第三节部署任一平台，验证管理页与 /api/push 推送正常
4. 把手机端与各推送脚本的 Webhook 域名换到新平台
5. 观察一两天无异常后停用旧 Worker

## 五、其他说明

- 所有平台的 API 路径与 Worker 版一致：`/api/receive`、`/api/push`、`/api/messages`、
  `/api/devices`、`/api/devices/alias`、`/api/wait`、`/api/login`、`/api/logout`、`/api/cron`
- `/api/cron` 供外部调度器触发清理，鉴权方式：`?token=<RECEIVE_TOKEN>` 或
  `Authorization: Bearer <RECEIVE_TOKEN>`
- `/api/receive` 与 `/api/push` 不受登录开关影响，与 Worker 版一致
