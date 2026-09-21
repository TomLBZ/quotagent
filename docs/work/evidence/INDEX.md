# 证据索引（EV-001..）

<!-- budget: 8 KB。定义处：本页的表格行即 EV-ID 的定义 -->

| 编号 | 内容 | 对应 AC |
|---|---|---|
| EV-001 | 文档门运行记录（含首次失败与修复后全绿） | AC-DESIGN-001/002/003 |
| EV-002 | 设计期事实来源取证（cordis / 论文 / harness 的 commit 与文件行号） | 支撑 `docs/analysis/*` 的 `代码`/`论文` 标注 |
| EV-003 | 远端推送与 refs 回读 | 规则 7（一轮一批） |
| EV-004 | 文档门复跑：仓库内 + 干净副本（最小环境、裸解释器、未设 PYTHONPATH） | AC-DESIGN-001/002/003 |
| EV-005 | 账本篡改检测：篡改历史事件 → `verify_chain()` 假、审计包独立验证失败、冻结后拒追加 | AC-AUDIT-001 |
| EV-006 | 模型输入重建：抽样 20 次 `rebuild(inputs) == observed_inputs`；含未落账注入的负控；投影全量/增量/时点一致 | AC-AUDIT-002 |
| EV-007 | 自包含运行时：仅标准库、干净副本可跑、`tools/bootstrap.sh` 幂等、产物不落仓库外 | AC-RUNTIME-001 |
| EV-008 | CLI 契约：JSON 报告、退出码 0/1/2、未实现入口返回 2 | AC-RUNTIME-002 |
| EV-009 | 事件五模式实测：emit 全调用、parallel 全跑并聚合抛错、serial/bail 短路点、waterfall 委托链、模式误用报错、disposer 撤销 | AC-EVT-001 |
| EV-010 | waterfall 不调 `next()` 即短路（下游不执行、返回值即最终值、记录短路点），且默认事件表的 waterfall 事件均在 05-events.md §5 登记 | AC-EVT-002 |
| EV-011 | 插件装载/卸载残留检查：监听器、账本订阅、定时器三类 effect 计数回到基线，定时器停止触发 | AC-PLUGIN-001 |
| EV-012 | 依赖失活 → 消费者 inactive 且 effects 回收、草稿清空；依赖恢复 → 自动重载（epoch 递增）且草稿重新生成 | AC-PLUGIN-002 |
| EV-013 | QEP 信封：字段齐全、可验签、逐字段篡改导致验签失败、body_hash/版本/承诺批准校验 | AC-QEP-001 |
| EV-014 | 幂等：同报文投递 3 次只 1 条事实 + 2 条 duplicate-dropped；重发 msg_id/body_hash 不变且不产生第二条事实 | AC-QEP-002 |
| EV-015 | 文件投递：临时文件 + rename 原子落盘、命名约定、半写/坏文件不被读取且坏文件被隔离并留原因 | AC-INTEG-001 |
| EV-016 | 混合口径归一：USD 含税 + cm 与 EUR 不含税 + kg 两条报价，金额与手算值在声明容差内；汇率时点不同则金额不同；结果携带口径因子 | AC-NORM-001 |
| EV-017 | 四条拒绝路径（缺计量规则/单位不在规则内/汇率时点不可得/缺税制）各自给出 code+reason+next_action，且不产生结果、不落账 normalized | AC-NORM-002 |
| EV-018 | 条目对齐三态（matched/additional/missing）：additional 显式标记并按报价单位归一（来源可查）；未对齐条目被拒绝并列出 | AC-NORM-003 |
| EV-019 | 包定义校验：清单单位不在计量规则表、接口无唯一责任方（缺/不唯一）→ 校验失败且逐条指明；服务可装可卸 | AC-RFQ-001 |
| EV-020 | 版本化：发布产生 rev=1 与内容哈希；原地修改与 modify_published 均被拒且哈希不变；amend 产生 rev=2 与字段级 delta；缺 quote_by 不得发布 | AC-RFQ-002 |
| EV-021 | 读包：逐条 item_id + 来源引用；无来源抽取标 [假设] 且 agent 不得自升级（人工确认后才成事实）；落账 quote/intake-completed | AC-INTAKE-001 |
| EV-022 | 缺项与疑问：人为删减的条目被检出（含 next_action）；条目齐全时无缺项；疑问未获人工确认不得外发，确认后逐条落账 clarification/asked | AC-INTAKE-002 |
| EV-023 | 成本构成：七要素按条目分解、手算总量（10100.51856）与单价（不含税 74.4876 / 含税 84.170988）逐项对齐、因子可追溯；明细落私域、账本只带哈希；对方 realm 读取被拒 | AC-COST-001 |
| EV-024 | 私域三处均不存在：对方视图/出站载荷、本侧模型输入（regulated 也不进）、视图；本侧视图仍看得到自己的私域（非空转）；注入私域字段的出站载荷被 `PrivateLeak` 拦下 | AC-TRUST-001 |
| EV-025 | 定价流水线五阶段（含手算 85.92889536）；越界定价无条件请求批准且状态待批；agent 确认被拒、人确认后落定并落账 human-approved；区间内不触发门 | AC-PRICE-001 |
| EV-026 | 人工门：批准请求→待批；agent 代签被拒且不落 granted；人签署后才有效；批准链按业务引用查回、两引用不串台；伪造 approval_id 被拒 | AC-APPROVE-001 |
| EV-027 | 无批准记录时三条承诺路径（提交报价/授标承诺/发 PO）全部抛错且不落账；跨动作复用被拒；有批准+供应商确认+已成立承诺时才成功；PO 不能手工另建 | AC-APPROVE-002 |
| EV-028 | 偏差：四类捕捉（技术/商务/进度/范围）；未标 impact 的偏差不进 TCO 但可查（excluded）；三维量化与手算合计（价格 1200 / 时间 20 天）；类别与影响可查；替代方案仅为 Intent | AC-DEV-001 |
| EV-029 | 版本失配报价不进排序：进 `excluded`（code=rfq_version_mismatch + 双方版本 + next_action）、落账 `rfq/version-mismatch`、金额不进任何 TCO 分量 | AC-COMPARE-001 |
| EV-030 | 确定性：两次排序字节级一致；手算 q-b 分量（交期 8000 / 质保 12000 / 融资 3478.356164）；换权重只改分数不改分量；`recompute` 用旧分量+新权重重现新排序分数 | AC-COMPARE-002 |
| EV-031 | 引用链：每个数值都有引用（前缀限定 ledger/package/quote/policy/deviation）；排序建议本身也带引用；人为删掉一条引用 → `MissingCitation` 并指出路径与 quote_id | AC-COMPARE-003 |
| EV-032 | 护栏只标注：异常低价 + 漏项各被标 Flag（带 severity 与证据）；Flag 不改变排序与状态；无 `reject`/`veto` 接口；Flag 逐条落账 `compare/flag-raised` | AC-GUARD-001 |
| EV-033 | S4 反例：注入（只标注、原文与金额不被改写）/ 漏项 / 虚假产能 / 伪造批准（agent 代签 + 伪造 approval_id）全部被拦，每个 case 有账本留痕；反例集删除被拒 | AC-GUARD-003 |
| EV-034 | 场景集 S1..S4 全绿；同输入重放两次 digest 一致、非易变字段字节一致；S1 步骤齐全（询价→澄清→2 报价→比价）且规模符合定义；`suite s1..s4` 一条命令退出码 0 | AC-EVAL-001 |
| EV-035 | 指标基线：九项指标可采集且带依据事件（不补零）；报告可生成且人可读、声明不设目标值；反例集只增不减（删除与改写均被拒） | AC-EVAL-002 |
| EV-036 | V-002 备料自检（agent 可执行部分）：结构化报价表单 → 归一化（20 行、容差 5 bps）→ 护栏（0 Flag）→ 比价（含税总额 174486.0、TCO 193803.844、18 条引用）；证明表单字段自洽可被读入。**不是现场结论** | T-117 备料 |
| EV-037 | V-011 备料自检（agent 可执行部分）：QEP 报文构造 → 原子落盘（`000001-<msg_id>.qep.json`）→ 读回验签通过 → 篡改 body 后验签被拒；给出对方可一行命令复算的 sha256。**不是现场结论** | T-117 备料 |
| EV-038 | cordis 依赖探针与宿主冒烟：钉住版本 4.0.0-rc.10、五模式语义（含 waterfall 可变载荷/短路、parallel 聚合抛错）、effect 与订阅随 fiber 卸载回收、重载得新 uid；18 条断言全绿 | ADR-0012 / T-201 前置 |
| EV-039 | 宿主 profile 与配置否决（AC-PLUGIN-003，11 条断言）：三个 profile 是组成数据；两个 profile = 两个真进程（pid/realm/账本/配置摘要各异）；内核键更新被否决且**配置未变、插件未重启**（摘要/激活代/文件字节都不变）；授权区间拒绝 agent 来源；白名单外键被拒；无违规更新生效并落盘 | AC-PLUGIN-003 / T-201 |
