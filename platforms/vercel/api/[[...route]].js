/**
 * CloudSMSForCF — Vercel Edge Function 入口（catch-all：捕获全部路径）
 * 本目录自包含：app.js（核心应用）与 db.js（Turso 适配层）均为本目录内独立副本，
 * 直接把 vercel/ 作为项目根目录部署即可（见 platforms/README.md「Vercel」）。
 *
 * 说明：
 *  - runtime=edge：直接使用 Web 标准 Request/Response，与核心应用零转换；
 *  - 长轮询 /api/wait 最长挂起 25s：若执行上限被提前截断，前端轮询循环会自动重试，不影响使用；
 *  - 定时清理：vercel.json 已配置 crons 调用 /api/cron；
 *    Vercel Cron 会自动附带 Authorization: Bearer $CRON_SECRET，
 *    请把环境变量 CRON_SECRET 设为与 RECEIVE_TOKEN 相同的值。
 */
import { fetchApp, handleCronRequest } from "../app.js";
import { createTursoDb } from "../db.js";

export const config = { runtime: "edge" };

let cachedDb = null;

/* 环境变量 → 核心应用 env 对象（Turso 连接实例在进程内缓存复用） */
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

function configError(e) {
  return new Response(JSON.stringify({ success: false, error: "config error: " + (e && e.message) }), {
    status: 500,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async function handler(request) {
  let env;
  try {
    env = buildEnv();
  } catch (e) {
    return configError(e);
  }
  const url = new URL(request.url);
  if (url.pathname.replace(/\/+$/, "") === "/api/cron") {
    return handleCronRequest(request, env);
  }
  return fetchApp(request, env);
}
