# 架构决策记录（ADR）

<!-- budget: 6 KB. 何时写 ADR 见 ../12-documentation-standard.md §4 -->

## 索引

| ID | 决策 | 状态 |
|---|---|---|
| ADR-0001 | 采用 Cordis 的 context 范式作为系统设计内核（借鉴设计，不 vendor 代码） | accepted |
| ADR-0002 | 内核冻结 + 能力以接缝三角扩展 | accepted |
| ADR-0003 | 跨方账本同步采用字段权威方 + 三方协调（替代 Cordis 的"文件赢"） | accepted |
| ADR-0004 | 事实/意图/承诺三分，承诺必须人工批准 | accepted |
| ADR-0005 | 自进化必须经影子重放 + 评测门 + canary | accepted |
| ADR-0006 | QEP 传输无关，且协议版本不兼容即拒绝 | accepted |

## 格式

每条 ADR 固定结构：`Status` → `## Problem` → `## Decision` → `## Consequences` →
`## Alternatives rejected` → `## Revisit conditions`。

**不可原地改语义**：修改已 accepted 的决策 = 新写一条并在旧条目头行标注
`Status: superseded by ADR-NNNN`。
