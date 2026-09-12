# ADR-0007 P0 实现栈与账本文件格式

Status: accepted

## Problem

设计期结束，实现自 P0 起（`AGENTS.md` 当前阶段）。有两件事必须在写第一行代码前定死，否则后续每一轮
都在漂：

1. **实现栈与运行时**：`01-architecture.md` §6 只给了 `minimal-mock` profile，`04` 只给了方法签名。
   P0 的价值在于"可复跑、可取证"——若一个检查需要一个安装步骤，它在下一台机器上就不再运行，
   而没人会发现"其实什么都没检查"。现场机器不保证有包管理器、网络或宿主 Python 依赖。
2. **账本记录的字节格式**：`04` §1 定义了 `append/read/project/verify_chain` 与不变量，但没落到字节。
   哈希公式或字段一改，此前全部证据文件与审计包都失效，而跨方交换（ADR-0006）要求双方对同一条
   事件算出同一个哈希。按 `AGENTS.md` 规则 8（协议与账本格式变更必须新增 ADR）与
   `12-documentation-standard.md` §4（实现栈选择必须写 ADR），这两件事都必须成文。

## Decision

1. **实现栈**：Python 3.9+，**仅标准库**。包根 `src/quotagent/`，AC 运行器 `src/quotagent/qa/`。
   不引入第三方运行时依赖、不需要安装步骤；确需依赖时新写 ADR（见 Revisit conditions）。
2. **仓库内自包含运行时**（T-101）：`tools/runtime.sh` 按序解析解释器——
   `$QUOTAGENT_PY` → 仓库 `.venv/bin/python` → 工作区工具链 `$WS_VENV/bin/python` → `PATH` 上的
   `python3`/`python`；每个候选都**实际执行一段代码**来验证（因此 `python3.x-config` 这类同名包装器
   不会被选中）。`tools/bootstrap.sh` 幂等：在仓库内创建 `.venv`（`--without-pip`，`.gitignore` 已忽略）
   并写 `quotagent-runtime.json` 清单；`tools/run.sh` 负责 `PYTHONPATH=src` 并 `exec`。
   **仓库不写仓库外的文件**：临时产物落 `tmp/`（gitignored，用后清理）。
3. **CLI 骨架**（T-101）：`python -m quotagent.qa ac <AC-ID> | suite <name> | list | selftest`。
   AC 是 `src/quotagent/qa/checks_*.py` 中的断言函数，注册进注册表（新增 AC = 加一个函数 + 一条
   `acceptance-criteria.md` 行）。`qa ac` 在 stdout 打印 `{ac, status, assertions[], evidence_refs[]}`，
   人工摘要走 stderr；退出码 `0`=通过、`1`=断言失败、`2`=未知入口/未实现（不伪装通过）。
   证据由 `--evidence EV-NNN` 写入 `docs/work/evidence/EV-<NNN>-<AC-ID>.txt`，头部含时间、命令、
   commit、退出码。
4. **账本文件格式**（`ledger.jsonl`，一行一事件，canonical JSON：键排序、无空白、UTF-8 NFC）：

   ```
   seq, ts, realm, type, class, correlation_id, actor, refs, body,
   body_hash, prev_hash, entry_hash
   ```

   - `body_hash = sha256(canonical(body))`
   - `entry_hash = sha256(canonical(记录去掉 entry_hash))`（因此覆盖 seq/ts/type/class/
     correlation_id/actor/refs/body_hash/prev_hash）
   - `prev_hash` = 前一条的 `entry_hash`；创世前驱为 `sha256:` + 64 个 `0`
   - 哈希字符串一律带 `sha256:` 前缀；`body` 规范化前先做 NFC 归一
   - 追加：`seq` 单调、`open(..., "a")` 单行写入并 flush（可选 fsync）
5. **去重**：键 `(correlation_id, type, body_hash)`；重复 `append` 返回既有 `ref` 且
   `duplicate=true`，不产生第二条事实（FR-LEDGER-004）。事件一经追加不可修改：`read()` 返回副本。
6. **停发语义**：启动与每次追加后都校验哈希链；失败即冻结该账本对象——拒绝继续 `append`，
   并提供 `assert_healthy()` 供对外发送路径前置检查（FR-LEDGER-003）。**已落盘数据仍可读**，
   因为审计需要读取被篡改的账本。
7. **审计包（P0 最小形态）**：`events[] + leafs[] + merkle_root + manifest{anchor_prev_hash,
   head_hash, pack_hash, from_seq, to_seq, count}`；独立验证只依赖包内自洽性，不信任导出方状态
   （AC-AUDIT-001）。签名、留存策略与审计包对外交付属 P1（T-208），本 ADR 不覆盖。
8. **模型可见 ⟺ 账本可见**（`AGENTS.md` 规则 2 / P4）：新事件类型 `kernel/model-call`（完整输入）
   与 `kernel/model-replied`（输出与用量）。提供方在自己的边界独立记录收到的输入；
   `rebuild_inputs()` 只读账本重建，`AC-AUDIT-002` 抽样 20 次比对，并带一个负控
   （故意注入未落账内容必须被检出），确保比对不是空转。事件类型登记见 `05-events.md` §2 与
   `02-domain-model.md` §4。

## Consequences

**正向**

- 任何有 Python 3.9+ 的机器都能复跑全部 AC 与文档门，不依赖安装、网络或宿主包管理（AC-RUNTIME-001）。
- 账本格式字节级确定：同一条事件在双方算出同一 `entry_hash`，审计包可被第三方独立验证。
- 去重与停发都落在唯一写入口 `append`，业务层无法绕过；模型输入与账本的双向对应可机检。
- 运行产物被限定在 `.venv/`、`tmp/`、`__pycache__/`，仓库工作树不因运行而变脏。

**负向**

- 仅标准库意味着若干能力（HTTP、重试、请求校验）需要自实现或用 `urllib` 拼装，开发效率低于
  引入成熟库；P0 接受这一代价（可用性 > 便利性）。
- `.venv` 是每台机器各自的产物，不入库；换机需重跑 `tools/bootstrap.sh`（幂等，约 1 秒）。
- P0 审计包不含签名，只证明"包内自洽 + 链完整"；跨方验签能力在 P1 补齐前不能主张。

## Alternatives rejected

| 方案 | 否决理由 |
|---|---|
| 引入第三方库（pydantic / click / pytest / typer） | 现场机器无法保证安装与网络；依赖一旦缺失，门与 AC 静默不执行 |
| 账本改用 SQLite（P2 计划） | P0 需要人可读、可 diff、可手工篡改以验证"篡改能被检出"；jsonl 更利于取证 |
| 每次打开账本写一条 genesis 事件 | 把"打开"变成写操作，污染幂等与去重语义，也无法区分空账本与已初始化账本 |
| 审计包 P0 就上签名与密钥管理 | 密钥轮换属 T-304 范围，P0 引入会拖住账本核心；哈希链 + Merkle 根已覆盖 AC-AUDIT-001 |
| 用一个 `tools/run.sh` 内联所有逻辑（无包结构） | AC 与业务插件需要同一套内核；无包结构会让 T-102..T-115 各自复制账本逻辑 |

## Revisit conditions

1. 若性能预算（`10-nonfunctional.md` §3）在仅标准库下被证伪（例如 10^6 事件的重建超预算），
   新写 ADR 引入最小依赖集或改用 `ledger.sqlite`。
2. 若账本记录需增删字段或改哈希公式，新写 ADR 并加格式版本字段；旧账本按 ADR-0006 的过渡期
   规则只读保留，不得原地改语义。
3. P1 的 T-208 落地跨方签名与审计包验证后，本 ADR 第 7 条的 P0 最小形态即被取代。
4. 若出现"必须在无 Python 的现场跑"的真实需求（例如纯 shell 环境），运行时策略需重定。
