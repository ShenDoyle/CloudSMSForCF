/**
 * Netlify Scheduled Function：每天 UTC 17:00（北京 01:00）清理过期数据
 * 与 Cloudflare Worker 版 [triggers] crons = ["0 17 * * *"] 行为一致。
 * 也可改用外部 cron 调用 GET /api/cron?token=<RECEIVE_TOKEN>，二者取其一即可。
 */
import { runCron } from "../app.js";
import { createTursoDb } from "../db.js";

export const config = { schedule: "0 17 * * *" };

let cachedDb = null;

function buildEnv() {
  if (!cachedDb) {
    cachedDb = createTursoDb({
      TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL || "",
      TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN || "",
    });
  }
  return {
    DB: cachedDb,
    RECEIVE_TOKEN: process.env.RECEIVE_TOKEN || "",
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "",
    ENABLE_AUTH: process.env.ENABLE_AUTH || "",
    RETENTION_DAYS: process.env.RETENTION_DAYS || "",
    FEISHU_WEBHOOK: process.env.FEISHU_WEBHOOK || "",
    SITE_NAME: process.env.SITE_NAME || "",
    SITE_ICON: process.env.SITE_ICON || "",
  };
}

export default async function scheduledHandler() {
  await runCron(buildEnv());
  return new Response(JSON.stringify({ success: true }), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
