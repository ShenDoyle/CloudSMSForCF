/**
 * CloudSMSForCF — Node.js 自托管入口（Node 18+，零 npm 依赖）
 * 适用：Fly.io / Railway / 任意 VPS / 本地调试（产物目录 = platforms/dist/node）
 *   本地启动：TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... RECEIVE_TOKEN=... node server.mjs
 *   Docker：  见同目录 Dockerfile（Fly.io / Railway 直接可用）
 *
 * 说明：
 *  - 内置每日清理：UTC 17:00（北京 01:00）自动执行；
 *  - 也可用平台调度器（Fly Machines Cron / Railway Cron）
 *    GET /api/cron?token=<RECEIVE_TOKEN>。
 */
import http from "node:http";
import { Readable } from "node:stream";
import { fetchApp, runCron, handleCronRequest } from "../../shared/app.js";
import { createTursoDb } from "../../shared/db.js";

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

/* Node IncomingMessage → Web Request（零依赖转换） */
function toWebRequest(req) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else if (v != null) {
      headers.set(k, v);
    }
  }
  const method = (req.method || "GET").toUpperCase();
  const host = req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || "http";
  const init = { method: method, headers: headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }
  return new Request(proto + "://" + host + req.url, init);
}

/* Web Response → Node res（本项目响应体均为小型文本，整体缓冲写入） */
async function writeResponse(res, resp) {
  const headers = {};
  for (const [k, v] of resp.headers) headers[k] = v;
  res.writeHead(resp.status, headers);
  const buf = await resp.arrayBuffer();
  res.end(Buffer.from(buf));
}

const PORT = parseInt(process.env.PORT || "8787", 10);

const server = http.createServer(async function (req, res) {
  try {
    const webReq = toWebRequest(req);
    const url = new URL(webReq.url);
    const env = buildEnv();
    const resp = url.pathname.replace(/\/+$/, "") === "/api/cron"
      ? await handleCronRequest(webReq, env)
      : await fetchApp(webReq, env);
    await writeResponse(res, resp);
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ success: false, error: "internal error: " + (e && e.message) }));
  }
});

server.listen(PORT, function () {
  console.log("CloudSMSForCF node server listening on :" + PORT);
});

/* ---------------- 内置每日清理（UTC 17:00 = 北京 01:00，与 Worker 版 cron 一致） ---------------- */

let lastCronDay = "";
setInterval(function () {
  const d = new Date();
  if (d.getUTCHours() === 17 && d.getUTCMinutes() === 0) {
    const day = d.toISOString().slice(0, 10);
    if (day !== lastCronDay) {
      lastCronDay = day;
      runCron(buildEnv()).catch(function (e) {
        console.error("cron cleanup failed:", e && e.message);
      });
    }
  }
}, 30 * 1000).unref();
