/**
 * SMSToWeb — 腾讯 EdgeOne Makers Functions 兜底路由（捕获 /foo、/api/xxx 等非根路径）
 * 根路径 / 由同目录 index.js 承接（EdgeOne 路由规则：index.js -> example.com/）。
 * 为避免两个入口文件逻辑重复、修改漏同步导致漂移，本文件仅 re-export index.js 的 onRequest，
 * 全部逻辑与 ENV_KEYS 白名单以 index.js 为单一来源（由 platforms/gen_app.py 同步）。
 */
export { onRequest } from "./index.js";
