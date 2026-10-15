/**
 * SMSToWeb — 腾讯 EdgeOne Makers Functions 入口（[[default]].js 兜底捕获全部路由）
 * 本目录自包含：app.js（核心应用）与 db.js（Turso 适配层）均为本目录内独立副本，
 * 直接把 edgeone/ 作为项目根目录部署即可（见 platforms/README.md 与 edgeone/README.md）。
 *
 * 说明：
 *  - EdgeOne Functions 提供 Web 标准 Request/Response，与核心应用零转换；
 *  - 平台暂无原生定时任务：用外部 cron（如 cron-job.org）定期
 *    GET /api/cron?token=<RECEIVE_TOKEN>；
 *  - 注意（2026-10 实测）：本文件兜底只匹配 /foo、/api/xxx 等非根路径，
 *    根路径 / 由同目录 index.js 承接（EdgeOne Makers 路由规则），
 *    两个入口文件逻辑保持一致，修改时需同步。
 */
import { fetchApp, handleCronRequest } from "../app.js";
import { createTursoDb } from "../db.js";

let cachedDb = null;

/* ==== ENV_KEYS BEGIN（由 platforms/gen_app.py 同步，勿手工修改）==== */
const ENV_KEYS = [
  "RECEIVE_TOKEN",
  "ENABLE_AUTH",
  "ADMIN_PASSWORD",
  "RETENTION_DAYS",
  "SITE_NAME",
  "SITE_ICON",
  "FEISHU_WEBHOOK",
  "FEISHU_SECRET",
  "WECOM_WEBHOOK",
  "DINGTALK_WEBHOOK",
  "DINGTALK_SECRET",
  "SERVERCHAN_SENDKEY",
  "PUSHPLUS_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "BARK_DEVICE_KEY",
  "BARK_URL",
  "NTFY_URL",
  "NTFY_TOKEN",
  "GOTIFY_URL",
  "GOTIFY_TOKEN",
  "RESEND_API_KEY",
  "MAIL_TO",
  "MAIL_FROM",
  "GENERIC_WEBHOOKS",
  "GENERIC_WEBHOOK_TEMPLATE",
  "GENERIC_WEBHOOK_HEADERS",
];
/* ==== ENV_KEYS END ==== */

/* EdgeOne 环境变量通过 onRequest 的 env 参数注入（对象形式，白名单循环透传） */
function buildEnv(vars) {
  const g = function (k) {
    return vars && vars[k] != null ? String(vars[k]) : "";
  };
  if (!cachedDb) {
    cachedDb = createTursoDb({
      TURSO_DATABASE_URL: g("TURSO_DATABASE_URL"),
      TURSO_AUTH_TOKEN: g("TURSO_AUTH_TOKEN"),
    });
  }
  const e = { DB: cachedDb };
  for (const k of ENV_KEYS) e[k] = g(k);
  return e;
}

function configError(e) {
  return new Response(JSON.stringify({ success: false, error: "config error: " + (e && e.message) }), {
    status: 500,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function onRequest({ request, env }) {
  let e;
  try {
    e = buildEnv(env);
  } catch (err) {
    return configError(err);
  }
  const url = new URL(request.url);
  if (url.pathname.replace(/\/+$/, "") === "/api/cron") {
    return handleCronRequest(request, e);
  }
  return fetchApp(request, e);
}
