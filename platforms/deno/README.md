# Deno Deploy 部署教程

把 SMSToWeb 部署到 Deno Deploy（Deno 原生运行时 + Turso 数据库）。与 Cloudflare Worker 语义最接近，免费版每月 100 万次请求，全程约 15 分钟。

**本目录文件**：`main.js`（入口，含 `Deno.serve` 与内置 `Deno.cron` 定时清理）、`app.js`（核心应用）、`db.js`（Turso 适配层）、`schema.sql`（建表）。

---

## 准备工作

1. 一个 GitHub 账号
2. 一个 Deno Deploy 账号（[注册入口](https://dash.deno.com/signin)，直接用 GitHub 登录）

## 第一步：准备代码仓库

1. 打开项目 GitHub 仓库，点右上角 **Fork**（或用你自己已 Push 的仓库）

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

## 第三步：在 Deno Deploy 创建项目并关联仓库

1. 登录 [dash.deno.com](https://dash.deno.com) → **New Project**（或 Create）
2. 选择 **Deploy from GitHub repository**（从 GitHub 仓库部署），授权并选择你 Fork 的仓库
3. 关键配置（Build Configuration）：
   - **Root Directory**：`platforms/deno`
   - **Entrypoint**（入口文件）：`main.js`
4. 先点 **Add Variable**（或部署后在 Settings 里）配置环境变量，见第四步
5. 点 **Deploy / Link**，等待构建完成

## 第四步：配置环境变量

项目 **Settings → Environment Variables** 中逐个添加：

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

保存后等待自动重新部署生效。

## 第五步：验证部署

1. 记下分配的域名（形如 `https://xxx.deno.dev`，区域实例另有 `xxx.deno.dev` 区域后缀）
2. 浏览器打开该域名，应看到管理页（默认「短信网关」；开了登录则先见登录页）
3. 验证推送接口：

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Deno Deploy 部署成功\"}"
```

返回 `{"success":true,...}` 即通，网页应立刻出现这条消息。

## 第六步：接入手机端与设备

按 [多平台接入部署指南](../../docs/多平台接入部署指南.md) 配置安卓 SmsForwarder 与各设备通知推送，域名用你的 `xxx.deno.dev`。

自定义域名：项目 **Settings → Domains** → Add Domain，按提示在域名 DNS 加 CNAME 记录。

## 注意事项与常见问题

- **定时清理**：`Deno.cron` 在部署时自动注册（每天 UTC 17:00 = 北京 01:00），无需任何额外配置，也不能手动触发测试——验证可看 D1/Turso 数据是否按期减少
- **免费额度**：每月 100 万次请求、100 万次 CPU 毫秒，个人使用绰绰有余
- **长轮询**：Deno Deploy 无严格函数时长上限，`/api/wait` 25 秒长轮询工作良好，实时性与 Worker 版一致
- **部署失败排查**：Entrypoint 必须填 `main.js`、Root Directory 必须是 `platforms/deno`；缺 `TURSO_*` 环境变量会 500 报 "config error"
- **更新代码**：push 到 GitHub 仓库自动重新部署
