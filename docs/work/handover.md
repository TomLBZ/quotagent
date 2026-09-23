# 交接

<!-- budget: 1024 bytes, hard -->

## 现在在哪

P2 · **WebUI 口径纠正 + 转做真 GUI**（`D-086`）：WebUI 是**完整 GUI 应用**（真源
`docs/design/29-webui-gui-app.md` + `AGENTS.md` 规则 11/12）。P36（本批）实测：套件 `s1..s4` 全绿，
逐门 58/59（红 `clean-copy`/`evolve-module`/`p0-no-node`，**全部既有红**，归因见
`docs/work/evidence/EV-192`）；`tmp/` 4.4 G → 183 M。细节见归档 §0 / §1。

## 下一步唯一动作

按 `EV-192` 归因表修两条「旧 UI 形态」AC 注册断言（`checks_adv.py:114`、`checks_gate.py:372`；等价判据已在
路由门与 `t281`/`t283`）—— 它们是 `p0-no-node`/`clean-copy` 红的唯一根因；沙盘 seed 的写者闸门另开一轮。

## 不变量

内核不可自改·账本唯一写者·账本行永不销毁·commit 面不进桥·私域不出 realm·V 只能人签·**门名是接口**。
`run-clone`/`clean-copy` 校验 HEAD ⇒ 提交后跑。待人手：T-224、G0/G1 签署。
