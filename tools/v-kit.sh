#!/bin/sh
# 薄转发（迁移阶段 4.1）：实体已搬到 `src/system/repo-gate/tools/v-kit.sh`。
# 本文件**不含实现**：只把调用原样转过去（`exec` 不留中间进程，退出码与真跑一致）。
# 文档与人手命令里的 `tools/v-kit.sh V-002` / `--all` 一行都不用改。
set -u
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec sh "$HERE/../src/system/repo-gate/tools/v-kit.sh" "$@"
