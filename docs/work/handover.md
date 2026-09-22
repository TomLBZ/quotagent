# 交接

<!-- budget: 1024 bytes, hard -->
## 现在在哪

P2 收尾（EV-178 / T-328）：① `host/lib` **剩 2 个**实体入 `code/`（裸 `cordis` 改模块内显式解析，**不拷**）
② `host/modules` **剩 16 个**实体入各自 `code/` ⇒ 该目录 **41 个全是薄重导** ③ `tools/**` 再搬 **17** 项
（基线→**13**）④ 补承载 **24**（19 Python `code/__init__.py` + 5 ESM）⇒ **53/63**。
门新增 **PA8**：宿主层非薄入口 == `27 §10` 例外集合（**空表**）。

## 下一步唯一动作

续搬余 **13** 项 `tools/**`（含两个 HEAD 门）；给 8 个多实体插件
（admin/agent-runtime/canary/eval/kernel-bridge/mail/webui/compare）定入口 —— **不许代做决定**。
规则见映射表 §规则。

## 不变量

内核不可自改·账本唯一写者·账本行永不销毁·commit 面不进桥·私域不出 realm·V 只能人签·**门名是接口**。
`run-clone`/`clean-copy` 校验 HEAD ⇒ 提交后跑。待人手：T-224 Jev key；G0/G1 签署。
