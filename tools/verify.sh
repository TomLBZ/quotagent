#!/bin/sh
# quotagent 验证入口。
#   tools/verify.sh docs         文档门（AC-DESIGN-001/002/003），纯标准库、只读
#   tools/verify.sh ac <AC-ID>   单条 AC（实现见 src/quotagent/qa/）
#   tools/verify.sh suite <name> 场景集
#   tools/verify.sh cordis       cordis 宿主冒烟（host/smoke.mjs）
#   tools/verify.sh v            V-001..V-012 登记表校验（T-117 / S0.15），只读
#   tools/verify.sh smoke        运行时自检（解释器解析 + 标准库依赖 + 临时目录）
#   tools/verify.sh g0|g1|g2     阶段门，未到达该阶段时返回 2
set -u
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
QUOTAGENT_ROOT=$ROOT
export QUOTAGENT_ROOT

. "$HERE/runtime.sh"
if [ -z "${QUOTAGENT_PY:-}" ]; then
  echo "quotagent: 无可用 Python 解释器，见上方提示（可设 QUOTAGENT_PY 或运行 tools/bootstrap.sh）" >&2
  exit 2
fi

case "${1:-}" in
  docs)
    shift
    exec "$QUOTAGENT_PY" "$ROOT/tools/check-docs.py" "$@"
    ;;
  ac|suite)
    exec "$HERE/run.sh" -m quotagent.qa "$@"
    ;;
  smoke)
    exec "$HERE/run.sh" -m quotagent.qa selftest
    ;;
  cordis)
    exec "$HERE/cordis.sh" smoke
    ;;
  v)
    shift
    exec "$QUOTAGENT_PY" "$ROOT/tools/check-v-register.py" "$@"
    ;;
  g0|g1|g2)
    echo "阶段门 $1 尚未实现：先完成 roadmap 中该阶段的任务与 AC，再实现门脚本。" >&2
    exit 2
    ;;
  *)
    echo "用法: tools/verify.sh docs|ac <AC-ID>|suite <name>|cordis|v|smoke|g0|g1|g2" >&2
    exit 2
    ;;
esac
