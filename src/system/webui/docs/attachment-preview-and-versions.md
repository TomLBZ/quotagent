# 附件：**界内预览**与**多版本**（不下载也能看；旧版不覆盖、仍可下载）

口径真源：`docs/design/29-webui-gui-app.md` §10（对象级附件 / 导出）与 §3（注册面）。
插件真源：`src/system/attachments/code/{attachments.mjs,index.mjs,ui.mjs}`。
本页只讲**怎么用、边界在哪、怎么复跑**；机制总览见 `files-and-exports.md`。
<!-- 预算：16 KB（硬上限；超了先删冗余，不加长度）。复跑：python3 tmp/p24-verify.py（截图 tmp/p24-shots/）、
     node tmp/p24-store-smoke.mjs（存储层 19 条）、node tmp/p24-feed-smoke.mjs（活动流 21 条）。 -->

## 1. 在界面上怎么用

1. **传**：对象页（RFQ 包 / 报价 / 变更 / PO）的「附件」面板，拖文件进去或点「选择文件」；
   先选「这个文件给谁看」：**交付件**（对方是当事方就能看/下）或**本侧内部件**（对方永远看不到）。
2. **看**（不下载）：同一个对象页的「**附件：预览与版本**」面板
   - **图片** → 浏览器直接渲染（`<img>`，同源相对路径）；
   - **PDF** → 浏览器**自带**阅读器（`<iframe>`，不引外部 PDF.js / CDN）；
   - **文本**（txt / csv / md / json / xml / yaml）→ 按 UTF-8 解码后以**转义纯文本**显示（不解析、不执行）；
   - 其余类型（Office / 压缩包 / 图纸 / 邮件）**如实说"不预览"**并给下载入口（`preview-type-not-allowed`）。
3. **换一版**：**同一个对象上再传一次同名文件 = 新版本**（v1、v2…）。旧版**不覆盖**：
   面板里的版本表逐条给出 版本号 / 上传人 / 时刻 / 大小 / sha256 / 给谁看 / **下载这一版**（旧版也能下）。
   同一份字节再传 ⇒ 判为**同一条**附件（回执 `attachment-unchanged`，不新建版本、不写 journal）。
4. **删**：只能删自己上传的；删除**留痕**（墓碑 + `trash/` 原件 + `journal.jsonl`），旧版本一样可以删。

## 2. 判据（都可机读、可复跑）

| 面 | 判据 | 落点 |
|---|---|---|
| 预览分流 | 只做 image / pdf / text（`PREVIEW_TYPES`）；其余 ⇒ **415 + `preview-type-not-allowed`** + 人话原因 + 下载地址 | `attachments.mjs#previewKindOf` / `preview()` |
| 预览响应 | `Content-Disposition: inline` + `X-Content-Type-Options: nosniff` + `Content-Security-Policy: default-src 'none'`；文本一律 `text/plain; charset=utf-8` | `index.mjs` 的 `/api/attachments/preview` |
| 预览上限 | 文本预览 ≤ `max_preview_text_bytes`（默认 256 KiB），超限**只给前一段**并如实标 `truncated`（不假装是全文）；一屏最多内联 4 个（`max_preview_render`），余下**如实计数** | 同上 + `ui.mjs` 面板 |
| 版本链 | 同一 `(对象类, 对象 id, 文件名归一键)` = 一条链；每条版本各有 id / sha256 / 上传人 / 时刻；`supersedes`/`superseded_by`/`is_latest` | `attachments.mjs#chainsOf` / `versions()` |
| 内容寻址 | 正文按 `blobs/<sha256>.bin` 存（同一份字节只存一份 **0600**）；文件名只进索引、不进路径 | `attachments.mjs#put` |
| 不进账本 | 上传 / 预览 / 版本 / 删除的 `ledger_added` 恒 `0`（正文与索引都在 `<ui_shared>/attachments/`，索引 **0600**、目录 **0700**） | 同左 + `/api/attachments/store` |
| 身份与侧 | 预览与下载**同一套**：会话身份 + 交付件当事方；未登录 **401**、跨侧 **403**（本侧内部件永不出本侧） | `attachments.mjs#canSee` |
| 只读路径围栏 | `versions` / `preview` / `list` / `file` 收到 `POST` ⇒ **405 + `Allow: GET`** | `index.mjs` 的 `ROUTES` |

**HTTP 入口**（都在 `/api/attachments/` 下，`GET` 起）：
`preview?id=<att-id>` · `versions?kind=<对象类>&id=<对象 id>` · `list?kind=&id=` · `file?id=`（下载唯一入口）·
`store`（自述：上限 / 预览与版本口径 / 为什么不是账本）。

**界面贡献**（插件用注册面声明的，外壳不认识"附件"这个概念）：
面板 `attach.files-<视图>-<对象类>`（形状 `files`：拖拽上传 + 文件表）与
`attach.review-<视图>-<对象类>`（形状 `html`：版本表 + 预览；本批新增）。
`html` 面板的内容**由插件自己生成并逐处转义**（外壳不洗 HTML）：0 脚本、0 内联事件属性、0 外网地址。

## 3. 复跑（真跑，含截图）

```bash
python3 tmp/p24-verify.py      # ①–⑤ 共 62 条断言：预览分流 / 多版本 / 活动流 / 导出 / 负控（截图 tmp/p24-shots/）
node tmp/p24-store-smoke.mjs   # 存储层 19 条：版本链 / 内容寻址 / 预览分流 / 越侧与未登录负控
python3 tmp/p6-verify.py       # 既有附件与导出面（本批不改它的口径，复跑防回归）
```

截图（`tmp/p24-shots/`）：`p24-01-versions-table.png`（同名两版 · 旧版仍可下）·
`p24-02-previews-image-pdf-text.png`（图片 / PDF / 文本 + "不预览"说明）·
`p24-09-docx-preview-refused-415.png`（非允许类型的**有名拒绝**）。

## 4. 边界（如实登记，不假装）

| 事项 | 现状 | 为什么 |
|---|---|---|
| PDF 在这台**无头浏览器**里显示空白 | 路由侧 200 + `application/pdf` + 逐字节一致（`tmp/p24-verify.py` ①.4 真跑）；渲染交给**浏览器自带阅读器**，无头 Chromium 常不带 ⇒ 面板里写着"看不到就下载" | 预览**不引外部 PDF.js/CDN**：渲染器有没有是浏览器的事，面板不假装加载中 |
| Office / 压缩包 / 图纸不预览 | 415 + 人话原因 + 下载入口 | 需要第三方解析器（引外网）或把不可信二进制交给浏览器渲染 |
| 正文级全文检索 | 不做 | 正文不进账本、也不进提示词；检索只按文件名/sha256/可见性等**索引字段**筛 |
| 附件进账本 / 进证据包 | **永不** | 见 `files-and-exports.md` §4 与 §10.2 的理由 |
| 同一文件名多版占**每对象 32 个**名额 | 有界，超限**有名拒绝**（`attachment-limit-reached`）并提示先清旧版 | 上限是界面的诚实读数，不静默放宽 |
