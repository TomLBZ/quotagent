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

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
else
  for _cand in "${WS_RUNTIME:-/workspace/runtime}/node"/*/bin/node; do
    [ -x "$_cand" ] && NODE_BIN=$_cand && break
  done
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
  ac-registry)
    exec "$QUOTAGENT_PY" "$ROOT/tools/check-ac-registry.py"
    ;;
  events)
    python3 tools/check-events.py
    ;;
  invariants)
    exec "$QUOTAGENT_PY" "$ROOT/tools/check-invariants.py" "$@"
    ;;
  evolution)
    exec "$NODE_BIN" "$ROOT/host/evolution.mjs" "$@"
    ;;
  plugins)
    shift
    exec "$QUOTAGENT_PY" "$ROOT/tools/check-plugin-inventory.py" "$@"
    ;;
  supplier-scorecard)
    shift
    exec node host/t247-scorecard-gate.mjs "$@"
    ;;
  mail)
    shift
    exec python3 tools/check-mail.py "$@"
    ;;
  faq)
    shift
    exec python3 tools/check-faq.py "$@"
    ;;
  negotiation)
    shift
    exec python3 tools/check-negotiation.py "$@"
    ;;
  pipeline-view)
    shift
    exec node host/t260-pipeline-gate.mjs "$@"
    ;;
  ui-seed)
    shift
    exec python3 tools/check-ui-seed.py "$@"
    ;;
  pipeline-route)
    shift
    exec python3 tools/check-pipeline-route.py "$@"
    ;;
  retention-view)
    shift
    exec node host/t254-retention-view-gate.mjs "$@"
    ;;
  retention)
    shift
    exec python3 tools/check-retention.py "$@"
    ;;
  coverage)
    shift
    exec python3 tools/check-fr-coverage.py "$@"
    ;;
  budget-route)
    shift
    exec python3 tools/check-budget-route.py "$@"
    ;;
  idem-route)
    shift
    exec python3 tools/check-idem-route.py "$@"
    ;;
  idempotency-guard)
    shift
    exec node host/t247-idem-gate.mjs "$@"
    ;;
  approval-digest)
    shift
    exec node host/t250-approval-gate.mjs "$@"
    ;;
  budget-guard)
    shift
    exec node host/t250-budget-gate.mjs "$@"
    ;;
  budget-route)
    shift
    exec python3 tools/check-budget-route.py "$@"
    ;;
  wiring)
    shift
    exec python3 tools/check-module-wiring.py "$@"
    ;;
  evolve-journal)
    shift
    exec node host/evolve-journal.mjs "$@"
    ;;
  ops-view)
    shift
    exec node host/ops-view.mjs "$@"
    ;;
  breaker-route)
    shift
    exec python3 tools/check-breaker-route.py "$@"
    ;;
  breaker)
    shift
    exec node host/breaker.mjs "$@"
    ;;
  evolve-module)
    shift
    exec python3 tools/check-evolved-module.py "$@"
    ;;
  observability)
    shift
    exec node host/observability.mjs "$@"
    ;;
  audit-hook)
    shift
    exec "$QUOTAGENT_PY" "$ROOT/tools/check-audit-hook.py" "$@"
    ;;
  governor)
    shift
    exec "$QUOTAGENT_PY" "$ROOT/tools/check-governor.py" "$@"
    ;;
  bridge-canary)
    shift
    exec "$QUOTAGENT_PY" "$ROOT/tools/check-bridge-canary.py" "$@"
    ;;
  canary-route)
    shift
    exec "$QUOTAGENT_PY" "$ROOT/tools/check-canary-dispatch.py" "$@"
    ;;
  canary)
    shift
    exec "$QUOTAGENT_PY" "$ROOT/tools/check-canary.py" "$@"
    ;;
  clean-copy)
    shift
    exec "$QUOTAGENT_PY" "$ROOT/tools/check-clean-copy.py" "$@"
    ;;
  webui)
    shift
    exec "$QUOTAGENT_PY" "$ROOT/tools/check-webui.py"
    ;;
  modules)
    shift
    exec "$QUOTAGENT_PY" "$ROOT/tools/check-modules.py" "$@"
    ;;
audit)
    exec "$HERE/run.sh" -m quotagent.qa ac AC-AUDIT-004
    ;;
  v)
    shift
    exec "$QUOTAGENT_PY" "$ROOT/tools/check-v-register.py" "$@"
    ;;
  g1)
    # 阶段门 G1 = MVP 判据（ADR-0014 §3）的可机检部分：
    #   其余四道门 + 全量 AC + 两个真进程/共享目录的端到端走查（含审计包第三方独立验证）
    for _gate in events ac-registry audit v; do
      "$HERE/verify.sh" "$_gate" || exit 1
    done
    "$HERE/run.sh" -m quotagent.qa all || exit 1
    "$QUOTAGENT_PY" "$ROOT/tools/g1-walkthrough.py" || exit 1
    echo "[ok] 阶段门 G1：MVP 判据全部可机检项通过（逐条判定见上方走查报告）"
    ;;
  g0|g2)
    echo "阶段门 $1 尚未实现：先完成 roadmap 中该阶段的任务与 AC，再实现门脚本。" >&2
    exit 2
    ;;
  *)
    echo "用法: tools/verify.sh ac-registry|approval-digest|audit-hook|breaker|breaker-route|bridge|bridge-canary|budget-guard|budget-route|canary|canary-route|clean-copy|cordis|coverage|docs|events|evolution|evolve-journal|evolve-module|g1|governor|idem-route|idempotency-guard|invariants|modules|observability|ops-view|p0-no-node|plugins|retention|smoke|supplier-scorecard|v|webui|wiring" >&2
    exit 2
    ;;
esac
