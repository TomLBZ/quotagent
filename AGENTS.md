# AGENTS.md — quotagent 的 agent 操作规则

<!-- budget: 4096 bytes, hard. 校验: tools/verify.sh agents-md (P1 起) -->

本仓库面向 agent：人类定约束，agent 做实现与在线自进化。**规则只在本文件**；README 讲怎么用，
`docs/` 讲是什么，`.agents/` 存机器可读状态与技能。不要把规则文本复制到别处——重复即漂移。

## 当前阶段

设计期（无 `src/`）：产出全部为文档。**实现自 P0 mock 起，且先有 FR/AC 再写代码**。
FR 见 `docs/work/functional-requirements.md`，AC 见 `docs/work/acceptance-criteria.md`，
进度见 `docs/work/progress-checklist.md`；接手先读 `docs/work/handover.md`。

## 规则

1. **一切注册可撤销**：新能力以插件/effect 形式注册并返回 disposer；不允许无法卸载的全局状态。
   卸载后不得残留订阅、定时器、外部通知或脏数据。
2. **模型可见 ⟺ 账本可见**：任何进入模型输入的事实必须能从 append-only 账本重建；新增模型可见
   输入必须同时新增账本事件类型。
3. **承诺需人工批准**：对外承诺（提交报价、授标、下单、变更批准、价格让步）必须经 approval 门，
   模型不得自行承诺。
4. **数据主权**：供应商成本模型、承包商标底与内部评分永不出各自 realm；交换只走 QEP 报文。
5. **未验证不断言**：文档中的事实性断言须标来源——代码路径、论文/规范，或标记 `[假设]`（待现场验证）。
6. **每条验收标准要有可执行证据**：命令 + 输出摘要落 `docs/work/evidence/`，AC 才能置为 passed。
7. **一轮一批**：更新 progress 与 handover → commit → push → 读回远端 refs 确认，缺一不可。
8. **协议与账本格式变更必须新增 ADR**（`docs/design/adr/`），不得原地改语义。
9. **文档预算**：文件头声明预算；`AGENTS.md` ≤ 4096 B，`handover.md` ≤ 1024 B，其余见
   `docs/design/12-documentation-standard.md`。超预算先删冗余，不加长度。
10. **不碰内核语义**：自进化只能发生在插件/配置/提示词/策略层；账本与 QEP 版本语义不可自改。
11. **WebUI = 完整 GUI 应用**（不是账本投影、不是只读路由）：插件注册 **UI 元素/交互方式/动作与命令/
    业务逻辑钩子/通知与状态**贡献任意功能；**双方必须仅通过 GUI 完成全部业务流程**（含写操作），允许前端
    框架。真源 `docs/design/29-webui-gui-app.md`；禁止再按旧口径描述它，也禁止新增只冻旧形态的 UI 判据
    （旧 UI 快照/seed/ui-mutate 门按 29 §2 删除）。
12. **业务功能优先**：推进真实业务功能是唯一重要的事；门禁与测试只是安全带 —— 与需求冲突或只冻旧形态的
    测试/门直接删除（存在不等于合理），不得为「门全绿」牺牲功能推进。

## 布局

```
docs/analysis/   对 cordis/harness 的代码级分析、可发扬的设计优势、领域痛点
docs/design/     系统设计：架构、领域模型、交换协议、服务/事件目录、自进化、信任、评测
docs/design/adr/ 架构决策记录（不可原地改语义）
docs/work/       路线图、功能需求、验收标准、进度清单、交接、证据
.agents/state.json   机器可读状态：阶段/下一任务/最后验证/阻塞
.agents/skills/      本仓库的 agent 技能（接手、实现任务、写设计记录）
.agents/sessions/    每轮次记录（一行一轮次）
```

## 交接与恢复

每轮次结束（完成、上下文压缩前、崩溃前最后一次成功动作后）都写 `docs/work/handover.md`：
当前阶段、最后验证命令与结果、**下一步唯一动作**、不变量、阻塞。恢复顺序：
`handover.md` → `.agents/state.json` → `progress-checklist.md` → 动手。

## 提交

`<type>(<scope>): <summary>`，type ∈ {docs, design, feat, fix, test, chore}；一次提交一件事；
提交信息可用中文或英文，但 type/scope 必须是英文标识符。
