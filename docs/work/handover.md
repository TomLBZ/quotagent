# 交接

<!-- budget: 1024 bytes, hard -->
## 现在在哪

P2。本批（EV-172 / T-321）把「每个插件自带测试与需求」推到**实体标准布局**：① **收紧** `depsClosure`/`scan`
（目录里没有**合法** `plugin.json` ⇒ 不算插件；见 EV-172 §一）② **58 份需求文档** `git mv` 进
`src/<层>/<插件>/requirements/README.md`+54 个插件补最小 `plugin.json` ③ **10 个围栅门**搬进各自 `tests/`
（旧处薄转发，rc/输出逐项对拍一致）。

## 下一步唯一动作

`plans/plugin-migration-plan.md` §2 续做**阶段 2**（services → `code/`）；阶段 4.2 剩 **10 个围栅门**
（`t260/t267/t268/t271/t275/t277/t279/t281/t282/t283`）；§分类 **64 项**`待搬`照旧。

## 不变量

内核不可自改 · 账本唯一写者 · 账本行永不销毁 · commit 面不进桥 · 私域不出 realm · V 只能人签 ·
**门名是接口**。`run-clone` 校验 HEAD ⇒ 须在 commit 后跑。待人手：T-224 Jev key；G0/G1 签署。
