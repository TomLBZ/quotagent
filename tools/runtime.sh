#!/bin/sh
# quotagent 自包含运行时解析（POSIX sh，只用标准库假设）。
#
# 用法:
#   . "$ROOT/tools/runtime.sh"        # 设置 QUOTAGENT_ROOT / QUOTAGENT_PY
#   "$ROOT/tools/runtime.sh" --print  # 打印解释器绝对路径
#
# 解析顺序: $QUOTAGENT_PY → 仓库内 .venv/bin/python → 工作区工具链 $WS_VENV/bin/python →
#          PATH 上的 python3 / python。
# 每个候选都用它真正执行一段代码来验证（拒绝 python3.x-config 这类同名包装器）；
# 仓库不写任何仓库外的文件（ADR-0007）。
set -u

_qt_here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
QUOTAGENT_ROOT=${QUOTAGENT_ROOT:-$(CDPATH= cd -- "$_qt_here/.." && pwd)}
export QUOTAGENT_ROOT

_qt_probe='import sys
assert sys.version_info[:2] >= (3, 9), "需要 Python 3.9+，当前 " + sys.version
print(sys.executable)'

_qt_try() {
  _qt_cand=$1
  [ -n "$_qt_cand" ] || return 1
  case "$_qt_cand" in
    */*) [ -x "$_qt_cand" ] || return 1 ;;
  esac
  _qt_out=$("$_qt_cand" -c "$_qt_probe" 2>/dev/null) || return 1
  [ -n "$_qt_out" ] || return 1
  QUOTAGENT_PY=$_qt_out
  export QUOTAGENT_PY
  return 0
}

_qt_resolved=0
if _qt_try "${QUOTAGENT_PY:-}"; then _qt_resolved=1
elif _qt_try "$QUOTAGENT_ROOT/.venv/bin/python"; then _qt_resolved=1
elif [ -n "${WS_VENV:-}" ] && _qt_try "$WS_VENV/bin/python"; then _qt_resolved=1
elif _qt_try python3; then _qt_resolved=1
elif _qt_try python; then _qt_resolved=1
fi

if [ "$_qt_resolved" -eq 0 ]; then
  {
    echo "quotagent: 找不到可用的 Python 3.9+ 解释器。"
    echo "  修复: 设置 QUOTAGENT_PY=/path/to/python3，或先运行 tools/bootstrap.sh"
  } >&2
  return 2 2>/dev/null || exit 2
fi

if [ "${1:-}" = "--print" ]; then
  printf '%s\n' "$QUOTAGENT_PY"
fi
