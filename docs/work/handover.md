# 交接

<!-- budget: 1024 bytes, hard -->

## 现在在哪

P2 收尾（`EV-181`/`T-331`）：① 干净副本 3 条红 AC（`AC-AGENTRT-002/006/007`）根因 = 门要的宿主依赖
`host/node_modules`（gitignored）不在 `git archive` 副本里 ⇒ 改走既有 `tools/cordis.sh run`（判据未改）
② 7 个多实体插件的 `entry` 决定并接上（D-078..D-084）⇒ `plugin.sh list` **63/63 valid**；A13/A14 改指
对照根负控 + 真根正控（66 → **68/68**）③ 硬编码仓库根 4 处修掉 + 新门断言 **PA9**。细节见
`handover-archive.md` §1；更早见 §2..§4。

## 下一步唯一动作

`tools/**` 非薄入口余 **1**（`manual-check.py`，0 调用者）按需再定；人手：T-224、G0/G1 签署。

## 不变量

内核不可自改·账本唯一写者·账本行永不销毁·commit 面不进桥·私域不出 realm·V 只能人签·**门名是接口**。
`run-clone`/`clean-copy` 校验 HEAD ⇒ 提交后跑。
