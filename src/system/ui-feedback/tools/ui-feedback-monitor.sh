#!/bin/bash
# ui-feedback-monitor —— 反馈闭环 cron 的“变化探测器”（喂给 cronjob 的 monitor 字段）。
#
# 契约（cronjob monitor 要求）：输出必须是**确定性**的（不含时间戳/随机），
# 与上一次输出相同 ⇒ 调度器**跳过**本次 agent 运行（不发任何消息）。
# 因此这里只打印“当前待处理的反馈清单指纹”，不打印时间、不打印绝对路径的变动噪声。
set -u
# 根目录可被 `QUOTAGENT_ROOT` 覆盖（与 tools/verify.sh 同一约定）：机检要在**隔离根**上真跑
# 「空待办 ⇒ 恰一行 pending=0」「有 2 条待办 ⇒ pending=2」两态，不能靠读源码猜（见 AC-USREQ-006）。
ROOT="${QUOTAGENT_ROOT:-/workspace/projects/quotagent}"
PEND="$ROOT/tmp/ui-shared/ui-feedback"
shopt -s nullglob 2>/dev/null || true
files=()
if [ -d "$PEND" ]; then
  for f in "$PEND"/*.json; do files+=("$(basename "$f")"); done
fi
printf 'pending=%s\n' "${#files[@]}"
if [ "${#files[@]}" -gt 0 ]; then
  printf 'ids=%s\n' "$(printf '%s\n' "${files[@]}" | LC_ALL=C sort | tr '\n' ',')"
fi
