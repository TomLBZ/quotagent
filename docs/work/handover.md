# 交接

<!-- budget: 1024 bytes, hard -->

## 现在在哪

**P2 进行中**：10 件进树 domain 插件（AI 决策建议层 `advice-panel` 30/30；本批新增
**审批等多久 / 变更单谁卡着** `gate-timeline` 32/32 + 真路由 11/11）。
本轮收口两条 human problem（`ux-双方痛点与交互需求.md.txt` P-02/03、P-14）：**等待时长口径 = 事实 ts 之差
（不取墙钟）**、卡点用队列真审批人、超时策略三种后果、变更单带 basis；
插件**不能批准**，催办只落 0600 待办件、由 `tools/gate-nudge.py` 落 `gate/nudged`（EV-153）。九道门全绿。

## 下一步唯一动作

`progress-checklist.md` 未完成行；缺口 FR 见 `docs/design/15-requirements-coverage.md` §3。

## 不变量与阻塞

内核不可自改 · 账本唯一写者 · **账本行永不销毁** · commit 面不进桥 · 私域不出 realm · V 只能人签。
待人手：**T-224 需把 Jev key 放进 `/workspace/config.yaml`**；G0/G1 签署。无技术阻塞。
