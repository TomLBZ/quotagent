# 交接

<!-- budget: 1024 bytes, hard -->

## 现在在哪

**P2 进行中**。FR/AC 定义 = 主文件 + 同目录 `*-archive.md`（门的定义集合；P0 行留主文件）。
本批 EV-157：AC 集合化批次 B（16 条最老非 P0 行入归档；主文件 32616→28622 B）
+ `rfq-deadline` 插件（回文时限口径 = 事实 ts 差、不取墙钟、**发不出信**）与门 `verify.sh rfq-deadline`。
十二道门全绿。

## 下一步唯一动作

`progress-checklist.md` 未完成行；缺口 FR 见 `docs/design/15-requirements-coverage.md` §3。

## 不变量与阻塞

内核不可自改 · 账本唯一写者 · **账本行永不销毁** · commit 面不进桥 · 私域不出 realm · V 只能人签。
待人手：**T-224 需把 Jev key 放进 `/workspace/config.yaml`**；G0/G1 签署。无技术阻塞。
细节：`.agents/state.json`、`docs/work/evidence/`、`docs/work/roadmap.md`。
