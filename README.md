# SMSToWeb — 短信/通知上云网关

把 Android 手机的短信和各类设备的通知实时推送到云端，通过网页随时查看。免费部署、无需服务器、约 10 分钟完成。

- **多平台部署**：Cloudflare（主版本）/ Vercel / Deno Deploy / Netlify / 腾讯 EdgeOne / Docker 自托管，六选一，功能完全一致
- **实时接收**：Webhook 秒级入库，网页自动刷新，无需手动操作
- **通用推送**：任何能发 HTTP 请求的设备（Linux / Windows / macOS / iOS / NAS / 脚本）都能把通知推进同一个页面
- **来源筛选**：短信与通知按来源分类展示
- **双通道备份**：云端网关 + 飞书机器人同时推送，防单点丢失（可选）
- **安全可选**：管理页登录开关、验证码识别与一键复制、暗色模式

```
【短信】Android(SmsForwarder) ──POST /api/receive──┐
                                                   ├─→ 云端网关（任选一平台）─→ 数据库
【通知】各平台脚本/快捷指令 ──POST /api/push────────┘         │
                                                  浏览器 ◀── 网页管理页（网关内嵌）
```

| 平台 | 部署方式 | 定时清理 | 详细教程 |
|---|---|---|---|
| **Cloudflare**（推荐） | Worker + D1 | 平台 cron | [cloudflare/README.md](cloudflare/README.md) |
| Vercel | Edge Function + Turso | 平台 cron | [platforms/vercel/README.md](platforms/vercel/README.md) |
| Deno Deploy | Deno 原生 + Turso | Deno.cron | [platforms/deno/README.md](platforms/deno/README.md) |
| Netlify | Functions v2 + Turso | Scheduled Function | [platforms/netlify/README.md](platforms/netlify/README.md) |
| 腾讯 EdgeOne Pages | Functions + Turso | 外部 cron | [platforms/edgeone/README.md](platforms/edgeone/README.md) |
| Fly.io / Railway / VPS | Docker（Node 20）+ Turso | 进程内置 | [platforms/node/README.md](platforms/node/README.md) |

> 每个平台目录**完全自包含**（代码 + schema + 独立文档，零 npm 依赖、无需构建），点上表「详细教程」即可按步骤部署。功能与数据表结构全平台一致，可随时互相迁移。
> 平台对比与通用准备（Turso 数据库）见 [platforms/README.md](platforms/README.md)。

---

## 手机端与多平台接入

所有平台把消息推进同一个网页：手机短信走 `/api/receive`（安卓 SmsForwarder），其余一切通知走通用接口 `/api/push`。

分步配置（每平台附可直接复制的命令/脚本）：**[docs/多平台接入部署指南.md](docs/多平台接入部署指南.md)**

**通用推送接口速览**（详细字段见接入指南）：

```
POST https://<你的域名>/api/push?token=<RECEIVE_TOKEN>
{"source":"notify","sender":"demo","content":"hello from anywhere"}
```

返回 `{"success":true,...}` 即入库；完全相同的重复推送返回 `duplicated:true`。

## 环境变量（各平台通用）

| 变量 | 必填 | 说明 |
|---|---|---|
| `RECEIVE_TOKEN` | 是 | 推送鉴权密钥，自己编一个足够长的随机字符串 |
| `ENABLE_AUTH` | 否 | `"true"` 管理页需登录；默认免登录 |
| `ADMIN_PASSWORD` | 否 | 登录密码（`ENABLE_AUTH="true"` 时必填） |
| `RETENTION_DAYS` | 否 | 数据保留天数，默认 30 |
| `FEISHU_WEBHOOK` | 否 | 飞书机器人 Webhook，配置后新消息自动转发飞书群 |
| `SITE_NAME` / `SITE_ICON` | 否 | 网站名 / 图标 URL，未设置用默认值 |

Cloudflare 平台额外需要 `DB`（D1 绑定）；其余平台需要 `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`（Turso 数据库，见各平台教程）。

## 常见问题（通用）

- **标签显示 `{{XXX}}` 字面量** → 不会发生：网关检测到 `{{` 字面量会自动置空，标签回退显示 `sim`；标签名请在模板 `name` 字段直接填自定义名
- **接口 401/403** → 检查 URL 里 `token=` 与 `RECEIVE_TOKEN` 是否一致；`/api/receive`、`/api/push` 不受登录开关影响
- **设备标签改名** → 标签名由消息模板 `name` 字段决定，改 `name` 会生成新标签；旧标签可在网页上合并/删除（无消息时）

## 开发说明

- `src/worker.js`：核心源码（Cloudflare Worker 形态）
- `platforms/gen_app.py`：从 `src/worker.js` 生成平台无关的 `app.js` 并同步到各平台目录（保证六平台业务代码逐字节一致）
- `platforms/*/`：各平台自包含部署目录（入口 + app.js + db.js 适配层 + schema.sql + 本平台教程）
- `docs/多平台接入部署指南.md`：接收端配置文档
- 修改核心代码后：`python platforms/gen_app.py` 重新同步全部平台

## License

[MIT](LICENSE) © 2026 [左立方](https://cbm.im/)
