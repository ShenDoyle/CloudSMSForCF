/**
 * SMS Gateway (SMSToWeb) — Cloudflare Worker
 * 接收 SmsForwarder(短信转发器) Webhook 推送的短信，存入 D1，提供 JSON API 与 Web 管理页。
 * 设备标签（网页标签展示值）由 App 消息模板的 name 字段提供（自定义名称）；sim 填收件手机号，
 * 在卡片右下角展示，双击可复制。
 *
 * 除短信外，任何平台（Linux/Windows/macOS/iOS/安卓等）均可通过通用推送接口
 * POST /api/push 提交通知类消息，与短信一起在管理页按「来源」筛选查看。
 *
 * 可配置项（部署时在 Variables / wrangler.toml [vars] 设置）：
 *   RETENTION_DAYS   — 数据保留天数，默认 30（每天 UTC 17:00 定时清理）
 *   ENABLE_AUTH      — 管理页登录开关："true" 需密码登录，"false" 免登录（默认）
 *   FEISHU_WEBHOOK   — 飞书机器人 Webhook（可选）：绑定后收到新消息自动转发到飞书群
 *   SITE_NAME        — 网站名（可选）：管理页标题/页头，默认「短信网关」
 *   SITE_ICON        — 网站图标 URL（可选）：默认 jsdelivr favicon；设置了但加载失败自动回退默认
 *   （Secret）RECEIVE_TOKEN   — 推送鉴权（/api/receive 与 /api/push 共用）
 *   （Secret）ADMIN_PASSWORD  — 登录密码（仅 ENABLE_AUTH="true" 时需要）
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Receive-Token, Authorization",
  "Access-Control-Max-Age": "86400",
};

const DEFAULT_RETENTION_DAYS = 30;

/* 站名与图标：可用变量 SITE_NAME / SITE_ICON 覆盖；图标设置了但加载失败时前端自动回退默认 */
const DEFAULT_SITE_NAME = "短信网关";
const DEFAULT_SITE_ICON = "https://cdn.jsdelivr.net/gh/ShenDoyle/ShenDoyle.github.io@main/img/site/favicon.ico";

function siteName(env) {
  return (String(env.SITE_NAME || "").trim() || DEFAULT_SITE_NAME).slice(0, 40);
}
function siteIcon(env) {
  const v = String(env.SITE_ICON || "").trim();
  return /^https?:\/\/\S+$/i.test(v) ? v : DEFAULT_SITE_ICON;
}
function escAttr(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
/* 注入 JS 字符串字面量：JSON 转义并把 < 转 unicode，防止值里出现 </script> 提前闭合 */
function jsStr(s) {
  return JSON.stringify(s).replace(/</g, "\\u003c");
}
/* 把页面模板中的占位标记替换为实际配置值（用函数替换器，避免值里含 $& 等特殊序列被误解释） */
function renderHtml(html, env) {
  return html
    .replace(/__SITE_NAME__/g, function () { return escAttr(siteName(env)); })
    .replace(/__SITE_NAME_JSON__/g, function () { return jsStr(siteName(env)); })
    .replace(/__SITE_ICON__/g, function () { return escAttr(siteIcon(env)); })
    .replace(/__DEFAULT_ICON_JSON__/g, function () { return jsStr(DEFAULT_SITE_ICON); });
}

/* 设备标签（网页标签展示值）由 App 消息模板的 name 字段提供，自定义命名；
   sim 填收件手机号，展示在卡片右下角（双击复制）。未渲染的 {{变量}} 字面量在接收时被置空。 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function nowUTC() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/** 时序安全的 token 比较（避免 timing 泄露） */
function safeEqual(a, b) {
  const ba = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

/* ---------------- 管理页登录（可选，由 ENABLE_AUTH 开关控制） ---------------- */

const AUTH_COOKIE = "sms_auth";

/* 开关是否处于开启状态（仅字符串 "true" 视为开启） */
function authEnabled(env) {
  return String(env.ENABLE_AUTH || "").trim().toLowerCase() === "true";
}

/* 无状态登录凭证：SHA-256("sms-gateway-auth-v1|" + 密码)，密码不变则凭证稳定，无需存储 */
async function authCookieValue(password) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("sms-gateway-auth-v1|" + password)
  );
  return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

/* 管理接口/页面统一鉴权：开关关闭直接放行；开启则校验登录 cookie */
async function isAuthed(request, env) {
  if (!authEnabled(env)) return true;
  if (!env.ADMIN_PASSWORD) return false; /* 开启登录但未设密码 → 一律拒绝（安全默认） */
  return getCookie(request, AUTH_COOKIE) === (await authCookieValue(env.ADMIN_PASSWORD));
}

async function handleLogin(request, env) {
  if (!authEnabled(env) || !env.ADMIN_PASSWORD) return json({ success: false, error: "auth disabled" }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ success: false, error: "invalid json" }, 400); }
  const pw = body && body.password !== undefined ? String(body.password) : "";
  if (!pw || !safeEqual(pw, env.ADMIN_PASSWORD)) return json({ success: false, error: "wrong password" }, 403);
  const token = await authCookieValue(env.ADMIN_PASSWORD);
  return new Response(JSON.stringify({ success: true }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": AUTH_COOKIE + "=" + token + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800",
      ...CORS,
    },
  });
}

function handleLogout() {
  return new Response(JSON.stringify({ success: true }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": AUTH_COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
      ...CORS,
    },
  });
}

/**
 * 解析 SmsForwarder webhook 请求为统一结构
 * 兼容：JSON / 表单 / 纯文本 / query 参数；字段名多别名兼容（含中文模板变量名）
 */
async function parseIncoming(request, url) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  let raw = {};
  if (ct.includes("application/json")) {
    try { raw = await request.json(); } catch { return null; }
  } else if (ct.includes("urlencoded") || ct.includes("form-data")) {
    try {
      const form = await request.formData();
      for (const [k, v] of form.entries()) raw[k] = v;
    } catch { return null; }
  } else {
    const text = await request.text();
    try { raw = JSON.parse(text); } catch { raw = { content: text }; }
  }
  // query 参数兜底（SmsForwarder GET 转发场景）
  for (const k of ["token", "name", "device", "sim", "from", "content", "time"]) {
    if (raw[k] === undefined && url.searchParams.get(k) !== null) {
      raw[k] = url.searchParams.get(k);
    }
  }
  const pick = (...keys) => {
    for (const k of keys) {
      const v = raw[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
    return "";
  };
  return {
    token: pick("token", "access_token", "key"),
    name: pick("name", "device", "device_name", "设备名", "设备信息", "sim_info"),
    sim: pick("sim", "sim_slot", "卡槽信息", "card"),
    from: pick("from", "sender", "phone", "发送号码", "mobile", "address"),
    content: pick("content", "text", "body", "短信内容", "message", "msg"),
    time: pick("time", "timestamp", "date", "接收时间", "received_time"),
  };
}

/**
 * 时间标准化：统一为 UTC "YYYY-MM-DD HH:MM:SS"
 * 秒/毫秒时间戳 -> 精确解析；无时区的文本时间按北京时间(+08:00)解析
 */
function normalizeTime(t) {
  if (!t) return nowUTC();
  const s = String(t).trim();
  const toStr = (d) => d.toISOString().replace("T", " ").slice(0, 19);
  if (/^\d{10}$/.test(s)) return toStr(new Date(Number(s) * 1000));
  if (/^\d{13}$/.test(s)) return toStr(new Date(Number(s)));
  const withTZ = /Z$|[+-]\d{2}:?\d{2}$/.test(s) ? s.replace(" ", "T") : s.replace(" ", "T") + "+08:00";
  const d = new Date(withTZ);
  return isNaN(d.getTime()) ? nowUTC() : toStr(d);
}

/* ---------------- 飞书机器人转发（可选，绑定 FEISHU_WEBHOOK 后自动启用） ---------------- */

/* UTC 时间串 → 北京时间串（用于飞书消息展示） */
function bjTime(utcStr) {
  const d = new Date(String(utcStr || "").replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return String(utcStr || "");
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) + "（北京时间）";
}

/* 转发一条消息到飞书群；未配置 Webhook 或发送失败均不影响主流程 */
async function forwardFeishu(env, head, content, timeStr) {
  const hook = env.FEISHU_WEBHOOK;
  if (!hook) return;
  try {
    await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msg_type: "text",
        content: { text: head + "\n" + String(content || "") + (timeStr ? "\n" + timeStr : "") },
      }),
    });
  } catch (e) {
    console.error("feishu forward failed:", e && e.message);
  }
}

/* ---------------- 接收（短信：SmsForwarder 等 App Webhook） ---------------- */

async function handleReceive(request, env, url, ctx) {
  const data = await parseIncoming(request, url);
  if (!data) return json({ success: false, error: "invalid body" }, 400);

  // 鉴权：token 可在 query 或 body，与 Secret 比对
  const provided = url.searchParams.get("token") || data.token;
  if (!env.RECEIVE_TOKEN || !provided || !safeEqual(provided, env.RECEIVE_TOKEN)) {
    return json({ success: false, error: "unauthorized" }, 403);
  }
  if (!data.content) return json({ success: false, error: "empty content" }, 400);

  // App 变量未渲染时值为 {{XXX}} 字面量：置空避免产生脏标签（标签名请在 App 模板中直接填自定义名称）
  if (String(data.name).indexOf("{{") !== -1) data.name = "";
  if (String(data.sim).indexOf("{{") !== -1) data.sim = "";

  // 设备注册/复用：name + sim 唯一（devices.device 列存 App 模板的 name 字段；改 name 会生成新标签）
  const dev = await env.DB.prepare(
    "INSERT INTO devices(device, sim) VALUES(?1, ?2) " +
    "ON CONFLICT(device, sim) DO UPDATE SET device = excluded.device RETURNING id"
  ).bind(data.name, data.sim).first();
  if (!dev || dev.id === undefined) return json({ success: false, error: "device upsert failed" }, 500);

  // 去重：同设备+发件人+内容+秒级时间 视为重复（SmsForwarder 重试场景）；重复不重复转发
  const receivedAt = normalizeTime(data.time);
  const ins = await env.DB.prepare(
    "INSERT OR IGNORE INTO messages(device_id, sender, content, received_at, source) VALUES(?1, ?2, ?3, ?4, 'sms')"
  ).bind(dev.id, data.from, data.content, receivedAt).run();
  const duplicated = ins.meta && ins.meta.changes === 0;

  if (!duplicated) {
    const head = "【短信】" + (data.sim || "未知收件号") + (data.from ? " ← " + data.from : "");
    ctx.waitUntil(forwardFeishu(env, head, data.content, bjTime(receivedAt)));
  }

  return json({
    success: true,
    device_id: dev.id,
    duplicated,
  });
}

/* ---------------- 通用推送（多平台接入）：POST /api/push ----------------
 * body(JSON): { token, source, sender/title, content, time, name }
 *   source — 来源标识，默认 "notify"（管理页来源筛选用，如 notify/sms/自定义）
 *   sender — 来源标题（如主机名、App 名、脚本名），可空
 *   name   — 设备标签名（与短信标签并列展示），默认「通知网关」；兼容旧字段 device
 */
async function handlePush(request, env, url, ctx) {
  let body;
  try { body = await request.json(); } catch { return json({ success: false, error: "invalid json" }, 400); }
  if (!body || typeof body !== "object") return json({ success: false, error: "invalid body" }, 400);

  const provided = url.searchParams.get("token") || body.token;
  if (!env.RECEIVE_TOKEN || !provided || !safeEqual(provided, env.RECEIVE_TOKEN)) {
    return json({ success: false, error: "unauthorized" }, 403);
  }
  const content = String(body.content || body.text || body.message || body.msg || "").trim();
  if (!content) return json({ success: false, error: "empty content" }, 400);

  const source = (String(body.source || "notify").trim() || "notify").slice(0, 20);
  const sender = String(body.sender || body.title || body.from || "").trim().slice(0, 100);
  const deviceName = (String(body.name || body.device || "通知网关").trim() || "通知网关").slice(0, 50);

  const dev = await env.DB.prepare(
    "INSERT INTO devices(device, sim) VALUES(?1, '') " +
    "ON CONFLICT(device, sim) DO UPDATE SET device = excluded.device RETURNING id"
  ).bind(deviceName).first();
  if (!dev || dev.id === undefined) return json({ success: false, error: "device upsert failed" }, 500);

  const receivedAt = normalizeTime(body.time);
  const ins = await env.DB.prepare(
    "INSERT OR IGNORE INTO messages(device_id, sender, content, received_at, source) VALUES(?1, ?2, ?3, ?4, ?5)"
  ).bind(dev.id, sender, content, receivedAt, source).run();
  const duplicated = ins.meta && ins.meta.changes === 0;

  if (!duplicated) {
    const head = "【" + source + "】" + (sender ? sender + " · " : "") + deviceName;
    ctx.waitUntil(forwardFeishu(env, head, content, bjTime(receivedAt)));
  }

  return json({ success: true, device_id: dev.id, duplicated });
}

/* ---------------- 查询 / 管理 API ---------------- */

async function handleListMessages(url, env) {
  const deviceId = parseInt(url.searchParams.get("device_id") || "", 10);
  const q = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10) || 20));

  const source = (url.searchParams.get("source") || "").trim();

  const where = [];
  const params = [];
  if (Number.isInteger(deviceId) && deviceId > 0) {
    where.push("m.device_id = ?");
    params.push(deviceId);
  }
  if (source) {
    where.push("m.source = ?");
    params.push(source);
  }
  if (q) {
    where.push("(m.content LIKE ? OR m.sender LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages m ${whereSql}`
  ).bind(...params).first();
  const total = totalRow ? totalRow.n : 0;

  const list = await env.DB.prepare(
    `SELECT m.id, m.sender, m.content, m.received_at, m.device_id, m.source,
            COALESCE(NULLIF(d.alias, ''), d.device) AS device_name, d.sim, d.device
     FROM messages m JOIN devices d ON d.id = m.device_id
     ${whereSql}
     ORDER BY m.received_at DESC, m.id DESC
     LIMIT ? OFFSET ?`
  ).bind(...params, limit, (page - 1) * limit).all();

  const rows = list.results || [];
  for (const r of rows) r.sim_number = r.sim || "";

  return json({
    success: true,
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    list: rows,
  });
}

async function handleDeleteMessage(idParam, env) {
  const id = parseInt(idParam, 10);
  if (!Number.isInteger(id) || id <= 0) return json({ success: false, error: "invalid id" }, 400);
  const res = await env.DB.prepare("DELETE FROM messages WHERE id = ?1").bind(id).run();
  return json({ success: true, deleted: res.meta ? res.meta.changes : 0 });
}

async function handleListDevices(env) {
  const list = await env.DB.prepare(
    `SELECT d.id, d.device, d.sim, d.alias,
            COALESCE(NULLIF(d.alias, ''), d.device) AS display_name,
            COUNT(m.id) AS msg_count, MAX(m.received_at) AS last_at
     FROM devices d LEFT JOIN messages m ON m.device_id = d.id
     GROUP BY d.id
     ORDER BY last_at DESC`
  ).all();
  // 标签显示优先级：别名 > 设备名（App 模板 name 字段，自定义） > 收件号（sim） > 未命名设备
  const rows = (list.results || []).map(function (r) {
    if (!r.alias) r.display_name = r.device || r.sim || "未命名设备";
    return r;
  });
  return json({ success: true, list: rows });
}

async function handleSetAlias(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ success: false, error: "invalid json" }, 400); }
  const id = parseInt(body && body.id, 10);
  const alias = body && body.alias !== undefined ? String(body.alias).trim().slice(0, 50) : null;
  if (!Number.isInteger(id) || id <= 0) return json({ success: false, error: "invalid device id" }, 400);
  await env.DB.prepare("UPDATE devices SET alias = ?1 WHERE id = ?2").bind(alias, id).run();
  return json({ success: true });
}

/* 删除设备（tag）：仅在无短信时可删，防止误删有数据的记录 */
async function handleDeleteDevice(idParam, env) {
  const id = parseInt(idParam, 10);
  if (!Number.isInteger(id) || id <= 0) return json({ success: false, error: "invalid id" }, 400);
  const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE device_id = ?1").bind(id).first();
  if (cnt && cnt.n > 0) return json({ success: false, error: "has messages" }, 400);
  const res = await env.DB.prepare("DELETE FROM devices WHERE id = ?1").bind(id).run();
  return json({ success: true, deleted: res.meta ? res.meta.changes : 0 });
}

/* 长轮询：最多挂起 25s，期间每 2s 查一次是否有比 last_id 更新的消息；
   有则立即返回 changed=true（前端收到后刷新列表），实现推送式自动刷新 */
async function handleWait(url, env) {
  const lastId = parseInt(url.searchParams.get("last_id") || "0", 10) || 0;
  const deviceId = parseInt(url.searchParams.get("device_id") || "", 10);
  const filter = Number.isInteger(deviceId) && deviceId > 0;
  const deadline = Date.now() + 25000;
  for (;;) {
    const sql = filter
      ? "SELECT MAX(id) AS n FROM messages WHERE device_id = ?1"
      : "SELECT MAX(id) AS n FROM messages";
    const row = await (filter ? env.DB.prepare(sql).bind(deviceId) : env.DB.prepare(sql)).first();
    if (row && row.n > lastId) return json({ success: true, changed: true });
    if (Date.now() > deadline) return json({ success: true, changed: false });
    await new Promise(function (r) { setTimeout(r, 2000); });
  }
}

/* ---------------- Web 管理界面（登录开关 ENABLE_AUTH 控制） ---------------- */

/* String.raw：内嵌前端源码按原文下发，防止模板字面量把 \b \d \s \/ 当转义序列吃掉 */
const PAGE_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="__SITE_ICON__">
<title>__SITE_NAME__</title>
<style>
  :root {
    --bg: #f5f6f7; --card: #fff; --text: #20242a; --muted: #6b7280; --faint: #9aa3ab;
    --border: #d8dce0; --card-border: #e3e6e9; --row-border: #eef1f3;
    --accent: #15803d; --accent-deep: #116632;
    --badge-bg: #e7f4ec; --sender: #0f766e; --link: #2563eb;
    --code-bg: #fef3c7; --code-border: #fcd34d; --code-text: #92400e; --code-hover: #fde68a;
    --del: #9aa3ab; --del-hover: #b91c1c; --tabx: #e8b4b4;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14171a; --card: #1d2126; --text: #e6e9ec; --muted: #9aa3ab; --faint: #6b7480;
      --border: #33393f; --card-border: #2a3036; --row-border: #262c31;
      --accent: #22a04f; --accent-deep: #1a8a41;
      --badge-bg: #12351f; --sender: #4fd1a5; --link: #6ea8ff;
      --code-bg: #3a2f14; --code-border: #6b5518; --code-text: #fbd46d; --code-hover: #4a3c1a;
      --del: #6b7480; --del-hover: #f87171; --tabx: #8a4a4a;
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: var(--bg); color: var(--text); padding: 0 0 40px; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 18px; margin: 8px 0 12px; }
  .tabs { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 8px; margin-bottom: 8px; }
  .tab { flex: none; padding: 5px 12px; border: 1px solid var(--border); border-radius: 999px;
         background: var(--card); cursor: pointer; font-size: 13px; color: var(--text); white-space: nowrap; }
  .tab.active { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 8px; }
  .toolbar input[type=search] { flex: 1; padding: 8px 12px; border: 1px solid var(--border);
         border-radius: 8px; font-size: 14px; background: var(--card); color: var(--text); }
  .toolbar select { padding: 8px 8px; border: 1px solid var(--border); border-radius: 8px;
         font-size: 13px; background: var(--card); color: var(--text); }
  .opts { display: flex; gap: 16px; margin: 0 0 10px; font-size: 12px; color: var(--muted); }
  .opt { cursor: pointer; user-select: none; }
  .opt input { vertical-align: -2px; margin-right: 4px; accent-color: var(--accent); }
  .meta { display: flex; justify-content: space-between; align-items: center;
          color: var(--muted); font-size: 12px; margin-bottom: 8px; }
  .list { display: flex; flex-direction: column; gap: 8px; }
  .daysep { font-size: 12px; color: var(--faint); font-weight: 600; margin: 10px 4px 0; }
  .card { background: var(--card); border: 1px solid var(--card-border); border-radius: 10px; padding: 10px 12px;
          animation: slidein .25s ease-out; }
  @keyframes slidein { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .row1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-bottom: 6px; margin-bottom: 6px; border-bottom: 1px solid var(--row-border); }
  .sender { font-weight: 700; font-size: 16px; color: var(--sender); }
  .del { margin-left: auto; border: none; background: none; color: var(--del); cursor: pointer; font-size: 12px; padding: 2px 4px; }
  .del:hover { color: var(--del-hover); }
  .srctag { flex: none; font-size: 11px; font-weight: 700; color: var(--badge-bg); background: var(--accent);
            border-radius: 5px; padding: 1px 7px; }
  .code-line { margin: 6px 0 2px; color: var(--code-text); }
  .code-line b { font-size: 17px; letter-spacing: 1px; margin-right: 8px;
                 font-family: ui-monospace, Consolas, monospace; background: var(--code-bg);
                 padding: 0 6px; border-radius: 5px; }
  .copy { border: 1px solid var(--code-border); background: var(--code-bg); color: var(--code-text);
          border-radius: 6px; padding: 1px 10px; cursor: pointer; font-size: 12px; }
  .copy:hover { background: var(--code-hover); }
  .line { margin-top: 4px; }
  .content { word-break: break-word; white-space: pre-wrap; }
  .content a { color: var(--link); word-break: break-all; }
  .time-line { color: var(--faint); font-size: 12px; cursor: default; }
  .foot-line { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .recv { flex: none; font-weight: 600; font-size: 12px; color: var(--muted); cursor: pointer; user-select: none; }
  .recv:hover { color: var(--text); }
  .empty { text-align: center; color: var(--faint); padding: 40px 0; }
  .pager { display: flex; gap: 8px; justify-content: center; align-items: center; margin-top: 16px; }
  .pager button { padding: 6px 14px; border: 1px solid var(--border); border-radius: 8px;
                  background: var(--card); color: var(--text); cursor: pointer; font-size: 13px; }
  .pager button:disabled { opacity: .4; cursor: default; }
  .tabx { margin-left: 2px; color: var(--tabx); font-weight: 700; padding: 0 2px; }
  .tabx:hover { color: var(--del-hover); }
  .toast { position: fixed; left: 50%; bottom: 48px; transform: translate(-50%, 12px);
           background: #111827; color: #fff; padding: 9px 18px; border-radius: 999px;
           font-size: 13px; opacity: 0; pointer-events: none; transition: all .25s ease; z-index: 99; }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }
  .foot { text-align: center; font-size: 12px; margin-top: 28px; color: var(--faint); }
  .foot a { color: var(--faint); }
  .gh { position: fixed; top: 14px; right: 14px; color: var(--faint); opacity: .75;
        transition: opacity .2s, color .2s; z-index: 50; }
  .gh:hover { opacity: 1; color: var(--text); }
  @media (prefers-color-scheme: dark) {
    .toast { background: #e6e9ec; color: #14171a; }
  }
</style>
</head>
<body>
<a class="gh" href="https://github.com/ShenDoyle/SMSToWeb" target="_blank" rel="noopener noreferrer" title="GitHub 仓库" aria-label="GitHub 仓库">
  <svg viewBox="0 0 16 16" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
</a>
<div class="wrap">
  <h1>__SITE_NAME__</h1>
  <div class="tabs" id="tabs"></div>
  <div class="toolbar">
    <input type="search" id="q" placeholder="搜索发件人或内容…">
    <select id="src" title="按来源筛选">
      <option value="">全部来源</option>
      <option value="sms">短信</option>
      <option value="notify">通知</option>
    </select>
  </div>
  <div class="opts">
    <label class="opt"><input type="checkbox" id="autocopy">自动复制验证码</label>
    <label class="opt"><input type="checkbox" id="notifyon">后台通知</label>
  </div>
  <div class="meta"><span id="stat"></span><span id="pageinfo"></span></div>
  <div class="list" id="list"><div class="empty">加载中…</div></div>
  <div class="pager">
    <button id="prev">上一页</button>
    <span id="pagenum"></span>
    <button id="next">下一页</button>
  </div>
</div>
<footer class="foot">© 2026 <a href="https://cbm.im/" target="_blank" rel="noopener noreferrer">左立方</a> · <a href="https://github.com/ShenDoyle/SMSToWeb" target="_blank" rel="noopener noreferrer">SMSToWeb</a></footer>
<script>
(function () {
  var SITE_NAME = __SITE_NAME_JSON__;
  /* 图标回退：SITE_ICON 设置了但加载失败时，自动换回默认图标 */
  (function () {
    var l = document.querySelector('link[rel="icon"]'); if (!l) return;
    var def = __DEFAULT_ICON_JSON__;
    if (!def || l.getAttribute("href") === def) return;
    var img = new Image();
    img.onerror = function () { l.href = def; };
    img.src = l.getAttribute("href");
  })();
  var state = {
    device: 0, src: "", q: "", page: 1, pages: 1, total: 0, lastId: 0, deb: null,
    inited: false, unread: 0,
    autoCopy: (function () { try { return localStorage.getItem("sms_autocopy") !== "0"; } catch (e) { return true; } })(),
    notify: (function () { try { return localStorage.getItem("sms_notify") !== "0"; } catch (e) { return true; } })()
  };
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function parseUTC(utc) {
    var d = new Date(String(utc).replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? null : d;
  }
  function partsOf(d) {
    var parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(d);
    var v = {};
    for (var i = 0; i < parts.length; i++) v[parts[i].type] = parts[i].value;
    var pad = function (s) { s = String(s); return s.length < 2 ? "0" + s : s; };
    v.pmonth = pad(v.month); v.pday = pad(v.day);
    v.phour = pad(v.hour); v.pminute = pad(v.minute); v.psecond = pad(v.second);
    return v;
  }
  function fmtTime(utc) {
    var d = parseUTC(utc);
    if (!d) return String(utc || "");
    var v = partsOf(d);
    return v.year + "年" + v.pmonth + "月" + v.pday + "日 " + v.phour + ":" + v.pminute + ":" + v.psecond;
  }
  /* 相对时间：刚刚 / N 分钟前 / N 小时前 / 更早显示短日期；悬停卡片可看完整时间 */
  function relTime(utc) {
    var d = parseUTC(utc);
    if (!d) return String(utc || "");
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    var v = partsOf(d), now = partsOf(new Date());
    var yr = v.year === now.year ? "" : v.year + "年";
    return yr + Number(v.pmonth) + "月" + Number(v.pday) + "日 " + v.phour + ":" + v.pminute;
  }
  /* 日期分组标签：今天 / 昨天 / M月D日（跨年带年份） */
  function dayLabel(utc) {
    var d = parseUTC(utc);
    if (!d) return "";
    var v = partsOf(d), now = partsOf(new Date());
    if (v.year === now.year && v.pmonth === now.pmonth) {
      var dd = Number(v.pday), nd = Number(now.pday);
      if (dd === nd) return "今天";
      if (nd - dd === 1) return "昨天";
    }
    var yr = v.year === now.year ? "" : v.year + "年";
    return yr + Number(v.pmonth) + "月" + Number(v.pday) + "日";
  }
  /* 验证码提取：仅当短信含验证码类关键词时提取（数字码 / 字母数字混合码），否则返回空 */
  function extractCode(text) {
    var s = String(text || "");
    var kw = "验证码|校验码|确认码|动态码|授权码|随机码|取件码|提货码|code|otp";
    var m = s.match(new RegExp("(?:" + kw + ")[^0-9]{0,12}([0-9]{4,8})(?![0-9])", "i"));
    if (m) return m[1];
    m = s.match(new RegExp("(?:" + kw + ")[^0-9A-Za-z]{0,4}([0-9A-Za-z]{4,8})(?![0-9A-Za-z])", "i"));
    if (m && /[0-9]/.test(m[1]) && /[A-Za-z]/.test(m[1])) return m[1];
    /* Google 风格：码在关键词之前，如「G-383838 是您的 Google 验证码」 */
    if (new RegExp("(?:" + kw + ")").test(s)) {
      m = s.match(/\b[A-Z]{1,3}-(\d{4,8})(?![0-9])/i);
      if (m) return m[1];
    }
    return "";
  }
  /* 内容链接化：注意入参必须已经过 esc() 转义 */
  function linkify(escaped) {
    return String(escaped || "").replace(/https?:\/\/[^\s<>"'，。；！？、）【】]+/g, function (u) {
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>';
    });
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
  }
  function doCopy(text, btn) {
    var done = function () {
      var old = btn.textContent;
      btn.textContent = "已复制";
      btn.disabled = true;
      setTimeout(function () { btn.textContent = old; btn.disabled = false; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  /* 轻提示（底部浮现，2.6 秒后消失） */
  function toast(msg) {
    var t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add("show"); }, 10);
    setTimeout(function () {
      t.classList.remove("show");
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, 2600);
  }
  /* 新消息处理：验证码自动复制 + 标题未读数 + 后台系统通知 */
  function notifyNew(fresh) {
    var latest = fresh[0];
    var code = extractCode(latest.content);
    if (code && state.autoCopy) {
      var fin = function () { toast("验证码 " + code + " 已复制"); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(fin, function () { fallbackCopy(code); fin(); });
      } else { fallbackCopy(code); fin(); }
    }
    if (document.hidden) {
      state.unread += fresh.length;
      document.title = "(" + state.unread + ") " + SITE_NAME;
      if (state.notify && window.Notification && Notification.permission === "granted") {
        var body = (code ? "验证码 " + code + "  " : "") + String(latest.content || "");
        try {
          new Notification(String(latest.sender || "新短信"), { body: body.slice(0, 140), tag: "sms-" + latest.id });
        } catch (e) {}
      }
    }
  }
  function qs() {
    var p = new URLSearchParams();
    if (state.device) p.set("device_id", state.device);
    if (state.src) p.set("source", state.src);
    if (state.q) p.set("q", state.q);
    p.set("page", state.page);
    return p.toString();
  }
  function loadDevices() {
    return fetch("/api/devices").then(function (r) { return r.json(); }).then(function (res) {
      var tabs = $("tabs");
      tabs.innerHTML = "";
      var mk = function (label, id, extra) {
        var el = document.createElement("div");
        el.className = "tab" + (state.device === id ? " active" : "");
        el.textContent = label + (extra ? " " + extra : "");
        el.onclick = function () { state.device = id; state.page = 1; renderTabs(res.list || []); load(); };
        return el;
      };
      tabs.appendChild(mk("全部", 0, "(" + (res.list || []).reduce(function (s, d) { return s + d.msg_count; }, 0) + ")"));
      (res.list || []).forEach(function (d) {
        var el = mk(d.display_name, d.id, "(" + d.msg_count + ")");
        /* 无短信的设备标签显示 × 可手动删除；有短信时后端拒绝删除 */
        if (!d.msg_count && d.id) {
          var x = document.createElement("span");
          x.className = "tabx";
          x.textContent = "×";
          x.title = "删除该设备标签";
          x.onclick = function (ev) {
            ev.stopPropagation();
            if (!confirm("删除该设备标签？（须先清空其全部短信）")) return;
            fetch("/api/devices/" + d.id, { method: "DELETE" })
              .then(function (r) { return r.json(); })
              .then(function (res2) {
                if (!res2.success) {
                  alert(res2.error === "has messages" ? "该设备仍有短信，请先删除全部短信" : (res2.error || "删除失败"));
                  return;
                }
                if (state.device === d.id) { state.device = 0; state.page = 1; }
                refreshAll();
              });
          };
          el.appendChild(x);
        }
        tabs.appendChild(el);
      });
    });
  }
  function renderTabs(list) { loadDevices(); }
  function load() {
    return fetch("/api/messages?" + qs())
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.success) throw new Error(res.error || "load failed");
        state.total = res.total; state.pages = res.pages;
        var list = res.list || [];
        /* 新消息识别：首次加载建立基线；之后把比 lastId 新的交给 notifyNew（自动复制/通知/未读数） */
        if (!state.inited) {
          state.inited = true;
          if (list.length) state.lastId = list[0].id;
        } else {
          var fresh = list.filter(function (m) { return m.id > state.lastId; });
          if (fresh.length) { state.lastId = fresh[0].id; notifyNew(fresh); }
        }
        $("stat").textContent = "共 " + res.total + " 条";
        $("pageinfo").textContent = res.pages > 1 ? "第 " + res.page + " / " + res.pages + " 页" : "";
        $("pagenum").textContent = res.pages > 1 ? res.page + " / " + res.pages : "";
        $("prev").disabled = res.page <= 1;
        $("next").disabled = res.page >= res.pages;
        if (!list.length) { $("list").innerHTML = '<div class="empty">暂无短信</div>'; return; }
        /* 按日期分组渲染：今天 / 昨天 / M月D日 分隔行；来源徽章区分短信与通知 */
        var html = "", lastDay = "";
        list.forEach(function (m) {
          var day = dayLabel(m.received_at);
          if (day !== lastDay) { html += '<div class="daysep">' + esc(day) + '</div>'; lastDay = day; }
          var code = extractCode(m.content);
          var isSms = (m.source || "sms") === "sms";
          var recv = m.sim_number || m.sim || "";
          html += '<div class="card">' +
            '<div class="row1">' +
              (isSms
                ? '<span class="sender">' + esc(m.sender || "未知号码") + '</span>'
                : '<span class="srctag">' + esc(m.source || "通知") + '</span><span class="sender">' + esc(m.sender || m.device_name || "通知") + '</span>') +
              '<button class="del" data-id="' + m.id + '">删除</button>' +
            '</div>' +
            (code ? '<div class="code-line">验证码：<b>' + esc(code) + '</b><button class="copy" data-code="' + esc(code) + '">复制</button></div>' : '') +
            '<div class="line"><span class="content">' + linkify(esc(m.content)) + '</span></div>' +
            '<div class="line foot-line"><span class="time-line" title="' + esc(fmtTime(m.received_at)) + '">' + esc(relTime(m.received_at)) + '</span>' +
              (isSms && recv ? '<span class="recv" title="双击复制收件号">' + esc(recv) + '</span>' : '') +
            '</div>' +
          '</div>';
        });
        $("list").innerHTML = html;
      })
      .catch(function (e) { $("list").innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'; });
  }
  function refreshAll() { return loadDevices().then(load); }
  $("q").addEventListener("input", function () {
    clearTimeout(state.deb);
    state.deb = setTimeout(function () { state.q = $("q").value.trim(); state.page = 1; load(); }, 300);
  });
  $("prev").onclick = function () { if (state.page > 1) { state.page--; load(); } };
  $("next").onclick = function () { if (state.page < state.pages) { state.page++; load(); } };
  $("src").onchange = function () { state.src = $("src").value; state.page = 1; load(); };
  /* 推送式自动刷新：长轮询 /api/wait，有新消息立即加载；搜索模式下退化为 5s 轮询 */
  function pollLoop() {
    if (state.q) {
      setTimeout(function () { load().then(pollLoop); }, 5000);
      return;
    }
    var p = "last_id=" + (state.lastId || 0);
    if (state.device) p += "&device_id=" + state.device;
    fetch("/api/wait?" + p)
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.changed) load(); })
      .catch(function () {})
      .finally(pollLoop);
  }
  pollLoop();
  /* 开关初始化与记忆（localStorage） */
  var acb = $("autocopy"), nb = $("notifyon");
  acb.checked = state.autoCopy;
  nb.checked = state.notify;
  acb.onchange = function () {
    state.autoCopy = acb.checked;
    try { localStorage.setItem("sms_autocopy", state.autoCopy ? "1" : "0"); } catch (e) {}
    toast(state.autoCopy ? "已开启验证码自动复制" : "已关闭验证码自动复制");
  };
  nb.onchange = function () {
    state.notify = nb.checked;
    try { localStorage.setItem("sms_notify", state.notify ? "1" : "0"); } catch (e) {}
    if (state.notify && window.Notification && Notification.permission === "default") {
      Notification.requestPermission();
    }
    toast(state.notify ? "已开启后台通知" : "已关闭后台通知");
  };
  /* 回到页面即清零未读数、恢复标题 */
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) { state.unread = 0; document.title = SITE_NAME; }
  });
  $("list").addEventListener("click", function (ev) {
    var copyBtn = ev.target.closest ? ev.target.closest(".copy") : null;
    if (copyBtn) { doCopy(copyBtn.getAttribute("data-code"), copyBtn); return; }
    var btn = ev.target.closest ? ev.target.closest(".del") : null;
    if (!btn) return;
    var id = btn.getAttribute("data-id");
    if (!confirm("确认删除这条短信？")) return;
    fetch("/api/messages/" + id, { method: "DELETE" }).then(load);
  });
  /* 双击收件号直接复制 */
  $("list").addEventListener("dblclick", function (ev) {
    var el = ev.target.closest ? ev.target.closest(".recv") : null;
    if (!el) return;
    var text = el.textContent;
    var fin = function () { toast("收件号已复制"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(fin, function () { fallbackCopy(text); fin(); });
    } else { fallbackCopy(text); fin(); }
  });
  refreshAll();
})();
</script>
</body>
</html>`;

/* 登录页（仅 ENABLE_AUTH="true" 时对未登录访问下发） */
const LOGIN_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="__SITE_ICON__">
<title>__SITE_NAME__ - 登录</title>
<style>
  :root { --bg: #f5f6f7; --card: #fff; --text: #20242a; --border: #e3e6e9; --input-border: #d8dce0; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #14171a; --card: #1d2126; --text: #e6e9ec; --border: #2a3036; --input-border: #33393f; }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: var(--bg); color: var(--text); display: flex; align-items: center;
         justify-content: center; min-height: 100vh; }
  .box { background: var(--card); border: 1px solid var(--border); border-radius: 12px;
         padding: 28px 24px; width: 300px; text-align: center; }
  h1 { font-size: 17px; margin-bottom: 16px; }
  input { width: 100%; padding: 9px 12px; border: 1px solid var(--input-border); border-radius: 8px;
          font-size: 14px; margin-bottom: 10px; background: var(--card); color: var(--text); }
  button { width: 100%; padding: 9px 0; border: none; border-radius: 8px; background: #15803d;
           color: #fff; font-size: 14px; cursor: pointer; }
  button:hover { background: #116632; }
  .err { color: #b91c1c; font-size: 12px; min-height: 18px; margin-top: 8px; }
  .foot { color: var(--faint); font-size: 12px; margin-top: 14px; }
  .foot a { color: var(--faint); }
</style>
</head>
<body>
<div class="box">
  <h1>__SITE_NAME__</h1>
  <input type="password" id="pw" placeholder="管理密码" autofocus>
  <button id="go">登 录</button>
  <div class="err" id="err"></div>
  <div class="foot">© 2026 <a href="https://cbm.im/" target="_blank" rel="noopener noreferrer">左立方</a> · <a href="https://github.com/ShenDoyle/SMSToWeb" target="_blank" rel="noopener noreferrer">SMSToWeb</a></div>
</div>
<script>
(function () {
  /* 图标回退：SITE_ICON 设置了但加载失败时，自动换回默认图标 */
  (function () {
    var l = document.querySelector('link[rel="icon"]'); if (!l) return;
    var def = __DEFAULT_ICON_JSON__;
    if (!def || l.getAttribute("href") === def) return;
    var img = new Image();
    img.onerror = function () { l.href = def; };
    img.src = l.getAttribute("href");
  })();
  var pw = document.getElementById("pw");
  var err = document.getElementById("err");
  function tryLogin() {
    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw.value })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.success) { location.reload(); return; }
      err.textContent = d && d.error === "wrong password" ? "密码错误" : "登录失败";
    }).catch(function () { err.textContent = "网络错误"; });
  }
  document.getElementById("go").onclick = tryLogin;
  pw.addEventListener("keydown", function (e) { if (e.key === "Enter") tryLogin(); });
})();
</script>
</body>
</html>`;

/* ---------------- 定时清理：保留天数由变量 RETENTION_DAYS 控制（默认 30） ---------------- */

async function handleCron(env) {
  const days = Math.max(1, parseInt(env.RETENTION_DAYS, 10) || DEFAULT_RETENTION_DAYS);
  const res = await env.DB.prepare(
    `DELETE FROM messages WHERE received_at < datetime('now', ?1)`
  ).bind(`-${days} days`).run();
  console.log(`[cron] cleaned ${res.meta ? res.meta.changes : 0} messages older than ${days} days`);
}

/* ---------------- 路由 ---------------- */

/* ---------------- 通用入口导出（本段由 platforms/gen_app.py 生成，勿手工修改） ----------------
 * 以上业务代码与 src/worker.js 逐字节一致；仅将 Worker 专属的 export default 替换为：
 *   fetchApp(request, env[, ctx])   — 请求处理主入口（ctx 可省略，内部提供 waitUntil 兜底）
 *   runCron(env)                    — 定时清理入口，供各平台原生 cron 调用
 *   handleCronRequest(request, env) — cron 的 HTTP 触发入口（GET /api/cron，token 鉴权）
 */

export async function fetchApp(request, env, ctx) {
  /* 非 Workers 运行时没有 ctx：提供 waitUntil 兜底实现（后台任务失败静默，不阻塞响应） */
  if (!ctx) {
    ctx = {
      waitUntil: function (p) {
        if (p && typeof p.catch === "function") p.catch(function () {});
      },
    };
  }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      /* 登录开关：开启后，除推送接口与登录/登出外，页面与管理 API 均需登录 */
      const isPage = path === "/" || path === "/index.html";
      const isPublicApi = path === "/api/receive" || path === "/api/push" || path === "/api/login" || path === "/api/logout";
      if (!isPublicApi && !(await isAuthed(request, env))) {
        if (isPage && request.method === "GET") {
          return new Response(renderHtml(LOGIN_HTML, env), {
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          });
        }
        return json({ success: false, error: "unauthorized" }, 401);
      }

      if (path === "/api/receive" && (request.method === "POST" || request.method === "GET")) {
        return await handleReceive(request, env, url, ctx);
      }
      if (path === "/api/push" && request.method === "POST") {
        return await handlePush(request, env, url, ctx);
      }
      if (path === "/api/login" && request.method === "POST") {
        return await handleLogin(request, env);
      }
      if (path === "/api/logout" && request.method === "POST") {
        return handleLogout();
      }
      if (path === "/api/messages" && request.method === "GET") {
        return await handleListMessages(url, env);
      }
      const msgMatch = path.match(/^\/api\/messages\/(\d+)$/);
      if (msgMatch && request.method === "DELETE") {
        return await handleDeleteMessage(msgMatch[1], env);
      }
      if (path === "/api/devices" && request.method === "GET") {
        return await handleListDevices(env);
      }
      const devMatch = path.match(/^\/api\/devices\/(\d+)$/);
      if (devMatch && request.method === "DELETE") {
        return await handleDeleteDevice(devMatch[1], env);
      }
      if (path === "/api/wait" && request.method === "GET") {
        return await handleWait(url, env);
      }
      if (path === "/api/devices/alias" && request.method === "POST") {
        return await handleSetAlias(request, env);
      }
      if ((path === "/" || path === "/index.html") && request.method === "GET") {
        return new Response(renderHtml(PAGE_HTML, env), {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      return json({ success: false, error: "not found" }, 404);
    } catch (err) {
      console.error("worker error:", err && err.message);
      return json({ success: false, error: "internal error" }, 500);
    }
}

/* ---------------- 定时清理：供各平台 cron 定时器调用 ---------------- */

export async function runCron(env) {
  await handleCron(env);
}

/* ---------------- cron HTTP 触发入口：GET /api/cron ----------------
 * 鉴权：?token=<RECEIVE_TOKEN> 或 Authorization: Bearer <RECEIVE_TOKEN>
 * （Vercel Cron 自动附带 Bearer 头，需把环境变量 CRON_SECRET 设为与 RECEIVE_TOKEN 相同值）
 */

export async function handleCronRequest(request, env) {
  const url = new URL(request.url);
  const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const provided = url.searchParams.get("token") || bearer;
  if (!env.RECEIVE_TOKEN || !provided || !safeEqual(provided, env.RECEIVE_TOKEN)) {
    return json({ success: false, error: "unauthorized" }, 403);
  }
  await runCron(env);
  return json({ success: true });
}
