# 交接

<!-- budget: 1024 bytes, hard -->

## 现在在哪

P2 进行中。本批消掉两个迁移阻塞（EV-164）：① 门缺陷 **D-073 根因**（`AC-AGENTRT-002` 哨兵扫描改「**契约源集合**」口径 + 反向断言 ⇒ 有 `tmp/` 整树副本也不再红）② **文档预算**（AC 主文件 32645→26355 B、进度清单 31843→25339 B；最老的行**整行**搬入 `acceptance-criteria-archive-b.md` / `progress-checklist-archive.md`，门的 **T 定义集合先扩到归档**再搬）。

## 下一步唯一动作

跑 `docs/work/plans/plugin-migration-plan.md` §2 的**阶段 0**（建 `src/{system,domain,userspace}` 骨架 + `plugin.json` + `tools/plugin.sh list`）。未完成行见 `progress-checklist.md`。

## 不变量与阻塞

内核不可自改 · 账本唯一写者 · 账本行永不销毁 · commit 面不进桥 · 私域不出 realm · V 只能人签 · **门名是接口**。
待人手：T-224 把 Jev key 放进 `/workspace/config.yaml`；G0/G1 签署。无技术阻塞。
