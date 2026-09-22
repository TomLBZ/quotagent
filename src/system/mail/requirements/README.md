# system/mail 需求（**本插件自己的** FR/AC 行 + 每条的可执行验收命令）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`；
逐插件唯一指针（机检 `tools/verify.sh plugin-requirements`）：`docs/work/plugin-requirements-map.md`。
本文件**只引用 ID，不复制正文**（一处一事实）。

> **本文件的位置**：就是 27 §2.1 的**标准位置**（`src/system/mail/requirements/README.md`）—— `T-318` 期间它曾在
> `docs/work/plugin-requirements-system-mail.md`，`T-321` 用 `git mv` 归位（**内容逐字节不变**；逐条 sha256 与归位台账见映射表 §4.2 与
> `docs/work/evidence/EV-172-*`）。
> **当初为什么放 `docs/work/`**（实测，非推测）：那时 `plugin-registry` 的 `depsClosure` 把「目录存在」当
> 「插件存在」，先建裸目录会让 `plugin-lifecycle` 的 A13/A14 变红；`T-321` 已**收紧**该处（27 §2.4）⇒ 现在可以建了。

## 用途（一句话）

邮件域：SMTP 发信 / IMAP 收信（标准库实现，Python 侧唯一写者）+ 宿主侧**只读**运维视图，
**没有凭据不得假装能发**（缺凭据时 `available=false` + 有名 reason + `next_action`）。

## 归属行（本插件承载的需求）

| ID | 一句话（本插件承担的部分） | 可执行验收命令 |
|---|---|---|
| FR-MAIL-001 | 邮件的真收发由插件提供：SMTP/IMAP 参数从配置读（env 优先），未配置如实报未连接 | `tools/verify.sh mail-transport` |
| FR-MAIL-002 | 邮件配置键进白名单（配置 UI 可直接改并持久化）；宿主只读视图（队列计数/最近结果/reason/`next_action`，零写面） | `tools/verify.sh mail-transport` · `config-route` |
| FR-INTEG-003 | 邮件绑定：失败**不得落账为「已发送」** | `tools/verify.sh mail` · `transport` · `pipeline-view` |

## 对外契约（provides / 依赖）

| 面 | 内容 |
|---|---|
| provides | `mailView`（宿主只读视图 `host/modules/mail-view.mjs`）；Python 侧服务面 `mail` / `mail_transport`（`src/quotagent/services/mail*.py`） |
| 依赖 | `system/config`（配置键与凭据指纹只读）、`system/kernel`（发信事实落账本，唯一写者路径）；**不联网的宿主半边**：宿主零网络 |
| 写面 | Python 侧：账本 `mail/*` 事件的唯一写者（`permissions.ledger = sole-writer`）；宿主侧：只读快照（`tools/refresh-ui-snapshots.py` 写快照，宿主不写） |
| 凭据 | 缺失**不阻塞启动**（28 §3.1）；凭据只存指针与指纹，永不回显、不进日志/账本/异常消息 |
| 门 | `tools/verify.sh mail-transport`（27 条，含回环真发收）· `mail`（`AC-MAIL-001` / `AC-MAIL-002`） |

## 本插件不承载

| 事项 | 归属 |
|---|---|
| 澄清公告的广播口径 | `domain/clarify`（`FR-CLARIFY-002`） |
| RFQ 分发与截止提醒的**业务判定** | `domain/rfq`、`domain/rfq-deadline`（本插件只提供通道事实） |
| 通知（页面横幅等非邮件通道） | `system/ui-feedback`（`FR-UIFB-001`）；独立 `system/notification` 仍未成立（`docs/design/27-plugin-architecture.md` §1.4） |
| 上游 `@cordisjs/mail` 的替换 | 判为**不可直接替换**（本仓邮件是账本事实；见 27 §7.2），替换需先写 ADR |
| 需求归属与 FR 映射 | `system/repo-gate`（`docs/work/plugin-requirements-map.md`） |

## 落地状态（`code/`）

<!-- 本行由批 `EV-176` 逐插件如实登记（机检口径见 `docs/work/plans/plugin-file-map.md` §分类）。 -->

- `code:` 部分落地 —— Python 实体 2 个已在 `code/`（`mail.py`、`mail_transport.py`）；宿主 **ESM 入口未接** ⇒ `entry` 仍如实报 `degraded: artifact-missing`。
- **待定（需设计决定，本批不代做 ✗）**：`code/` 里 `mail-view.mjs` 自述 `provides=['mailView']`，
  而 Python 侧 `mail.py`/`mail_transport.py` 是**邮件收发服务本体**（`provides` 占位键现在写的是 `mail`）⇒ **两个面**，
  入口取哪一个（视图 vs 服务本体）属**插件设计**。
