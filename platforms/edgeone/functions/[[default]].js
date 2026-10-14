/**
 * CloudSMSForCF — 腾讯 EdgeOne Pages Functions 入口（[[default]].js 兜底捕获全部路由）
 * 产物目录 = platforms/dist/edgeone（由 platforms/build.py 生成），部署见 platforms/README.md
 *
 * 说明：
 *  - EdgeOne Functions 提供 Web 标准 Request/Response，与核心应用零转换；
 *  - 平台暂无原生定时任务：用外部 cron（如 cron-job.org）定期
 *    GET /api/cron?token=<RECEIVE_TOKEN>；
 *  - 若你的 EdgeOne 版本对兜底路由文件名要求不同，可把本文件改名为 [[path]].js（与 CF Pages 一致）。
 */
import { fetchApp, handleCronRequest } from "../../shared/app.js";
import { createTursoDb } from "../../shared/db.js";

let cachedDb = null;

/* EdgeOne 环境变量通过 onRequest 的 env 参数注入（对象形式） */
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
  return {
    DB: cachedDb,
    RECEIVE_TOKEN: g("RECEIVE_TOKEN"),
    ADMIN_PASSWORD: g("ADMIN_PASSWORD"),
    ENABLE_AUTH: g("ENABLE_AUTH"),
    RETENTION_DAYS: g("RETENTION_DAYS"),
    FEISHU_WEBHOOK: g("FEISHU_WEBHOOK"),
    SITE_NAME: g("SITE_NAME"),
    SITE_ICON: g("SITE_ICON"),
  };
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
