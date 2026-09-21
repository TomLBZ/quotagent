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

# 门名从脚本自身解析（不手写、不漂移）：用于 help 与用法串
gate_names() {
  grep -oE '^  [a-z0-9|_-]+\)' "$0" 2>/dev/null || grep -oE '^  [a-z0-9|_-]+\)' "$1"
}

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
  help|-h|--help)
    names=$(gate_names "$0")
    printf '可用门（%s 个名字）：\n' "$(printf '%s\n' "$names" | tr -d ' )' | tr '|' '\n' | sort -u | wc -l | tr -d ' ')"
    printf '  %s\n\n' "$(printf '%s\n' "$names" | tr -d ' )' | tr '|' '\n' | sort -u | tr '\n' '|' | sed 's/|$//')"
    printf '说明：`all` 不含 ui-mutate（约 4 分钟）；`clean-copy` 校验 HEAD，须在 commit 之后跑。\n'
    exit 0
    ;;
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
    # 诊断口径：子进程输出**不再丢**。单条 AC 首次红 → 立刻**隔离重试**一次（同命令、同环境、
    # 只跑这一条）；**连续两次红才算真红** —— 真红时把该 AC 的 stdout/stderr 原样回显，并把
    # 日志路径写进错误信息。首红次绿 = 瞬时命中：不判红，但把第 1 次的原样输出回显出来、日志留在
    # tmp/（下次出现直接看证据定位，不用猜）。日志目录每跑一次 mktemp 独立新建 —— 不与别的门
    # 共享临时路径（并发跑时不会互相覆盖/误删）。
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
    mkdir -p "$ROOT/tmp"
    P0_LOG_DIR=$(mktemp -d "$ROOT/tmp/p0-no-node.XXXXXX")
    P0_TRANSIENT=0
    for ac in $acs; do
      P0_ATTEMPT=1
      while :; do
        P0_LOG="$P0_LOG_DIR/$ac.attempt$P0_ATTEMPT.log"
        QUOTAGENT_NODE=/nonexistent/node PATH=/usr/bin:/bin \
          "$HERE/run.sh" -m quotagent.qa ac "$ac" >"$P0_LOG" 2>&1
        P0_STATUS=$?
        [ "$P0_STATUS" -eq 0 ] && break
        if [ "$P0_ATTEMPT" -ge 2 ]; then
          echo "P0 AC 在无 Node 环境下**连续两次**失败（真红）: $ac（exit=$P0_STATUS）" >&2
          echo "  —— 该 AC 的 stdout/stderr 原样回显（完整日志: $P0_LOG）——" >&2
          cat "$P0_LOG" >&2
          echo "  —— 回显结束；本轮全部日志: $P0_LOG_DIR ——" >&2
          exit 1
        fi
        echo "[warn] $ac 第 1 次红（exit=$P0_STATUS）→ 隔离重试一次（判据：连续两次红才算真红）" >&2
        sleep 1
        P0_ATTEMPT=2
      done
      if [ "$P0_ATTEMPT" -gt 1 ]; then
        P0_TRANSIENT=$((P0_TRANSIENT + 1))
        echo "[warn] $ac 首红次绿（瞬时命中，不判红，但原样输出必须留证）: $P0_LOG_DIR/$ac.attempt1.log" >&2
        cat "$P0_LOG_DIR/$ac.attempt1.log" >&2
      fi
    done
    if [ "$P0_TRANSIENT" -gt 0 ]; then
      echo "P0 阶段 $count 条 AC 在无 Node 环境下全绿（P0 不因引入宿主而失去可复跑性）；"\
"瞬时命中 $P0_TRANSIENT 条（隔离重试后绿，原样输出已回显，日志: $P0_LOG_DIR）"
    else
      echo "P0 阶段 $count 条 AC 在无 Node 环境下全绿（P0 不因引入宿主而失去可复跑性）；无瞬时命中（日志: $P0_LOG_DIR）"
    fi
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
  bid-heuristics)
    # 比价 heuristics（T-279）：① 插件围栏门（含 4 处单点变异）② 真 HTTP 端到端（真进程真回读、
    # 双方视角各自 200、改权重后响应体不同、私域哨兵 0 次）。两半都跑，任一失败即红。
    "${QUOTAGENT_NODE:-node}" "$HERE/../host/t279-heuristics-gate.mjs" || exit 1
    exec "$QUOTAGENT_PY" "$HERE/check-heuristics-route.py" "$@"
    ;;
  advice)
    # 决策建议层（本批）：① 插件围栏门（30 条断言 + 4 处单点变异 + 还原字节一致）
    # ② 真 HTTP 端到端（真进程真回读：四条路由 200 / 两视角建议确实不同 / 空投影必须降级且建议数 0 /
    # 私域哨兵 0 次 / 同 URL 两次逐字节一致）。两半都跑，任一失败即红。
    "${QUOTAGENT_NODE:-node}" "$HERE/../host/t281-advice-gate.mjs" || exit 1
    exec "$QUOTAGENT_PY" "$HERE/check-advice-route.py" "$@"
    ;;
  gates)
    # 审批等多久 / 变更单到底是谁卡着（本批：「审批人等不到」+「变更单扯皮」两条 human problem）：
    # ① 插件围栏门（33 条断言 + 4 处单点变异 + 还原字节一致；**age 不随两个不同 now 入口变化** /
    #    空投影两列表为 0 / 插件不能批准 / 每条都有 basis）② 真 HTTP 端到端（真进程真回读：两视角页面与
    #    JSON 200 / 空投影降级且两列表 0 / 催办 POST 只落 0600 待办件且账本零新增 / 真跑 gate-nudge.py
    #    落 gate/nudged 且 ops 计数 +1 / 幂等 duplicates / 两条拒绝路径 / 私域哨兵 0 次）。
    # 两半都跑，任一失败即红。
    "${QUOTAGENT_NODE:-node}" "$HERE/../host/t282-gate-timeline-gate.mjs" || exit 1
    exec "$QUOTAGENT_PY" "$HERE/check-gate-timeline-route.py" "$@"
    ;;
  change-detail)
    # 变更单**逐行明细**（本批：「变更单到底改了什么、多花多少钱」——P-14 的原话是"看不到明细"）：
    # ① 插件围栏门（22 条断言 + 4 处单点变异 + 还原字节一致；**逐行手算金额对账** /
    #    缺依据的行不入小计 / 空输入 degraded + 明细空 + 小计记 null / 供应商侧哨兵逐字节一致）② 真 HTTP
    #    端到端（真进程真回读：两视角明细页与 JSON 200 / 页面与 JSON 的数字与**手算的整数分**一致 /
    #    未知 id 页面与 JSON 都 404 + next_action / 私域两面都扫 / 只读⇒账本零新增 / 0 内联脚本）。
    # 两半都跑，任一失败即红。
    "${QUOTAGENT_NODE:-node}" "$HERE/../host/t283-change-detail-gate.mjs" || exit 1
    exec "$QUOTAGENT_PY" "$HERE/check-change-detail-route.py" "$@"
    ;;
  ui-feedback)
    # WebUI 反馈闭环（用户反馈 → agent 产新版本 → 自动重载 → 页面提示"请刷新"）：
    # ① 插件围栏门（28 条断言 + 4 处单点变异 + 还原字节一致）② 真 HTTP 端到端
    # （真进程真回读：401 同形 / 两侧反馈页 200 / 提交后计数 +1 / 真跑 ui-feedback-apply.py /
    #  横幅两个方向 / 幂等 / 三条拒绝路径）。两半都跑，任一失败即红。
    "${QUOTAGENT_NODE:-node}" "$HERE/../host/t280-ui-feedback-gate.mjs" || exit 1
    exec "$QUOTAGENT_PY" "$HERE/check-ui-feedback.py" "$@"
    ;;
  mail)
    shift
    exec python3 tools/check-mail.py "$@"
    ;;
  mail-transport)
    # 邮件的**真收发**门（本批）：未配置诚实拒绝 / 回环真发收 / 凭据零泄漏 / 有界读取 / 配置键落盘
    shift
    exec python3 tools/check-mail-transport.py "$@"
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
  storage)
    # 存储（文件管理+键值表）的宿主围栏门（T-277）
    "${QUOTAGENT_NODE:-node}" "$HERE/../host/t277-storage-gate.mjs"
    ;;
  agent-runtime)
    # agent 运行期插件（上下文/记忆/harness）的宿主围栏门（T-275）
    "${QUOTAGENT_NODE:-node}" "$HERE/../host/t275-runtime-gate.mjs"
    ;;
  user-space)
    shift
    exec node host/t268-user-space-gate.mjs "$@"
    ;;
  plugin-market)
    shift
    exec node host/t267-market-gate.mjs "$@"
    ;;
  admin-route)
    shift
    exec python3 tools/check-admin-route.py "$@"
    ;;
  config-route)
    # 配置与凭据（P0）：UI 化 + YAML 持久化 + 配置文件初始化的端到端门
    shift
    exec python3 tools/check-config-route.py "$@"
    ;;
  ui-mutate)
    shift
    exec python3 tools/mutate-ui-views.py "$@"
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
    printf '用法: tools/verify.sh %s （全部见 `tools/verify.sh help`）\n' "$(gate_names "$0" | tr -d ' )' | tr '|' '\n' | sort -u | tr '\n' '|' | sed 's/|$//')" >&2
    exit 2
    ;;
esac
