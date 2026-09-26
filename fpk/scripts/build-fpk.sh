#!/usr/bin/env bash
# build-fpk.sh —— 为飞牛 FPK 构建 Go 后端二进制。
#
# 产物（相对 fntvplus 仓库根）：
#   app/server/fntvplus        linux/amd64 二进制（fnOS x86 包，fnpack 只打包 app/ 目录内容）
#   app/server/fntvplus-arm64  linux/arm64 二进制（可选，ARM 包用；x86 测试包可不编）
#
# 重要：fnpack build 会把仓库根的 app/ 目录打成 app.tgz 放进 .fpk，
#       安装后 app/ 内容直接落在 TRIM_APPDEST 根 —— 所以二进制必须在
#       app/server/fntvplus（对应运行时 $TRIM_APPDEST/server/fntvplus，
#       与 cmd/main 的 BIN 路径一致）。根目录 server/ 不会进包！
#
# 用法（在 fntvplus/ 仓库根执行）：
#   bash scripts/build-fpk.sh            # 仅 amd64
#   WITH_ARM64=1 bash scripts/build-fpk.sh  # amd64 + arm64
#
# 前置：Go 1.23+（交叉编译无需目标平台工具链，纯标准库）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GO="${GO:-go}"

echo "==> building linux/amd64 -> app/server/fntvplus ..."
mkdir -p app/server
( cd src/go && GOOS=linux GOARCH=amd64 "$GO" build -o ../app/server/fntvplus ./cmd/fntvplus )

if [ "${WITH_ARM64:-0}" = "1" ]; then
  echo "==> building linux/arm64 -> app/server/fntvplus-arm64 ..."
  ( cd src/go && GOOS=linux GOARCH=arm64 "$GO" build -o ../app/server/fntvplus-arm64 ./cmd/fntvplus )
fi

echo "==> done. Files:"
ls -la app/server/
echo ""
echo "==> next: run fnpack build (or Windows 上直接双击 build-fpk.exe 一键打包)"
