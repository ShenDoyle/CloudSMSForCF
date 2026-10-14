# CloudSMSForCF — 手机短信接入 Cloudflare 网页

把 Android 手机的短信实时推送到 Cloudflare，通过网页随时查看。基于 SmsForwarder（开源转发 App）+ Cloudflare Workers + D1，无需服务器、零成本、部署约 10 分钟。

```
手机 SmsForwarder ──Webhook POST──▶ Cloudflare Worker ──▶ D1 数据库
                                        │
浏览器 ◀─────────网页管理页（Worker 内嵌）──┘
飞书群 ◀───────备份通道（同一条短信，可选）
```

## 功能

- **实时接收**：手机短信 → Webhook → Worker → D1，秒级入库；网页长轮询自动刷新，无需手动操作
- **网页展示**：
  - 首行【收件手机号】+ 来源号码
  - 自动识别验证码：单独一行 + 一键复制按钮（无验证码不显示该行）
  - 短信内容中的网址自动转为可点击链接
  - 中文格式发送时间
- **收件号标签**：标签显示什么由手机 App 消息模板的 `sim` 字段决定（推荐直接填手机号），顶部标签筛选；无短信的标签可点 × 删除
- **可选登录**：一个开关决定管理页是否需要密码登录（见下文配置项）
- **保留天数可调**：默认 30 天，改个数字即可（见下文配置项）
- **多平台接入**：不止短信——Linux/Windows/macOS/iOS/安卓的通知都能经通用接口 `/api/push` 推进来，网页按「来源」筛选
- **双通道备份**：Cloudflare + 飞书机器人同时推送，防单点丢失（可选）

## 配置项一览

| 名称 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `RETENTION_DAYS` | 变量 | `30` | 数据保留天数，定时任务每天清理超过该天数的短信 |
| `ENABLE_AUTH` | 变量 | `"false"` | `"true"` = 管理页需要登录；`"false"` = 免登录直接看 |
| `ADMIN_PASSWORD` | Secret | 无 | 登录密码，仅 `ENABLE_AUTH="true"` 时需要 |
| `RECEIVE_TOKEN` | Secret | 无 | 手机推送鉴权密钥（必须设置，否则推送被拒绝） |
| `DB` | D1 绑定 | — | D1 数据库绑定，变量名必须是 `DB` |

> 变量与 Secret 的区别：变量（Vars）明文可随时改；Secret（密钥）加密存储写入后不可再查看只能重设。密码和 token 一律用 Secret。

---

# 部署流程（全程网页操作，无需装任何工具）

## 第一步：创建 D1 数据库

1. 登录 [dash.cloudflare.com](https://dash.cloudflare.com)
2. 左侧菜单 **存储和数据库 → D1 SQL 数据库**
3. 点 **创建数据库**，名称填 `sms-gateway-db`（其他默认），点创建
4. 进入刚建好的数据库 → **控制台** 标签页
5. 把 [`schema.sql`](schema.sql) 的全部内容复制粘贴进输入框，点 **执行**
6. 提示执行成功（会创建 `messages` 和 `devices` 两张表）

## 第二步：创建 Worker 并粘贴代码

1. 左侧菜单 **计算（Workers）→ Workers 和 Pages**
2. 点 **创建应用程序 → 创建 Worker**，名称填 `sms-gateway`，点 **部署**（先用默认代码部署成功即可）
3. 点 **编辑代码**，删除编辑器里的全部默认代码
4. 打开本项目的 [`src/worker.js`](src/worker.js)，全选复制，粘贴进编辑器
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

浏览器打开管理页应看到「短信网关」页面（若开了登录则先见登录页）。再验证接收接口（把 `<域名>` 和 `<密钥>` 换成你的）：

```
curl "https://<域名>/api/receive?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"device\":\"test\",\"sim\":\"13800138000\",\"from\":\"10086\",\"content\":\"部署测试\"}"
```

返回 `{"success":true,...}` 即通。这条测试短信可在网页上删除。

### 命令行部署（备选，会装 wrangler 的人用）

```bash
npm install -g wrangler
wrangler login
wrangler d1 execute sms-gateway-db --file=schema.sql --remote
wrangler secret put RECEIVE_TOKEN
wrangler secret put ADMIN_PASSWORD   # 仅开登录时需要
wrangler deploy
```

---

# 手机端配置（SmsForwarder）

1. 手机安装 [SmsForwarder](https://github.com/pppscn/SmsForwarder)（酷安/GitHub 下载，包名 `cn.ppps.forwarder`），授予短信、通知权限并允许后台自启
2. **通用设置 → 打开「转发短信广播」总开关**（⚠️ 最容易漏的一步，关了会静默丢短信，且通道测试全绿也发现不了）
3. **发送通道 → 新建发送通道 → Webhook 通道**：
   - 请求方式：`POST`
   - URL：`https://<你的域名>/api/receive?token=<你的RECEIVE_TOKEN>`
   - 消息模板——**网页上的「收件号标签」显示的就是 `sim` 字段的值，直接填手机号最直观**（改成你自己的号码）：

     ```json
     {"device":"{{DEVICE_NAME}}","sim":"13800138000","from":"{{FROM}}","content":"{{SMS}}","time":"{{DATE}}"}
     ```

   **模板变量说明**：

   | 变量 | 含义 | 用法建议 |
   |---|---|---|
   | `{{SMS}}` | 短信正文 | ⚠️ `content` 必须用它，用别的变量或留空会导致内容混入号码/卡槽/时间等噪音 |
   | `{{FROM}}` | 发件人号码 | 配合 `from` 字段 |
   | `{{DEVICE_NAME}}` | 设备名 | 多台手机时用于区分；单台可留空或不传 |
   | `{{SIM_SLOT}}` | 卡槽代号 | 渲染结果形如 `SIM1_`，**不是手机号**，不建议用作收件号标签 |
   | `{{DATE}}` | 接收时间 | 配合 `time` 字段，留空则按服务器接收时间 |

   **收件号（sim 字段）怎么填**：
   - **单机单卡（最常见）**：直接写死手机号，如上面模板所示 → 网页标签显示 `13800138000`
   - **多台手机**：每台手机各自 App 的模板里写各自的号码
   - **同一台手机双卡需区分**：新建两条 Webhook 通道 + 两条转发规则（SIM 卡 1 的规则选通道 A 且模板 `sim` 填卡 1 号码；卡 2 的规则选通道 B 填卡 2 号码）
   - `sim` 留空 → 标签回退显示设备名
   - 若模板里写了 `{{SIM_SLOT}}` 这类变量但 App 没渲染（推过来是 `{{XXX}}` 字面量），Worker 会自动置空，不会产生脏标签
4. （可选备份通道）**发送通道 → 新建飞书机器人通道**，填群机器人的 Webhook 地址
5. **转发规则 → 新建规则**：消息类型勾「短信」，处理操作选「个人版」→ 同时勾选上面两个通道，启用
6. 用另一部手机给你的号码发条真实短信，网页应秒级出现

---

# 多平台接入（不止短信）：通用推送接口 /api/push

除了手机短信，任何能发 HTTP 请求的设备、脚本、自动化都可以把通知推进同一个网页，与短信一起展示、按来源筛选、同步转发飞书。

**接口**：`POST https://<你的域名>/api/push`（token 也可放 query：`?token=<RECEIVE_TOKEN>`）

**请求字段**（JSON）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `token` | 是 | 鉴权密钥，与 `RECEIVE_TOKEN` 相同 |
| `content` | 是 | 通知正文（别名 `message` / `text` / `msg` 均可） |
| `source` | 否 | 来源标识，默认 `notify`；网页顶部「来源」下拉按它筛选，可自定义（如 `cron`、`nas`、`monitor`） |
| `sender` | 否 | 来源标题，显示在卡片首行（如主机名、App 名、脚本名） |
| `device` | 否 | 标签名，默认「通知网关」；多台设备用不同名字便于筛选 |
| `time` | 否 | 秒/毫秒时间戳或文本时间；留空按服务器接收时间 |

所有平台通用的最小示例：

```bash
curl "https://<你的域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"demo\",\"content\":\"hello from anywhere\"}"
```

返回 `{"success":true,...}` 即入库；完全相同的重复推送返回 `duplicated:true`，不会重复转发飞书。

## 安卓：应用通知转发（SmsForwarder）

复用手机上已装的 SmsForwarder，把微信、银行、购物等各类 App 通知也推上来。

**前置**：SmsForwarder 已授予「通知使用权」（系统设置 → 通知读取权限），并在最近任务里锁定后台、关闭电池优化，防止被杀后台。

1. **发送通道 → 新建发送通道 → Webhook 通道**：
   - 请求方式：`POST`
   - URL：`https://<你的域名>/api/push?token=<RECEIVE_TOKEN>`
   - 消息模板：

     ```json
     {"source":"notify","sender":"{{APP_NAME}}","content":"{{TITLE}}：{{MSG}}","device":"安卓手机"}
     ```

   通知类模板变量：

   | 变量 | 含义 |
   |---|---|
   | `{{APP_NAME}}` | App 名称（如 微信），作 sender 显示在卡片首行 |
   | `{{APP_PKG}}` | App 包名（如 com.tencent.mm） |
   | `{{TITLE}}` | 通知标题 |
   | `{{MSG}}` | 通知正文 |

2. **转发规则 → 新建规则**：
   - 消息类型：勾「应用通知」
   - （可选）只转发指定 App：在规则里勾选要监听的应用
   - 处理操作：选上面新建的 Webhook 通道，启用规则
3. 点通道「测试」或在手机上触发一条真实通知，网页「来源」下拉切到对应来源即可看到
4. 通知转发与短信转发互不影响：同一台手机可同时保留短信链路（`/api/receive`）与通知链路（`/api/push`），各自独立建通道和规则

## iOS / iPadOS：快捷指令

iOS 出于隐私限制，快捷指令**无法自动读取短信正文**，按用途选下面两种方式：

**方式 A：手动转发（能带上原文内容）**

1. 快捷指令 App → 「+」新建，命名如「推送到短信网关」
2. 添加动作 **获取剪贴板**（转发前先复制要推的内容）
3. 添加动作 **获取 URL 内容**：
   - URL：`https://<你的域名>/api/push?token=<RECEIVE_TOKEN>`
   - 方法：`POST`
   - 请求头：`Content-Type` = `application/json`
   - 请求体（JSON）逐个添加字段：`source`=`notify`、`sender`=`iPhone`、`device`=`iOS`、`content`=引用上方「剪贴板」变量
4. 在信息/微信等 App 里复制文字 → 直接运行该快捷指令（可添加到主屏幕或分享菜单）

**方式 B：全自动（适合定时/位置/状态提醒，不涉及读短信）**

1. 快捷指令 → **自动化 → 新建个人自动化**，触发器选「特定时间」「到达某地」「专注模式开启」等
2. 动作同方式 A 第 2–3 步，把「获取剪贴板」换成固定的 **文本** 动作写死内容
3. 关闭「运行前询问」→ 到点自动推送，网页秒收

## Linux：curl + cron / systemd

**第一步：创建推送脚本**

```bash
sudo tee /usr/local/bin/push-note.sh > /dev/null <<'EOF'
#!/usr/bin/env bash
# 用法：push-note.sh "通知内容"
curl -s "https://<你的域名>/api/push?token=<RECEIVE_TOKEN>" \
  -H "Content-Type: application/json" \
  -d "{\"source\":\"notify\",\"sender\":\"$(hostname)\",\"content\":\"$1\",\"device\":\"Linux 服务器\"}"
EOF
sudo chmod +x /usr/local/bin/push-note.sh
```

**第二步：手动测试**

```bash
/usr/local/bin/push-note.sh "手动测试"
# 返回 {"success":true,...} 即通；网页「来源」下拉选 notify 可见
```

**第三步：挂定时（二选一）**

cron 方式（简单任务首选）：

```bash
crontab -e   # 首次会让你选编辑器，选 1 (nano) 即可
# 加入（每 5 分钟检查磁盘，超 90% 推送告警）：
*/5 * * * * use=$(df / | awk 'NR==2{gsub("%","",$5);print $5}'); [ "$use" -ge 90 ] && /usr/local/bin/push-note.sh "根目录使用率 ${use}%"
# crontab -l 确认已保存
```

systemd timer 方式（需要日志与依赖管理时）：

```bash
sudo tee /etc/systemd/system/push-note.service > /dev/null <<'EOF'
[Unit]
Description=Push note to sms gateway

[Service]
Type=oneshot
ExecStart=/usr/local/bin/push-note.sh "每日巡检完成"
EOF

sudo tee /etc/systemd/system/push-note.timer > /dev/null <<'EOF'
[Unit]
Description=Run push-note daily

[Timer]
OnCalendar=*-*-* 09:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now push-note.timer
systemctl list-timers | grep push-note   # 确认已排期
```

排查：curl 加 `-v` 看请求详情；systemd 方式用 `journalctl -u push-note.service` 查日志。

## Windows：PowerShell + 任务计划程序

**第一步：创建脚本**（新建目录 `C:\scripts`，保存为 `C:\scripts\push-note.ps1`）：

```powershell
param([string]$Text = "测试通知")
$body = @{
  token   = "<RECEIVE_TOKEN>"
  source  = "notify"
  sender  = $env:COMPUTERNAME
  content = $Text
  device  = "Windows 主机"
} | ConvertTo-Json
try {
  Invoke-RestMethod -Uri "https://<你的域名>/api/push" -Method Post -ContentType "application/json; charset=utf-8" -Body $body
} catch {
  Write-Host "推送失败: $_"
}
```

**第二步：手动测试**（`-ExecutionPolicy Bypass` 仅对本次进程生效，不改动系统策略）：

```powershell
powershell -ExecutionPolicy Bypass -File C:\scripts\push-note.ps1 "备份完成"
```

**第三步：任务计划程序挂定时**（`Win+R` 输入 `taskschd.msc` 回车）：

1. 右侧点 **创建任务**（不是「基本任务」，选项更全）
2. **常规**：名称填「每日推送」；笔记本按需取消「只有在计算机使用交流电源时才启动此任务」
3. **触发器** → 新建 → 每天 `09:00:00` → 确定
4. **操作** → 新建 → 程序或脚本填 `powershell.exe`，添加参数填
   `-ExecutionPolicy Bypass -File C:\scripts\push-note.ps1 "每日备份已完成"` → 确定
5. **条件/设置**：保持默认即可 → 确定
6. 验证：任务列表里右键该任务 → **运行**，网页应出现一条通知

命令行一步创建（替代上面点选）：

```powershell
schtasks /Create /TN "每日推送" /SC DAILY /ST 09:00 /TR "powershell -ExecutionPolicy Bypass -File C:\scripts\push-note.ps1 '每日备份已完成'"
```

## macOS：快捷指令或 launchd / cron

**快捷指令**：与 iOS 做法完全相同（方式 A 手动转发 / 方式 B 自动化），`device` 可填 `macOS`。

**脚本定时**：

```bash
# 创建脚本（同 Linux，sender 取电脑名，device 改成 macOS）
cat > ~/push-note.sh > /dev/null <<'EOF'
#!/usr/bin/env bash
curl -s "https://<你的域名>/api/push?token=<RECEIVE_TOKEN>" \
  -H "Content-Type: application/json" \
  -d "{\"source\":\"notify\",\"sender\":\"$(scutil --get ComputerName)\",\"content\":\"$1\",\"device\":\"macOS\"}"
EOF
chmod +x ~/push-note.sh
~/push-note.sh "手动测试"
```

launchd 方式（macOS 官方定时机制，重启后自动生效）：

```bash
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/cbm.pushnote.plist > /dev/null <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>cbm.pushnote</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/你的用户名/push-note.sh</string>
    <string>早晨日报</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/cbm.pushnote.plist   # 卸载用 launchctl unload
launchctl list | grep pushnote   # 确认已加载
```

> plist 里的脚本路径必须写绝对路径，把 `你的用户名` 换成实际用户名。

cron 方式（macOS 仍支持）：`crontab -e` 加入 `0 9 * * * /Users/你的用户名/push-note.sh "早晨日报"`。

> 进阶：已使用 [Apprise](https://github.com/caronc/apprise)、ntfy 等通知聚合工具的设备，可在其自定义 JSON Webhook / 脚本输出里对接本接口，无需逐台改脚本。

**多平台接入验证清单**：

1. curl/脚本推送一条 → 接口返回 `success:true`
2. 网页「来源」下拉切到对应 source（或「全部」）→ 卡片出现，左上角显示来源徽章与 sender
3. 同一条重复推送 → 返回 `duplicated:true`，飞书群不重复收到

---

# 管理页登录开关（ENABLE_AUTH）

| 场景 | 做法 |
|---|---|
| 免登录（默认，个人内网用） | `ENABLE_AUTH = "false"`，网页直接看 |
| 需要登录（公网防偷看） | ① 添加 Secret `ADMIN_PASSWORD` 设好密码；② 把 `ENABLE_AUTH` 改为 `"true"`；③ 生效后打开网页会先看到登录页，输入密码进入，凭证保持 7 天 |
| 修改密码 | Dashboard 里重新设置 `ADMIN_PASSWORD`（Secret 不可查看只能重设），旧登录凭证随密码变更立即失效 |
| 关闭登录 | 把 `ENABLE_AUTH` 改回 `"false"`，所有登录要求立即消失 |

注意：手机推送接口 `/api/receive` 不受此开关影响，始终靠 `RECEIVE_TOKEN` 鉴权。

# 收件号标签

网页顶部筛选标签和短信卡片首行【收件号】显示的都是入库 `sim` 字段的值，完全由 App 消息模板决定，服务端不做任何映射：

- 模板 `sim` 直接填手机号 → 标签显示手机号（推荐）
- `sim` 留空 → 标签回退显示设备名（`device` 字段）
- 变量未渲染（`{{XXX}}` 字面量）→ Worker 自动置空，按留空处理

改收件号显示 = 改手机 App 里的消息模板，重新发一条短信即生效。

# API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST/GET` | `/api/receive?token=<密钥>` | 接收短信（兼容 JSON/表单/纯文本/query，字段多别名） |
| `POST` | `/api/push` | 通用推送（多平台通知），字段说明见「多平台接入」一节 |
| `GET` | `/api/messages?device_id=&q=&page=&limit=` | 分页查短信 |
| `DELETE` | `/api/messages/<id>` | 删除单条 |
| `GET` | `/api/devices` | 设备列表（含条数/最近时间） |
| `POST` | `/api/devices/alias` | 设置设备别名 |
| `DELETE` | `/api/devices/<id>` | 删除设备标签（仅当其短信已清空） |
| `GET` | `/api/wait?last_id=N` | 长轮询：有比 N 新的消息立即返回，最多挂起 25 秒 |
| `POST` | `/api/login` | 登录（仅 `ENABLE_AUTH="true"`） |
| `POST` | `/api/logout` | 退出登录 |
| `GET` | `/` | 网页管理页 |

# 常见问题

- **通道「测试」通过但真实短信不上来** → 99% 是「转发短信广播」总开关没开；App 转发日志为空是关键证据
- **网页内容混入号码/卡槽/SubId/时间噪音** → Webhook 消息模板 `content` 没用 `{{SMS}}`，或模板留空走了默认全量模板
- **标签显示 `{{SIM_SLOT}}` 之类字面量** → 不会发生：Worker 检测到 `{{` 字面量会自动置空；要让标签显示手机号，请在模板 `sim` 字段直接填号码
- **自行修改内嵌页面后白屏卡「加载中」** → 内嵌 HTML 必须用 `String.raw` 包裹模板字符串，否则 JS 转义序列（`\b`/`\d`/`\s`）会被运行时解析破坏
- **密钥更换** → Dashboard Secret 与手机 URL 中 `token=` 两处必须同步
- **`/api/push` 推送成功但网页看不到** → 「来源」下拉还选着「短信」；切回「全部」或对应 source
- **通知类消息首行显示什么** → 左上角绿色徽章是 `source`，其后是 `sender`；都没填则显示「通知」/「通知网关」

---

# 许可证

[MIT License](LICENSE) © 2026 [左立方](https://cbm.im)
