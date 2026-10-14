#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 src/worker.js 生成多平台核心 app.js，并同步独立副本到各平台目录（保证五平台功能一致）。

产出：
  1. platforms/shared/app.js  — 唯一源：业务代码与 src/worker.js 逐字节一致，
                                仅把 Worker 专属的 export default 替换为通用导出
                                fetchApp / runCron / handleCronRequest
  2. platforms/<平台>/app.js  — 各平台独立副本（vercel / netlify / deno / edgeone / node）
  3. platforms/<平台>/db.js   — 各平台独立副本（源：platforms/shared/db.js）
  4. platforms/<平台>/schema.sql — 建表脚本副本（源：仓库根 schema.sql）

各平台目录因此完全自包含：入口文件只引用本目录内的 app.js / db.js，可独立部署、
互不依赖。src/worker.js、shared/db.js 或根 schema.sql 有更新后重新执行本脚本即可全量同步。

用法：python platforms/gen_app.py
"""
from pathlib import Path
import shutil
import sys

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "src" / "worker.js"
SHARED_DIR = REPO_ROOT / "platforms" / "shared"
SHARED_APP = SHARED_DIR / "app.js"
PLATFORM_DIRS = ["vercel", "netlify", "deno", "edgeone", "node"]

FETCH_SIG = "async fetch(request, env, ctx) {"
SCHED_SIG = "async scheduled(event, env) {"

NEW_TAIL = """/* ---------------- 通用入口导出（本段由 platforms/gen_app.py 生成，勿手工修改） ----------------
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
__BODY__
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
  const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\\s+/i, "").trim();
  const provided = url.searchParams.get("token") || bearer;
  if (!env.RECEIVE_TOKEN || !provided || !safeEqual(provided, env.RECEIVE_TOKEN)) {
    return json({ success: false, error: "unauthorized" }, 403);
  }
  await runCron(env);
  return json({ success: true });
}
"""


def generate_shared_app(text: str) -> str:
    pos = text.index("export default {")
    head, tail = text[:pos], text[pos:]

    # 提取 fetch 方法体（从签名后到「  },」收尾之间，逐字节保留）
    b0 = tail.index(FETCH_SIG) + len(FETCH_SIG)
    s0 = tail.index(SCHED_SIG)
    close = tail.rindex("\n  },", b0, s0)
    body = tail[b0:close]

    out = head + NEW_TAIL.replace("__BODY__", body)

    # 自检：模板与字面量特征必须与源文件完全一致（未被生成过程触碰）
    checks = {
        "String.raw 数量": (text.count("String.raw`"), out.count("String.raw`")),
        "反引号总数": (text.count("`"), out.count("`")),
        "${ 出现次数": (text.count("${"), out.count("${")),
    }
    bad = {k: v for k, v in checks.items() if v[0] != v[1]}
    if bad:
        for k, (a, b) in bad.items():
            print("自检失败 %s: 源=%d 生成=%d" % (k, a, b), file=sys.stderr)
        sys.exit(1)
    assert head in out, "head 丢失"
    assert body in out, "fetch 方法体丢失"

    SHARED_DIR.mkdir(parents=True, exist_ok=True)
    SHARED_APP.write_text(out, encoding="utf-8", newline="\n")
    print("[ok] 生成唯一源 %s（%d 行）" % (SHARED_APP, out.count("\n") + 1))
    return out


def sync_platforms(shared_app_text: str, db_text: str) -> None:
    """把唯一源同步为各平台目录内的独立副本（各平台目录因此自包含）。"""
    schema_text = (REPO_ROOT / "schema.sql").read_text(encoding="utf-8")
    for name in PLATFORM_DIRS:
        d = REPO_ROOT / "platforms" / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "app.js").write_text(shared_app_text, encoding="utf-8", newline="\n")
        (d / "db.js").write_text(db_text, encoding="utf-8", newline="\n")
        (d / "schema.sql").write_text(schema_text, encoding="utf-8", newline="\n")
        ok = (d / "app.js").read_text(encoding="utf-8") == shared_app_text and \
             (d / "db.js").read_text(encoding="utf-8") == db_text and \
             (d / "schema.sql").read_text(encoding="utf-8") == schema_text
        if not ok:
            print("同步校验失败: %s" % name, file=sys.stderr)
            sys.exit(1)
        print("[ok] 同步独立副本 %s/{app.js,db.js,schema.sql}" % name)


def main() -> int:
    text = SRC.read_text(encoding="utf-8")
    shared_app_text = generate_shared_app(text)
    db_text = (SHARED_DIR / "db.js").read_text(encoding="utf-8")
    sync_platforms(shared_app_text, db_text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
