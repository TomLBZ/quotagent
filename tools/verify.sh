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
  bridge)
    "$HERE/run.sh" -m quotagent.qa ac AC-INTEG-004 || exit 1
    "$HERE/run.sh" -m quotagent.qa ac AC-INTEG-005 || exit 1
    exec "$HERE/run.sh" -m quotagent.qa ac AC-INTEG-006
    ;;
  p0-no-node)
    # P0 可复跑性（ADR-0013 §8）：把 Node 藏起来，P0 阶段的 AC 仍必须全绿。
    # 注意：空集合必须判为失败（否则"没跑到"会被当成"全绿"）。
    acs=$("$HERE/run.sh" -m quotagent.qa list 2>/dev/null | "$QUOTAGENT_PY" -c '
import json, sys
data = json.load(sys.stdin)
acs = data.get("acs") if isinstance(data, dict) else data
print(" ".join(sorted({item["ac"] for item in acs if item.get("phase") != "P1"})))')
    count=$(printf '%s' "$acs" | wc -w)
    if [ "$count" -lt 34 ]; then
      echo "P0 AC 集合异常（只取到 $count 条，ADR-0013 §8 说的是 34 条）：拒绝给出假的绿灯" >&2
      exit 2
    fi
    for ac in $acs; do
      QUOTAGENT_NODE=/nonexistent/node PATH=/usr/bin:/bin "$HERE/run.sh" -m quotagent.qa ac "$ac" >/dev/null 2>&1 \
        || { echo "P0 AC 在无 Node 环境下失败: $ac" >&2; exit 1; }
    done
    echo "P0 阶段 $count 条 AC 在无 Node 环境下全绿（P0 不因引入宿主而失去可复跑性）"
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
