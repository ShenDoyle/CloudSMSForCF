#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 src/worker.js 生成 platforms/shared/app.js（多平台通用核心）。

规则：
  1. 除「路由导出段」外，业务代码与 Cloudflare Worker 版逐字节一致（含 String.raw 内嵌前端）；
  2. 仅把尾部 export default { fetch, scheduled } 替换为三个通用导出：
       fetchApp(request, env[, ctx])   — 请求处理主入口（ctx 可省略）
       runCron(env)                    — 定时清理入口，供各平台原生 cron 调用
       handleCronRequest(request, env) — cron 的 HTTP 触发入口（GET /api/cron，token 鉴权）
  3. 生成后自检：String.raw 模板数、反引号总数、${ 出现次数必须与源文件完全一致
     （保证内嵌前端与既有模板字面量未被触碰）。

用法：python platforms/gen_app.py
"""
from pathlib import Path
import sys

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "src" / "worker.js"
DST = REPO_ROOT / "platforms" / "shared" / "app.js"

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


def main() -> int:
    text = SRC.read_text(encoding="utf-8")
    pos = text.index("export default {")
    head, tail = text[:pos], text[pos:]

    # 提取 fetch 方法体（从签名后到「  },」收尾之间，逐字节保留）
    b0 = tail.index(FETCH_SIG) + len(FETCH_SIG)
    s0 = tail.index(SCHED_SIG)
    close = tail.rindex("\n  },", b0, s0)
    body = tail[b0:close]

    new_tail = NEW_TAIL.replace("__BODY__", body)
    out = head + new_tail

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
        return 1
    # 自检：业务代码逐字节一致（生成文件必须包含源文件 head 与 body 原文）
    assert head in out, "head 丢失"
    assert body in out, "fetch 方法体丢失"

    DST.parent.mkdir(parents=True, exist_ok=True)
    DST.write_text(out, encoding="utf-8", newline="\n")
    print("[ok] 生成 %s（%d 行，源 %d 行）" % (DST, out.count("\n") + 1, text.count("\n") + 1))
    for k, (a, b) in checks.items():
        print("     自检通过 %s: %d == %d" % (k, a, b))
    return 0


if __name__ == "__main__":
    sys.exit(main())
