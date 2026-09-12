#!/bin/sh
# 仓库内自包含运行时入口（T-101）。
#
#   tools/run.sh -m quotagent.qa ac AC-AUDIT-001
#   tools/run.sh -c "import quotagent; print(quotagent.__version__)"
#
# 由本脚本负责 sys.path（PYTHONPATH=src）与解释器解析，命令不依赖调用者的环境。
set -u
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
QUOTAGENT_ROOT=$ROOT
export QUOTAGENT_ROOT

. "$HERE/runtime.sh"

PYTHONPATH="$ROOT/src${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONPATH
export PYTHONIOENCODING=${PYTHONIOENCODING:-utf-8}

exec "$QUOTAGENT_PY" "$@"
