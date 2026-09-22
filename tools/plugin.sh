#!/bin/sh
# 插件生命周期入口（**一行命令**，六动词；契约见 src/system/runtime/docs/lifecycle-contract.md）。
#
#   tools/plugin.sh list [--layer system|domain|userspace] [--json]
#   tools/plugin.sh status <插件>              # 插件 id 一律写 `层次/插件`（userspace 写 userspace/<ns>/<plugin>）
#   tools/plugin.sh load   <插件> [--config '{...}']
#   tools/plugin.sh reload <插件>              # 先卸后装 ⇒ 新实例（新 uid）
#   tools/plugin.sh unload <插件>              # 卸载并归零 effects（可重复）
#   tools/plugin.sh deps   <插件>              # 依赖闭包（有环给环上的 id）
#
#   tools/plugin.sh <动词> <插件> --live        # **装进正在服务的那个进程**（长驻 WebUI，真路由/真页面）
#                                             #   加 --live 后本入口改 exec 客户端 src/system/runtime/tools/plugin-live.mjs；
#                                             #   围栅与回执见 src/system/runtime/docs/lifecycle-contract.md §4
#                                             #   （需要控制令牌；没配 = 通道整体关闭）
#
# 说明（本入口只做三件事，逻辑全在实现里 —— 薄入口纪律，见 docs/design/27 §9 未决 3）：
#   ① 解析 Node（$QUOTAGENT_NODE → PATH → 工作区运行时），与 tools/cordis.sh 同一套；
#   ② 把 `--root` 默认钉成本仓（调用方不必关心相对路径）；
#   ③ exec 实现（**不留中间进程**），退出码原样透传：0 成功 / 1 有 `code` 的失败 / 2 用法或环境错误。
set -u
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
IMPL="$ROOT/src/system/runtime/tools/plugin-lifecycle.mjs"
IMPL_LIVE="$ROOT/src/system/runtime/tools/plugin-live.mjs"

resolve_node() {
  if [ -n "${QUOTAGENT_NODE:-}" ] && [ -x "${QUOTAGENT_NODE}" ]; then echo "$QUOTAGENT_NODE"; return 0; fi
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  for candidate in "${WS_RUNTIME:-/workspace/runtime}"/node/*/bin/node; do
    [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

NODE=$(resolve_node) || {
  {
    echo '{"ok":false,"verb":null,"code":"cordis-missing","reason":"找不到 Node（宿主内核需要 Node；纯内核不需要）",'
    echo '"next_action":"设 QUOTAGENT_NODE=/path/to/node 或 source /workspace/bin/activate.sh"}'
  } >&2
  exit 2
}

[ -f "$IMPL" ] || {
  echo "{\"ok\":false,\"verb\":null,\"code\":\"usage\",\"reason\":\"缺少实现 $IMPL\"," >&2
  echo "\"next_action\":\"确认仓库完整（src/system/runtime/tools/plugin-lifecycle.mjs）\"}" >&2
  exit 2
}

case "${1:-}" in
  --help|-h|help)
    exec "$NODE" "$IMPL" --help
    ;;
esac

# `--live` = 装进**正在服务的那个进程**（长驻 WebUI）：改 exec 客户端（薄入口，不留中间进程）。
# 纪律：`--live` 是**模式开关**（不属于六动词的参数），因此先把它摘掉，再把剩下的参数原样交给客户端
# （逐行一个参数重建参数表：插件 id/旗标里不含换行，值里的空格因此不会被拆开）。
LIVE=0
LIVE_ARGS=""
for _arg in "$@"; do
  if [ "$_arg" = "--live" ]; then LIVE=1; continue; fi
  LIVE_ARGS="$LIVE_ARGS
$_arg"
done
if [ "$LIVE" = "1" ]; then
  _ifs_save=$IFS
  IFS='
'
  set -f
  set -- $LIVE_ARGS
  set +f
  IFS=$_ifs_save
  exec "$NODE" "$IMPL_LIVE" --root "$ROOT" "$@"
fi

# `--root` 缺省 = 本仓（调用方从任何 cwd 调都一致）；显式传了就尊重调用方。
case " $* " in
  *" --root "*) exec "$NODE" "$IMPL" "$@" ;;
  *) exec "$NODE" "$IMPL" --root "$ROOT" "$@" ;;
esac
