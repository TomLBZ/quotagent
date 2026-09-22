# 交接

<!-- budget: 1024 bytes, hard -->

## 现在在哪

P2 收尾（`EV-180`/`T-330`）：① 修 `g1` 的**索引执行位**真缺陷（`tools/audit-verify.py`：HEAD 里非 `100755` 且
无 shebang）② 解 15/14/进度清单/handover 的预算压力 ⇒ 各搬进 `*-archive*.md` ③ `tools/**` 非薄入口再搬 2
⇒ **1**。逐条细节见 `handover-archive.md` §1；上一批（`EV-179`）见 §2；更早见 §3。

## 下一步唯一动作

给仍需**设计决定**的 7 个多实体插件定入口（`webui` 最急，为什么见 `handover-archive.md` §1 ⑤）。**不许代做**：
理由逐条在各插件 `requirements/README.md`。余 1 个非薄入口（`manual-check.py`）按需再定。

## 不变量

内核不可自改·账本唯一写者·账本行永不销毁·commit 面不进桥·私域不出 realm·V 只能人签·**门名是接口**。
`run-clone`/`clean-copy` 校验 HEAD ⇒ 提交后跑。待人手：T-224、G0/G1 签署。
