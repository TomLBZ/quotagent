# 交接

<!-- budget: 1024 bytes, hard -->

## 现在在哪

P2 中，①–④见 EV-160…167（T-288/313/314/315/316）。⑤ **本批**（EV-169/T-318，只动文档）：**逐插件需求文档补齐到 63/63**（52 份新写 + 6 份改名，见映射表 §4），缺口 **52 → 0**（§5 复算）；位置口径定案 27 §2.4：**不建裸目录**（`depsClosure` 把「目录存在」当「插件存在」）⇒ 后续 `git mv` 进 `requirements/README.md`；六道门在本批提交树上全绿。

## 下一步唯一动作

`plans/plugin-migration-plan.md` §2 续做**阶段 2**（services → `code/`，逐个搬 + 跑 AC）；建目录时同步 `plugin-lifecycle` 的 A13/A14，并 `git mv` 需求文档进 `requirements/README.md`。

## 不变量与阻塞

内核不可自改 · 账本唯一写者 · 账本行永不销毁 · commit 面不进桥 · 私域不出 realm · V 只能人签 · **门名是接口**。
待人手：T-224 的 Jev key；G0/G1 签署。无技术阻塞。
