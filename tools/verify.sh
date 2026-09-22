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
    printf '说明：`clean-copy` 校验 HEAD，须在 commit 之后跑。\n'
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
  plugin-lifecycle)
    # 「一切皆插件」的骨架与契约工具（迁移阶段 1）：① 六动词真跑（list/status/load/reload/unload/deps，
    # 含幂等与拒绝路径：未知插件/非法层名/未知动词/依赖成环/坏清单）② 注入式 UI 注册面（真 HTTP：两个
    # 样板插件注册的只读区块在页面上真出现、`/api/ui/blocks` 只回执元数据、只读路由 POST ⇒ 405、
    # 两页 0 内联脚本，且 `host/modules/webui.mjs` 里 0 次出现它们的 id/标题 = webui 不懂业务）
    # ③ 机制层拒绝语义（负控）④ **4 处单点变异全红**且产品树字节不变。
    exec "$QUOTAGENT_PY" "$ROOT/tools/check-plugin-lifecycle.py" "$@"
    ;;
  run-once)
    # 一键运行契约（QUOTAGENT-ONE-COMMAND v1，28 §3.1）的真跑验收：`./run up|down|status|doctor`
    #   · doctor 只读体检 7 项 + 逐项 next_action；凭据缺失只降级（**不阻塞 up**）；端口被别的进程占则非 0
    #   · up 真起服务 + 健康 200 + 二次 up 幂等（pid 不变、两次 status 逐字节一致）+ down 真释放端口
    #   · 凭据缺失下 up 仍成功（临时空配置）且 status 报 available:false + reason
    #   · `run` 的 **4 处单点变异全红**（每处先在未变异基线上确认不红）+ 产品树字节不变
    exec "$QUOTAGENT_PY" "$ROOT/tools/check-run-once.py" "$@"
    ;;
  run-clone)
    # 「克隆就能一键跑」的**干净副本**那一半（QUOTAGENT-ONE-COMMAND v1，28 §3.1【验收】）：`git archive HEAD`
    # 解到**仓库外**的临时目录（只含已提交内容：无 .venv/host/node_modules/tmp/user-space 目录），在其中真跑
    #   · 入口可执行位（`run` 与每个 `tools/*.sh`；实测缺陷：索引 100644 ⇒ 干净克隆 up 装不了依赖、doctor 的 gates 项 FAIL）
    #   · `doctor` 7 项齐全 + 逐项 next_action + 退出码 0（缺凭据/缺依赖只降级）
    #   · `up` 一条命令成功（外部实测 health 200 + `/quotagent/` 200 + 副本内自建 .venv）
    #   · 二次 `up` 幂等（pid 不变）+ 两次 `status` 逐字节一致 · `down` 真释放端口
    #   · 反向对照：删掉 node_modules 后如实报；断网垫片 + 空 npm 缓存 ⇒ 如实失败且带 log/log_tail（可诊断）
    #   · **4 处单点变异全红**（依赖准备改坏 / 健康检查不检查 / down 不释放端口 / doctor 假装能跑）+ 产品树字节不变
    # 它校验 **HEAD 本身**：与 `clean-copy` 同类，**须在 commit 之后跑**（不进提交前的门链）。
    exec "$QUOTAGENT_PY" "$ROOT/tools/check-run-clone.py" "$@"
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
  authority)
    # 授权区间（本批：「谁能批到多少 / 越界怎么办 / 下一个能批的人是谁」——P-12「授权区间不可见」的原话）：
    # ① 插件围栏门（22 条断言 + 4 处单点变异 + 还原字节一致；**三例边界值手算对账**（恰等于限额/超一分/差一分）/
    #    **未配置不得编限额**（required_role 与 next_role 留空）/ 越界必出升级命令且命令真存在（真跑 verify.sh help）/
    #    插件**不能批准**（服务面无审批类方法 + can_approve=false）/ 金额非法三类拒绝 / 确定性 / 有界 /
    #    私域哨兵零泄漏 / 零写面 / 四道页面子导航入口 / 页面 0 内联脚本）② 真 HTTP 端到端（真进程真回读：
    #    两视角页面与 JSON 200 / 边界三例与手算一致 / **改配置前后同一金额结论不同**（`--config-file` 临时配置，
    #    真 /workspace/config.yaml 指纹前后一致）/ 未配置 ⇒ unconfigured 且角色字段空 / 升级命令真存在 /
    #    私域哨兵 0 命中 / 只读⇒账本零新增 / 0 内联脚本）。两半都跑，任一失败即红。
    "${QUOTAGENT_NODE:-node}" "$HERE/../host/t284-authority-gate.mjs" || exit 1
    exec "$QUOTAGENT_PY" "$HERE/check-authority-route.py" "$@"
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
  rfq-visibility)
    # 「供应商看不到自己的 RFQ 包」这个根因（本批）：`rfq/*` 只落在**发送方** realm 的账本里，供应商那本
    # 账本里一条都没有 ⇒ 供应商看不到要报的包、看不到 @rev、看不到报价截止。修法 = 投递信封 + 收件人
    # 作用域 + 字段白名单（`host/modules/projection.mjs`）。
    #   ① 围栏门（26 条断言：**被邀的看得到 / 没被邀的看不到**（同一次调用对比）/ 他家供应商代号与他家包
    #      0 命中 / **带哨兵与不带哨兵输出逐字节一致** / rev 与截止逐字取事实（不取墙钟）/ 确定性 /
    #      有界 + `omitted` / 七种有名降级 / 派生行形状（账本行不增不减）/ 承包商侧不得减少 / 零写面 /
    #      页面块 0 内联脚本；**4 处单点变异全红**（含"把包发给所有供应商"这种越权变异）+ 防假变异 +
    #      还原字节一致）
    #   ② 真 HTTP 端到端（真起两个进程、两种身份、同一份投递目录：被邀的看得到包（逐字）/ 未被邀的
    #      看不到 / 追加"只发给别家"的信封后输出**逐字节不变** / 追加"同时发给两家"的信封后**必须变化** /
    #      哨兵 0 命中 / 承包商侧不减少 / 只读 + 确定性 / 0 内联脚本）。两半都跑，任一失败即红。
    "${QUOTAGENT_NODE:-node}" "$HERE/../host/t287-rfq-visibility-gate.mjs" || exit 1
    exec "$QUOTAGENT_PY" "$HERE/check-rfq-visibility-route.py" "$@"
    ;;
  rfq-deadline)
    # RFQ 回文时限（本批：「来不及回 RFQ：谁还没回 / 还差多久 / 催了没有」——P-10「截止时间与催报
    # 没有入口」+ P-04「被迫回电脑前再算、错过截止」的原话）：
    # ① 插件围栏门（23 条断言 + 4 处单点变异 + 还原字节一致；**期限不随窗口变化**（两个墙钟入口各给
    #    两个不同值 ⇒ 输出逐字节一致，remaining 与手算对账）/ **没凭据不得假装能发**（available=false ⇒
    #    blocked_by 写「无法代发」，输出里"发过了"类表述 0 命中）/ 空输入 degraded + 条目空 /
    #    确定性 / 有界 + omitted / 私域哨兵零泄漏 / **名册白名单（非业主视角读都不读）** / 零写面 /
    #    四道页面子导航入口 / 页面模板 0 内联脚本）② 真 HTTP 端到端（真进程真回读：两视角页面与 JSON
    #    200 / 剩余时长与手算一致 / 空投影降级且条目 0 / 登记承诺 POST 只落 0600 待办件且账本零新增 /
    #    真跑 rfq-promise.py 落 rfq/promised（body 恰 6 键）且计数 +1 / **承诺真的改变页面口径** /
    #    幂等 duplicates / 两条拒绝路径 / 私域哨兵 0 命中）。两半都跑，任一失败即红。
    "${QUOTAGENT_NODE:-node}" "$HERE/../host/t285-rfq-deadline-gate.mjs" || exit 1
    exec "$QUOTAGENT_PY" "$HERE/check-rfq-deadline-route.py" "$@"
    ;;
  quote-draft)
    # 「不要假成功」+ 报价草稿写闭环（本批：「员工填了单价点了提交、浏览器回一页 200、什么都没发生」）：
    # ① 插件围栏门（17 条断言 + 4 处单点变异 + 还原字节一致；服务面**恰 8 键**且无签名/提交/发信方法 /
    #    字段级拒绝码闭合 / 草稿恒为**待签署** / 行项目读不出来不编 / 确定性（载荷墙钟入口读都不读）/
    #    私域哨兵零泄漏 / 零写面）② 真 HTTP 端到端（真进程真回读：**逐条只读路由 POST ⇒ 405 +
    #    method-not-allowed + `Allow: GET`**，反向对照写路由不返回该 code / 字段级 errors / 待办件恰 0600 /
    #    宿主账本零新增 / 真跑 `tools/quote-draft.py` 两侧账本各 +1 且 body 恰 12 键不含备注正文 / 幂等 /
    #    拒绝码 / 两视角页面都回读那份草稿 + 承包商侧「已准备报价（待签署）」/ 真跑 `tools/quote-sign.py`
    #    证明「签名只能由人」）。两半都跑，任一失败即红。
    "${QUOTAGENT_NODE:-node}" "$HERE/../host/t286-quote-draft-gate.mjs" || exit 1
    exec "$QUOTAGENT_PY" "$HERE/check-quote-draft-route.py" "$@"
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
    # admin 道的**宿主侧围栏门**（T-271）：两件产物（`admin-guard` 鉴权 + `admin-view` 只读视图）的
    # 18 条断言，含 4 处单点变异。**本批（EV-173 / T-322）搬迁时实测发现它此前没有任何门在跑**
    # （`tools/verify.sh` 无分支、无 AC 引用它）⇒ 孤儿门，这里接上（门名不变、只增不减）。
    "${QUOTAGENT_NODE:-node}" "$HERE/../host/t271-admin-gate.mjs" || exit 1
    shift
    exec python3 tools/check-admin-route.py "$@"
    ;;
  config-route)
    # 配置与凭据（P0）：UI 化 + YAML 持久化 + 配置文件初始化的端到端门
    shift
    exec python3 tools/check-config-route.py "$@"
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
  plugin-assets)
    # 「散落的检查/测试资产收进各自插件的 tests|tools」的**归属一致性门**（迁移阶段 4.1）：
    #   ① 每个已搬资产：目标存在 + 旧位置只剩**薄转发**（标记/行数/字节/指向，且字节 ≤ 目标 1/4、sha256 ≠ 目标）
    #   ② `docs/work/plans/plugin-file-map.md` §分类 的「已搬」行 == 门内登记（双向）+ 三节表是**全量登记**
    #      （`tools/` 顶层文件 / `host/*-gate.mjs` / `src/quotagent/qa/checks_*.py` 逐条有行）
    #   ③ 归属唯一：同一资产的 basename 在 `src/**` 里只出现一次且在**归属插件**目录下
    #   ④ 门接口不因搬迁失联：`verify.sh help` 门名 ↔ case 分支 ↔ 实现路径三方对齐 + 真跑 help/v
    #   ⑤ `tools/**` 的非薄入口数 **只减不增**（≤ 63）且集合 == §分类 的「待搬」集合
    #   反向验证：**4 处单点变异全红**（抽走目标 / 转发改实体 / 副本塞进别的插件 / 加未登记的非薄入口）
    #   + 防假变异 + 产品树字节不变（变异只写在 tmp/ 的整树副本里）。实现：tools/check-plugin-assets.py
    exec "$QUOTAGENT_PY" "$ROOT/tools/check-plugin-assets.py" "$@"
    ;;
  plugin-requirements)
    # 「需求归属到插件」的机检（T-316 批次；规则真源 docs/design/28 §1，归属真源 = 15-requirements-coverage.md）：
    #   把"每条 FR 由哪个插件提供"变成断言 ——
    #     ① `tools/plugin.sh list` 枚举到的每个插件在映射表 `docs/work/plugin-requirements-map.md` 里有行；
    #     ② 映射表引用的每个 FR 号都在 FR 定义集合内（主文件 + `functional-requirements-archive*.md`）；
    #     ③ 每条 FR 恰好被一个插件认领（唯一指针：未认领与重复认领都判红）；
    #     ④ `src/<层>/<插件>/requirements/` 存在的插件都在映射表里有行（目录不无主）、每个 `req=` 指向的文档真实存在、
    #        文档不在标准布局位置的逐条登记、没有需求文档的插件逐条列在 §4.1 缺口清单（状态取值合法、`done` 必须有真证据）。
    #   反向验证：**4 处单点变异全红**（抽一行插件 / FR 改成不存在的号 / FR 重复认领 / 抽掉 req= 标记）
    #   且产品树字节不变（变异只写在 tmp/ 的临时副本里）。
    exec "$QUOTAGENT_PY" "$ROOT/tools/check-plugin-requirements.py" "$@"
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
