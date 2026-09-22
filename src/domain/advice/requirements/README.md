# domain/advice 需求（**本插件自己的** FR/AC 行 + 每条的可执行验收命令）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1（需求归属硬规则）；归属真源 = 覆盖矩阵 `docs/design/15-requirements-coverage.md`。
本文件**只引用 ID，不复制正文**（一处一事实）；FR/AC 的定义仍在 `docs/work/functional-requirements.md` 与 `docs/work/acceptance-criteria.md`。

## 归属行（本插件承载的需求）

| ID | 一句话（本插件承担的部分） | 可执行验收命令 |
|---|---|---|
| FR-ADV-001 | 决策建议层：把"下一步"变成可复制、可溯源的建议；没有可分的数据就不给建议（不编） | `tools/verify.sh advice` |
| FR-USREQ-012 | 用户诉求：把 agent 的建议变成**能立刻执行**的动作（不是一段说明文字） | `tools/verify.sh advice` |
| AC-ADV-001 | 建议条数有界、每条有非空 `basis`、空投影 `degraded+reason` 且 0 条 | `tools/verify.sh advice` |
| AC-PLUGIN-005 | 六动词生命周期在本插件上真跑（装载/重载新 uid/卸载可重复/未知与非法层拒绝） | `tools/verify.sh plugin-lifecycle` |
| AC-PLUGIN-006 | 本插件向 WebUI 注册面提交的只读区块在页面上真出现，且 webui 源文件 0 次出现本插件 id/标题 | `tools/verify.sh plugin-lifecycle` |

## 本插件不承载（避免范围蔓延）

| 事项 | 归属 |
|---|---|
| 建议页/建议 JSON 的路由与页面装配 | `system/webui`（`FR-UX-*`/`FR-UXWEB-*`） |
| 载荷的口径与私域过滤 | `system/projection`（`FR-RFQ-008`/`FR-RFQ-009`） |
| 人工门与签署 | `system/approval`（批准只能由 `human:*` 签；本插件不能批准） |
| 需求归属合法性判据 A7 | 待建（`T-312` 子项，见 28 §2.6） |
