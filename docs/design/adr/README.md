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
| ADR-0007 | P0 实现栈（Python 3.9+ 仅标准库）+ 仓库内自包含运行时 + 账本文件格式 | accepted |
| ADR-0008 | P0 的 QEP 落地细节：HMAC-SHA256 签名占位 + 文件投递命名/原子写 + QEP 落账事件 | accepted |
| ADR-0009 | P0 的归一化链语义、声明容差、汇率时点精确命中、版本不可变与读包两条门 | accepted |
| ADR-0010 | P0 的人工门（批准绑 scope+ref、只能由人产生）与 realm 过滤（三处过滤点、私域工件哈希引用） | accepted |
| ADR-0013 | cordis 宿主与 Python 内核的桥接协议（NDJSON/stdio v1、版本握手、方法分级、背压与故障语义） | accepted |
| ADR-0015 | 宿主 profile（组成即数据）与配置更新的否决语义（用 cordis 原生 `fiber.update`+`internal/update`） | accepted |
| ADR-0014 | P1 的推进前提（V 假设通过，标 not_a_conclusion）、MVP 判据、削减顺序与"绝不许假"清单 | accepted |
| ADR-0012 | 直接依赖 cordis 4.0.0-rc.10 作为宿主层（取代 ADR-0001 的"不引入其代码"；含实测约定与桥接边界） | accepted |
| ADR-0011 | P0 的比价 TCO 口径与引用链、护栏只标注（Flag 枚举扩展 `private_leak`）、场景集确定性与指标基线 | accepted |
| ADR-0016 | 自进化的可写面：插件产物由提案交付，晋升仍需人工引用 | accepted |
| ADR-0017 | canary 分流与自动回滚的方向性 | accepted |
| ADR-0018 | 留存与销毁的边界：账本行永不销毁，销毁只作用于派生副本 | accepted |
| ADR-0019 | 谈判轮次与让步的边界 | accepted |
| ADR-0020 | 一切皆插件：三层分类、目录规范与注入式 UI | accepted |
| ADR-0021 | 需求必须归属到插件（不存在「产品整体」的功能性需求） | accepted |
| ADR-0022 | 人工门的派分事实（审批人与超时策略）随开单落账本 body | accepted |
| ADR-0023 | 终止（`approval/aborted`）的理由正文进账本 body | accepted |
| ADR-0024 | 承诺 / 发 PO 必须**消费**一扇别人批过的门（不得自签自批） | accepted |
| ADR-0025 | 授权区间变更必须**另一个人**批过才生效（不得自提自批） | accepted |
| ADR-0026 | GUI 外壳共享、**数据按会话侧隔离**（`/app/<侧>/**` 与 `/api/ui/panels\|object` 的侧门） | accepted |

## 格式

每条 ADR 固定结构：`Status` → `## Problem` → `## Decision` → `## Consequences` →
`## Alternatives rejected` → `## Revisit conditions`。

**不可原地改语义**：修改已 accepted 的决策 = 新写一条并在旧条目头行标注
`Status: superseded by ADR-NNNN`。
