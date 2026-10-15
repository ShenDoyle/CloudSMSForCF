# Netlify 部署教程

把 SMSToWeb 部署到 Netlify（Functions v2 + Turso 数据库）。全程约 15 分钟。

**本目录文件**：`functions/api.mjs`（入口，`path: "/*"` 捕获全部路由）、`functions/cron.mjs`（定时清理 Scheduled Function）、`app.js`（核心应用）、`db.js`（Turso 适配层）、`schema.sql`（建表）、`netlify.toml`（站点配置）。

---

## 准备工作

1. 一个 GitHub 账号
2. 一个 Netlify 账号（[注册入口](https://app.netlify.com/signup)，直接用 GitHub 登录）

## 第一步：准备代码仓库

打开项目 GitHub 仓库，点右上角 **Fork**（或用你自己已 Push 的仓库）。

## 第二步：创建 Turso 数据库

Turso 提供 SQLite 兼容数据库（免费额度：500 个数据库、每月 10 亿次行读取）。

1. 打开 [turso.tech](https://turso.tech)，点 **Get Started**，用 GitHub 登录
2. 进入控制台 → **Create Database**：
   - Name：`sms-gateway`
   - Location：选离你近的区域（如 Singapore / Hong Kong）
   - Type：Free
3. 创建后进入数据库详情页：
   - 记下 **Database URL**（形如 `libsql://sms-gateway-xxxx.turso.io`）
   - 点 **Create Token** 创建访问令牌，**立即复制保存**（只显示一次）
4. 初始化表结构：数据库详情页 → **Console** → 把本目录 [`schema.sql`](schema.sql) 全部内容粘贴进去 → 执行 → 提示成功

> 也可用 Turso CLI：`turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`。

## 第三步：导入仓库到 Netlify

1. 登录 [app.netlify.com](https://app.netlify.com) → **Add new site → Import an existing project**
2. 选择 **Deploy with GitHub**，授权后在列表选你 Fork 的仓库
3. 部署配置页（Site settings for…）：
   - **Base directory**（根目录）：填 `platforms/netlify`
   - Build command / Publish directory：保持默认即可（`netlify.toml` 已在目录内，自动生效）
4. 展开下方 **Show advanced → New variable**，先添加环境变量（见第四步），再点 **Deploy**

## 第四步：配置环境变量

部署配置页高级选项中添加（后续也可在 **Site configuration → Environment variables** 里改）：

| 名称 | 值 | 说明 |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | 第二步记下的 URL |
| `TURSO_AUTH_TOKEN` | （第二步的令牌） | 只显示一次的那个 |
| `RECEIVE_TOKEN` | 自己编的长随机串 | 推送鉴权，勿用示例值 |
| `ENABLE_AUTH` | `false` | 要登录改 `true` |
| `ADMIN_PASSWORD` | 自己编的密码 | 仅 `ENABLE_AUTH="true"` 时需要 |
| `RETENTION_DAYS` | `30` | 数据保留天数 |
| `FEISHU_WEBHOOK` | （可选）飞书机器人 Webhook | 配置后新消息自动转发飞书群 |
| `SITE_NAME` / `SITE_ICON` | （可选） | 网站名 / 图标 URL |

点 **Deploy**，等待约 1 分钟部署完成。

## 第五步：验证部署

1. 部署完成，记下站点域名（形如 `https://xxx.netlify.app`）
2. 浏览器打开该域名，应看到管理页（默认「短信网关」；开了登录则先见登录页）
3. 验证推送接口：

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Netlify 部署成功\"}"
```

返回 `{"success":true,...}` 即通，网页应立刻出现这条消息。

## 第六步：接入手机端与设备

按 [多平台接入部署指南](../../docs/多平台接入部署指南.md) 配置安卓 SmsForwarder 与各设备通知推送，域名用你的 `xxx.netlify.app`。

自定义域名：**Site configuration → Change site name**（改子域名）或 **Domain management → Add a domain**（自有域名，按提示加 DNS）。

## 注意事项与常见问题

- **定时清理**：`functions/cron.mjs` 是 Netlify Scheduled Function，部署后自动注册（每天 UTC 17:00 = 北京 01:00），无需额外配置。验证：站点 **Functions** 页可看到 `cron` 函数及其调度状态
- **免费版函数时长**：同步函数 10 秒级上限，管理页长轮询 `/api/wait`（挂起 25 秒）**会被提前截断**——前端轮询循环会立即重试，**功能不受影响**，仅新消息提醒稍不及时。若在意实时性，建议选 Cloudflare / Deno Deploy / 自托管版本
- **部署失败排查**：Base directory 必须是 `platforms/netlify`；缺 `TURSO_*` 环境变量会 500 报 "config error"；可在站点 **Functions → api → 日志** 查看报错详情
- **更新代码**：push 到 GitHub 仓库自动重新部署
