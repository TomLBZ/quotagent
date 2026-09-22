# 交接

<!-- budget: 1024 bytes, hard -->

## 现在在哪

P2 中。①–③见 EV-160…166（真写闭环 / 规范 27-28+ADR-0021 / 阶段 1 骨架 + 六动词 + 注入式 UI + `./run`）。④ **需求归属落成**（EV-167/T-316）：`docs/work/plugin-requirements-map.md`（63 行，166/166 FR 唯一归属）+ 9 份插件需求文档（6 在 `docs/work/`）+ `14` 先归档再加行（27390 B）+ 新门 `plugin-requirements` 17/17（变异全红）。同树有并发批次在飞 ⇒ `plugin-lifecycle` 43/44。

## 下一步唯一动作

`docs/work/plans/plugin-migration-plan.md` §2 续做**阶段 2**（services → `code/`，逐个搬 + 跑 AC）；建插件目录时同步 `plugin-lifecycle` 的 A13/A14（裸目录被当已知插件，见映射表 §4.2）。

## 不变量与阻塞

内核不可自改 · 账本唯一写者 · 账本行永不销毁 · commit 面不进桥 · 私域不出 realm · V 只能人签 · **门名是接口**。
待人手：T-224 的 Jev key；G0/G1 签署。无技术阻塞。
