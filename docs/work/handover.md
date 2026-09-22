# 交接

<!-- budget: 1024 bytes, hard -->

## 现在在哪

P2 中。三批：① T-288 真写闭环（EV-160/161）；② 硬规范 27/28 + ADR-0020/0021 + 迁移计划（EV-162）；③ **迁移阶段 1**（EV-165/166，T-314/315）：三层骨架 + 样板插件（各层 1 个）+ `tools/plugin.sh` 六动词（真装载；reload 新实例、unload effects 归零）+ 注入式 UI 注册面（区块真出现在页面上，webui 零业务耦合）+ `./run up|down|status|doctor`；新门 `plugin-lifecycle` 43/43、`run-once` 18/18（变异全红）。

## 下一步唯一动作

`docs/work/plans/plugin-migration-plan.md` §2 续做**阶段 2**（`src/quotagent/services/**` 逐个搬进 `code/`，每搬一个跑它的 AC）。未完成行见 `progress-checklist.md`。

## 不变量与阻塞

内核不可自改 · 账本唯一写者 · 账本行永不销毁 · commit 面不进桥 · 私域不出 realm · V 只能人签 · **门名是接口**。
待人手：T-224 的 Jev key；G0/G1 签署。无技术阻塞。
