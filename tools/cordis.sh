#!/bin/sh
# quotagent 宿主层（cordis/Node）入口。
#   tools/cordis.sh install        仓库内安装依赖（幂等；只写 host/，不写仓库外）
#   tools/cordis.sh smoke          运行 host/smoke.mjs
#   tools/cordis.sh run <script>   运行 host/ 下的任意脚本
# 解释器解析顺序：$QUOTAGENT_NODE → PATH 上的 node → 工作区运行时自带的 node。
set -u
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
HOST="$ROOT/host"
WORKSPACE_NODE_GLOB="/workspace/runtime/node/*/bin"

resolve_node() {
  if [ -n "${QUOTAGENT_NODE:-}" ] && [ -x "${QUOTAGENT_NODE}" ]; then
    echo "$QUOTAGENT_NODE"; return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node; return 0
  fi
  for candidate in $WORKSPACE_NODE_GLOB/node; do
    [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

NODE=$(resolve_node) || {
  echo "quotagent: 找不到 Node（可设 QUOTAGENT_NODE，或用工作区工具链 source /workspace/bin/activate.sh）" >&2
  exit 2
}
NPM="$(dirname "$NODE")/npm"

[ -d "$HOST" ] || { echo "quotagent: 缺少 host/ 目录（$HOST）" >&2; exit 2; }

install_deps() {
  if [ -d "$HOST/node_modules/cordis" ]; then
    echo "host 依赖已就绪：$(node_version_note)"
    return 0
  fi
  echo "安装 host 依赖（仓库内 host/node_modules，gitignored）..."
  ( cd "$HOST" && "$NPM" install --no-audit --no-fund ) || return 1
  echo "已安装：$(node_version_note)"
}

node_version_note() {
  "$NODE" --input-type=module -e "
import fs from 'node:fs'
const p = JSON.parse(fs.readFileSync('$HOST/node_modules/cordis/package.json', 'utf8'))
console.log('cordis ' + p.version + ' · node ' + process.version)
" 2>/dev/null || echo "cordis 未知版本"
}

case "${1:-}" in
  install)
    install_deps || exit 1
    ;;
  smoke)
    install_deps >/dev/null || exit 1
    exec "$NODE" "$HOST/smoke.mjs"
    ;;
  run)
    shift
    [ $# -ge 1 ] || { echo "用法: tools/cordis.sh run <script.mjs> [args...]" >&2; exit 2; }
    script=$1
    shift
    install_deps >/dev/null || exit 1
    exec "$NODE" "$HOST/$script" "$@"
    ;;
  *)
    echo "用法: tools/cordis.sh install|smoke|run <script.mjs>" >&2
    exit 2
    ;;
esac
