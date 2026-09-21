# 决策记录（归档段）

本文件是 `docs/work/decisions.md` 的**归档段**：为守住 decisions.md 的预算上限，把**没有被任何代码/门引用**的较早决策整段搬到这里（内容一字未改、只搬位置；**门的预算规则未改**）。被断言引用的决策（如 D-016）一律留在 `decisions.md`，否则机检会红——这是本轮实测到的约束。

## D-018 Jev 只做“建议层”，不进判定层（T-223，2026-09-21T08:22:34Z）

- 结论：模型 `Jev`（TypeSafe AI，System One 评估模型）确实存在且接口为“state + 类型化问题 → 类型化答案 +
  置信度”。本项目**可将其用于建议类判定**（澄清分流、异常打标、偏离分级、路由建议、字段预筛），
  **禁止**用于演化门判定、账本事实生成、替代人工门、算术与期限计算。
- 依据：一手来源核验（`docs/work/evidence/EV-060-jev-primary-sources.txt`）与报告
  `docs/analysis/jev-model-research.md`；本仓既有纪律：演化门指标不得为模型自评（`host/lib/evolution.mjs`
  负控）、账本唯一写入者是内核（`ADR-0007`）、人工门前置（`AC-APPROVE-003`）。
- 接入三纪律（若做 `T-224`）：模型可见 ⟺ 账本可见；建议不改变任何既有判定；外部不可达时主流程照常。
- 状态：`accepted`（由独立 agent 调研 + 本 agent 复核得出，非人工批准；用户 2026-09-21 明示批准以调研结论推进）。

## D-019 subagent 交付插件：授权范围与复核纪律（T-226/T-227，2026-09-21T08:26:41Z）

- 授权：用户 2026-09-21 明示"可以用 subagents 制作一些 domain based 插件或者中间件满足一些具体业务逻辑"、
  "允许 subagent 做决策，留下明确的决策记录即可"。据此把两个**新增插件**整文件交给独立 subagent 编写。
- 边界：subagent 只能新建 `host/modules/<name>.mjs` 一个文件；不得改检查器、清单、ADR、门、其它模块；
  不得改文档。父 agent 负责接线、文档、证据与提交。
- 复核（父 agent 实测，非转述）：`tools/verify.sh modules` 73/73（A1..A6，含内建 mixin 负控、零残留、
  确定性、跨模块 import、config 负控）；`tools/verify.sh plugins` 4/4；静态扫描无跨模块 import、
  无文件/网络副作用（唯一命中的 `Date.now` 是注释里"绝不用"的说明）。
- 交付：`host/modules/sourcing.mjs`（领域插件：RFQ 覆盖率/缺口/临期，纯函数只读账本行）、
  `host/modules/timeline.mjs`（中间件：按 realm 的时间线环形缓冲，幂等去重、零残留、无定时器）。
- 复核发现的边界：`sourcing` 只读账本行、不做数值推断；`timeline` 不产生业务事实（事实仍以 Python 账本为准）。

