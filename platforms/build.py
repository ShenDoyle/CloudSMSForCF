#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
多平台构建脚本：把 shared/ 与各平台入口组装为自包含部署产物，输出到 <out>/<平台>/。
产物可直接用于各平台部署（各平台部署步骤见 platforms/README.md）。

用法：
  python platforms/build.py                    # 构建全部平台
  python platforms/build.py --only node,vercel # 仅构建指定平台
  python platforms/build.py --out <目录>       # 自定义输出根目录（默认 platforms/dist）

说明：源码中各平台入口统一以 "../../shared/" 引用共享层；本脚本复制时按目标
      目录深度重写导入路径，确保产物自包含、可直接部署。
"""
import argparse
import shutil
import sys
from pathlib import Path

PLATFORMS_DIR = Path(__file__).resolve().parent
REPO_ROOT = PLATFORMS_DIR.parent
SHARED_SRC = PLATFORMS_DIR / "shared"
SRC_IMPORT = '"../../shared/'

# 目标 → (需复制的文件清单, 源导入路径的替换前缀)
TARGETS = {
    "vercel": {
        "files": ["api/[[...route]].js", "vercel.json", "package.json"],
        "shared_prefix": '"../shared/',
    },
    "netlify": {
        "files": ["functions/api.mjs", "functions/cron.mjs", "netlify.toml", "public/index.html"],
        "shared_prefix": '"../../shared/',
    },
    "deno": {
        "files": ["main.js"],
        "shared_prefix": '"./shared/',
    },
    "edgeone": {
        "files": ["functions/[[default]].js"],
        "shared_prefix": '"../shared/',
    },
    "node": {
        "files": ["server.mjs", "package.json", "Dockerfile"],
        "shared_prefix": '"./shared/',
    },
}


def build_target(name: str, out_root: Path) -> None:
    cfg = TARGETS[name]
    out = out_root / name
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    # 1. 复制共享层 + schema.sql（部署时用于初始化 Turso）
    shutil.copytree(SHARED_SRC, out / "shared")
    shutil.copy2(REPO_ROOT / "schema.sql", out / "schema.sql")

    # 2. 复制平台文件并按目标目录深度重写 shared 导入路径
    for rel in cfg["files"]:
        src = PLATFORMS_DIR / name / rel
        dst = out / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        text = src.read_text(encoding="utf-8")
        text = text.replace(SRC_IMPORT, cfg["shared_prefix"])
        dst.write_text(text, encoding="utf-8", newline="\n")

    print("[ok] %s -> %s" % (name, out))


def main() -> int:
    ap = argparse.ArgumentParser(description="生成各平台自包含部署产物")
    ap.add_argument("--only", default="", help="逗号分隔的平台名，默认全部")
    ap.add_argument("--out", default=str(PLATFORMS_DIR / "dist"), help="输出根目录")
    args = ap.parse_args()

    names = [n.strip() for n in args.only.split(",") if n.strip()] or list(TARGETS)
    unknown = [n for n in names if n not in TARGETS]
    if unknown:
        print("未知平台: %s；可选: %s" % (", ".join(unknown), ", ".join(TARGETS)), file=sys.stderr)
        return 1
    for n in names:
        build_target(n, Path(args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
