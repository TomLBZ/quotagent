# quotagent

面向 **承包商 ↔ 供应商** 采购-报价闭环的 agentic 系统设计。架构范式取自
[Cordis](https://github.com/cordiverse/cordis)（时空可组合性元框架）：
revertible effects + reactive coeffects，[arXiv:2608.25512](https://arxiv.org/abs/2608.25512)。
工程约定参考 DeepSeek Harness 的「全插件 agent harness」形态。

**当前状态：P2 进行中**（自包含运行时 + 账本 + 宿主插件层 + 一键运行已落地）。需求与设计在
`docs/`，路线图 `docs/work/roadmap.md`；由 agent 自实现并在线自进化。

痛点与应对：承包商（询价包口径不一/报价不可比/变更无审计链）→ 规范化询价包 + 标准化比价 + 澄清账本 +
变更单闭环；供应商（读包靠人/成本难沉淀）→ 自动读包 + 成本模型 + 澄清工单 + 报价策略记忆；对接
（Excel/邮件互发、口径漂移、数据主权）→ QEP 交换协议 + 三方账本 + 隔离 realm + 承诺审批门。

## 快速开始（从零到能用）

```bash
git clone <repo-url> quotagent && cd quotagent
./run doctor     # 只读体检 7 项（解释器/Node/cordis/端口/配置/凭据/门），逐条 next_action；0 = 这机器能跑
./run up         # 一条命令：备仓库内 .venv → 装宿主依赖（缺失才装）→ 起服务 → 健康检查 → 打印 URL
```

`up` 成功后访问它打印的 URL（缺省 `http://127.0.0.1:8093/quotagent/`）；`--port N` 换端口。
`./run status`（一行 JSON：`ok/pid/port/url/healthy/ready_ms/managed/degraded[]`）·
`./run logs`（日志**路径** + 有界尾部，缺省 40 / 上限 200 行；没日志如实失败）·
`./run down`（回收**本次启动的**进程，不删数据，重复执行幂等）。

**外部凭据缺失不阻塞启动**（"没凭据不得假装能发"）：受影响的插件在 `status.degraded[]` 报
`available:false` + 有名 reason + next_action。要配置：`./run config init` 生成**只含白名单键**的
`config.yaml`（不覆盖已有文件、0600、打印指纹与逐条 next_action）→ 填值；**改已有值**走人工门
`tools/config-apply.py`（唯一落盘者，或管理道 UI 的干跑 → 0600 待办件）。凭据只存指针与指纹、永不回显；
管理员 token 放 0600 文件 `/workspace/config/quotagent-admin-token`（权限不符 fail-closed）。

**下一步看哪里**：用法与判据 `src/system/runtime/docs/one-command-run.md`；契约原文
`docs/design/28-plugin-requirements-and-run.md` §3.1；门 `tools/verify.sh run-once`（工作树真跑）与
`tools/verify.sh run-clone`（只含已提交内容的干净副本里真跑，**须在 commit 之后跑**）。

## 插件与门

```bash
tools/plugin.sh list --json                        # 枚举三层插件（system/domain/userspace）
tools/plugin.sh status domain/advice               # 装载状态 / 依赖 / effects 计数
tools/plugin.sh load|reload|unload domain/advice   # 装载 / 热重载（新 uid）/ 卸载（effects 归零）
./run plugin load domain/advice                    # 同一件事，但作用于**正在服务的进程**（运行期装卸）
```

契约见 `src/system/runtime/docs/lifecycle-contract.md`；规范 `docs/design/27-plugin-architecture.md`。

## 给 agent 的最小操作序列

```bash
cat docs/work/handover.md          # 1. 我在哪、下一步唯一动作
cat .agents/state.json             # 2. 机器可读状态
tools/verify.sh docs               # 3. 基线门（动任何东西之前先确认它绿）
tools/verify.sh smoke              # 4. 运行时自检（解释器 / 标准库依赖 / 临时目录）
tools/verify.sh ac AC-AUDIT-001    # 5. 跑一条 AC（AC 实现在 src/quotagent/qa/）
# 6. 在 progress-checklist 里挑一个 status=todo 的任务，按其 FR/AC 实现
# 7. 取证：tools/run.sh -m quotagent.qa ac <AC-ID> --evidence EV-NNN
# 8. 更新 progress-checklist + handover + state.json；commit & push 并回读远端
```

规则见 [AGENTS.md](AGENTS.md)——本仓库规则的唯一真源。
