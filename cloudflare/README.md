# Cloudflare 部署教程（主版本，全程网页操作）

这是项目的主版本：手机短信/通知 → Cloudflare Worker → D1 数据库 → 网页管理页。
无需服务器、免费额度充足、全程网页点击即可完成，无需安装任何工具。

本目录是文档；代码在 [`../src/worker.js`](../src/worker.js)，配置在 [`../wrangler.toml`](../wrangler.toml)。

---

## 准备工作

1. 一个 Cloudflare 账号（[注册入口](https://dash.cloudflare.com/sign-up)，免费，邮箱即可）
2. 本项目代码（页面上的 `src/worker.js` 就是要粘贴的全部代码）

## 第一步：创建 D1 数据库

1. 登录 [dash.cloudflare.com](https://dash.cloudflare.com)
2. 左侧菜单 **存储和数据库 → D1 SQL 数据库**
3. 点 **创建数据库**，名称填 `sms-gateway-db`（其他默认），点创建
4. 进入刚建好的数据库 → **控制台** 标签页
5. 把 [`schema.sql`](../schema.sql) 的全部内容复制粘贴进输入框，点 **执行**
6. 提示执行成功（会创建 `messages` 和 `devices` 两张表）

## 第二步：创建 Worker 并粘贴代码

1. 左侧菜单 **计算（Workers）→ Workers 和 Pages**
2. 点 **创建应用程序 → 创建 Worker**，名称填 `sms-gateway`，点 **部署**（先用默认代码部署成功即可）
3. 点 **编辑代码**，删除编辑器里的全部默认代码
4. 打开本项目的 [`src/worker.js`](../src/worker.js)，全选复制，粘贴进编辑器
5. 点右上角 **部署**，提示部署成功

## 第三步：绑定 D1 数据库

1. 回到 Worker 概览页 → **设置 → 绑定**
2. 点 **添加 → D1 数据库**
3. 变量名称填 `DB`（必须一模一样，大写），选择刚建的 `sms-gateway-db`
4. 点 **部署/保存**

## 第四步：设置变量与密钥

同一位置 **设置 → 变量和机密（Variables and Secrets）**，逐个添加：

1. **添加变量**（类型选「文本」）：
   - 名称 `RETENTION_DAYS`，值 `30`（想保留 90 天就填 `90`）
   - 名称 `ENABLE_AUTH`，值 `false`（要登录就填 `true`）
   - 名称 `SITE_NAME`（可选），值自定义网站名，如 `我的短信站`
   - 名称 `SITE_ICON`（可选），值图标 URL（`http(s)://` 开头）；不填或 URL 失效自动用内置图标
2. **添加密钥**（类型选「密钥/Secret」）：
   - 名称 `RECEIVE_TOKEN`，值自己编一个足够长的随机字符串（不要使用任何教程示例值，越长越好）
   - 名称 `ADMIN_PASSWORD`，值自己编一个管理页登录密码（仅当 `ENABLE_AUTH="true"` 时才需要）
3. 每次添加后点 **部署/保存**

> 改这些值随时生效，不用重新粘贴代码。修改 `RECEIVE_TOKEN` 后记得同步更新手机端 URL 里的 `token=`。

## 第五步：设置定时清理任务

1. Worker → **设置 → 触发事件 → Cron 触发器**
2. 点 **添加 Cron 触发器**，填 `0 17 * * *`，保存
3. 含义：每天 UTC 17:00（北京时间凌晨 1 点）自动删除超过保留天数的数据

## 第六步：绑定域名（可选，推荐）

1. Worker → **设置 → 域和路由**
2. 点 **添加 → 自定义域**，填一个子域名（如 `sms.你的域名.com`）
3. Cloudflare 自动创建 DNS 记录并签发 HTTPS 证书，几分钟内生效
4. 之后浏览器直接访问 `https://sms.你的域名.com` 即为管理页

> 没有域名也可用默认的 `https://sms-gateway.<你的子域>.workers.dev` 地址。

## 第七步：验证部署

浏览器打开管理页应看到你的网站名页面（默认「短信网关」，可用 `SITE_NAME` 改；若开了登录则先见登录页）。再验证接收接口（把 `<域名>` 和 `<密钥>` 换成你的）：

```
curl "https://<域名>/api/receive?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"name\":\"test\",\"sim\":\"13800138000\",\"from\":\"10086\",\"content\":\"部署测试\"}"
```

返回 `{"success":true,...}` 即通。这条测试短信可在网页上删除。

## 接入手机端

按 [多平台接入部署指南](../docs/多平台接入部署指南.md) 配置安卓 SmsForwarder 与各设备通知推送，把接口域名换成你的 Worker 地址即可。

## 命令行部署（备选，会装 wrangler 的人用）

```bash
npm install -g wrangler
wrangler login
wrangler d1 execute sms-gateway-db --file=schema.sql --remote
wrangler secret put RECEIVE_TOKEN
wrangler secret put ADMIN_PASSWORD   # 仅开登录时需要
wrangler deploy
```

## 注意事项与常见问题

- **收不到转发短信**：依次排查 ① SmsForwarder 通用设置「转发短信广播」总开关（最容易漏，关了会静默丢弃且通道测试全绿）→ ② 转发规则的 token/URL 是否与 Worker 密钥一致 → ③ Worker 实时日志看请求是否到达
- **Worker 免费额度**：每天 10 万次请求，个人使用绰绰有余；D1 免费额度每天 500 万行读取
- **长轮询**：管理页 `/api/wait` 挂起最长 25 秒等待新消息，Workers 无请求时长问题，实时性最好
- **数据迁移**：从其他平台迁回 CF 时，导出 Turso 数据再导入 D1 即可（表结构完全一致）
