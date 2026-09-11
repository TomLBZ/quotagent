---
name: quotagent-design-note
description: Use when changing protocols, ledger semantics, kernel boundaries, trust model, or the self-evolution surface in quotagent. Keeps decisions traceable instead of rewriting history.
---

# 写设计记录（ADR）与文档改动

## 何时必须写 ADR

（`AGENTS.md` 规则 8；判据同 `docs/design/12-documentation-standard.md` §4）

- QEP 信封/报文体/版本语义变化
- 账本事件类型的语义变化（新类型可以，改语义不行）
- 内核边界、可写面、人工门、信任与密钥模型的变化
- 实现栈、传输绑定、部署形态的更换

不必写：措辞调整、状态更新、场景数据补充、错别字。

## ADR 格式（固定，缺项即漏）

```
# ADR-NNNN <一句话决策>
Status: proposed | accepted | superseded by ADR-NNNN

## Problem        为什么必须现在决定；不决定会发生什么
## Decision       决策本体，可执行、可机检的措辞
## Consequences   正向 / 负向各列（负向不写等于没审）
## Alternatives rejected   表格：方案 | 否决理由
## Revisit conditions      什么条件下应重新评估
```

## 不可违反

- **已 accepted 的 ADR 不得原地改语义**：新写一条，并在旧条目头行标注 `superseded by ADR-NNNN`。
- 决策理由进 ADR；设计文档只写"是什么"，不写"我们曾考虑"。
- 每个新 ID（FR/AC/T/INV/V/NFR/EV）必须在自己的定义文件里出现，否则 `tools/verify.sh docs` 会红。

## 文档改动流程

1. 想清楚这一条事实的**唯一归属**（一处一事实）；其他位置只放链接或 ID。
2. 改完立刻跑 `tools/verify.sh docs`（ID 完整性 + 预算 + 覆盖 + 占位符）。
3. 超预算时按顺序处理：删重复 → 删叙述 → 拆文件 → 才考虑提高预算（提高需在提交信息说明理由）。
4. 若改动影响任务划分或阶段门，同步更新 `docs/work/roadmap.md` 与 `progress-checklist.md`。
