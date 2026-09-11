#!/bin/sh
# quotagent 验证入口。
#   tools/verify.sh docs        文档门（AC-DESIGN-001/002/003），当前阶段可运行
#   tools/verify.sh g0|g1|g2    阶段门，未到达该阶段时返回 2
set -u
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "${1:-}" in
  docs)
    shift
    exec python3 "$HERE/check-docs.py" "$@"
    ;;
  g0|g1|g2)
    echo "阶段门 $1 尚未实现：先完成 roadmap 中该阶段的任务与 AC，再实现门脚本。" >&2
    exit 2
    ;;
  *)
    echo "用法: tools/verify.sh docs|g0|g1|g2" >&2
    exit 2
    ;;
esac
