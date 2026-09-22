# 交接

<!-- budget: 1024 bytes, hard -->
## 现在在哪

P2。本批（EV-176 / T-326）：① `tools/**` 非薄入口 **12 项**进各自 `tests/`（旧处薄转发）
② **13 个** `host/modules/*.mjs` 实体进 `code/`（blob 守恒 13/13；旧处经 `host/lib/entity-*` **薄重导**，
导入面逐名一致；**先改读方再搬 10 处**）③ **7 个**「清单先行」插件补**真实承载**（`code/index.mjs` 薄包装 +
真实服务键），余 47 个 README 如实标 `code:`。`plugin-assets` 已搬 **96**、非薄入口 **42**。

## 下一步唯一动作

续搬**余下 42 项 `tools/**`**（登记 + `git mv` + 薄转发）与 `host/modules/**` 余下实体、`host/lib/**`
（先改读方再搬）；规则见映射表 §规则。

## 不变量

内核不可自改·账本唯一写者·账本行永不销毁·commit 面不进桥·私域不出 realm·V 只能人签·**门名是接口**。
`run-clone`/`clean-copy` 校验 HEAD ⇒ 提交后跑。待人手：T-224 Jev key；G0/G1 签署。
