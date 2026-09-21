# 证据索引（P1 mvp demo：EV-039 起）

> P0 阶段的证据在 [`INDEX.md`](INDEX.md)：EV-001..EV-038。

| 证据 | 内容 | 关联 |
|---|---|---|
| EV-039 | 宿主 profile 与配置否决（AC-PLUGIN-003，11 断言）：两 profile = 两真进程（pid/realm/账本/配置各异）；内核键更新被否决且配置未变·插件未重启；授权区间拒 agent；陌生键被拒；生效更新落盘 | AC-PLUGIN-003 / T-201 |
| EV-040 | 桥接最小闭环（AC-INTEG-004 12 断言 + AC-INTEG-005 6 断言）（详情见 EV 文件本体） | AC-INTEG-004, AC-INTEG-005 / T-216 |
| EV-041 | 桥的故障语义（AC-INTEG-006，13 断言 + 7 个场景原始输出）（详情见 EV 文件本体） | AC-INTEG-006 / T-217 |
| EV-042 | QEP 顺序与版本协商（AC-QEP-003 14 断言 + AC-QEP-004 6 断言）（详情见 EV 文件本体） | AC-QEP-003/004 / T-202 |
| EV-043 | relay 绑定（AC-INTEG-002，11 断言）：relay 只记整包 sha256（不解析 body）；目标不可达→relay/queued→pump→relay/delivered；字节透明（逐字节相同）；篡改包照常转发但接收方验签拒收留痕；spool 被改→拒投 + relay/tamper-detected；账本隔离；发送侧不可达不落半条记录、恢复后重发幂等 | AC-INTEG-002 / T-218 |
| EV-044 | 账本同步（AC-SYNC-001，15 断言）（详情见 EV 文件本体） | AC-SYNC-001 / T-203 |
| EV-045 | 澄清工单（AC-CLARIFY-001 8 + 002 3 + 003 4 断言）（详情见 EV 文件本体） | AC-CLARIFY-001..003 / T-204 |
| EV-046 | 报价过期与重报（AC-RFQ-004 10 断言）（详情见 EV 文件本体） | AC-RFQ-004 / T-205 |
| EV-047 | 护栏扩展与产能日历（AC-GUARD-002 6 断言 + AC-CAP-001 10 断言，另回归 AC-GUARD-001/003）（详情见 EV 文件本体） | AC-GUARD-002 / AC-CAP-001 / T-206 / T-207 |
| EV-048 | 审计包签名与包含证明（AC-AUDIT-004 12 断言）：包带 HMAC 签名与签名者、`manifest_hash` 绑定清单、包含证明（叶子+证明+根）、错误密钥失败、未提供密钥不静默通过、独立入口 `tools/audit-verify.py` 对未篡改/篡改/无签名/缺文件分别退出 0/1/1/2 | AC-AUDIT-004 / T-208 |
| EV-049 | 人工门队列与超时（AC-APPROVE-003 11 断言）（详情见 EV 文件本体） | AC-APPROVE-003 / T-210 |
| EV-050 | 条款库与冲突标注（AC-TERMS-001 13 断言）（详情见 EV 文件本体） | AC-TERMS-001 / T-211 |
| EV-051 | 变更闭环与生效版本（AC-CHANGE-001 5 + AC-CHANGE-002 8 断言）（详情见 EV 文件本体） | AC-CHANGE-001/002 / T-212 |
| EV-052 | 授标与 PO 闭环（AC-AWARD-001 8 + AC-AWARD-002 7 断言）（详情见 EV 文件本体） | AC-AWARD-001/002 / T-213 |
| EV-053 | 比较表导出（AC-COMPARE-004 13 断言）（详情见 EV 文件本体） | AC-COMPARE-004 / T-214 |
| EV-054 | RFQ 分发记录与截止管理（AC-RFQ-003 10 断言）：分发逐参与者留痕且版本以快照哈希锚定、历史只增、名单问题即拒；截止剩余小时/临近阈值可配/是否已过；提醒按 overdue|due-soon 分流且幂等、绝不自动顺延截止 | AC-RFQ-003 / T-215a |
| EV-055 | 部署手册干净副本实跑（T-215b）：`git archive HEAD` → 裸解释器 `verify.sh smoke` / `verify.sh docs` / `python3 tools/g1-walkthrough.py` 的原始输出；并含 `verify.sh g1` 聚合门（全量 57 条 AC + 14 条 MVP 判据）的结论 | T-215b / S1.14 |
| EV-056 | 宿主强制不变量 H1/H2/H3/H5/H6（`verify.sh invariants` 22/22）（详情见 EV 文件本体） | T-219 / 评审 C §7.1 |
| EV-060 | 模型 Jev 一手来源核验（Cloudflare/Vercel 原文节选） | T-223 | P2 |
| EV-069 | governor 接进 UI HTTP 路径（接线完成，映射未断言） | T-234 | P2 |
| EV-068 | 运行期审计钩子中间件（决策留痕，不写账本） | T-233 | P2 |
| EV-067 | 运行期中间件 governor（准入/背压/超时/有界重试） | T-232 | P2 |
| EV-066 | canary 接到真实桥调用（调用面分流 + 失败隔离） | T-231 | P2 |
| EV-065 | canary 接线到真实入口（投影插件化 + 失败隔离 + 端到端） | T-230 | P2 |
| EV-064 | canary 分流与自动回滚（方向性纪律的机检） | T-229 | P2 |
| EV-063 | 自进化产出插件（提案→影子→fixture 门→晋升→回滚） | T-227 | P2 |
| EV-062 | A1 builtin 断言双向 + 模块声明对齐 | T-228 | P2 |
| EV-061 | 插件化（清单门/自动发现/clean-copy 门）+ timeline 中间件 | T-225/T-226 | P2 |
| EV-059 | WebUI 插件 + 工作区路由接入（双方视角） | T-222 | P2 |
| EV-057 | 演化门骨架（`verify.sh evolution` 15/15 含负控）（详情见 EV 文件本体） | T-220 / 评审 C §7.1 第 7 条 |
| EV-058 | 进树模块 manifest + fixture A1..A6（`verify.sh modules` 36/36，含负控）：inject 白名单/零残留/config 负控/事件声明/确定性/无跨模块 import；含"inject 写内建 mixin 会永 pending"的实测发现；并复核 `g1` 门 | T-221 / 评审 C §7.1 第 5 条 |
| EV-150 | AI agent 决策建议层（`advice-panel`，确定性规则、`engine=rules`）：围栏门 30/30（含 4 处单点变异全部变红 + 防假变异自检 + 产品树字节还原）+ 真 HTTP 端到端 14/14（两个真进程：有数据的一件 + 空投影的一件）；空投影必须 `degraded+reason` 且建议数 0、两视角建议确实不同、私域哨兵 0 次、十道门全绿（详情见 EV 文件本体） | AC-ADV-001 | P2 |
| EV-151 | 门维护：storage 门对**无关写入者**解耦（第 8 条收窄为"本用例自身触及目标"的白名单 + 新增第 19 条全局层断言；并发写入者下 19/19 仍绿，旧门同一写入者下必红（A/B 实测）；负控创建白名单目标 → 17/19 必红；变异 1..4 全 ok）+ `p0-no-node` **失败可诊断**（输出落 `tmp/p0-no-node.<mktemp>/`、失败原样回显、连续两次红才算真红；瞬时分支实测首红次绿）。p0-no-node 瞬时红的真因量出来了：文档门 `md_files()` 扫 `tmp/**`（267 个 .md 里 166 个在 tmp/）与整树副本门 TOCTOU，16 次里 2 次 `FileNotFoundError`；文档门本轮未改，残留记为 D-071（详情见 EV 文件本体） | storage / p0-no-node / D-071 | P2 |
