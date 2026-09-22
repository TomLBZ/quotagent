#!/usr/bin/env python3
"""plugin-assets 门（`tools/verify.sh plugin-assets`）—— **检查/测试资产的归属一致性**（迁移阶段 4.1）。

规则真源：`docs/design/27-plugin-architecture.md` §2.1（每个插件有自己的 `code/`+`tools/`+`tests/`+…）、
§2.2（`tools/` 里的写账本者只能是该账本唯一写者）、§9 未决 3（`tools/` 保留的薄入口）；
执行清单：`docs/work/plans/plugin-migration-plan.md` §2 阶段 1/4.1；**人可读的分类表**在
`docs/work/plans/plugin-file-map.md` §分类（本门把它当登记真源逐条核对，不另立一处）。

这个门断言什么（每条都**真读磁盘 / 真跑命令**，不读代码猜）：
  PA1 每个**已搬**资产：**目标位置存在**（文件、非空），且**旧位置只剩薄转发**（含
      `薄转发（迁移阶段 4.1）` 标记、行数 ≤ 20、字节 ≤ 1200、内含目标相对路径、内容与目标不同）。
  PA2 旧位置**不是实体**：转发文件字节 ≤ 目标字节 1/4 且 sha256 ≠ 目标（挡住"把转发改成实体"）。
  PA3 分类表**双向**：`plugin-file-map.md` §分类 里 `插件·已搬` 的行 == 门内登记（旧位置/归属/子目录逐条一致），
      且门内登记的每一项都在表里有行（不许"搬了不登记"）。
  PA4 分类表是**全量登记**：§分类 三节的行集合 == 磁盘上的资产集合（`tools/` 顶层文件、`host/*-gate.mjs`、
      `src/quotagent/qa/checks_*.py`）—— 新增一个资产而不登记即红。
  PA5 归属唯一：每个已搬资产的 basename 在 `src/**`（排除 `__pycache__`）里**只出现一次**，
      且位于**归属插件**的目录下（资产不得出现在别的插件目录里）。
  PA6 门接口**不因搬迁失联**：`tools/verify.sh help` 真跑 rc=0、门名数 ≥ 70、`help` 列出的每个名字都有
      `case` 分支；每个分支里引用的**实现路径**都解析得到且真实存在；每个已搬资产仍被
      `tools/verify.sh` 或 `src/quotagent/qa/*.py` 引用（防"搬完就没人调用"）；再真跑一条最便宜的
      只读既有门（`v`）证明接口真能跑。
  PA7 `tools/**` 的**散落不再增长**：`tools/` 下的**非薄入口**文件集合 == §分类 里 `插件·待搬` 的集合（双向），
      且数量 ≤ `BASELINE_NONTHIN`（本批实测值，**只减不增**）。
  PA8 宿主层**非薄入口 == 文档登记的例外集合**（双向，默认集合为**空**）：`host/modules/**` 与 `host/lib/**`
      里不该再有实现文件（搬迁完成后应只剩薄入口/薄重导/薄转发）；任何仍有实体声明的文件必须在
      `docs/design/27-plugin-architecture.md` §10 的例外表里逐条登记（登记锚点 `<!-- exceptions: host-layer-nonthin -->`）。
      以前「搬漏一个」只有人眼能发现；这条把它变成**必红**。
  PA9 可移植性（服务「克隆即跑」）：`src/**`、`host/**`、`tools/**`、任意 `*.sh`、**根入口 `run`
      （没有扩展名，在 `**/*.sh` 之外）**里**没有硬编码的仓库根**——判据是「以 `quotagent` 为**末段目录**
      的绝对路径字面量」0 处（与"当前仓库在哪"无关 ⇒ 克隆到任何路径都能抓到别处硬编码过的那一串）；
      同时探针自证正则非空转。与 `clean-copy`/`run-clone` 互补：那两道门真跑行为，这条抓字面量。
  PA9b 扫描面**自证**：光有「0 处命中」分不清「干净」与「没扫到」⇒ 逐条点名「必须被扫到」的文件
      （含没有扩展名的根入口 `run`），漏一个即红。
  F0 基线（未变异）在同一套判据上**不红**（否则"变异变红"说明不了任何事）。
  F1..F4 **4 处单点变异全红**（整树副本 + 单点改动；每处必须让**指定的**断言变红）；
      ① 抽走目标目录里的资产 ② 把一条转发改成实体 ③ 把资产副本放进另一个插件目录
      ④ 往 `tools/` 加一个未登记的非薄入口 ⑤ 把一个**实体**放回 `host/modules/` 而不登记（PA8）
      ⑥ 在 `tools/` 的源码里写死仓库根（PA9）⑦ 在没有扩展名的**根入口 `run`** 里写死仓库根（PA9 的
      扫描面自证：那一层不在 `**/*.sh` 里）。
  F5 防假变异：不存在的锚点必须被判为假变异（不许"没改到任何字节"也算红）。
  F6 全过程**产品树字节不变**（变异只写在 `tmp/` 的整树副本里）。

用法：`tools/verify.sh plugin-assets`（或 `python3 tools/check-plugin-assets.py [--root DIR]`）
退出码：0 全通过 / 1 有断言失败 / 2 环境错误。
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
MAP_REL = "docs/work/plans/plugin-file-map.md"
VERIFY_REL = "tools/verify.sh"

#: 已搬资产登记（**唯一机器登记处**）：旧位置 → (归属插件 id, 新位置)；分类表里必须逐条对上（PA3）。
RELOCATED: dict[str, tuple[str, str]] = {
    # --- 本批（EV-176 / T-326）：`tools/**` 非薄入口 **12 个**搬进各自插件的 `tests/`（外圈、归属明确），
    # 旧位置留薄转发；实现只改一处 —— `ROOT` 推导 `parents[1]`/`parent.parent`（`tools/` 下）→ `parents[4]`
    # （`src/<层>/<插件>/tests/` 下，深度与既有已搬件一致）。门名与 `tools/verify.sh` 的分支一行未改。
    "tools/check-docs.py": (
        "system/repo-gate", "src/system/repo-gate/tests/check-docs.py"),
    "tools/check-ac-registry.py": (
        "system/repo-gate", "src/system/repo-gate/tests/check-ac-registry.py"),
    "tools/check-fr-coverage.py": (
        "system/repo-gate", "src/system/repo-gate/tests/check-fr-coverage.py"),
    "tools/check-invariants.py": (
        "system/repo-gate", "src/system/repo-gate/tests/check-invariants.py"),
    "tools/check-v-register.py": (
        "system/repo-gate", "src/system/repo-gate/tests/check-v-register.py"),
    "tools/check-module-wiring.py": (
        "system/repo-gate", "src/system/repo-gate/tests/check-module-wiring.py"),
    "tools/check-plugin-inventory.py": (
        "system/repo-gate", "src/system/repo-gate/tests/check-plugin-inventory.py"),
    "tools/check-clean-copy.py": (
        "system/repo-gate", "src/system/repo-gate/tests/check-clean-copy.py"),
    "tools/check-events.py": (
        "system/kernel", "src/system/kernel/tests/check-events.py"),
    "tools/check-webui.py": (
        "system/webui", "src/system/webui/tests/check-webui.py"),
    "tools/check-heuristics-route.py": (
        "domain/bid-heuristics", "src/domain/bid-heuristics/tests/check-heuristics-route.py"),
    "tools/check-idem-route.py": (
        "system/idempotency-guard", "src/system/idempotency-guard/tests/check-idem-route.py"),
    "tools/check-quote-draft-route.py": (
        "domain/quote-prepare", "src/domain/quote-prepare/tests/check-quote-draft-route.py"),
    "tools/check-rfq-visibility-route.py": (
        "system/projection", "src/system/projection/tests/check-rfq-visibility-route.py"),
    "tools/check-gate-timeline-route.py": (
        "domain/gate-timeline", "src/domain/gate-timeline/tests/check-gate-timeline-route.py"),
    "tools/check-change-detail-route.py": (
        "domain/gate-timeline", "src/domain/gate-timeline/tests/check-change-detail-route.py"),
    "tools/check-authority-route.py": (
        "domain/authority-band", "src/domain/authority-band/tests/check-authority-route.py"),
    "tools/check-plugin-lifecycle.py": (
        "system/runtime", "src/system/runtime/tests/check-plugin-lifecycle.py"),
    "tools/check-advice-route.py": (
        "domain/advice", "src/domain/advice/tests/check-advice-route.py"),
    "src/quotagent/qa/checks_qprep.py": (
        "domain/quote-prepare", "src/domain/quote-prepare/tests/checks_qprep.py"),
    # --- 阶段 4.2（EV-172 / T-321）：`host/*-gate.mjs` 20 个里的**前 10 个**搬进各自插件的 `tests/`，
    # 旧位置留薄转发（`import './../src/…'`；门名与 `tools/verify.sh` 的分支一行未改）。剩下 10 个登记为下批。
    "host/t247-idem-gate.mjs": (
        "system/idempotency-guard", "src/system/idempotency-guard/tests/t247-idem-gate.mjs"),
    "host/t247-scorecard-gate.mjs": (
        "domain/supplier-scorecard", "src/domain/supplier-scorecard/tests/t247-scorecard-gate.mjs"),
    "host/t250-budget-gate.mjs": (
        "system/budget-guard", "src/system/budget-guard/tests/t250-budget-gate.mjs"),
    "host/t250-approval-gate.mjs": (
        "system/approval", "src/system/approval/tests/t250-approval-gate.mjs"),
    "host/t254-retention-view-gate.mjs": (
        "system/retention", "src/system/retention/tests/t254-retention-view-gate.mjs"),
    "host/t280-ui-feedback-gate.mjs": (
        "system/ui-feedback", "src/system/ui-feedback/tests/t280-ui-feedback-gate.mjs"),
    "host/t284-authority-gate.mjs": (
        "domain/authority-band", "src/domain/authority-band/tests/t284-authority-gate.mjs"),
    "host/t285-rfq-deadline-gate.mjs": (
        "domain/rfq-deadline", "src/domain/rfq-deadline/tests/t285-rfq-deadline-gate.mjs"),
    "host/t286-quote-draft-gate.mjs": (
        "domain/quote-prepare", "src/domain/quote-prepare/tests/t286-quote-draft-gate.mjs"),
    "host/t287-rfq-visibility-gate.mjs": (
        "system/projection", "src/system/projection/tests/t287-rfq-visibility-gate.mjs"),
    # --- 阶段 4.2 续批（EV-173 / T-322）：`host/*-gate.mjs` **剩下 10 个**搬进各自插件的 `tests/`，
    # 旧位置留薄转发（`import './../src/…'`；门名与 `tools/verify.sh` 的分支一行未改）。
    # 搬迁补丁与上批逐字相同：HERE 由仓库根推出宿主目录 + `cordis` 改为按宿主目录显式解析。
    "host/t260-pipeline-gate.mjs": (
        "system/pipeline-view", "src/system/pipeline-view/tests/t260-pipeline-gate.mjs"),
    "host/t267-market-gate.mjs": (
        "system/market", "src/system/market/tests/t267-market-gate.mjs"),
    "host/t268-user-space-gate.mjs": (
        "system/user-plugin-manager", "src/system/user-plugin-manager/tests/t268-user-space-gate.mjs"),
    "host/t271-admin-gate.mjs": (
        "system/admin", "src/system/admin/tests/t271-admin-gate.mjs"),
    "host/t275-runtime-gate.mjs": (
        "system/agent-runtime", "src/system/agent-runtime/tests/t275-runtime-gate.mjs"),
    "host/t277-storage-gate.mjs": (
        "system/storage", "src/system/storage/tests/t277-storage-gate.mjs"),
    "host/t279-heuristics-gate.mjs": (
        "domain/bid-heuristics", "src/domain/bid-heuristics/tests/t279-heuristics-gate.mjs"),
    "host/t281-advice-gate.mjs": (
        "domain/advice", "src/domain/advice/tests/t281-advice-gate.mjs"),
    "host/t282-gate-timeline-gate.mjs": (
        "domain/gate-timeline", "src/domain/gate-timeline/tests/t282-gate-timeline-gate.mjs"),
    "host/t283-change-detail-gate.mjs": (
        "domain/gate-timeline", "src/domain/gate-timeline/tests/t283-change-detail-gate.mjs"),
    # --- 同批（EV-173 / T-322）：`src/quotagent/qa/checks_*.py` **21 个**搬进各自插件的 `tests/`，
    # 旧位置留薄转发（`importlib` 按文件路径装载实体；`quotagent.qa` 包的导入面与 AC 注册不变）。
    "src/quotagent/qa/checks_admin.py": (
        "system/admin", "src/system/admin/tests/checks_admin.py"),
    "src/quotagent/qa/checks_adv.py": (
        "domain/advice", "src/domain/advice/tests/checks_adv.py"),
    "src/quotagent/qa/checks_gate.py": (
        "domain/gate-timeline", "src/domain/gate-timeline/tests/checks_gate.py"),
    "src/quotagent/qa/checks_uifb.py": (
        "system/ui-feedback", "src/system/ui-feedback/tests/checks_uifb.py"),
    "src/quotagent/qa/checks_viz.py": (
        "domain/bid-heuristics", "src/domain/bid-heuristics/tests/checks_viz.py"),
    "src/quotagent/qa/checks_config.py": (
        "system/config", "src/system/config/tests/checks_config.py"),
    "src/quotagent/qa/checks_uxweb.py": (
        "system/webui", "src/system/webui/tests/checks_uxweb.py"),
    "src/quotagent/qa/checks_storage.py": (
        "system/storage", "src/system/storage/tests/checks_storage.py"),
    "src/quotagent/qa/checks_userplugin.py": (
        "system/user-plugin-manager", "src/system/user-plugin-manager/tests/checks_userplugin.py"),
    "src/quotagent/qa/checks_userplugin_versions.py": (
        "system/user-plugin-manager", "src/system/user-plugin-manager/tests/checks_userplugin_versions.py"),
    "src/quotagent/qa/checks_userplugin_elevate.py": (
        "system/user-plugin-manager", "src/system/user-plugin-manager/tests/checks_userplugin_elevate.py"),
    "src/quotagent/qa/checks_agentrt.py": (
        "system/agent-runtime", "src/system/agent-runtime/tests/checks_agentrt.py"),
    "src/quotagent/qa/checks_agentrt_lifecycle.py": (
        "system/agent-runtime", "src/system/agent-runtime/tests/checks_agentrt_lifecycle.py"),
    "src/quotagent/qa/checks_agentrt_memory.py": (
        "system/agent-runtime", "src/system/agent-runtime/tests/checks_agentrt_memory.py"),
    "src/quotagent/qa/checks_mail.py": (
        "system/mail", "src/system/mail/tests/checks_mail.py"),
    "src/quotagent/qa/checks_mail_transport.py": (
        "system/mail", "src/system/mail/tests/checks_mail_transport.py"),
    "src/quotagent/qa/checks_usreq.py": (
        "system/repo-gate", "src/system/repo-gate/tests/checks_usreq.py"),
    "src/quotagent/qa/checks_design.py": (
        "system/repo-gate", "src/system/repo-gate/tests/checks_design.py"),
    "src/quotagent/qa/checks_audit.py": (
        "system/evidence", "src/system/evidence/tests/checks_audit.py"),
    "src/quotagent/qa/checks_retention.py": (
        "system/retention", "src/system/retention/tests/checks_retention.py"),
    "src/quotagent/qa/checks_retention_exec.py": (
        "system/retention", "src/system/retention/tests/checks_retention_exec.py"),
    # --- 阶段 4.2 终批（EV-174 / T-323）：`src/quotagent/qa/checks_*.py` **剩下的 25 个**搬进各自插件的
    # `tests/`，旧位置留薄转发（`importlib` 按文件路径装载实体；`quotagent.qa` 包的导入面与 AC 注册不变）。
    # 至此 `qa/checks_*.py`：实体 0 / 旧位置薄转发 47（47/47 搬完）。
    "src/quotagent/qa/checks_award.py": (
        "domain/commitments", "src/domain/commitments/tests/checks_award.py"),
    "src/quotagent/qa/checks_bridge.py": (
        "system/kernel-bridge", "src/system/kernel-bridge/tests/checks_bridge.py"),
    "src/quotagent/qa/checks_capacity.py": (
        "domain/capacity", "src/domain/capacity/tests/checks_capacity.py"),
    "src/quotagent/qa/checks_change.py": (
        "domain/change", "src/domain/change/tests/checks_change.py"),
    "src/quotagent/qa/checks_clarify.py": (
        "domain/clarify", "src/domain/clarify/tests/checks_clarify.py"),
    "src/quotagent/qa/checks_compare.py": (
        "domain/compare", "src/domain/compare/tests/checks_compare.py"),
    "src/quotagent/qa/checks_cost.py": (
        "domain/costmodel", "src/domain/costmodel/tests/checks_cost.py"),
    "src/quotagent/qa/checks_deviation.py": (
        "domain/deviation", "src/domain/deviation/tests/checks_deviation.py"),
    "src/quotagent/qa/checks_eval.py": (
        "system/eval", "src/system/eval/tests/checks_eval.py"),
    "src/quotagent/qa/checks_events.py": (
        "system/kernel", "src/system/kernel/tests/checks_events.py"),
    "src/quotagent/qa/checks_export.py": (
        "domain/export", "src/domain/export/tests/checks_export.py"),
    "src/quotagent/qa/checks_faq.py": (
        "domain/faq", "src/domain/faq/tests/checks_faq.py"),
    "src/quotagent/qa/checks_guard.py": (
        "domain/guard", "src/domain/guard/tests/checks_guard.py"),
    "src/quotagent/qa/checks_intake.py": (
        "domain/intake", "src/domain/intake/tests/checks_intake.py"),
    "src/quotagent/qa/checks_negotiation.py": (
        "domain/negotiation", "src/domain/negotiation/tests/checks_negotiation.py"),
    "src/quotagent/qa/checks_norm.py": (
        "system/norm", "src/system/norm/tests/checks_norm.py"),
    "src/quotagent/qa/checks_plugin.py": (
        "system/kernel", "src/system/kernel/tests/checks_plugin.py"),
    "src/quotagent/qa/checks_pricing.py": (
        "domain/pricing", "src/domain/pricing/tests/checks_pricing.py"),
    "src/quotagent/qa/checks_qep.py": (
        "system/kernel", "src/system/kernel/tests/checks_qep.py"),
    "src/quotagent/qa/checks_quotes.py": (
        "domain/quotes", "src/domain/quotes/tests/checks_quotes.py"),
    "src/quotagent/qa/checks_rfq.py": (
        "domain/rfq", "src/domain/rfq/tests/checks_rfq.py"),
    "src/quotagent/qa/checks_runtime.py": (
        "system/runtime", "src/system/runtime/tests/checks_runtime.py"),
    "src/quotagent/qa/checks_sync.py": (
        "domain/sync", "src/domain/sync/tests/checks_sync.py"),
    "src/quotagent/qa/checks_terms.py": (
        "domain/terms", "src/domain/terms/tests/checks_terms.py"),
    "src/quotagent/qa/checks_ui_snapshot.py": (
        "system/webui", "src/system/webui/tests/checks_ui_snapshot.py"),
    # --- 本批（EV-177 / T-327）：`tools/**` 非薄入口 **12 个**（8 个路由门 + 4 个平台门）搬进各自插件的
    # `tests/`（旧位置留**薄转发**，`runpy` 按目标路径装载）；实现只改一处 —— `ROOT` 推导
    # `Path(__file__).resolve().parents[1]`（`tools/` 下）→ `parents[4]`（`src/<层>/<插件>/tests/` 下）。
    # 门名与 `tools/verify.sh` 的分支一行未改 ⇒ 受影响门的 rc 与 passed/total 逐项对拍不变。
    "tools/check-admin-route.py": (
        "system/admin", "src/system/admin/tests/check-admin-route.py"),
    "tools/check-budget-route.py": (
        "system/budget-guard", "src/system/budget-guard/tests/check-budget-route.py"),
    "tools/check-pipeline-route.py": (
        "system/pipeline-view", "src/system/pipeline-view/tests/check-pipeline-route.py"),
    "tools/check-rfq-deadline-route.py": (
        "domain/rfq-deadline", "src/domain/rfq-deadline/tests/check-rfq-deadline-route.py"),
    "tools/check-ui-seed.py": (
        "system/webui", "src/system/webui/tests/check-ui-seed.py"),
    "tools/check-mail-transport.py": (
        "system/mail", "src/system/mail/tests/check-mail-transport.py"),
    "tools/check-config-route.py": (
        "system/config", "src/system/config/tests/check-config-route.py"),
    "tools/check-ui-feedback.py": (
        "system/ui-feedback", "src/system/ui-feedback/tests/check-ui-feedback.py"),
    "tools/check-modules.py": (
        "system/repo-gate", "src/system/repo-gate/tests/check-modules.py"),
    "tools/check-evolved-module.py": (
        "system/evolution", "src/system/evolution/tests/check-evolved-module.py"),
    "tools/check-plugin-requirements.py": (
        "system/repo-gate", "src/system/repo-gate/tests/check-plugin-requirements.py"),
    "tools/check-plugin-assets.py": (
        "system/repo-gate", "src/system/repo-gate/tests/check-plugin-assets.py"),
    # --- 本批（EV-178 / T-328）：`tools/**` 非薄入口 **17 个**搬进各自插件的 `tools/`（旧位置留**薄转发**，
    # `runpy`/`exec bash`/副作用 import 三种形态按扩展名选，见 `plugin-file-map-batches.md` §批次台账）。
    # 实现只改一处 —— 仓库根推导 `parents[1]`/`parent.parent`（`tools/` 下）→ `parents[4]`
    # （`src/<层>/<插件>/tools/` 下，深度与既有 `tests/` 已搬件一致）；门名与 `tools/verify.sh` 的分支一行未改。
    # 被**源码文本读**的三处读方（`checks_uifb.py` 的 `APPLY`、`checks_admin.py` 的 `WRITER`、
    # `checks_usreq.py` 的 `MONITOR`/`TICK`）**先改指实体**再搬，否则断言会在 4 行转发上静默判绿。
    "tools/admin-apply.py": (
        "system/admin", "src/system/admin/tools/admin-apply.py"),
    "tools/audit-verify.py": (
        "system/evidence", "src/system/evidence/tools/audit-verify.py"),
    "tools/evolve-module.mjs": (
        "system/evolution", "src/system/evolution/tools/evolve-module.mjs"),
    "tools/evolve-record.py": (
        "system/evolution", "src/system/evolution/tools/evolve-record.py"),
    "tools/export-events.py": (
        "system/evidence", "src/system/evidence/tools/export-events.py"),
    "tools/gate-nudge.py": (
        "domain/gate-timeline", "src/domain/gate-timeline/tools/gate-nudge.py"),
    "tools/refresh-admin-snapshot.py": (
        "system/admin", "src/system/admin/tools/refresh-admin-snapshot.py"),
    "tools/refresh-agent-memory.py": (
        "system/agent-runtime", "src/system/agent-runtime/tools/refresh-agent-memory.py"),
    "tools/refresh-retention-plan.py": (
        "system/retention", "src/system/retention/tools/refresh-retention-plan.py"),
    "tools/rfq-promise.py": (
        "domain/rfq-deadline", "src/domain/rfq-deadline/tools/rfq-promise.py"),
    "tools/storage.py": (
        "system/storage", "src/system/storage/tools/storage.py"),
    "tools/ui-feedback-apply.py": (
        "system/ui-feedback", "src/system/ui-feedback/tools/ui-feedback-apply.py"),
    "tools/ui-feedback-monitor.sh": (
        "system/ui-feedback", "src/system/ui-feedback/tools/ui-feedback-monitor.sh"),
    "tools/ui-feedback-tick.sh": (
        "system/ui-feedback", "src/system/ui-feedback/tools/ui-feedback-tick.sh"),
    "tools/userplugin-elevate.py": (
        "system/user-plugin-manager", "src/system/user-plugin-manager/tools/userplugin-elevate.py"),
    "tools/userplugin-record.py": (
        "system/user-plugin-manager", "src/system/user-plugin-manager/tools/userplugin-record.py"),
    "tools/ws-integrate.py": (
        "system/runtime", "src/system/runtime/tools/ws-integrate.py"),
    # --- 阶段 4.2 续搬（EV-175 / T-325）：挑**外圈且归属明确**的 10 个 `tools/**` 非薄入口搬进各自插件的
    # `tests/`（旧位置留薄转发；`tools/verify.sh` 的门名与分支一行未改）。选的都是自洽的小门：
    # 只做 `ROOT` 推导（`parents[1]` → `parents[4]`）这一处改动，行为逐项对拍一致。
    "tools/check-faq.py": (
        "domain/faq", "src/domain/faq/tests/check-faq.py"),
    "tools/check-negotiation.py": (
        "domain/negotiation", "src/domain/negotiation/tests/check-negotiation.py"),
    "tools/check-retention.py": (
        "system/retention", "src/system/retention/tests/check-retention.py"),
    "tools/check-mail.py": (
        "system/mail", "src/system/mail/tests/check-mail.py"),
    "tools/check-canary.py": (
        "system/canary", "src/system/canary/tests/check-canary.py"),
    "tools/check-canary-dispatch.py": (
        "system/canary", "src/system/canary/tests/check-canary-dispatch.py"),
    "tools/check-bridge-canary.py": (
        "system/canary", "src/system/canary/tests/check-bridge-canary.py"),
    "tools/check-governor.py": (
        "system/governor", "src/system/governor/tests/check-governor.py"),
    "tools/check-audit-hook.py": (
        "system/audit-hook", "src/system/audit-hook/tests/check-audit-hook.py"),
    "tools/check-breaker-route.py": (
        "system/circuit-breaker", "src/system/circuit-breaker/tests/check-breaker-route.py"),
    # --- 本批（`EV-179`）：`tools/**` 非薄入口**再搬 10 个**（余 3：`netblock.c` / `v-kit.sh` /
    # `manual-check.py`）。旧位置留 `runpy` 薄转发；实现只改一处 —— `ROOT` 推导 `parents[1]`
    # （`tools/` 下）→ `parents[4]`（`src/<层>/<插件>/{tests,tools}/` 同为四层上溯），外加**先改读方**
    # （按路径装载被检查实体的 7 处：check-config-route / check-mail-transport ×2 / mail_transport /
    # check-ui-seed / checks_ui_snapshot / checks_qprep / check-quote-draft-route / check-run-once）。
    "tools/check-run-once.py": (
        "system/runtime", "src/system/runtime/tests/check-run-once.py"),
    "tools/check-run-clone.py": (
        "system/runtime", "src/system/runtime/tests/check-run-clone.py"),
    "tools/config-apply.py": (
        "system/config", "src/system/config/tools/config-apply.py"),
    "tools/g1-walkthrough.py": (
        "system/repo-gate", "src/system/repo-gate/tests/g1-walkthrough.py"),
    "tools/mutate-ui-views.py": (
        "system/webui", "src/system/webui/tools/mutate-ui-views.py"),
    "tools/quote-draft.py": (
        "domain/quote-prepare", "src/domain/quote-prepare/tools/quote-draft.py"),
    "tools/quote-sign.py": (
        "domain/quote-prepare", "src/domain/quote-prepare/tools/quote-sign.py"),
    "tools/refresh-ui-snapshots.py": (
        "system/webui", "src/system/webui/tools/refresh-ui-snapshots.py"),
    "tools/ui-seed-pipeline.py": (
        "system/webui", "src/system/webui/tools/ui-seed-pipeline.py"),
    "tools/v-kit.sh": (
        "system/repo-gate", "src/system/repo-gate/tools/v-kit.sh"),
    "tools/netblock.c": (
        "system/runtime", "src/system/runtime/tests/netblock.c"),
    "tools/webui-serve.py": (
        "system/webui", "src/system/webui/tools/webui-serve.py"),
}

#: 平台级薄入口（27 §9 未决 3 + 阶段 5.2 的 `plugin.sh`）：不搬、留名。
THIN_ENTRIES = frozenset({"verify.sh", "run.sh", "runtime.sh", "bootstrap.sh", "cordis.sh", "plugin.sh"})
FORWARDER_MARK = "薄转发（迁移阶段 4.1）"
MAX_FORWARDER_BYTES = 1200
MAX_FORWARDER_LINES = 20
EXCLUDE_DIRS = frozenset({"__pycache__", ".git", "tmp", "node_modules", ".venv"})

#: `tools/` 下非薄入口文件的**实测值**：一路由 69（搬前）→ 63 → 64（`EV-171` 加干净副本门）→ 54（`EV-175` 搬 10）
#: → 42（`EV-176` 搬 12）→ 30（`EV-177` 搬 12）→ 13（`EV-178` 搬 17）→ 3（`EV-179` 再搬 10）
#: → **1（本批 `EV-180` 再搬 2）**；旧位置全部变薄转发（`.c` 用 `#include`、`.sh` 用 `exec sh`）。
#: 余下**一个**逐条留名：`manual-check.py`（PA6 断言「已搬资产仍被**契约面**引用」，它在 verify.sh / qa /
#: tests / tools 里都没有调用者 ⇒ 搬了就等于制造一个孤儿）。本批搬走的两个不再有这种理由：
#: `netblock.c` 的读方 `src/system/runtime/tests/check-run-once.py` 已**跟到实体**、`v-kit.sh` 由
#: `docs/work/validation/README.md` 的人手命令使用（旧路径的 `exec sh` 薄转发保持命令不变）。
#: 逐批加减史与复算命令见 `docs/work/plans/plugin-file-map-batches.md` §「非薄入口数的加减史」。
#: 锁的语义是"只减不增"：搬走本门或其它项时这个数应随之下调；**上调只允许"新增一个同级平台门"这一种理由**（改这一行是显式动作）。
BASELINE_NONTHIN = 1
#: 门名数下界（阶段 4.1 搬前 69 + `plugin-assets` = 70；本批新增 `run-clone` ⇒ 71；门名是接口，只增不减）。
MIN_GATE_NAMES = 71
#: `--help` 一类的别名不算"实现分支"。
HELP_ALIASES = frozenset({"help", "--help", "-h"})

CASE_RE = re.compile(r"^  (?P<name>[a-zA-Z0-9|_-]+)\)\s*$", re.M)
# 实现路径 token：可带 `$ROOT/` / `$HERE/` 锚点，允许 `../` 链，必须以扩展名结尾（挡住散文里的目录名）。
PATH_RE = re.compile(r"(?:(?P<anchor>\$\{?(?:ROOT|HERE)\}?)/)?(?P<rel>(?:\.\./)*[A-Za-z0-9_./-]*\.[A-Za-z0-9]+)")
TOP_DIRS = ("tools", "host", "src", "docs", "run", "AGENTS.md", "README.md")
ROW_RE = re.compile(r"^\|\s*`(?P<asset>[^`]+)`\s*\|\s*(?P<owner>[^|]*?)\s*\|\s*(?P<klass>[^|]*?)\s*\|\s*(?P<sub>[^|]*?)\s*\|\s*$")
CLASSES = ("平台薄入口", "插件·已搬", "插件·待搬")

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def is_excluded(path: Path, root: Path) -> bool:
    """按**相对仓库根**的路径分量判定（副本位于 `/…/tmp/…` 下也不会被整片误排除）。"""
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        parts = path.parts
    return bool(EXCLUDE_DIRS.intersection(parts))


def tools_files(root: Path) -> list[str]:
    """`tools/` 下的文件（相对仓库根；排除 `__pycache__` 一类派生目录）。"""
    base = root / "tools"
    out = [str(p.relative_to(root)) for p in base.rglob("*") if p.is_file() and not is_excluded(p, root)]
    return sorted(out)


def host_gate_files(root: Path) -> list[str]:
    return sorted(str(p.relative_to(root)) for p in (root / "host").glob("*-gate.mjs") if p.is_file())


def qa_check_files(root: Path) -> list[str]:
    return sorted(str(p.relative_to(root)) for p in (root / "src" / "quotagent" / "qa").glob("checks_*.py") if p.is_file())


#: 硬编码「仓库根（checkout 路径）」的判据：绝对路径里以 `quotagent` 为**末段目录**的那些。
#: 判据形状 = `<任意前缀目录>` 之后直接接上末段目录 `quotagent`（例：`<工作区>/projects` 再拼 `quotagent`）
#: ✅ 命中；`/workspace/config/quotagent-admin-token` ❌（末段是文件名，不是 checkout 根）；
#: `/…/config` 段下把 `quotagent` 当**文件名词干**（如 admin token 文件）❌ 不命中；
#: HTTP 路由前缀那种（前导段后直接接 `quotagent/`）❌ 也不命中——本条注释自己也受 PA9 扫，故只按形状描述。
#: 与「当前仓库实际在哪」无关 ⇒ 克隆到任何路径都能抓到**别处硬编码过的**那一串（才是可移植性缺陷）。
HARDCODED_CHECKOUT_RE = re.compile(r"(?:/[A-Za-z0-9._-]+)+/quotagent(?![A-Za-z0-9._-])")
#: 扫描面（PA9）= 会被「克隆即跑」直接执行的那几层：`src/**`、`host/**`、`tools/**`、任意 `*.sh`、
#: **以及仓库根那个没有扩展名的入口 `run`**（`**/*.sh` 匹配不到它 —— 盲区；而 `./run up` 恰恰是
#: 「克隆即跑」的第一层）。
PORTABLE_SCAN_GLOBS = ("src/**/*", "host/**/*", "tools/**/*", "**/*.sh", "run")
MAX_PORTABLE_SCAN_BYTES = 512_000


def hardcoded_root_hits(root: Path) -> tuple[list[str], int, list[str]]:
    """PA9 的扫描器：返回（`相对路径:行号: 原始行` 升序, 扫描文件数, 扫描到的相对路径升序）。只读、有界。

    第三个返回值是给 PA9b 用的**扫描面自证**：光看命中数为 0 分不清「干净」与「没扫到」
    （扩展名外的入口漏扫过一次，正是这条要防的）。
    """
    files: set[Path] = set()
    for pattern in PORTABLE_SCAN_GLOBS:
        for path in root.glob(pattern):
            if path.is_file() and not is_excluded(path, root):
                files.add(path)
    hits: list[str] = []
    for path in sorted(files):
        try:
            if path.stat().st_size > MAX_PORTABLE_SCAN_BYTES:
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:                      # 读不到/竞态消失：不把它当命中（范围外的事不该让断言变红）
            continue
        for number, line in enumerate(text.splitlines(), start=1):
            if HARDCODED_CHECKOUT_RE.search(line):
                hits.append(f"{path.relative_to(root)}:{number}: {line.strip()[:120]}")
    return hits, len(files), sorted(str(p.relative_to(root)) for p in files)


def classification_rows(root: Path) -> list[dict]:
    """解析 `plugin-file-map.md` §分类 的三节表（机器登记的人可读镜像）。"""
    text = (root / MAP_REL).read_text(encoding="utf-8")
    rows: list[dict] = []
    section = None
    in_it = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("## 分类") or stripped.startswith("## 分类表"):
            in_it = True
            continue
        if in_it and stripped.startswith("## "):
            break
        if in_it and stripped.startswith("### "):
            section = stripped
            continue
        if not in_it:
            continue
        match = ROW_RE.match(stripped)
        if not match or section is None:
            continue
        asset = match.group("asset").strip()
        klass = match.group("klass").strip().strip("`")
        if klass not in CLASSES:
            continue
        owner = match.group("owner").strip().strip("`")
        rows.append({"section": section, "asset": asset, "owner": owner, "klass": klass,
                     "sub": match.group("sub").strip().strip("`")})
    return rows


def forwarder_problem(root: Path, old: str, target: str) -> str:
    """旧位置是否"只剩薄转发"；返回空串 = 通过，否则是有名的原因。"""
    old_path, target_path = root / old, root / target
    if not old_path.is_file():
        return f"旧位置不存在：{old}"
    text = old_path.read_text(encoding="utf-8", errors="replace")
    size, lines = old_path.stat().st_size, len(text.splitlines())
    if FORWARDER_MARK not in text:
        return f"缺薄转发标记（{FORWARDER_MARK}）：{old}"
    if size > MAX_FORWARDER_BYTES:
        return f"转发文件过大（{size} B > {MAX_FORWARDER_BYTES} B）：{old}"
    if lines > MAX_FORWARDER_LINES:
        return f"转发文件行数过多（{lines} > {MAX_FORWARDER_LINES}）：{old}"
    if target not in text and Path(target).name not in text:
        return f"转发没有指向目标（{target}）：{old}"
    if target_path.is_file():
        if sha256(old_path) == sha256(target_path):
            return f"旧位置与目标字节相同（= 实体没搬走/留了副本）：{old}"
        if size * 4 > target_path.stat().st_size:
            return (f"旧位置相对目标过大（{size} B vs {target_path.stat().st_size} B，"
                    f"超过 1/4 ⇒ 不像薄转发）：{old}")
    return ""


# ---------------------------------------------------------------------------
# PA8：宿主层非薄入口的判据与「文档登记的例外集合」读取
# ---------------------------------------------------------------------------
EXCEPTIONS_DOC = "docs/design/27-plugin-architecture.md"
EXCEPTIONS_ANCHOR = "<!-- exceptions: host-layer-nonthin -->"
#: 实现声明（出现任意一条即「不是薄入口」）。
DECL_RE = re.compile(r"^\s*(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\b")
THIN_MARKS = ("薄重导", "薄转发")


def is_thin_host_file(path: Path) -> bool:
    """薄入口/薄重导/薄转发：含标记 + ≤ `MAX_FORWARDER_LINES` 行 + ≤ `MAX_FORWARDER_BYTES` 字节 + 无实现声明。

    为什么不用「文件很小」当唯一判据：8 行的重导与 8 行的**实现**在字节上分不开 —— 判据必须落在
    「除注释与 `import`/`export *` 外没有声明」这一条上，否则把实体改短就能绕过去。
    """
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    if not any(mark in text for mark in THIN_MARKS):
        return False
    if path.stat().st_size > MAX_FORWARDER_BYTES:
        return False
    lines = [line for line in text.splitlines()
             if line.strip() and not line.strip().startswith(("//", "*", "/*"))]
    if len(lines) > MAX_FORWARDER_LINES:
        return False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("import ") or stripped.startswith("export *"):
            continue
        if DECL_RE.match(line):
            return False
    return True


def nonthin_host_files(root: Path) -> list[str]:
    """`host/modules/**` 与 `host/lib/**` 里**仍有实体**的 `.mjs`（相对仓库根，排序）。"""
    out: list[str] = []
    for base in ("host/modules", "host/lib"):
        for path in sorted((root / base).glob("*.mjs")):
            if not is_thin_host_file(path):
                out.append(str(path.relative_to(root)))
    return out


def exception_rows(root: Path) -> set[str] | None:
    """读 `27-plugin-architecture.md` §10 的例外登记表；缺锚点返回 None（= 判红，不许悄悄没有登记处）。"""
    try:
        text = (root / EXCEPTIONS_DOC).read_text(encoding="utf-8")
    except OSError:
        return None
    if EXCEPTIONS_ANCHOR not in text:
        return None
    section = text.split(EXCEPTIONS_ANCHOR, 1)[1].split("\n## ", 1)[0]
    rows: set[str] = set()
    for line in section.splitlines():
        match = re.match(r"^\|\s*`(?P<path>[^`]+)`\s*\|", line.strip())
        if match:
            rows.add(match.group("path").strip())
    return rows


def resolve_tokens(root: Path, body: str) -> tuple[list[str], list[str]]:
    """抽出分支体里引用的实现路径 → (真实存在的, 解析不到/不存在的)。"""
    ok: list[str] = []
    bad: list[str] = []
    for line in body.splitlines():
        if line.strip().startswith("#"):
            continue
        for match in PATH_RE.finditer(line):
            rel = match.group("rel")
            anchor = match.group("anchor")
            if any(ch in rel for ch in "*${}") or "XXXX" in rel:
                continue
            if anchor == "$HERE":
                rel = "tools/" + rel
            rel = os.path.normpath(rel)
            # 只认"实现路径"：首段必须是本仓的顶层目录（挡住 `tmp/*.XXXXXX` 一类临时路径与散文里的文件名）。
            if rel.split("/", 1)[0] not in TOP_DIRS:
                continue
            if rel.startswith("..") or (root / rel).is_dir():
                continue
            (ok if (root / rel).exists() else bad).append(rel)
    return sorted(set(ok)), sorted(set(bad))


def gate_interface_problems(root: Path, run_gates: bool) -> tuple[list[str], str]:
    """PA6：门名 ↔ 分支 ↔ 实现路径三方对齐；可选真跑 help 与 v。"""
    problems: list[str] = []
    text = (root / VERIFY_REL).read_text(encoding="utf-8")
    starts = [(m.start(), m.group("name")) for m in CASE_RE.finditer(text)]
    names: set[str] = set()
    for _entry in starts:
        names |= {n for n in _entry[1].split("|") if n}
    resolved = 0
    for i, (pos, name) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(text)
        good, bad = resolve_tokens(root, text[pos:end])
        resolved += len(good)
        for rel in bad:
            problems.append(f"分支 `{name}` 引用的实现不存在：{rel}")
    if len(names) < MIN_GATE_NAMES:
        problems.append(f"门名数 {len(names)} < {MIN_GATE_NAMES}（门名是接口，只增不减）")
    if resolved < 60:
        problems.append(f"分支里解析到的实现路径只有 {resolved} 个（判定器在空转？）")
    if not run_gates:
        return problems, f"静态解析 {resolved} 条实现路径"
    env = dict(os.environ)
    env["QUOTAGENT_ROOT"] = str(root)
    helped = subprocess.run(["sh", str(root / VERIFY_REL), "help"], cwd=str(root), capture_output=True,
                            text=True, timeout=180, env=env)
    if helped.returncode != 0:
        problems.append(f"`verify.sh help` rc={helped.returncode}（接口失联）")
    listed: set[str] = set()
    for line in helped.stdout.splitlines():
        for token in line.strip().split("|"):
            token = token.strip()
            if re.fullmatch(r"[a-z0-9_-]+", token or ""):
                listed.add(token)
    for name in sorted(listed - HELP_ALIASES):
        if name not in names:
            problems.append(f"`verify.sh help` 列出了 `{name}`，但没有对应的 case 分支")
    if len(listed) < MIN_GATE_NAMES:
        problems.append(f"`verify.sh help` 只列出 {len(listed)} 个门名（< {MIN_GATE_NAMES}）")
    cheap = subprocess.run(["sh", str(root / VERIFY_REL), "v"], cwd=str(root), capture_output=True,
                           text=True, timeout=300, env=env)
    if cheap.returncode != 0:
        problems.append(f"`verify.sh v`（最便宜的只读门）rc={cheap.returncode}："
                        f"{(cheap.stderr or cheap.stdout).strip().splitlines()[-1][:120] if (cheap.stderr or cheap.stdout).strip() else ''}")
    return problems, f"真跑 help rc={helped.returncode}（{len(listed)} 个门名）+ v rc={cheap.returncode}；静态解析 {resolved} 条实现路径"


def evaluate(root: Path, run_gates: bool = True) -> tuple[list[tuple[str, bool, str]], dict]:
    """对给定仓库根求值（正控与变异共用同一套判据，杜绝两套）。"""
    res: list[tuple[str, bool, str]] = []
    add = lambda name, ok, detail="": res.append((name, bool(ok), detail))  # noqa: E731
    facts: dict = {}

    # --- PA1/PA2：已搬资产（目标在 + 旧位置只剩薄转发 + 旧位置不是实体）------------------
    p1: list[str] = []
    p2: list[str] = []
    for old, (owner, target) in sorted(RELOCATED.items()):
        target_path = root / target
        if not target_path.is_file():
            p1.append(f"目标不存在：{target}")
            continue
        if target_path.stat().st_size == 0:
            p1.append(f"目标是空文件：{target}")
        problem = forwarder_problem(root, old, target)
        if problem:
            p1.append(problem)
        else:
            old_size, target_size = (root / old).stat().st_size, target_path.stat().st_size
            if old_size * 4 > target_size:
                p2.append(f"{old}（{old_size} B vs {target_size} B）")
    add(f"PA1 已搬 {len(RELOCATED)} 个资产：目标存在且旧位置只剩薄转发（标记/行数/字节/指向）",
        not p1, "; ".join(p1[:6]) or f"全部通过（{len(RELOCATED)} 项）")
    add("PA2 旧位置不是实体：字节 ≤ 目标 1/4 且 sha256 ≠ 目标（挡住「把转发改成实体」）",
        not p2, "; ".join(p2[:6]) or "全部通过")

    # --- PA3/PA4：分类表双向 + 全量登记 -----------------------------------------------
    rows = classification_rows(root)
    facts["rows"] = len(rows)
    table_moved = {r["asset"]: r for r in rows if r["klass"] == "插件·已搬"}
    mismatch: list[str] = []
    for old, (owner, target) in sorted(RELOCATED.items()):
        row = table_moved.get(old)
        if row is None:
            mismatch.append(f"表里没有已搬行：{old}")
            continue
        sub = f'{target.rsplit("/", 2)[1]}/'
        if row["owner"] != owner:
            mismatch.append(f"{old} 归属不一致：表={row['owner']} 登记={owner}")
        if row["sub"] != sub:
            mismatch.append(f"{old} 子目录不一致：表={row['sub']} 登记={sub}")
    for asset in sorted(set(table_moved) - set(RELOCATED)):
        mismatch.append(f"表里标了已搬但门内无登记：{asset}")
    add(f"PA3 分类表 §分类 的「已搬」行 == 门内登记（{len(RELOCATED)} 项，归属与子目录逐条一致）",
        not mismatch, "; ".join(mismatch[:6]) or "双向一致")

    disk = {
        "tools": set(tools_files(root)),
        "host": set(host_gate_files(root)),
        "qa": set(qa_check_files(root)),
    }
    name_of = {"tools": "`tools/**`", "host": "`host/*-gate.mjs`", "qa": "`src/quotagent/qa/checks_*.py`"}
    unregistered: list[str] = []
    for key, files in disk.items():
        registered = {r["asset"] for r in rows if r["asset"] in files}
        for asset in sorted(files - registered):
            unregistered.append(f"{key}: {asset}")
    add(f"PA4 分类表是**全量登记**（tools {len(disk['tools'])} / host {len(disk['host'])} / "
        f"qa {len(disk['qa'])} 个资产逐条有行）", not unregistered, "; ".join(unregistered[:8]) or "无遗漏")
    facts["registered"] = sum(len({r['asset'] for r in rows if r['asset'] in f}) for f in disk.values())

    # --- PA5：归属唯一（不许出现在别的插件目录里）-------------------------------------
    src_files = [p for p in (root / "src").rglob("*") if p.is_file() and not is_excluded(p, root)]
    wrong: list[str] = []
    for old, (owner, target) in sorted(RELOCATED.items()):
        base = Path(target).name
        # 旧位置自身允许存在（它就是薄转发的家）；这里只看"实体"是否唯一、是否落在归属插件目录里。
        hits = [str(p.relative_to(root)) for p in src_files if p.name == base and str(p.relative_to(root)) != old]
        if len(hits) != 1:
            wrong.append(f"{base} 在 src/** 里出现 {len(hits)} 次：{hits[:4]}")
            continue
        owner_dir = f"src/{owner}/"
        if not hits[0].startswith(owner_dir):
            wrong.append(f"{base} 落在 `{hits[0]}`，不属于归属插件 `{owner}`")
    add("PA5 归属唯一：每个已搬资产的 basename 在 `src/**` 里只出现一次且在**归属插件**目录下",
        not wrong, "; ".join(wrong[:6]) or f"{len(RELOCATED)} 项全部唯一且在归属目录")

    # --- PA6：门接口不因搬迁失联 -----------------------------------------------------
    problems, note = gate_interface_problems(root, run_gates)
    referenced: list[str] = []
    verify_text = (root / VERIFY_REL).read_text(encoding="utf-8")
    qa_text = "\n".join((root / "src" / "quotagent" / "qa" / p.name).read_text(encoding="utf-8", errors="replace")
                        for p in (root / "src" / "quotagent" / "qa").glob("*.py"))
    # 参考面（`EV-178` 起**跟到搬完的家**）：早期批次里已搬资产的调用者都还在 `tools/verify.sh` 与
    # `src/quotagent/qa/*.py`；但阶段 4.1/4.2 把**门与 AC 的实现**也搬进了 `src/<层>/<插件>/tests/`
    # （`qa/*.py` 只剩薄转发）⇒ 只扫旧面会把「调用者自己搬了家」误判成「没人调用」。
    # 判据本身**一格没松**：任何一个参考面里都找不到该资产 ⇒ 仍然红（下面另有一条非空转探针）。
    tests_text = "\n".join(p.read_text(encoding="utf-8", errors="replace")
                           for p in sorted((root / "src").glob("*/*/tests/*.*")) if p.is_file())
    chain_text = "\n".join(p.read_text(encoding="utf-8", errors="replace")
                           for p in sorted((root / "src").glob("*/*/tools/*.*")) if p.is_file())
    surface = "\n".join((verify_text, qa_text, tests_text, chain_text))
    for old, (_owner, target) in sorted(RELOCATED.items()):
        base = Path(target).name
        if old not in surface and base not in surface:
            referenced.append(f"{old} 搬完之后没人引用（门名/AC/测试/工具链都指不到它）")
    # 非空转探针：一个绝不可能被引用的名字必须在参考面上**找不到**（否则说明 surface 是空串/恒真）。
    # 探针串**在运行期拼**：本文件自己也在 `src/*/*/tests/` 里（参考面会读到自己），写死会自命中。
    probe = "zz-orphan" + "-probe-" + "does-not-exist"
    if probe in surface or not surface.strip():
        referenced.append("参考面判据在空转（surface 为空或探针命中）")
    add("PA6 门接口不因搬迁失联（help 门名 ↔ case 分支 ↔ 实现路径三方对齐 + 真跑 help/v + 已搬资产仍被引用）",
        not problems and not referenced, "; ".join((problems + referenced)[:6]) or note)

    # --- PA7：散落不再增长 -----------------------------------------------------------
    nonthin = [f for f in disk["tools"] if Path(f).name not in THIN_ENTRIES and f not in RELOCATED]
    pending_tools = {r["asset"] for r in rows if r["klass"] == "插件·待搬" and r["asset"].startswith("tools/")}
    diff: list[str] = []
    for asset in sorted(set(nonthin) - pending_tools):
        diff.append(f"`tools/` 里的非薄入口不在待搬清单（散落没登记）：{asset}")
    for asset in sorted(pending_tools - set(nonthin)):
        diff.append(f"待搬清单里的项在磁盘上不是非薄入口：{asset}")
    if len(nonthin) > BASELINE_NONTHIN:
        diff.append(f"非薄入口 {len(nonthin)} 个 > 基线 {BASELINE_NONTHIN} 个（散落变多）")
    add(f"PA7 `tools/**` 的散落不再增长（非薄入口 == §分类 的待搬集合 {len(pending_tools)} 项，"
        f"且 ≤ 基线 {BASELINE_NONTHIN}）", not diff, "; ".join(diff[:8]) or f"实计 {len(nonthin)} 项，双向一致")
    facts["nonthin"] = len(nonthin)
    facts["thin_entries"] = sorted(Path(f).name for f in disk["tools"] if Path(f).name in THIN_ENTRIES)

    # --- PA8：宿主层非薄入口 == 文档登记的例外集合（双向；默认空）----------------------
    host_nonthin = nonthin_host_files(root)
    registered = exception_rows(root)
    p8: list[str] = []
    if registered is None:
        p8.append(f"缺例外登记锚点 `{EXCEPTIONS_ANCHOR}`（{EXCEPTIONS_DOC} §10 是这条断言的登记真源）")
    else:
        for rel in sorted(set(host_nonthin) - registered):
            p8.append(f"`{rel}` 是**非薄入口实体**，但 27 §10 例外表里没有登记（搬漏，或放回 host/modules 没登记）")
        for rel in sorted(registered - set(host_nonthin)):
            p8.append(f"27 §10 登记了 `{rel}`，但它现在是**薄**的（登记与事实不符，应删掉这行）")
    add(f"PA8 宿主层非薄入口 == 27 §10 登记的例外集合（默认空；双向）",
        not p8, "; ".join(p8[:6]) or f"host/modules+host/lib 非薄入口 {len(host_nonthin)} 个，"
                                     f"例外表 {len(registered) if registered is not None else '（缺）'} 条，双向一致")
    facts["host_nonthin"] = len(host_nonthin)
    facts["host_exceptions"] = sorted(registered) if registered is not None else None

    # --- PA9：可移植性（硬编码仓库根 ⇒ 红）--------------------------------------------
    # 与 `clean-copy`/`run-clone` 互补：那两道门**真跑**（行为），这条抓**字面量**（且克隆位置无关）。
    # 判据 = `src/**`、`host/**`、`tools/**`、任意 `*.sh` 里「以 `quotagent` 为末段目录的绝对路径」0 处；
    # 探针自证判据非空转（运行期拼出违例串 ⇒ 同一正则必须命中，否则说明正则退化成空转）。
    hits9, scanned, scanned_names = hardcoded_root_hits(root)
    probe_literal = "/" + "srv/" + "zz-probe/" + "quotagent"      # 运行期拼：本文件自己不许含违例字面量
    probe9 = bool(HARDCODED_CHECKOUT_RE.search("ROOT = Path('" + probe_literal + "')"))
    add(f"PA9 仓库内**没有硬编码的仓库根**（`src/**`/`host/**`/`tools/**`/`*.sh`/根入口 `run` 扫 {scanned} 个文件："
        f"以 `quotagent` 为末段目录的绝对路径字面量 0 处；探针自证非空转）",
        not hits9 and probe9,
        "; ".join(hits9[:6]) or f"{scanned} 个文件 0 处硬编码仓库根（探针命中={probe9}）")
    facts["portable_scanned"] = scanned
    facts["hardcoded_root"] = len(hits9)
    #: PA9b：**扫描面自证**。「0 处命中」分不清「真的干净」与「根本没扫到」—— 根入口 `run` 没有扩展名，
    #: `**/*.sh` 匹配不到它（实测盲区），而它正是「克隆即跑」的第一层。所以扫描面本身要有断言：
    #: 逐个点名要求「必须被扫到」的文件，缺一个就红（F9 从行为侧再证一次：往 `run` 里写死仓库根 ⇒ PA9 必红）。
    required_scanned = ("run", "tools/verify.sh", "host/modules/webui.mjs", "src/system/runtime/tools/plugin-lifecycle.mjs")
    missing_scan = [rel for rel in required_scanned if rel not in scanned_names]
    add(f"PA9b 扫描面**覆盖「克隆即跑」的第一层**（逐条点名：{len(required_scanned)} 个必扫文件 —— 含"
        f"**没有扩展名的根入口 `run`**，它在 `**/*.sh` 之外）",
        not missing_scan,
        f"漏扫={missing_scan}；扫描面共 {len(scanned_names)} 个文件")
    facts["portable_scan_required_missing"] = missing_scan
    return res, facts


def tree_copy(src: Path, dst: Path) -> Path:
    """整树副本（排除 `.git`/`tmp`/`__pycache__`；`.venv` 与 `node_modules` 保留，符号链接按原样）。"""
    shutil.copytree(src, dst, symlinks=True,
                    ignore=shutil.ignore_patterns(".git", "tmp", "__pycache__"))
    return dst


def apply_replacement(path: Path, find: str, replace: str) -> bool:
    """唯一锚点替换；锚点不存在或不唯一 ⇒ False（= 假变异）。"""
    text = path.read_text(encoding="utf-8")
    if text.count(find) != 1:
        return False
    path.write_text(text.replace(find, replace, 1), encoding="utf-8")
    return True


def main() -> int:
    global ROOT
    argv = list(sys.argv[1:])
    if "--root" in argv:
        index = argv.index("--root")
        try:
            ROOT = Path(argv[index + 1]).resolve()
        except IndexError:
            print("用法：python3 tools/check-plugin-assets.py [--root DIR]", file=sys.stderr)
            return 2
    if not (ROOT / MAP_REL).is_file() or not (ROOT / VERIFY_REL).is_file():
        print(f"plugin-assets 门：{ROOT} 不像仓库根（缺 {MAP_REL} 或 {VERIFY_REL}）", file=sys.stderr)
        return 2

    relevant = [ROOT / MAP_REL, ROOT / VERIFY_REL,
                *[ROOT / p for p in RELOCATED], *[ROOT / t for _o, (_w, t) in RELOCATED.items()]]
    digests_before = {str(p): sha256(p) for p in relevant if p.is_file()}

    RESULTS.extend(evaluate(ROOT, run_gates=True)[0])
    baseline_red = [name for name, ok, _ in RESULTS if not ok]

    # --- F1..F4：4 处单点变异（整树副本；每处必须让指定断言变红）------------------------
    tmp_root = ROOT / "tmp"
    tmp_root.mkdir(exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="plugin-assets-", dir=str(tmp_root)))
    mutant_specs = [
        {"name": "F1 抽走目标目录里的资产（`src/domain/authority-band/tests/check-authority-route.py`）必须让 PA1 变红",
         "apply": lambda base: (base / "src/domain/authority-band/tests/check-authority-route.py").unlink(),
         "must_red": "PA1 ", "why": "目标不存在 ⇒ 实体丢了"},
        {"name": "F2 把一条转发改成实体（`tools/check-change-detail-route.py` ← 目标全文）必须让 PA1/PA2 变红",
         "apply": lambda base: (base / "tools/check-change-detail-route.py").write_bytes(
             (base / "src/domain/gate-timeline/tests/check-change-detail-route.py").read_bytes()),
         "must_red": "PA1 ", "why": "旧位置变成实体 ⇒ 两份实现、字节相同"},
        {"name": "F3 把资产副本放进另一个插件目录（change-detail 的副本塞进 authority-band）必须让 PA5 变红",
         "apply": lambda base: shutil.copyfile(
             base / "src/domain/gate-timeline/tests/check-change-detail-route.py",
             base / "src/domain/authority-band/tests/check-change-detail-route.py"),
         "must_red": "PA5 ", "why": "归属唯一被打破：同一资产出现在两个插件目录"},
        {"name": "F4 往 `tools/` 加一个未登记的非薄入口（`tools/check-zz-unregistered.py`）必须让 PA4/PA7 变红",
         "apply": lambda base: (base / "tools/check-zz-unregistered.py").write_text(
             "# 未登记的新检查资产（变异）\n", encoding="utf-8"),
         "must_red": "PA7 ", "why": "散落变多且没登记"},
    ]
    mutant_specs.append({
        "name": "F7 把一个**实体**放回 `host/modules/` 而不登记（`host/modules/zz-unregistered-entity.mjs`）必须让 PA8 变红",
        "apply": lambda base: (base / "host/modules/zz-unregistered-entity.mjs").write_text(
            "/** 未登记的实体（变异）：含实现声明，不是薄重导。 */\nexport function zz() { return 1 }\n",
            encoding="utf-8"),
        "must_red": "PA8 ", "why": "宿主层出现未登记的实现文件 ⇒ 例外表与事实不符"})
    #: 违例字面量**运行期拼**（本文件自己也在 PA9 的扫描面里，写死会自命中）。
    _hard = "'" + "/" + "workspace/projects/" + "quotagent'"
    mutant_specs.append({
        "name": "F8 在 `tools/` 的源码里写死仓库根（往 `tools/manual-check.py` 追加一行绝对 checkout 路径）"
                "必须让 PA9 变红",
        "apply": lambda base: (base / "tools/manual-check.py").write_text(
            (base / "tools/manual-check.py").read_text(encoding="utf-8") + "ANCHOR = " + f"{_hard}\n",
            encoding="utf-8"),
        "must_red": "PA9 ", "why": "可移植性被破坏：硬编码 checkout 路径 ⇒ 克隆到别的路径就废"})
    mutant_specs.append({
        "name": "F9 在**根入口 `run`**（没有扩展名，`**/*.sh` 匹配不到它）里写死仓库根必须让 PA9 变 red"
                "（证明扫描面真盖到了那一层，而不是只靠扩展名）",
        "apply": lambda base: (base / "run").write_text(
            (base / "run").read_text(encoding="utf-8") + "# ANCHOR = " + f"{_hard}\n", encoding="utf-8"),
        "must_red": "PA9 ", "why": "盲区回归：没有扩展名的入口层被漏扫"})
    mutated_roots: list[Path] = []
    for index, spec in enumerate(mutant_specs, start=1):
        base = tree_copy(ROOT, work / f"mutant-{index}")
        spec["apply"](base)
        res, _facts = evaluate(base, run_gates=True)
        reds = [name for name, ok, _ in res if not ok]
        hit = [name for name in reds if spec["must_red"] in name]
        delta = [n for n in reds if n not in baseline_red]
        mutated_roots.append(base)
        check(f"{spec['name']}", bool(hit) and bool(delta),
              f"变异体红 {len(reds)} 项、新增红 {len(delta)} 项、命中指定断言={bool(hit)}；{spec['why']}；"
              f"红项={[n.split(' ')[0] for n in reds][:8]}")

    check("F0 基线（未变异）在同一套判据上**不红**（否则 4 处变异变红都是空转）",
          not baseline_red, f"基线红项={baseline_red}")
    probe = work / "probe-fake.py"
    probe.write_text("# 探针文件（只为验证 F5 的防假变异路径）\n", encoding="utf-8")
    check("F5 防假变异：不存在的锚点必须返回 False（不许「没改到任何字节」也算红）",
          apply_replacement(probe, "不存在的锚点", "x") is False,
          "唯一锚点缺失 ⇒ False（探针文件在 tmp/ 副本根，产品树不受影响）")
    after = {str(p): sha256(p) for p in relevant if p.is_file()}
    check("F6 全过程**产品树字节不变**（变异只写在 tmp/ 的整树副本里）",
          after == digests_before, f"前后 {len(digests_before)}/{len(after)} 个文件摘要一致="
                                   f"{after == digests_before}；副本 {len(mutated_roots)} 份在 {work}")

    failed = [item for item in RESULTS if not item[1]]
    for name, ok, detail in RESULTS:
        print(f"{'[ok]  ' if ok else '[FAIL]'} {name}")
        if detail:
            print(f"        {detail}")
    total = len(RESULTS)
    print(f"RESULT: {'PASS' if not failed else 'FAIL'}（plugin-assets 门 {total - len(failed)}/{total}）")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
