#!/bin/bash
# 薄转发（迁移阶段 4.1）：src/system/ui-feedback/tools/ui-feedback-monitor.sh
exec bash "$(dirname "$0")/../src/system/ui-feedback/tools/ui-feedback-monitor.sh" "$@"
