# 交接

<!-- budget: 1024 bytes, hard -->

## 现在在哪

P2 · **WebUI = 完整 GUI 应用**（规则 11/12；真源 `29-webui-gui-app.md`）。P46（本批）收尾三处遗留：
① 待办卡请求人改 `?? row.actor`（新门真身份、旧门照账本）② `ApprovalService.__init__` 的 `_counter=0` 根因修好
（不再重号）③ 两支审计尺子进 `src/system/repo-gate/tools/`（29 第 24 节写明何时跑/怎么读/偏差处置）。
细节见归档 §0/§5；门 rc 见 `EV-194`。

## 下一步唯一动作

按 `EV-192` 修两条「旧 UI 形态」AC 注册断言（`checks_adv.py:114`/`checks_gate.py:372`；等价判据已在路由门）
—— 它们是 `p0-no-node`/`clean-copy` 红的唯一根因；沙盘 seed 写者闸门另开一轮。

## 不变量

内核不可自改·账本唯一写者·账本行永不销毁·commit 面不进桥·私域不出 realm·V 只能人签·**门名是接口**。
`run-clone`/`clean-copy` 校验 HEAD ⇒ 提交后跑。待人手：T-224、G0/G1 签署。
