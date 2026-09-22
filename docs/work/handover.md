# 交接

<!-- budget: 1024 bytes, hard -->
## 现在在哪

P2。本批（EV-173 / T-322）：① `host/*-gate.mjs` 剩 10 个全搬完（**20/20**）② **21 个** `qa/checks_*.py`
搬进各自 `src/<层>/<插件>/tests/` ③ **阶段 5 第一小片**：内核实体进 `src/system/kernel/code/`，旧路径留
**薄重导**（导入面照旧）。`plugin-assets` 已搬 **49**、非薄入口仍 **64**。

## 下一步唯一动作

`plans/plugin-migration-plan.md` §2 续做**阶段 4.2 余下 64 项 `tools/**`**（登记 §分类 + `git mv` +
旧处留薄转发）；随后阶段 5 续搬 `services/**`。

## 不变量

内核不可自改 · 账本唯一写者 · 账本行永不销毁 · commit 面不进桥 · 私域不出 realm · V 只能人签 ·
**门名是接口**。`run-clone` 校验 HEAD ⇒ commit 后跑。已知红：`storage` 门 **18/19**（第 8 条，事实区
判据对 `user-space` 符号链接失效，**搬前即红**，EV-173 §四）。待人手：T-224 Jev key；G0/G1 签署。
