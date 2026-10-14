/**
 * CloudSMSForCF — Deno Deploy 入口
 * 本目录自包含：app.js（核心应用）与 db.js（Turso 适配层）均为本目录内独立副本，
 * 直接部署本目录的 main.js 即可（见 platforms/README.md「Deno Deploy」）。
 *
 * 说明：
 *  - Deno.serve + Web 标准 Request/Response，与核心应用零转换；
 *  - Deno.cron 为平台原生定时任务（每天 UTC 17:00 = 北京 01:00）；
 *  - /api/cron 也可由外部 cron 调用：GET /api/cron?token=<RECEIVE_TOKEN>。
 */
import { fetchApp, runCron, handleCronRequest } from "./app.js";
import { createTursoDb } from "./db.js";

let cachedDb = null;

/* 环境变量 → 核心应用 env 对象（Turso 连接实例在进程内缓存复用） */
function buildEnv() {
  if (!cachedDb) {
    cachedDb = createTursoDb({
      TURSO_DATABASE_URL: Deno.env.get("TURSO_DATABASE_URL") || "",
      TURSO_AUTH_TOKEN: Deno.env.get("TURSO_AUTH_TOKEN") || "",
    });
  }
  return {
    DB: cachedDb,
    RECEIVE_TOKEN: Deno.env.get("RECEIVE_TOKEN") || "",
    ADMIN_PASSWORD: Deno.env.get("ADMIN_PASSWORD") || "",
    ENABLE_AUTH: Deno.env.get("ENABLE_AUTH") || "",
    RETENTION_DAYS: Deno.env.get("RETENTION_DAYS") || "",
    FEISHU_WEBHOOK: Deno.env.get("FEISHU_WEBHOOK") || "",
    SITE_NAME: Deno.env.get("SITE_NAME") || "",
    SITE_ICON: Deno.env.get("SITE_ICON") || "",
  };
}

function configError(e) {
  return new Response(JSON.stringify({ success: false, error: "config error: " + (e && e.message) }), {
    status: 500,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

Deno.serve(async function (request) {
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
});

/* 每天 UTC 17:00（北京 01:00）清理过期数据（与 Worker 版 cron 一致） */
Deno.cron("cleanup", "0 17 * * *", async function () {
  try {
    await runCron(buildEnv());
  } catch (e) {
    console.error("cron cleanup failed:", e && e.message);
  }
});
