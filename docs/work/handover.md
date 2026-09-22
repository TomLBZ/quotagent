# 交接

<!-- budget: 1024 bytes, hard -->

## 现在在哪

P2 中，①–④见 EV-160…167。并发批次 EV-169/T-318（只动文档）：逐插件需求文档补齐 63/63，缺口 52→0。**本批**（EV-170/T-319）：8 项散落的检查资产搬进各自插件 `tests/`（旧位置只剩薄转发；门名与 `tools/verify.sh` 一行未改，逐项对拍一致）+ 4 个插件骨架 + 新门 `plugin-assets` 14/14；`tools/**` 非薄入口 69→63；分类表 143 行在 `plugin-file-map.md` §分类。

## 下一步唯一动作

`plans/plugin-migration-plan.md` §2 续做**阶段 2**（services → `code/`，逐个搬 + 跑 AC）；建目录同步 `plugin-lifecycle` 的 A13/A14；§分类 的 129 项`待搬`按同一套继续搬。

## 不变量与阻塞

内核不可自改 · 账本唯一写者 · 账本行永不销毁 · commit 面不进桥 · 私域不出 realm · V 只能人签 · **门名是接口**。
待人手：T-224 的 Jev key；G0/G1 签署。无技术阻塞。
