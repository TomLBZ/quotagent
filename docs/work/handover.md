# 交接（每轮次更新，≤ 1024 B）

<!-- budget: 1024 bytes, hard -->

## 现在在哪

**P2 进行中**：自进化流水线已实装并**产出 9 件插件**（其中 4 件由 subagents 生产），全部接线并可见
（业务双方 `/contractor/`、`/supplier/` + 运维 `/ops/`）。需求覆盖矩阵与 `verify.sh coverage` 已建立，
插件 ↔ FR/AC 双向可核对。本批 **T-252**：FR-EVIDENCE-004 留存与销毁 —— 判定器入库、21 条机检。

## 下一步唯一动作

**T-253 留存执行侧**（真正删除派生副本 + 读侧封存 + 落 `evidence/retention-*`）——
落地后 `AC-AUDIT-003` 才可标绿。其余缺口 FR（邮件集成/谈判轮次/FAQ 沉淀）见覆盖矩阵 §3。

## 不变量

内核不可自改 · 账本唯一写者 · **账本行永不销毁** · commit 面不进桥 · 私域不出 realm · V 结论只能人签。

## 阻塞

无技术阻塞。待人手：**T-224 需把 Jev key 放进 `/workspace/config.yaml`**；V 项结论与 G0/G1 签署。
