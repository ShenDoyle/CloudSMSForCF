# 自托管部署教程（Fly.io / Railway / VPS / 本地）

把 SMSToWeb 以 Docker 容器方式自托管。进程常驻、无函数时长限制，长轮询实时性最佳，适合有现成服务器或想用 Fly.io/Railway 免费额度的用户。

**本目录文件**：`server.mjs`（Node 18+ 零依赖入口，含内置每日清理）、`app.js`（核心应用）、`db.js`（Turso 适配层）、`schema.sql`（建表）、`Dockerfile`、`package.json`。

---

## 准备工作

- Fly.io 或 Railway 账号（或任意有 Docker 的 VPS）
- 数据库仍用 Turso（SQLite 兼容），下面第一步统一准备

## 第一步：创建 Turso 数据库

1. 打开 [turso.tech](https://turso.tech)，点 **Get Started**，用 GitHub 登录
2. 进入控制台 → **Create Database**：
   - Name：`sms-gateway`
   - Location：选离服务器近的区域
   - Type：Free
3. 创建后进入数据库详情页：
   - 记下 **Database URL**（形如 `libsql://sms-gateway-xxxx.turso.io`）
   - 点 **Create Token** 创建访问令牌，**立即复制保存**（只显示一次）
4. 初始化表结构：数据库详情页 → **Console** → 把本目录 [`schema.sql`](schema.sql) 全部内容粘贴进去 → 执行 → 提示成功

> CLI 方式：`turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`。

## 方式 A：Fly.io

1. 本地安装 flyctl（[官方安装指引](https://fly.io/docs/flyctl/install/)）后 `fly auth login`
2. 在本目录执行：

```bash
cd platforms/node
fly launch                 # 按提示创建应用：区域自选；询问数据库时选 No（我们用 Turso）
fly secrets set TURSO_DATABASE_URL=libsql://sms-gateway-xxxx.turso.io TURSO_AUTH_TOKEN=<你的令牌> RECEIVE_TOKEN=<你的密钥>
fly secrets set ENABLE_AUTH=true ADMIN_PASSWORD=<你的密码>     # 可选
fly deploy
fly status                 # 记下分配的域名 https://<app>.fly.dev
```

3. 验证：浏览器打开 `https://<app>.fly.dev` 应看到管理页；推送测试：

```
curl "https://<app>.fly.dev/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Fly 部署成功\"}"
```

4. 自定义域名：`fly certs add sms.你的域名.com`，按提示加 DNS（A 记录或 CNAME）

## 方式 B：Railway

1. 登录 [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**，选择你 Fork 的仓库
2. 服务设置 **Settings → Root Directory**：`platforms/node`（Railway 自动识别 Dockerfile 并构建）
3. **Variables** 面板添加环境变量（见下方通用表；`PORT` 平台自动注入，代码已适配）
4. **Settings → Networking → Generate Domain** 生成公网域名
5. 验证同上（换成你的 Railway 域名）

## 方式 C：任意 VPS（Docker）

```bash
# 上传本目录到服务器后
cd platforms/node
docker build -t smstoweb .
docker run -d --name smstoweb --restart unless-stopped -p 8787:8787 \
  -e TURSO_DATABASE_URL=libsql://sms-gateway-xxxx.turso.io \
  -e TURSO_AUTH_TOKEN=<你的令牌> \
  -e RECEIVE_TOKEN=<你的密钥> \
  smstoweb
# 验证
curl "http://127.0.0.1:8787/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"content\":\"VPS 部署成功\"}"
```

建议用 Caddy/Nginx 反代加 HTTPS。不用 Docker 也可以直接 `node server.mjs`（需 Node 18+，零 npm 依赖）。

## 环境变量（三种方式通用）

| 名称 | 值 | 说明 |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | 第一步记下的 URL |
| `TURSO_AUTH_TOKEN` | （第一步的令牌） | 只显示一次的那个 |
| `RECEIVE_TOKEN` | 自己编的长随机串 | 推送鉴权，勿用示例值 |
| `ENABLE_AUTH` | `false` | 要登录改 `true` |
| `ADMIN_PASSWORD` | 自己编的密码 | 仅 `ENABLE_AUTH="true"` 时需要 |
| `RETENTION_DAYS` | `30` | 数据保留天数 |
| `PORT` | 默认 `8787` | 一般无需设置（Railway 自动注入） |
| `FEISHU_WEBHOOK` | （可选）飞书群机器人 Webhook | 配置后新消息自动转发飞书群 |
| `WECOM_WEBHOOK` | （可选）企业微信群机器人 Webhook | 配置后新消息自动转发企微群 |
| `DINGTALK_WEBHOOK` | （可选）钉钉群机器人 Webhook | 加签安全设置需另配 `DINGTALK_SECRET` |
| `SERVERCHAN_SENDKEY` | （可选）Server酱 SendKey | 微信推送 |
| `PUSHPLUS_TOKEN` | （可选）PushPlus 令牌 | 微信推送 |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | （可选）Telegram Bot | 两者都配置才生效 |
| `BARK_DEVICE_KEY` | （可选）Bark 设备 Key | 自建服务器另配 `BARK_URL`，默认官方 |
| `NTFY_URL` | （可选）ntfy 主题 URL | 完整 URL，如 `https://ntfy.sh/my-sms` |
| `GOTIFY_URL` + `GOTIFY_TOKEN` | （可选）Gotify | 服务器地址 + 应用令牌 |
| `RESEND_API_KEY` + `MAIL_TO` | （可选）邮件（Resend） | 可选 `MAIL_FROM`，默认 `onboarding@resend.dev` |
| `GENERIC_WEBHOOKS` | （可选）通用 Webhook | 逗号分隔多个 URL；可选 `GENERIC_WEBHOOK_TEMPLATE` 自定义请求体 |
| `SITE_NAME` / `SITE_ICON` | （可选） | 网站名 / 图标 URL |

## 接入手机端与设备

按 [多平台接入部署指南](../../docs/多平台接入部署指南.md) 配置安卓 SmsForwarder 与各设备通知推送，域名用你的服务地址。

## 注意事项与常见问题

- **定时清理**：进程内置每天 UTC 17:00（北京 01:00）自动清理，无需配置。也可改用平台调度器（Fly Machines Cron / Railway Cron）调 `GET /api/cron?token=<RECEIVE_TOKEN>`，二选一
- **常驻进程优势**：无函数时长上限，`/api/wait` 长轮询与 Cloudflare Worker 体验一致，实时性最好
- **免费额度**：Fly.io 免费额度已改为按量计费（新账号需绑卡，微用量基本免费）；Railway 提供一次性试用额度，之后按用量计费——长期零成本首选 Cloudflare 主版本
- **数据备份**：数据都在 Turso，换服务器只需重新配好环境变量，数据无损
- **日志排查**：`fly logs` / Railway Deployments → Logs / `docker logs smstoweb`
