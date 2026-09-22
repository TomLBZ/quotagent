# 交接

<!-- budget: 1024 bytes, hard -->
## 现在在哪

P2，①–④见 EV-160…167，迁移 4.1 见 EV-170；**本批**（EV-171/T-320）一键跑落成**只含已提交内容**的
干净副本验收——新门 `run-clone` 真跑正路 + 两条**反向对照** + 4 处单点变异；
**实测真缺陷并修复**：`tools/*.sh` 索引里是 `100644`（`core.filemode=false`）⇒ 干净克隆 `./run up` 报
`host-deps-install-failed`；依赖失败改为可诊断（`log`+`log_tail`）；README 快速开始补全。

## 下一步唯一动作

`plans/plugin-migration-plan.md` §2 续做**阶段 2**（services → `code/`，逐个搬 + 跑 AC；建目录同步
`plugin-lifecycle` A13/A14）；§分类 **64 项**`待搬`照旧。

## 不变量

内核不可自改 · 账本唯一写者 · 账本行永不销毁 · commit 面不进桥 · 私域不出 realm · V 只能人签 ·
**门名是接口**。`run-clone` 校验 HEAD ⇒ 须在 commit 后跑。待人手：T-224 Jev key；G0/G1 签署。
