# 交接

<!-- budget: 1024 bytes, hard -->

## 现在在哪

P2 进行中。本工作树两批：
① T-288 真写闭环：`quote-prepare` + 门 `quote-draft`/`rfq-visibility`（EV-160/EV-161）；
② 本批（只改文档）："一切皆插件"硬规范 = `docs/design/27`（分类/目录/清单/生命周期/cordis 边界）+ `28`（需求归属 + 一键运行契约）+ ADR-0020/0021 + `docs/work/plans/` 的迁移计划（6 阶段）、逐文件映射（259 行）、事实源落点；证据 EV-162。

## 下一步唯一动作

跑 `docs/work/plans/plugin-migration-plan.md` §2 的**阶段 0**（建 `src/{system,domain,userspace}` 骨架 + `plugin.json` + `tools/plugin.sh list`）。未完成行见 `progress-checklist.md`。

## 不变量与阻塞

内核不可自改 · 账本唯一写者 · 账本行永不销毁 · commit 面不进桥 · 私域不出 realm · V 只能人签 · **门名是接口**。
待人手：T-224 把 Jev key 放进 `/workspace/config.yaml`；G0/G1 签署。无技术阻塞。
