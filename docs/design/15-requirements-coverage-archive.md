# 15 需求覆盖矩阵 · 归档（§1 FR 覆盖的末段整段）

> 主文件：`15-requirements-coverage.md`。本文件与主文件同属**矩阵文档集合**，门 `tools/verify.sh coverage`
> 读的是**主文件 + 同目录 `15-requirements-coverage-archive*.md` 的并集**（与 FR/AC/T 定义集合、插件清单集合
> 同一套归档机制，口径见 `12-documentation-standard.md` §2 与 `check-fr-coverage.py` 头）。
> **归档不是豁免区**：搬进来的 FR 行仍受"与 FR 定义集合双向全覆盖 / 承载体真实存在 / 状态合法 /
> 【缺口】【存疑】逐条登记 / 每个插件至少归属 1 条"全部断言约束。
> 搬进来的原因：主文件到 `docs/design/*.md` 28 KB 硬预算的边缘（超预算处理顺序：删重复 → 删叙述 → 拆文件）。
> 搬行方式：**整行逐字**（搬前/搬后逐字节一致，见 `../work/evidence/EV-180-closeout-and-final-leftovers.md`）。

## 1. FR 覆盖（归档续）

| FR | 承载体 | 证据 | 状态 |
|---|---|---|---|
| FR-AGENTRT-007 | host/modules/agent-context.mjs + host/modules/agent-memory.mjs + host/modules/agent-harness.mjs | 见 AC-AGENTRT-007 | 直引 |
| FR-AGENTRT-002 | tools/refresh-agent-memory.py + host/modules/agent-memory.mjs | 见 AC-AGENTRT-002 | 直引 |
| FR-STORAGE-001 | tools/storage.py + host/modules/storage-view.mjs | 见 AC-STORAGE-001 | 直引 |
| FR-STORAGE-004 | tools/storage.py | 见 AC-STORAGE-004 | 直引 |
| FR-STORAGE-006 | tools/storage.py + host/modules/storage-view.mjs | 见 AC-STORAGE-006 | 直引 |
| FR-UXWEB-001 | host/modules/webui.mjs | 见 AC-UXWEB-001 | 直引 |
| FR-UXWEB-002 | host/modules/webui.mjs | 见 AC-UXWEB-001 | 直引 |
| FR-CONFIG-001 | host/modules/config-view.mjs + host/lib/config-ui.mjs + src/system/config/tools/config-apply.py | 见 AC-CONFIG-001 | 直引 |
| FR-CONFIG-002 | src/system/config/tools/config-apply.py + host/lib/config-keys.mjs | 见 AC-CONFIG-001 | 直引 |
| FR-MAIL-001 | src/quotagent/services/mail_transport.py + src/quotagent/services/mail.py | 见 AC-MAIL-001 | 直引 |
| FR-MAIL-002 | host/modules/mail-view.mjs + host/lib/config-keys.mjs | 见 AC-MAIL-002 | 直引 |
| FR-VIZ-001 | host/modules/bid-heuristics.mjs | 见 AC-VIZ-001 | 直引 |
| FR-UIFB-001 | host/modules/ui-feedback.mjs + tools/ui-feedback-apply.py | 见 AC-UIFB-001 | 直引 |
| FR-USREQ-006 | host/modules/ui-feedback.mjs + tools/ui-feedback-apply.py | AC-USREQ-006 10/10（探测器确定性 / 空待办恰一行 / 非空转；负控注入 `date` 即红） | 直引 |
| FR-USREQ-007 | docs/work/requirements-traceability.md | `verify.sh docs` + `verify.sh coverage`（本表与 §6.1 是同一批的落点） | 直引 |
| FR-USREQ-009 | host/modules/config-view.mjs + src/system/config/tools/config-apply.py | 见 AC-CONFIG-001（含 `--init` / 原子写 / 401 同形）；邮件侧 AC-MAIL-002 | 直引 |
| FR-USREQ-012 | host/modules/advice-panel.mjs + tools/userplugin-elevate.py | 见 AC-ADV-001；提权路径见 AC-USERPLUG-010 | 直引 |
| FR-USREQ-004 | host/modules/webui.mjs | 自述 `/api/routes`（`verify.sh webui`）；dashboard 侧为跨仓（见可追溯表） | 映射 |
| FR-USREQ-005 | host/modules/webui.mjs | 第一屏三块 + 子视图 + 上手入口（`verify.sh webui`） | 映射 |
| FR-USREQ-008 | host/modules/plugin-market.mjs + host/modules/admin-view.mjs + host/modules/evolve-journal.mjs | 市场/管理/自进化各自有门（plugin-market / admin-route / webui 的 `/api/ops`） | 映射 |
| FR-USREQ-010 | host/lib/evolution.mjs + host/modules/canary.mjs + host/lib/user-space.mjs | evolution / cordis / modules / user-space 门 | 映射 |
| FR-USREQ-011 | host/modules/webui.mjs | 双方视角各自可达且是不同路由（`verify.sh webui`） | 映射 |
| FR-USREQ-001 | host/modules/webui.mjs + host/modules/config-view.mjs | 四类写操作各有门（config-route / gates / rfq-deadline / ui-feedback），但「每一步」完整性无机检 | 缺口 |
| FR-USREQ-002 | host/modules/webui.mjs | 只有结构切片（0 内联脚本 / 三块顺序 / `data-empty`），视觉本身**零判据** | 缺口 |
| FR-USREQ-003 | host/profiles.mjs + src/quotagent/g1side.py | `verify.sh g1` 只覆盖「两侧各自跑完工作流」；「像员工」无机检 | 缺口 |
| FR-QUOTE-001 | host/modules/quote-prepare.mjs、src/domain/quote-prepare/tools/quote-draft.py、src/domain/quote-prepare/tools/quote-sign.py | **报价草稿写闭环**（`verify.sh quote-draft`）：围栏门（服务面恰 8 键且无 `approve/decide/submit/send`、`can_sign=false`、字段级拒绝码闭合、确定性、墙钟入口读都不读、私域哨兵逐字节一致、行项目读不出来不编、**4 处单点变异全红且还原字节一致**）+ 真路由门（真进程真回读）：假成功杀死（`/api/routes` 里每个 GET 只读路由 POST ⇒ 405 + `Allow: GET` + `method-not-allowed`；**反向对照**真写路由 POST ⇒ 不是该 code）/ 字段级 errors / 待办件恰 0600 / 宿主账本零新增 / 真跑工具后两侧账本各 +1 且 body 恰 12 键不含备注正文 / 幂等 / 拒绝码 / 双向可见 / 0 内联脚本 / 假成功对照（改前 GET 与 POST 逐字节相同） | 直引 |

> 末段 12 行 = **用户诉求批次**（`FR-USREQ-001..012`，契约见 `../../work/functional-requirements.md` §6.1；状态真源 `../../work/requirements-traceability.md`）。
