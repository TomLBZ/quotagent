# 交接

<!-- budget: 1024 bytes, hard -->

## 现在在哪

**P2 进行中**。FR 定义 = `functional-requirements.md` + 同目录 `functional-requirements-archive.md`
（门的 FR 定义集合；P0 行与 V 清单留主文件）。本批 EV-155：FR 集合化 + 47 条最老非 P0 行入归档。
九道门全绿。

## 下一步唯一动作

`progress-checklist.md` 未完成行；缺口 FR 见 `docs/design/15-requirements-coverage.md` §3。

## 不变量与阻塞

内核不可自改 · 账本唯一写者 · **账本行永不销毁** · commit 面不进桥 · 私域不出 realm · V 只能人签。
待人手：**T-224 需把 Jev key 放进 `/workspace/config.yaml`**；G0/G1 签署。无技术阻塞。
细节：`.agents/state.json`、`docs/work/evidence/`、`docs/work/roadmap.md`。
