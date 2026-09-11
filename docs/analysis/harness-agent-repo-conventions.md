# 面向 agent 的仓库工程约定（来源：DeepSeek Harness）

<!-- budget: 14 KB. 证据基准: deepseek-ai/deepseek-harness @ c291e79 (2026-09-10), 
     sparse clone 路径 docs/ 与 .agents/ -->

## 为什么参考它

DeepSeek Harness（`论文` 的落地应用：把全部产品能力做成插件挂在 Cordis 上）是一个**由 agent 长期
参与开发、且人类规则与 agent 工作流被显式建模**的仓库。我们需要的正是这部分：一个 agent 接手后
能自主推进、崩溃后能无缝续接、每次改动都留痕的仓库形态。以下均为可核实的事实（文件路径已在
上述 commit 取得）。

## 借鉴的六条约定

### 1. 根 `AGENTS.md` 是唯一规则书，且有硬预算

`代码` `AGENTS.md`（155 行）自身声明：规则一条一行、自包含、用链接引出高层文档；
`CLAUDE.md` 是它的符号链接；「Condense when clarity survives」——超预算就压缩表达而不是加长文件。

我们照搬**形态**，并把预算写进规则（本仓库 `AGENTS.md` 规则 9）。**理由**：规则文本重复到多个
文件后必然漂移；漂移的规则比没有规则更危险，因为 agent 会照过时规则行动。

### 2. 设计决策有固定容器：`.agents/notes/`

`代码` `.agents/notes/README.md` 定义的机制，可直接复用的是：

- 路径编码两个维度：`{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`，
  lifecycle ∈ {proposed, implemented, rejected, archived}，class 是闭合集合
  （feature / bug-fix / simplification / architecture / process / testing）。
- 文件头三行固定：`# Agent Note: <title>`、空行、`Status: <status>`；正文以 `## Problem` 开头。
- **非平凡改动必须在同一个 PR 里带 Note**；已归档的 Note 冻结，永不编辑、不作为当前权威。
- 交叉引用必须用相对 markdown 链接（可机检），不允许裸 prose 或编号。
- 明确拒绝集中式 `INDEX.md`——目录即生命周期树本身。

我们采用其**决策容器**思想，落到 `docs/design/adr/`，并在 `AGENTS.md` 规则 8 固化
"协议与账本格式变更必须新增 ADR，不得原地改语义"。

### 3. 仓库自带技能：`.agents/skills/<name>/SKILL.md`

`代码` `.agents/skills/` 下 13 个技能（如 `dsh-pre-push-checks`、`dsh-code-review`、
`dsh-prose-standard`、`dsh-translate-docs`）。目的是：**把"怎么做"从人的记忆搬进仓库**，
让任意 agent 会话都能装载同一套流程。

我们采用：`.agents/skills/quotagent-takeover`（接手与恢复）、`quotagent-implement-task`
（实现一个任务的标准流程）、`quotagent-design-note`（何时写 ADR/设计记录）。

### 4. 装配分层：profile / bundle / patch

`代码` `docs/architecture.md`：一个运行的实例是**启动时按序叠加的插件树**；bundle 是可分发的
配置行与其挂载代码；patch 按 id 整行替换或插入新行；层序为
「profile 列出的各 bundle → profile 的 `cordis.patch.yml` → home 级 patch → `--patch` 覆盖」。

我们映射为采购领域的四层授权：**行业模板 → 公司策略 → 项目 → 标段**，都是 patch 层，
使"同一套 agent 逻辑按客户/项目调参"成为纯数据操作（设计文档 01 §5）。

### 5. 能力接缝（capability seam）三角，不允许只有一个角色

`代码` `docs/architecture.md`：接缝 = Service Definition（接口）+ Service Provider（实现）
+ Consumer（使用者，通常是模型可见工具）；「A package may combine roles, but one role alone
is not a seam」。另外 `packages/AGENTS.md` 要求：运行时不变量只断言"独立观察者可分歧"的关系，
不允许写"服务存在性/插件元数据/固定样例"这类空检查。

我们照搬到服务目录（设计文档 04）：每个 `ctx.*` 必须明确三角与不变量，且不写空断言。

### 6. 证据纪律：只报告跑过的命令；模型可见即已记录

- `代码` `AGENTS.md`：「Run checks before pushes ... report only commands run」，
  并规定"匹配证据与改动面"：行为测试 / 快照 / 文档门 / 成品冒烟 / 真 API e2e，各司其职；
  **不要默认跑全量套件**，CI 拥有穷尽覆盖。
- `代码` `docs/architecture.md`：「**Model-visible means logged**」——任何进入模型请求的东西
  必须能从会话日志重建，并有运行时不变量断言它。

这两条直接进我们的 `AGENTS.md` 规则 2 与 6，以及验收标准文档（每条 AC 必须给出命令与输出证据）。

## 明确不借鉴的部分（及原因）

| 不借鉴 | 原因 |
|---|---|
| 双语 sidecar（`*.i18n.yaml`、`*.zh.md`）与翻译技能 | 翻译门是它们社区规模的产物；我们阶段早期引入只会稀释预算 |
| 16k commits 的 CI 矩阵、覆盖率门、快照回放基础设施 | 设计期无代码；P1 起按需引入最小门（`docs/design/12`） |
| vendoring 上游源码（`vendor/README.md` 的同步流程） | 我们**不 vendor Cordis**：只借鉴其设计纪律，实现语言与栈自由（ADR-0001） |
| 生成式目录（`docs/cordis-api/*` 由脚本生成） | 我们暂不生成 API 目录；改为手写服务/事件目录并靠 AC 校验与现实一致 |
| 把规则文档与 CLAUDE.md 双写 | 本仓库只保留 `AGENTS.md` 一处规则真源 |

## 一句话结论

Harness 仓库证明了一件事：**agent 能否长期自主工作，取决于仓库有没有把"规则、状态、流程、证据"
四样东西显式化。** 本仓库的 `AGENTS.md`（规则）、`docs/work/*`（状态与流程）、
`.agents/state.json`（机器可读状态）、`docs/work/evidence/`（证据）就是这四样。
