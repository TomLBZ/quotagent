# ADR-0016 自进化的可写面：插件产物由提案交付，晋升仍需人工引用

- 状态：accepted（2026-09-21）
- 依据：用户 2026-09-21 指令「当 agent 自进化能力上线后，可以用自进化的方式制作插件或中间件等来使每一个功能模块都可分别独立演进」；`ADR-0002`（内核不可自改）、`ADR-0012`（cordis 宿主层）、`ADR-0015`（组成即数据）、`docs/design/14-plugin-inventory.md`。
- 关联任务：`T-227`；机检 `tools/verify.sh evolution`（27 条断言）；证据 `docs/work/evidence/EV-063-*.txt`。

## 1. 决定

自进化可以**产出插件**（`host/modules/<name>.mjs`），但遵守四条硬约束：

1. **可写面只有 `host/modules/`**：写目标必须归一到该目录，否则拒绝（`artifact-outside-write-surface`）。
   内核（`kernel.*` / `src/quotagent/kernel/`）与服务层仍不可自改（`INV-010`）。
2. **产物必须是 cordis 插件**：至少导出 `name` 与 `apply`；否则拒绝（`artifact-not-a-module`）。
   模块契约（`provides`/`inject`/`builtin`/`usedServices`/`Config`/`fixture.sample`）由 `tools/verify.sh modules` 的 fixture A1..A6 机检。
3. **门信号是真实 fixture 结果**：`expected_effect.metric` 固定为 `fixture:module`；门的五条 AND 里第一条要求
   **对影子产物真跑** A1..A6 且全绿（`fixture.total ≥ 12`：空集合不得当通过）。模型自评不作为指标来源。
4. **晋升 = 门通过 + 人工 `approval_ref` + 哈希一致**：三者缺一不可；提案后产物被改动 → `artifact-tampered` 拒绝。

## 2. 流程（一步一事件，全部由 Python 侧落账）

| 步骤 | 动作 | 拒绝码（负控） |
|---|---|---|
| 1 | `makeModuleProposal`：绑定产物路径、`sha256` 内容哈希、字节数 | `artifact-outside-write-surface` / `artifact-not-a-module` / `effect-invalid`（指标来源非 fixture） |
| 2 | `shadowArtifact`：产物只进**影子目录**（`<shadow>/modules/`），真实目录不动 | `artifact-source-missing` |
| 3 | `runFixtures`：对影子产物**真跑** `check-modules.mjs --module <name> --module-dir <shadow>/modules` | 坏产物被 fixture 抓出 → 门 `rejected` |
| 4 | `gateModule`：五条 AND（fixture 全绿 / 不变量 / 反例集 / 预算 / 人工介入率不升） | 任一条不满足即 `rejected` 并给理由 |
| 5 | `promoteModule`：写真实目录 | `promote-needs-approval` / `promote-gate-failed` / `artifact-tampered` |
| 6 | `rollbackModule`：删自有产物 + journal 撤回 | `rollback-refused-modified`（内容被别人改过就不动手） |

事件：`evolve/proposed` → `evolve/shadowed` → `evolve/gated` → `evolve/promoted` → `evolve/rolled-back`（两侧登记，见 `docs/design/05-events.md` 与 `kernel/events.py`，由 `tools/verify.sh events` 双向机检）。

## 3. 为什么不是"自动晋升"

- 门只回答"**技术上是否达标**"，不回答"**该不该上线**"。产物是可执行代码，不是配置值；把两者合并会让
  "指标好看"直接等价于"上线许可"，而这正是评审 C `§5.2` 否掉的做法。
- 因此 P2 仍保留 `approval_ref` 门槛：**机器判据 + 人的引用**，两者不可互相替代（`docs/design/07-self-evolution.md §5`）。
- 自动晋升/自动回滚的阈值与 canary 真实路由属后续任务；本 ADR 只固定"可写面与门槛不可绕"。

## 4. 后果

- 新增功能有两条合法来源：人写（`T-2xx` 批次）与自进化提案（本 ADR）；两条都必须进
  `docs/design/14-plugin-inventory.md` 并过一个 profile 装配，`tools/verify.sh plugins` 会核对。
- 影子机制让"没晋升的产物"永远不会污染真实模块目录；fixture 的**空集合守卫**（`A0`）防止
  "没跑到"被当成"通过"。
- 已知限制（写入 `handover.md`）：门里的"宿主不变量"检查目前跑的是**宿主整体**的 `verify.sh invariants`，
  不是"影子模块挂载后的不变量"；后者需要影子挂载参与不变量运行，属 P2 余项。
