# 28 需求归属到插件 + 一键运行契约（硬规范）

<!-- budget: 28 KB。§1/§2 是需求归属规则（ADR-0021）；§3 是一键运行契约（ADR-0020 §6 的执行面）。 -->

## 1. 需求归属硬规则

用户原话（2026-09-22，逐字）：
> "整理产品需求，**不存在所谓的『产品整体』的功能性需求。所有功能性需求都应该由某个插件提供**。可以将需求合理分类，总结成若干系统级或 domain 级插件，然后给**每个插件写独立的需求文档**、让独立的 subagent 实现。"

由此定死四条：

| 规则 | 内容 | 违反时怎么发现 |
|---|---|---|
| R1 | 每条 `FR-*` 必须有**归属插件**：`层次/插件-id`（`system`/`domain`/`userspace` 之一） | 覆盖矩阵缺行（`tools/verify.sh coverage` 的 A1/A5） |
| R2 | 每条 `AC-*` 必须有归属插件（与它服务的 FR 同插件；跨插件则逐条注明） | 同左 + 本页 §2.3 的家族表 |
| R3 | 需求文档 = **每个插件自己的** `requirements/README.md`；矩阵（`docs/design/15-requirements-coverage.md`）是归属真源；两边引用 ID，不复制正文 | 人工/评审 + 矩阵双向核对 |
| R4 | 存在"产品整体"口径的 FR 视为**未归属**（不是"暂未归属"）：它必须在下一批落到某个插件，或被归档为"总纲"（见 §2.5） | 本页 §2.2/§2.3 的家族表里出现 `未归属` 即红 |

口径补充：**"总纲"不是功能性需求**。例如 `FR-PLUGIN-004`（配置更新可否决）是跨插件的**平台契约**，它的归属写 `system/kernel`（内核的插件生命周期面），
而它约束的对象是"全部插件"——这类条目允许"归属 + 约束范围"两个字段同时存在，但**归属字段不得为空**。

## 2. FR/AC 命名与重新归属方案

### 2.1 命名方案（新家族 vs 旧号）

| 情形 | 处理 | 理由 |
|---|---|---|
| **新需求** | 家族名 = 归属插件 id 的纯字母大写形式：`compare` → `FR-COMPARE-NNN`；`bid-heuristics` → `FR-VIZ-NNN`（既有）；`authority-band` → `FR-AUTH-NNN`（既有）。家族名**不含数字** | 门的 ID 正则只认 `[A-Z]+-\d{3}` 形态；带数字的家族门认不出（`docs/work/plans/ux2-index.json` 的 `naming` 记法与 D-069） |
| **旧需求（165 条 FR / 133 条 AC）** | **不改号，只补归属**：家族 → 归属插件的映射见 §2.2/§2.3；跨插件家族逐条拆见 §2.4 | 改号会同时打断 FR↔AC 覆盖、93 条归档 FR 行、3022 处 ID 引用与全部 `EV-` 证据链；缺归属是**数据缺失**，不是命名错误 |
| **同一个插件多个家族** | 允许（`system/runtime` 同时承载 `FR-RUNTIME-001/002` 与若干 AC）；插件需求文档按家族分节 | 家族是"文档分组"，插件是"归属单位" |
| **一个家族跨多个插件** | 家族级映射只能写"跨"，必须逐条拆到具体插件（§2.4） | 家族级"跨"如果当作终态，等于没有归属 |

### 2.2 FR 家族 → 归属插件（覆盖全部 40 家族 / 165 条）

| FR 家族 | 条数 | 归属插件 | 目标路径 |
|---|---|---|---|
| LEDGER | 4 | system/kernel | `src/system/kernel/ledger.py` |
| EVT | 3 | system/kernel | `src/system/kernel/events.py` |
| QEP | 8 | system/kernel | `src/system/kernel/qep.py` |
| PLUGIN | 4 | system/kernel（PLUGIN-004 约束范围为全部插件） | `src/system/kernel/plugin.py` |
| EVIDENCE | 6 | system/evidence | `src/system/evidence/` |
| NORM | 4 | system/norm | `src/system/norm/norm.py` |
| APPROVE | 3 | system/approval | `src/system/approval/approval.py` |
| MEASURES（无 FR 家族，服务承载） | – | system/measures | `src/system/measures/measures.py` |
| RUNTIME | 9 | **跨**：001/002 → system/runtime；003 → system/audit-hook；004 → system/budget-guard；005 → system/circuit-breaker；006 → system/governor；007 → system/observability；008 → system/timeline；009 → system/idempotency-guard（依据 `docs/design/15-requirements-coverage.md` §4） | 各插件目录 |
| EVAL | 5 | system/eval（EVAL-005 → domain/supplier-scorecard） | `src/system/eval/`、`src/domain/supplier-scorecard/` |
| ADMIN | 10 | system/admin | `src/system/admin/` |
| CONFIG | 2 | system/config | `src/system/config/` |
| STORAGE | 3 | system/storage | `src/system/storage/` |
| MARKET | 6 | system/market | `src/system/market/` |
| USERPLUG | 12 | system/user-plugin-manager | `src/system/user-plugin-manager/` |
| AGENTRT | 3 | system/agent-runtime | `src/system/agent-runtime/` |
| UIFB | 1 | system/ui-feedback | `src/system/ui-feedback/` |
| UX | 5 | system/webui | `src/system/webui/` |
| UXWEB | 2 | system/webui | `src/system/webui/` |
| EVOLVE | 7 | system/evolution（EVOLVE-005 → system/canary） | `src/system/evolution/`、`src/system/canary/` |
| MAIL | 2 | system/mail | `src/system/mail/` |
| INTEG | 4 | **跨**：001 → system/kernel（delivery）；002 → system/relay；003 → system/mail；004 → system/kernel-bridge | 各插件目录 |
| RFQ | 9 | **跨**：001–005 → domain/rfq；006 → domain/rfq-deadline；007 → domain/sourcing；008/009 → system/projection | 各插件目录 |
| COMPARE | 4 | domain/compare（COMPARE-004 → domain/export） | `src/domain/compare/`、`src/domain/export/` |
| GUARD | 5 | domain/guard（GUARD-003 复用产能口径） | `src/domain/guard/guard.py` |
| INTAKE | 3 | domain/intake | `src/domain/intake/intake.py` |
| CLARIFY | 4 | domain/clarify（CLARIFY-004 → domain/faq） | `src/domain/clarify/`、`src/domain/faq/` |
| AWARD | 3 | domain/commitments | `src/domain/commitments/commitments.py` |
| COST | 3 | domain/costmodel | `src/domain/costmodel/costmodel.py` |
| PRICE | 3 | domain/pricing（PRICE-003 → domain/price-history） | `src/domain/pricing/`、`src/domain/price-history/` |
| DEV | 2 | domain/deviation | `src/domain/deviation/deviation.py` |
| CAP | 2 | domain/capacity | `src/domain/capacity/capacity.py` |
| CHANGE | 2 | domain/change | `src/domain/change/change.py` |
| TERMS | 2 | domain/terms | `src/domain/terms/terms.py` |
| NEGO | 2 | domain/negotiation | `src/domain/negotiation/` |
| GATE | 2 | domain/gate-timeline | `src/domain/gate-timeline/` |
| AUTH | 1 | domain/authority-band | `src/domain/authority-band/` |
| ADV | 1 | domain/advice | `src/domain/advice/` |
| VIZ | 1 | domain/bid-heuristics | `src/domain/bid-heuristics/` |
| QUOTE | 1 | domain/quote-prepare | `src/domain/quote-prepare/` |
| USREQ | 12 | **逐条**（不新增插件）：由 `docs/work/requirements-traceability.md` 的"插件归属"列指到 `src/<层次>/<插件>/`，见 §2.4.3 | 各插件目录 |

### 2.3 AC 家族 → 归属插件（覆盖全部 45 家族 / 133 条）

| AC 家族 | 条数 | 归属插件 | 备注 |
|---|---|---|---|
| DESIGN | 3 | system/repo-gate | 文档门（`AC-DESIGN-001..003`） |
| AUDIT | 5 | system/evidence | 审计包与留存（`AC-AUDIT-001..005`） |
| TRUST | 1 | system/projection | 私域过滤（`AC-TRUST-001`） |
| UI | 2 | system/webui | 页面结构断言 |
| FAQ | 1 | domain/faq | 与 `CLARIFY-004` 同源 |
| SYNC | 1 | domain/sync | 三方协调 |
| 其余 38 家族 | 119 | 与其对应 FR 家族同插件（§2.2 逐行） | `AUDIT`/`DESIGN`/`TRUST`/`UI`/`FAQ`/`SYNC` 之外的家族名与 FR 家族名一致 |

> 说明（避免"看起来是偷懒"）：AC 家族与 FR 家族的对应关系由**门**保证——`FR↔AC 无孤儿`（`tools/verify.sh docs` 的覆盖检查）要求每条 AC 被至少一条 FR 引用，
> 因此"AC 家族与 FR 家族同名"时归属必然相同；不同名的 7 个家族（上表）逐条列出。

### 2.4 跨插件家族：逐条拆（这是归属方案的关键）

#### 2.4.1 FR-RUNTIME-*（9 条）

| FR | 归属插件 |
|---|---|
| FR-RUNTIME-001、FR-RUNTIME-002 | system/runtime（解释器解析与仓库内自包含运行时） |
| FR-RUNTIME-003 | system/audit-hook |
| FR-RUNTIME-004 | system/budget-guard |
| FR-RUNTIME-005 | system/circuit-breaker |
| FR-RUNTIME-006 | system/governor |
| FR-RUNTIME-007 | system/observability |
| FR-RUNTIME-008 | system/timeline |
| FR-RUNTIME-009 | system/idempotency-guard |

#### 2.4.2 FR-INTEG-* / FR-RFQ-* / FR-EVAL-* / FR-EVOLVE-* / FR-PRICE-* / FR-COMPARE-* / FR-CLARIFY-*

| FR | 归属插件 |
|---|---|
| FR-INTEG-001 | system/kernel（delivery） |
| FR-INTEG-002 | system/relay |
| FR-INTEG-003 | system/mail |
| FR-INTEG-004 | system/kernel-bridge |
| FR-RFQ-006 | domain/rfq-deadline |
| FR-RFQ-007 | domain/sourcing |
| FR-RFQ-008、FR-RFQ-009 | system/projection |
| FR-EVAL-005 | domain/supplier-scorecard |
| FR-EVOLVE-005 | system/canary |
| FR-PRICE-003 | domain/price-history |
| FR-COMPARE-004 | domain/export |
| FR-CLARIFY-004 | domain/faq |

（未列出的同家族条目归 §2.2 表里的那个插件。）

#### 2.4.3 FR-USREQ-001..012（用户诉求族，逐条归属）

| FR | 归属插件（目标路径） |
|---|---|
| FR-USREQ-001 | system/webui（+ system/ui-feedback、domain/gate-timeline、domain/rfq-deadline 的写入口） |
| FR-USREQ-002 | system/webui（视觉基线） |
| FR-USREQ-003 | system/runtime（两个 profile 的真实角色）+ system/repo-gate（走查证据） |
| FR-USREQ-004 | system/webui（`/api/routes` 自述面）+ system/runtime |
| FR-USREQ-005 | system/webui |
| FR-USREQ-006 | system/ui-feedback（cron 探测器与 tick） |
| FR-USREQ-007 | system/repo-gate（合同文档与门的持久化） |
| FR-USREQ-008 | system/market + system/admin + system/evolution + 各业务插件页 |
| FR-USREQ-009 | system/config（+ system/mail） |
| FR-USREQ-010 | system/evolution（+ system/repo-gate 的"cordis 已提供"反向判据，见 27 §7.2） |
| FR-USREQ-011 | system/webui |
| FR-USREQ-012 | domain/advice（+ system/user-plugin-manager 的提权路径） |

### 2.5 归档与门的配合

| 事项 | 口径 |
|---|---|
| 定义集合 | 主文件 + `functional-requirements-archive*.md` **同为定义集合**（既有口径，ADR-0021 §5 不改）；归档不豁免任何断言 |
| 归属行放哪 | 覆盖矩阵（`15-requirements-coverage.md`）与插件 `requirements/README.md`；因此"搬行进归档"不影响归属，也不需要动门 |
| 总纲条目 | `FR-PLUGIN-004` 这类"平台契约"允许"归属 + 约束范围"并存，归属字段不得为空；其约束范围写"全部插件" |
| 缺口 | 未归属/未实现的条目必须在矩阵 §3 逐条登记（现状已登记 `FR-USREQ-001..003` 三条缺口）；本批新增的缺口登记见 §2.6 与 `docs/work/plans/spec-persistence.md` |
| 归档触发 | 主文件接近 32 KB 时按标准 §1 顺序处理（删重复 → 删叙述 → 拆文件 → 才提预算）；本批**不搬行**（主文件已由前一批腾到 28 KB 级） |

### 2.6 待建判据 A7（登记为 `T-312` 子项，本批不改门）

`tools/check-fr-coverage.py` 现断言 A1–A6。本 ADR 要求的 A7 是：

> 每条 FR/AC 的归属必须是合法插件标识 `^(system|domain|userspace)/[a-z][a-z0-9-]{0,31}$`，且对应目录存在于 `src/` 下；
> 家族级"跨"（`跨`/`–`/空）在终态判红。

**本批不实现**（铁律：只改文档），因此现状的合规性靠本页 §2.2/§2.3 的**人工可复核表**与覆盖矩阵。

## 3. 一键运行契约

用户原话（逐字）："用户应当能够直接克隆 quotagent 仓库并且**一键运行**它。"

### 3.1 契约原文（规范文本，逐字）

```
一键运行契约（QUOTAGENT-ONE-COMMAND，v1）

【入口】仓库根的一条命令，从裸机克隆到服务可访问：
    git clone <repo-url> quotagent && cd quotagent && ./run up

【动词】./run up | down | status | logs | doctor | config init
    up      幂等启动：解析解释器 → 准备仓库内 .venv → 安装宿主依赖（仅在缺失时）→
            起服务 → 健康检查 → 打印可访问 URL 与端口；重复执行不重建、不覆盖数据
    down    停止服务并回收本次启动的进程（不删数据）
    status  一行 JSON：{ok, service, pid, port, url, healthy, ready_ms, degraded[]}
    doctor  只读体检：解释器/Node/cordis 版本、端口占用、配置文件与凭据指纹、门是否可跑；
            退出码 0 表示"这机器能跑"，非 0 表示"不能跑"并给逐条 next_action
    config init  生成 config.yaml（只含白名单键，值可为空），不改任何已有值

【必须自包含】不依赖机器上预装的 Python 包、Node 包或网络：
  ① Python 3.9+ 解释器解析顺序 QUOTAGENT_PY → 仓库 .venv → $WS_VENV → PATH（tools/runtime.sh，已有）
  ② 宿主依赖 cordis@4.0.0-rc.10 由锁文件安装到仓库内（src/system/runtime/package.json + package-lock.json）
  ③ Python 侧零第三方（ADR-0007）：因此不需要 pip、不需要网络
  ④ 运行期数据根（宿主 root / 账本 / 待办件 / 反馈件）自动创建在仓库内（tmp/ 与配置指定的根）
  ⑤ 端口默认值写死在契约里（webui 8093）并支持 --port 覆盖；被占用时 doctor 必须报出来
  ⑥ 健康检查：GET http://127.0.0.1:<port>/healthz 返回 200 且 body 含服务名与版本；
     连续不健康到超时 ⇒ up 退出非 0，并把日志路径写进错误信息（不允许"起了但其实是坏的"）
  ⑦ 门与自检不需要外部服务：tools/verify.sh smoke|docs|coverage 在离线机器上可跑

【外部凭据】SMTP/IMAP 账号、模型 key（如 Jev）等一律**不阻塞启动**：
  ① 缺失时：服务照常 up，受影响的插件报 available=false + 有名 reason + next_action；
     启动路径与健康检查**不得**因缺凭据而失败（"没凭据不得假装能发"的既有铁律）
  ② 接入方式：./run config init 生成 config.yaml（白名单键）→ 填值，或经系统管理道 UI 的配置面
     （干跑预览 → 落 0600 待办件 → Python 侧唯一落盘者写入）；凭据只存指针与指纹，永不回显
  ③ doctor 必须逐项列出"缺哪条凭据、影响哪个插件、怎么补"，而不是笼统报"未配置"

【验收】tools/verify.sh run-once（工作树真跑：空 HOME + 断网 + 凭据缺失不阻塞 + 单点变异）与
  tools/verify.sh run-clone（**只含已提交内容的副本**：git archive HEAD 解到仓库外，断言
  健康检查 200、URL 可达、down 后端口释放、第二次 up 幂等（逐字节一致的 status 摘要）；
  该门校验 HEAD ⇒ 与 clean-copy 同类，须在 commit 之后跑）。
```

### 3.2 契约必须自包含的东西（清单，逐条对应实现载体）

| # | 必须自包含 | 今天的载体 | 缺口 |
|---|---|---|---|
| 1 | Python 解释器解析 | `tools/runtime.sh`（已实现，含"拒绝同名包装器"的探针） | 无 |
| 2 | 仓库内 `.venv` | `tools/bootstrap.sh`（`--without-pip`，幂等） | 无 |
| 3 | 宿主依赖与版本钉死 | `tools/cordis.sh install`（只写仓库内）+ `package-lock.json` 入库 | 无（`./run up` 已串联：仅在缺失时装） |
| 4 | 服务进程与端口 | `tools/webui-serve.py`（独立进程 + healthz，端口 8093） | 无（`./run --port` 覆盖 + `doctor` 端口占用诊断） |
| 5 | 数据根 | `tmp/`、`host-root`（默认在 `process.cwd()`） | 无（`./run --data-dir` 统一运行期数据根，默认 `tmp/run-shared`；pid/日志落 `tmp/run/`） |
| 6 | 健康检查 | `/healthz`（已实现） | 无（`./run up` 已把它当退出码判据：连续不健康 ⇒ 非 0 + 日志路径） |
| 7 | 离线可跑的门 | `tools/verify.sh smoke|docs|coverage` | 无 |
| 8 | 单入口 | 仓库根 `./run`（契约六动词 `up|down|status|logs|doctor|config init` + 附加动词 `plugin`；EV-166/EV-168） | 无（`logs`/`config init` 已实现，EV-168） |

### 3.3 现状差距（诚实）

**已实现（EV-166 / T-315 + EV-168 / T-317）**：仓库根 `./run up | down | status | logs | doctor | config init` 六个契约动词
（+ 附加动词 `plugin`，运行期装卸）+ 门 `tools/verify.sh run-once`；
`up` 幂等（重复执行不重建、不覆盖数据）、`down` 只回收**本次启动的**进程且真释放端口、
`status` 一行 JSON（`ready_ms` 是启动时量到的常值 ⇒ 两次 `status` 逐字节一致）、
`doctor` 只读体检 7 项（解释器/Node/cordis/端口/配置指纹/凭据/门）逐条给 `next_action`，退出码 0 = 这机器能跑；
**外部凭据缺失不阻塞 `up`**（受影响项在 `status.degraded[]` 里报 `available:false` + 有名 reason + `next_action`）；
`logs`（路径 + 有界尾部，缺日志如实失败）与 `config init`（只含白名单键、存在即拒、0600、打印指纹与逐条 `next_action`、不写账本）。

**干净副本那一半的收口（EV-171 / T-320）**：契约 §3.1【验收】说的"清洁副本"以前只被 `run-once` 的
`QUOTAGENT_RUN_ROOT` 覆盖（那是**工作树**，带着 `.venv`/`host/node_modules`/`tmp`）。现在由
`tools/verify.sh run-clone` 在 `git archive HEAD` 解出的**只含已提交内容**的副本（仓库外）里真跑
`doctor`/`up`/`status`/`down` + 两条反向对照 + 4 处单点变异。**实测抓到真缺陷**：索引里 `tools/*.sh` 是
`100644`（`core.filemode=false` ⇒ `chmod +x` 不入库），干净克隆里 `./run up` 报 `host-deps-install-failed`；
已用 `git add --chmod=+x` 修复，并把"入口可执行位"冻结为断言。
**仍未实现（诚实）**：宿主依赖 `cordis@4.0.0-rc.10` 不入库（`host/node_modules` gitignored）⇒ 干净副本的
第一次 `up` 需要 **npm 缓存或网络**；缓存空 + 断网时 `up` 如实失败（`host-deps-install-failed` + 日志路径 + 尾部原因），
不假装成功。Python 侧零第三方（ADR-0007），故 `up` 本身不需要 pip/外网。

今天从裸机到服务可访问是**一条命令**（`./run up`，内部串起 `tools/bootstrap.sh` → `tools/cordis.sh install`（仅缺失时）→ `tools/webui-serve.py` → 健康检查）。
本页 §3.1 是规范原文；实现与判据：`src/system/runtime/docs/one-command-run.md`，门 `tools/verify.sh run-once`（EV-166）与
`tools/verify.sh run-clone`（EV-171，校验 HEAD，须在 commit 之后跑）。

## 4. 本页的验收

| 断言 | 命令 |
|---|---|
| §2.2/§2.3 的家族表覆盖全部 165 条 FR / 133 条 AC（逐家族计数可复核） | 计数见 `docs/work/evidence/EV-162-*.txt` §2 |
| 归属合法（`层次/插件-id`）与目录存在 | 待建的 A7（`T-312` 子项）；现在由覆盖矩阵 + 本页核对 |
| 每条 FR 都有归属且不写"跨"作为终态 | §2.4 逐条拆分表 |
| 契约文本与实际载体一致（§3.2 的 8 行） | `tools/verify.sh docs`（预算/ID）+ 逐行人工核对；`run-once`（工作树）与 `run-clone`（只含已提交内容的副本）两道门 |

## 5. 未决

1. **`./run` 的实现语言**：POSIX sh（与 `tools/*.sh` 一致）还是 Python（更强的参数与 JSON 处理）；倾向 sh，因为它必须在"还没有 Python 解释器"时也能给出可读的 `doctor` 输出。
2. **默认端口**：延续 webui 8093，还是按服务清单（`/workspace/services/services.json`）分配；需一次端口普查。
3. **`config init` 与既有 `tools/config-apply.py --init` 的关系**：建议前者只是后者的薄包装（一处一事实），待实现时确认。
4. **健康检查的"深度"**：只查 HTTP 进程，还是同时查账本可读与 profile 装配；后者更贵但更能防"起了但坏"。
