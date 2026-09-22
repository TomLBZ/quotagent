#!/bin/bash
# ui-feedback-tick —— WebUI 自适应闭环的**自动触发器**（watchdog 模式：无变化则静默）
#
# 为什么存在：`ui-feedback` 插件只把用户反馈落成 0600 待办件（宿主零写面、H1），
# 真正"把新版本应用掉"的是 Python 侧 `tools/ui-feedback-apply.py`（唯一落账本者）。
# 这个 tick 就是那个**周期性触发器**：把待处理反馈逐条 apply 掉，页面随即按新版本号
# 渲染 `data-ui-stale` 横幅提示"请刷新" —— 即"完成后自动重载 + 提示刷新"的自动那一半。
#
# 输出约定（供 cron 以 no_agent 模式直接投递）：**有变化才打印**，无变化输出空。
set -u
# 仓库根由**脚本自身位置**推出（`src/system/ui-feedback/tools/` 上溯 3 层），并可被 `QUOTAGENT_ROOT`
# 覆盖（与 `tools/verify.sh` / `ui-feedback-monitor.sh` 同一约定）—— 硬编码绝对路径会让「克隆到别的
# 路径」就废（可移植性，服务「克隆即跑」；机检 `tools/verify.sh plugin-assets` 的 PA9）。
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT="${QUOTAGENT_ROOT:-$(CDPATH= cd -- "$HERE/../../.." && pwd)}"
PEND="$ROOT/tmp/ui-shared/ui-feedback"
cd "$ROOT" || exit 1
[ -d "$PEND" ] || exit 0
shopt -s nullglob
n=0
for f in "$PEND"/*.json; do
  v=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('view',''))" "$f" 2>/dev/null) || continue
  [ -n "$v" ] || continue
  out=$(python3 tools/ui-feedback-apply.py --view "$v" --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>&1)
  rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -q '"applied": \[[^]]'; then
    echo "ui-feedback: view=$v → $(echo "$out" | head -c 300)"
    n=$((n+1))
  fi
done
[ $n -eq 0 ] && exit 0
echo "总计应用 $n 条反馈 → 受影响的页面已渲染「请刷新」横幅"
