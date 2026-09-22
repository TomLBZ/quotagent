# system/kernel 需求（**本插件自己的** FR/AC 行 + 每条的可执行验收命令）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`；
逐插件唯一指针（机检 `tools/verify.sh plugin-requirements`）：`docs/work/plugin-requirements-map.md`。
本文件**只引用 ID，不复制正文**（一处一事实）。

> **本文件的位置**：就是 27 §2.1 的**标准位置**（`src/system/kernel/requirements/README.md`）—— `T-318` 期间它曾在
> `docs/work/plugin-requirements-system-kernel.md`，`T-321` 用 `git mv` 归位（**内容逐字节不变**；逐条 sha256 与归位台账见映射表 §4.2 与
> `docs/work/evidence/EV-172-*`）。
> **当初为什么放 `docs/work/`**（实测，非推测）：那时 `plugin-registry` 的 `depsClosure` 把「目录存在」当
> 「插件存在」，先建裸目录会让 `plugin-lifecycle` 的 A13/A14 变红；`T-321` 已**收紧**该处（27 §2.4）⇒ 现在可以建了。

## 用途（一句话）

平台内核：唯一账本写者 + 事件总线 + QEP 交换协议 + 插件宿主与生命周期 + 文件投递绑定，
是全部插件的依赖根，也是**冻结面**（内核不可自改，ADR-0002 / `INV-010`）。

## 归属行（本插件承载的需求）

| ID | 一句话（本插件承担的部分） | 可执行验收命令 |
|---|---|---|
| FR-LEDGER-001 | append-only 账本 + 哈希链；事件一经追加不可修改 | `tools/verify.sh ac AC-AUDIT-001` |
| FR-LEDGER-002 | 从账本可重建任意时点投影（全量 + 增量） | `tools/verify.sh ac AC-AUDIT-002` |
| FR-LEDGER-003 | 启动与每次追加后校验哈希链，失败即停发 | `tools/verify.sh ac AC-AUDIT-001` |
| FR-LEDGER-004 | 同一 `(correlation_id, type, body_hash)` 不产生第二条事实 | `tools/verify.sh ac AC-QEP-002` |
| FR-EVT-001 | 事件五模式分发（emit/parallel/serial/bail/waterfall） | `tools/verify.sh events` |
| FR-EVT-002 | 监听器注册返回 disposer，卸载后自动注销 | `tools/verify.sh events` |
| FR-EVT-003 | waterfall 不调 `next()` 即短路，短路点必须在文档登记 | `tools/verify.sh events` |
| FR-QEP-001 | 构造/校验/签名/验签 QEP 信封 | `tools/verify.sh ac AC-QEP-001` |
| FR-QEP-002 | 承诺类报文缺人工批准即拒收 | `tools/verify.sh ac AC-APPROVE-002` |
| FR-QEP-003 | `seq` 空洞检测与重发请求；不跳号处理 | `tools/verify.sh ac AC-QEP-003` |
| FR-QEP-004 | 至少一次投递 + 幂等去重 | `tools/verify.sh ac AC-QEP-002` |
| FR-QEP-005 | 版本交集为空则拒绝通信并留痕（不静默降级） | `tools/verify.sh ac AC-QEP-004` |
| FR-QEP-006 | 特性级降级必须留痕；批准链/版本绑定/签名不可降级 | `tools/verify.sh ac AC-QEP-004` |
| FR-QEP-008 | 崩溃后未同步事件可安全重发，不产生重复事实 | `tools/verify.sh ac AC-QEP-002` |
| FR-PLUGIN-001 | 插件装载/卸载，依赖未就绪不得激活（宿主侧同一套六动词） | `tools/verify.sh plugin-lifecycle` |
| FR-PLUGIN-002 | 依赖变化自动触发消费者重载/失活，不自动迁移草稿 | `tools/verify.sh plugin-lifecycle` |
| FR-PLUGIN-003 | 卸载后无残留订阅、定时器、外部通知（effects 归零） | `tools/verify.sh plugin-lifecycle` |
| FR-PLUGIN-004 | 配置更新先过可否决的更新事件，否决即不生效（**约束范围：全部插件**） | `tools/verify.sh ac AC-PLUGIN-004` |
| FR-INTEG-001 | 文件投递绑定（原子写 + 命名约定） | `tools/verify.sh ac AC-INTEG-001` |

## 对外契约（provides / 依赖）

| 面 | 内容 |
|---|---|
| provides | 内核服务面 `ledger` / `events` / `qep` / `plugin` / `delivery`（Python 侧 `src/quotagent/kernel/`，经桥暴露；宿主不得直连） |
| 依赖 | 无（本插件是依赖闭包的根；不 import 任何其它插件） |
| 写面 | `permissions.ledger = "sole-writer"`：**账本是唯一事实写路径**（H1），其它插件的 `ledger` 默认 `none` |
| 冻结 | `frozen: true`（ADR-0002）：配置键永不接受自动更新（对齐 `INV-010`） |
| 门 | `tools/verify.sh events` · `invariants` · `ac-registry` · `plugin-lifecycle`（六动词） |

## 本插件不承载

| 事项 | 归属 |
|---|---|
| 宿主与内核之间的 stdio NDJSON 桥 | `system/kernel-bridge`（`FR-INTEG-004`） |
| 宿主运行期中间件（留痕/准入/熔断/预算/幂等/时间线） | `system/audit-hook`、`system/governor`、`system/circuit-breaker`、`system/budget-guard`、`system/idempotency-guard`、`system/timeline`（`FR-RUNTIME-003..009`） |
| 审计包导出/签名/包含证明 | `system/evidence`（`FR-EVIDENCE-*`） |
| 留存期与销毁执行 | `system/retention`（`FR-EVIDENCE-004`） |
| 需求归属合法性判据 | `system/repo-gate`（`docs/design/28` §2.6 的 `T-312` 子项，本批由 `tools/check-plugin-requirements.py` 承担） |

## 落地状态（`code/`）

<!-- 本批 `EV-181` 接上 `entry`；决策与被否决的选项见 `docs/work/decisions.md` D-084。 -->

- `code:` **已接入口** —— 内核 9 个 Python 模块（`canon.py`/`ledger.py`/`events.py`/`qep.py`/`plugin.py`/`delivery.py`/`evidence.py`/`modelgate.py` + `__init__.py`）
  与两个宿主机制件 `frozen.mjs`/`ledger-view.mjs` 都在 `code/`；`entry` = `code/__init__.py`（**内核包自己的**包初始化文件，不是新造）⇒ `valid:true`、`kind=python`。
- `provides` 沿用 `['kernel']`（内核只经 `kernel-bridge` 的 stdio 通道被使用，宿主**不**经 cordis 装载它；见 27 §7.1）。
- 边界：**内核不可自改**（ADR-0002）—— 接上 `entry` 只表示"实现落在 `code/`"，不表示内核成为可热插拔的宿主插件；
  任何门都没有放宽（装载/卸载内核仍不在判据内）。
- 被否决的选项（逐条理由）见 D-084：造一层 ESM 假面 / 不接（`degraded` 反而掩盖"Python 实现在树里"）。
