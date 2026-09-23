# system/attachments 需求（**本插件自己的**范围 + 每条的可执行验收命令）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`。
本文件**只引用 ID，不复制正文**（一处一事实）。

## 用途（一句话）

对象级附件与文件交换：RFQ 包 / 报价 / 变更 / PO 上都能传与看文件（拖拽 + 多文件），文件名/大小/上传人/
时间/sha256 可核、可下载、可删除（删除留痕）；正文**不进账本**，按侧与身份校验下载。

## 归属行（本插件承载的需求）

| ID | 一句话（本插件承担的部分） | 可执行验收命令 |
|---|---|---|
| FR-UXWEB-001 | 双方**仅通过 GUI** 就能完成全部业务流程：本条承载"传文件"这一硬需求（技术规格、质检报告、回签的 PO） | `python3 tmp/p6-verify.py`（P6 批次验证；真起服务 + 真 cookie 会话 + sha256 对账） |
| FR-USREQ-001 | 每一步都能在 APP 内闭环（含写操作）：附件上传/下载/删除都在界面里点得到，不经终端 | `python3 tmp/p6-verify.py` |
| FR-USREQ-011 | 可导出/可打印的可读格式（PO / RFQ 包 / 比价表），导出内容与账面逐行一致 | `python3 tmp/p6-verify.py`（导出与账本逐行比对） |

## 对外契约（provides / 依赖）

| 面 | 内容 |
|---|---|
| provides | `attachments`（`code/attachments.mjs` 的存储与权限面：`put/get/list/remove/visibleObjects/describe`） |
| 依赖 | `uiRoutes`（路由注册面，由 `system/webui` 提供；本插件**不改** `webui.mjs` 的静态路由表）；`code/identity.mjs` 的 `whoOf` 用来解析会话身份（只读，不重抄 cookie/会话解析） |
| 写面 | `plugin.json.permissions = {ledger: "none", writes: ["own-dir"], network: "loopback-only"}`：只写自己的目录 `<ui_shared>/attachments/`（目录 0700 / 文件 0600 / 原子写 / 内容寻址）；**账本零新增**（`ledger_added: 0`，插件不写账本 ⇒ `ledger: none`） |
| 门 | 本批**不新建门**（AGENTS.md 规则 12）；验证脚本在 `tmp/p6-verify.py`，证据与截图落 `tmp/p6-shots/` |

## 本插件不承载

| 事项 | 归属 |
|---|---|
| 账本（唯一事实写路径） | `system/kernel`（附件正文不进账本：`docs/design/25-storage-plugins.md` §3） |
| 业务对象的事实（RFQ 包/报价/PO/变更的字段） | `domain/{rfq,quote-prepare,compare,commitments}` |
| 导出**内容**的生成 | 各领域插件自己的动作（`report` 贡献只声明"能以哪几种格式导出"，内容由声明者生成） |
| 人员名册 / 协作痕迹 | `system/webui` 的机制贡献（`people.mjs` / `collab.mjs`） |
