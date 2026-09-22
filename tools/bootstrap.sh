#!/bin/sh
# 仓库内自包含运行时初始化（幂等，T-101）。
#
#   tools/bootstrap.sh          # 确保 <repo>/.venv 存在，写入运行时清单并冒烟
#   tools/bootstrap.sh --check  # 只做解析与冒烟，不创建 .venv
#
# 不安装任何第三方包，不写仓库外的文件（ADR-0007）。
set -u
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
QUOTAGENT_ROOT=$ROOT
export QUOTAGENT_ROOT

. "$HERE/runtime.sh"
VENV="$ROOT/.venv"
MODE="full"

if [ "${1:-}" = "--check" ]; then MODE="check"; fi

if [ "$MODE" = "full" ] && [ ! -x "$VENV/bin/python" ]; then
  printf 'bootstrap: 创建仓库内虚拟环境 %s\n' "$VENV"
  if ! "$QUOTAGENT_PY" -m venv --without-pip "$VENV"; then
    echo "bootstrap: venv 创建失败（解释器缺少 venv 模块）；仓库仍可直接用 QUOTAGENT_PY 运行" >&2
    exit 2
  fi
  REASON="created"
else
  REASON="reused"
fi

if [ "$MODE" = "full" ] && [ -x "$VENV/bin/python" ]; then
  "$VENV/bin/python" - "$VENV" "$REASON" <<'PY'
import json, platform, pathlib, sys, time

venv = pathlib.Path(sys.argv[1])
manifest = {
    "runtime": "quotagent/repo-venv",
    "event": sys.argv[2],
    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "python_version": "%d.%d.%d" % sys.version_info[:3],
    "python_implementation": platform.python_implementation(),
    "platform": platform.platform(),
    "third_party_packages": [],
    "note": "仅标准库；实现栈见 docs/design/adr/0007-p0-runtime-and-ledger-format.md",
}
path = venv / "quotagent-runtime.json"
path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print("manifest: %s" % path)
PY
  QUOTAGENT_PY="$VENV/bin/python"
  export QUOTAGENT_PY
fi

if [ "$MODE" = "check" ]; then
  exec "$HERE/run.sh" -m quotagent.qa selftest
fi

"$HERE/run.sh" -c "import quotagent, sys; print('quotagent %s on Python %s' % (quotagent.__version__, sys.version.split()[0]))" || exit 1
printf 'runtime ready: %s (%s)\n' "$VENV" "$REASON"
