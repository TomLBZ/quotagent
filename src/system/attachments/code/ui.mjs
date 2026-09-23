/**
 * `system/attachments` 的 **GUI 贡献**（`docs/design/29-webui-gui-app.md` §3 的注册面：视图/面板/交互/
 * 动作与命令/通知与状态）—— 对象级附件在界面上的那一半。
 *
 * 注册的东西（**全部是声明**；外壳按形状渲染，不认识"附件"这个业务概念）：
 *   · 面板 `attach.files-<view>-<kind>`（形状 `files`，`object_kind` = package / quote / po / change）：
 *     对象页上的**附件区** —— 拖拽上传（多文件）+ 文件列表（文件名/大小/上传人/时间/sha256）+
 *     每行的下载链接 + 每行的删除入口（`row_actions: ['attach.delete']`，与可编辑表格同一套行内动作机制）。
 *   · 面板 `attach.review-<view>-<kind>`（形状 `html`，同 `object_kind`）：**版本与预览** ——
 *     同一对象上同名文件的**版本链**（v1、v2…：谁在何时换了哪一版、每条都能下、旧版不覆盖）+
 *     **界内预览**（图片 `<img>` / PDF `<iframe>` / 文本转义进 `<pre>`：同源、不引外网依赖）+
 *     如实列出"界内不预览"的那些类型（Office/压缩包/图纸 ⇒ 下载来看）。
 *   · 动作 `attach.delete`（服务端一半在**外壳内**跑：`ctx.identity` 给侧与署名 ⇒ 只能删自己上传的；
 *     删除**留痕**：索引墓碑 + `trash/` 原件 + `journal.jsonl` 一行）。
 *   · 状态栏项 `status.attachments`：本侧附件读数 + 存储权限 + 上限（一眼能核）。
 *   · 通知源 `notify.attachments`：**本侧可见的附件被删除**时给一条带深链的通知（删除留痕的可见面）。
 *
 * 面板给的形状（客户端只按形状渲染）：
 *   `{kind:'files', object:{kind,id}, files:[…], upload:{url,kind,id,name_param,visibility_param,
 *     visibility:{default,options}, multiple, max_bytes, accept, help}, row_actions:['attach.delete'],
 *     counts:{…}, visibility_rule, reason?, next_action?, object_header}`。
 *
 * 纪律：本文件不 import `node:fs`、不起子进程、不写账本、不取墙钟、不发信；一切落盘/校验都在
 * `attachments.mjs`（同一份存储实例，见它的 `attachmentStore`）与 `code/index.mjs` 的路由面里。
 */
import { attachmentStore, ALLOWED_TYPES, OBJECT_POLICY, VISIBILITIES, PREVIEW_KINDS,
  previewKindOf, previewRefusalReason, LIMITS } from './attachments.mjs'

export const plugin_id = 'system/attachments'

/** 哪几个视图里有哪种对象类的附件区（**本插件的声明**：对象类由插件声明，外壳不认识任何 kind）。 */
export const KINDS_BY_VIEW = {
  contractor: ['package', 'quote', 'po', 'change'],
  supplier: ['package', 'quote', 'po'],
}

/** 可见性选项（给人看的说明：交付件 vs 本侧内部件）。 */
export const VISIBILITY_OPTIONS = [
  { value: 'both', label: '交付件（对方能看到并下载）',
    help: '对方必须是这个对象的当事方；RFQ 包/报价/回签 PO 这类交换件用这一档' },
  { value: 'side', label: '本侧内部件（对方永远看不到）',
    help: '内部核算依据、内部意见：连同侧其它人之外的人一律拿不到（下载按侧与身份校验）' },
]

const asText = (value) => (typeof value === 'string' ? value.trim() : '')
const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 「行」的最小形状 + 行数组读数（附件表的行数组：坏行逐条计数、好行照列 —— 一条坏行不打崩整页）。 */
const isRow = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const readRows = (value) => {
  const list = Array.isArray(value) ? value : []
  const rows = list.filter((row) => isRow(row))
  return { list: Array.isArray(value), rows, dropped: list.length - rows.length }
}
const humanBytes = (value) => {
  const bytes = Number(value) || 0
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}
/**
 * **版本 + 预览**面板的 HTML 渲染（纯函数：给数据、回 HTML，不读盘、不取墙钟）。
 *
 * 为什么是一块**独立面板**（`kind: 'html'`）而不是改文件表：外壳的文件表渲染器按"六列"渲染，
 * 它**不认识**版本与预览这两个概念（机制不该被业务改写）；插件把自己那一半（版本链 / 界内预览）
 * 用**声明**的方式摆出来 —— 这才是"注册面"的用法（`docs/design/29-webui-gui-app.md` §3）。
 *
 * 纪律（逐条都在这段里可核）：① 全部文本都过 `esc`（面板 HTML 是**插件自己生成**的，外壳不洗）；
 * ② 不带 `<script` / 内联事件属性 / `javascript:`；③ 预览一律**同源相对路径**（不引 CDN / 外网字体）；
 * ④ 渲染数量有界（版本链 ≤ 12 组、内联预览 ≤ `render_max`、文本预览 ≤ 2 份）并**如实说还剩多少**；
 * ⑤ 一类只做图片 / PDF / 文本 —— 其余的**逐个列出来如实说"不预览"**（不静默）。
 */
export function renderReviewPanel({ prefix = '', side = '', kind = '', id = '', groups = [], previews = [],
  skipped = [], limits = {}, identity = null, reason = '', nextAction = '', policy = null } = {}) {
  const fileUrl = (attId) => `${prefix}/api/attachments/file?id=${encodeURIComponent(attId)}`
  const previewUrl = (attId) => `${prefix}/api/attachments/preview?id=${encodeURIComponent(attId)}`
  const visLabel = (value) => (value === 'both' ? '交付件（对方可见）' : '本侧内部件')
  const rows = []
  let versioned = 0
  for (const group of groups.slice(0, 12)) {
    if (group.version_count > 1) versioned += 1
    group.versions.forEach((version, at) => {
      const latest = version.is_latest === true || version.latest === true
      rows.push(`<tr data-att-version="${esc(version.id)}" data-version="${esc(String(version.version))}"`
        + `${version.deleted ? ' class="q-file-deleted"' : ''}>`
        + `<td>${at === 0 ? `<b>${esc(group.name)}</b>` : `<span class="q-hint">↳ ${esc(group.name)}</span>`}</td>`
        + `<td><code>v${esc(String(version.version))}</code>${latest ? ' <b>最新</b>' : ''}`
        + `${version.deleted ? '（已删·留痕）' : (latest ? '' : '（已被更高版本取代）')}</td>`
        + `<td><code>${esc(version.uploader)}</code></td>`
        + `<td>${esc(version.at ?? version.uploaded_at ?? '')}</td>`
        + `<td>${esc(humanBytes(version.bytes))}</td>`
        + `<td><code title="${esc(version.sha256)}">${esc(String(version.sha256 ?? '').slice(0, 19))}…</code></td>`
        + `<td>${esc(visLabel(version.visibility))}</td>`
        + `<td>${version.deleted
          ? '已删除（墓碑 + trash/ 留痕）'
          : `<a class="q-deeplink" href="${esc(fileUrl(version.id))}" download="${esc(version.name)}"`
            + ` data-file-download="1" title="下载这一版（带 sha256 校验头）">下载 v${esc(String(version.version))}</a>`}`
        + `${version.previewable && !version.deleted
          ? ` · <a class="q-deeplink" href="${esc(previewUrl(version.id))}" data-att-preview-link="1"`
            + ` title="界内预览（不下载）">预览</a>` : ''}</td></tr>`)
    })
  }
  const versionBlock = groups.length
    ? `<h4>版本（同一对象上同名文件每传一次就是一版；旧版不覆盖、仍可逐条下载）</h4>`
      + `<div class="q-scroll"><table class="q-table q-files-table" data-att-versions="1">`
      + `<caption class="q-caption">${groups.length} 个文件名 · ${rows.length} 条版本`
      + `${versioned ? ` · ${versioned} 个文件名有多版` : '（还没有同名多版）'}</caption>`
      + `<thead><tr><th>文件名</th><th>版本</th><th>上传人</th><th>时间</th><th>大小</th><th>sha256</th>`
      + `<th>给谁看</th><th>操作</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
      + `${groups.length > 12 ? `<p class="q-hint">还有 ${groups.length - 12} 个文件名没摆在这里（有界渲染）——`
        + '用上面「附件」面板的筛选/搜索，或直接下载</p>' : ''}`
    : ''

  const previewBlocks = []
  for (const item of previews) {
    const caption = `${esc(item.name)}（v${esc(String(item.version))} · ${esc(item.uploader)} · `
      + `${esc(humanBytes(item.bytes))}${item.latest ? ' · 最新' : ''}）`
    if (item.kind === 'image') {
      previewBlocks.push(`<figure class="q-att-prev" data-att-preview="${esc(item.id)}" data-preview-kind="image">`
        + `<figcaption>${caption}</figcaption>`
        + `<img src="${esc(previewUrl(item.id))}" alt="${esc(`附件预览：${item.name}`)}" loading="lazy">`
        + `<figcaption class="q-hint">图片由浏览器直接渲染（同源，不引外网）：`
        + `<a class="q-deeplink" href="${esc(fileUrl(item.id))}" download="${esc(item.name)}">下载原图</a>`
        + ` · <a class="q-deeplink" href="${esc(previewUrl(item.id))}" data-att-preview-link="1">单独打开预览</a>`
        + '</figcaption></figure>')
      continue
    }
    if (item.kind === 'pdf') {
      previewBlocks.push(`<figure class="q-att-prev" data-att-preview="${esc(item.id)}" data-preview-kind="pdf">`
        + `<figcaption>${caption}</figcaption>`
        + `<iframe class="q-att-pdf" src="${esc(previewUrl(item.id))}" title="${esc(`PDF 预览：${item.name}`)}"`
        + ` width="100%" height="480" loading="lazy"></iframe>`
        + `<figcaption class="q-hint">PDF 走浏览器自带阅读器（同源；不引外部 PDF.js/CDN）。看不到时说明这台浏览器禁用了内建 PDF 查看器`
        + `——<a class="q-deeplink" href="${esc(fileUrl(item.id))}" download="${esc(item.name)}">下载来看</a>（如实说，不假装加载中）`
        + '</figcaption></figure>')
      continue
    }
    previewBlocks.push(`<figure class="q-att-prev" data-att-preview="${esc(item.id)}" data-preview-kind="text">`
      + `<figcaption>${caption}</figcaption>`
      + `<pre class="q-att-text" data-att-text="${esc(item.id)}">${esc(item.text ?? '')}</pre>`
      + `<figcaption class="q-hint">${item.truncated
        ? `只显示了前 ${esc(humanBytes(item.previewed_bytes))}（全文 ${esc(humanBytes(item.total_bytes))}）——`
          + '没有假装是全文：'
        : '按 UTF-8 解码后以纯文本显示（不解析、不执行）：'}`
      + `<a class="q-deeplink" href="${esc(fileUrl(item.id))}" download="${esc(item.name)}">下载全文</a>`
      + '</figcaption></figure>')
  }
  const notPreviewable = skipped.length
    ? `<p class="q-hint" data-att-not-previewable="${skipped.length}">界内不预览（如实说明，不假装加载中）：`
      + skipped.slice(0, 8).map((item) => `<code>${esc(item.name)}</code>（${esc(previewRefusalReason(item.name))}）`)
        .join('、')
      + `${skipped.length > 8 ? ` … 共 ${skipped.length} 个` : ''}——这一类要下载来看`
      + '（预览只做图片 / PDF / 文本：其余类型没有浏览器自带渲染器）</p>'
    : ''
  const previewBlock = `<h4>预览（不下载也能看：图片 / PDF / 文本）</h4>`
    + (previewBlocks.length ? previewBlocks.join('') : `<p class="q-hint" data-att-no-preview="1">`
      + '这个对象上现在没有可内联预览的件（图片 / PDF / 文本）——传一张图、一份 PDF 或一份 txt 就能在这里看</p>')
    + notPreviewable

  const head = `<p class="q-hint" data-att-review="${esc(`${kind}/${id}`)}">`
    + `本对象（${esc(policy?.label ?? kind)} ${esc(id)}）· 身份 <code>${esc(identity?.side ?? '（未登录）')}</code>`
    + `${identity?.human ? ` / <code>${esc(identity.human)}</code>` : ''}`
    + ' · 版本与预览都是读：不写账本（ledger_added 恒 0），正文仍在 0600 存储里</p>'
  const rule = `<p class="q-hint">口径：同一对象上同名文件 = 一条版本链（v1、v2…），每条版本有自己的`
    + ` id / sha256 / 上传人 / 时刻，旧版不覆盖、仍可下载；预览只做图片 / PDF / 文本，`
    + `身份与侧判据与下载同一套（未登录 401 / 跨侧 403），不引任何外网依赖。</p>`
  const degraded = reason
    ? `<p class="q-hint" data-att-review-reason="${esc(reason)}">这一块读不完整：${esc(reason)}`
      + `${nextAction ? `｜下一步：${esc(nextAction)}` : ''}</p>`
    : ''
  return [head, degraded, versionBlock, previewBlock, rule].filter((part) => part !== '').join('\n')
}

export async function register(surface, host) {
  const me = plugin_id
  const out = []
  const prefix = asText(host.prefix)
  const store = attachmentStore({ root: host.root, sharedDir: host.sharedDir,
    ledgerContractor: asText(host.config?.ledger_contractor), ledgerSupplier: asText(host.config?.ledger_supplier),
    delivery: asText(host.config?.rfq_delivery) })
  const limits = store.currentLimits()
  const accept = Object.keys(ALLOWED_TYPES).sort().map((ext) => `.${ext}`).join(',')
  const fileUrl = (id) => `${prefix}/api/attachments/file?id=${encodeURIComponent(id)}`
  const previewUrl = (id) => `${prefix}/api/attachments/preview?id=${encodeURIComponent(id)}`
  const uploadUrl = `${prefix}/api/attachments/upload`
  const listUrl = `${prefix}/api/attachments/list`
  const deleteRoute = `${prefix}/api/attachments/delete`

  // ---------------------------------------------------------------- 动作：删除（留痕）
  out.push(surface.action({
    plugin_id: me, id: 'attach.delete', title: '删除这个附件（留痕）', views: ['contractor', 'supplier'],
    group: '附件', order: 62, icon: 'trash', context_menu: true,
    hint: '只能删自己上传的附件；删除留痕：索引留墓碑、原件进 trash/、journal.jsonl 记一行（不是静默清除）',
    confirm: { required: true,
      message: '删除后这条附件从双方视野里消失（不可撤销）；痕迹（墓碑 + trash/ 原件 + 日志一行）会保留。确认删除？' },
    input: { fields: [
      { name: 'id', label: '附件 id', type: 'text', required: true, pattern: '^att-[0-9a-f]{12}$',
        help: '附件面板里那一行末尾的 id（形如 att-1a2b3c4d5e6f）' },
      { name: 'reason', label: '删除理由（可写）', type: 'text', max: 120,
        help: '写进 journal.jsonl，便于事后对账' },
    ] },
    server: (ctx, input) => {
      const who = ctx.identity
      if (!who) {
        return { ok: false, code: 'identity-required', reason: '删除附件需要会话身份',
          next_action: `先在 ${prefix}/identity/ 登录（侧与署名都取会话）` }
      }
      const verdict = store.remove({ side: who.side, actor: who.human, id: asText(input.id),
        reason: asText(input.reason) })
      if (!verdict.ok) return verdict
      return { ok: true, code: 'attachment-deleted', result: { attachment: verdict.entry,
        trace: verdict.trace, moved_to_trash: verdict.moved }, note: verdict.note,
        next_action: `附件面板已刷新：那条现在只留墓碑（${verdict.entry.deleted_by} @ `
          + `${verdict.entry.deleted_at}）` }
    },
  }))

  // ---------------------------------------------------------------- 面板：每个 (视图, 对象类) 一块附件区
  for (const [view, kinds] of Object.entries(KINDS_BY_VIEW)) {
    for (const kind of kinds) {
      const policy = OBJECT_POLICY[kind]
      out.push(surface.panel({
        plugin_id: me, id: `attach.files-${view}-${kind}`,
        title: `附件（${policy.label}）：拖进来就能传，双方向可核`,
        view, order: 62, kind: 'files', object_kind: kind, placement: 'main',
        hint: '文件名/大小/上传人/时间/sha256 都可核；正文不进账本（只落 0600 存储）',
        data: (ctx) => {
          const id = asText(ctx.route?.id)
          const side = ctx.identity?.side ?? ''
          if (id === '') {
            return { ok: true, kind: 'files', degraded: true, reason: 'object-address-incomplete',
              files: [], upload: null, object: { kind, id: '' },
              next_action: `附件挂在对象上：打开 ${prefix}/app/${view}/${kind}/<id>/ 再传` }
          }
          const seen = store.visibleObjects(side)
          const visible = side !== '' && store.objectVisible(side, kind, id)
          const listed = side === ''
            ? { ok: false, files: [], counts: { total: 0, live: 0, deleted: 0, mine: 0 } }
            : store.list({ side, kind, id })
          const listedRead = readRows(listed.files)
          const listedRows = listedRead.rows
          const files = listedRows.map((row) => ({ ...row, url: fileUrl(row.id),
            bytes_label: humanBytes(row.bytes), sha256_short: String(row.sha256 ?? '').slice(0, 19),
            // **多版本**与**预览**的界面声明（文件表本身按六列渲染；这两个字段给「预览与版本」面板与脚本用）
            version_label: `v${row.version ?? 1}${row.is_latest ? '（最新）' : ''}`,
            preview_url: row.previewable && !row.deleted ? previewUrl(row.id) : '',
            visibility_label: row.visibility === 'both' ? '交付件（对方可见）' : '本侧内部件' }))
          const upload = visible ? {
            url: uploadUrl, method: 'POST', kind, id,
            name_param: 'name', visibility_param: 'visibility',
            visibility: { default: policy.default_visibility, options: VISIBILITY_OPTIONS },
            multiple: true, max_bytes: limits.max_bytes, accept,
            help: `单个文件 ≤ ${humanBytes(limits.max_bytes)}；类型：${Object.keys(ALLOWED_TYPES).sort().join(' / ')}`,
          } : null
          const reason = side === '' ? 'identity-required' : (visible ? '' : 'object-not-in-your-view')
          return {
            ok: true, kind: 'files', object: { kind, id },
            found: visible, identity: side ? { side, human: ctx.identity.human } : null,
            files, upload, row_actions: ['attach.delete'],
            counts: { ...(listed.counts ?? {}), visible_ids: (seen.ids[kind] ?? new Set()).size,
              unreadable: listedRead.dropped },
            degraded: reason !== '',
            reason,
            visibility_rule: '下载与删除都要会话身份（未登录 401）；跨侧只在「交付件 + 对方是该对象当事方」'
              + '时放行，本侧内部件永不出本侧',
            next_action: reason === 'identity-required'
              ? `先在 ${prefix}/identity/ 登录：附件按侧隔离，未登录看不到任何一侧的件`
              : (visible ? (files.length ? '' : '拖文件到这个方块里，或点「选择文件」（可多选）')
                : `本侧看不到这个 ${policy.label}（${id}）：先让对方投给你，或换一个对象`),
            object_header: visible ? {
              found: true,
              title: `${policy.label} ${id}`,
              subtitle: `${files.filter((row) => !row.deleted).length} 个附件（本侧上传 `
                + `${files.filter((row) => row.mine && !row.deleted).length} 个）—— ${policy.note}`,
              facts: [
                { key: '附件（活的）', value: String(files.filter((row) => !row.deleted).length) },
                { key: '已删除（留痕）', value: String(files.filter((row) => row.deleted).length) },
                { key: '本侧可见的对象', value: `${(seen.ids[kind] ?? new Set()).size} 个${policy.label}` },
              ],
              links: [],
            } : {
              found: false, reason, title: `${policy.label} ${id}`,
              subtitle: '本侧看不到这个对象（附件也因此挂不上、下不了）',
              next_action: `本侧可见的${policy.label}：`
                + `${[...(seen.ids[kind] ?? new Set())].sort().slice(0, 6).join(' / ') || '（没有）'}`,
            },
          }
        },
      }))
    }
  }

  // ------------------------------------------- 面板：**预览与版本**（不下载也能看；旧版仍可下）
  // 为什么单开一块（而不是塞进文件表）：文件表按六列渲染、不认识"版本/预览"；这里是插件**自己的那一半**，
  // 用 `kind:'html'` 声明（外壳只注入插件生成的 HTML，不解读内容 —— 注册面的用法，见 `ui-surface.mjs` 头）。
  for (const [view, kinds] of Object.entries(KINDS_BY_VIEW)) {
    for (const kind of kinds) {
      const policy = OBJECT_POLICY[kind]
      out.push(surface.panel({
        plugin_id: me, id: `attach.review-${view}-${kind}`,
        title: `附件：预览与版本（图片/PDF/文本在界内看；同名多版不覆盖）`,
        view, order: 61, kind: 'html', object_kind: kind, placement: 'wide',
        hint: '预览 = 不下载也能看（只做图片/PDF/文本：浏览器自带渲染器，同源、不引外网）；'
          + '版本 = 同一对象上同名文件每传一次就是一版，旧版不覆盖、仍可下载（每条带人/时间/sha256）',
        data: (ctx) => {
          const id = asText(ctx.route?.id)
          const side = ctx.identity?.side ?? ''
          if (id === '') {
            return { ok: true, kind: 'html', degraded: true, reason: 'object-address-incomplete',
              html: renderReviewPanel({ prefix, kind, id: '', reason: 'object-address-incomplete',
                nextAction: `附件挂在对象上：打开 ${prefix}/app/${view}/${kind}/<id>/ 再看版本与预览` }),
              next_action: `打开 ${prefix}/app/${view}/${kind}/<id>/` }
          }
          const visible = side !== '' && store.objectVisible(side, kind, id)
          const groups = visible ? (store.versions({ side, kind, id }).groups ?? []) : []
          // 最新一版、活的、可预览的（旧版照样在版本表里，逐条能下、也能逐条预览）
          const latestPreviewable = groups.map((group) => group.versions.find((version) => !version.deleted))
            .filter((row) => row && row.previewable)
          const skippedFromList = groups.flatMap((group) => group.versions)
            .filter((version) => !version.deleted && !version.previewable).map((row) => ({ name: row.name }))
          const picked = latestPreviewable.slice(0, Math.max(1, limits.max_preview_render))
          const previews = []
          for (const row of picked) {
            const previewKind = previewKindOf(row.name)
            const item = { id: row.id, name: row.name, kind: previewKind, version: row.version,
              uploader: row.uploader, bytes: row.bytes, latest: true, uploaded_at: row.at }
            if (previewKind === 'text') {
              // 文本在**服务端**读一次（有界：16 KiB），转义后进 <pre>；超限如实标注
              const out = store.preview({ side, id: row.id, maxBytes: 16 * 1024 })
              if (!out.ok) { previews.push({ ...item, kind: null, skipped_reason: out.reason }); continue }
              previews.push({ ...item, text: out.text, truncated: out.truncated,
                previewed_bytes: out.previewed_bytes, total_bytes: out.total_bytes })
            } else previews.push(item)
          }
          const renderable = previews.filter((item) => item.kind !== null)
          const skipped = [
            ...skippedFromList,
            ...previews.filter((item) => item.kind === null).map((item) => ({ name: item.name,
              why: item.skipped_reason })),
          ]
          const html = renderReviewPanel({ prefix, side, kind, id,
            groups: groups.map((group) => ({ name: group.name, version_count: group.version_count,
              versions: group.versions.map((version) => ({ ...version, at: version.at ?? version.uploaded_at })) })),
            previews: renderable, skipped, limits,
            identity: side ? { side, human: ctx.identity?.human ?? '' } : null,
            policy, reason: side === '' ? 'identity-required' : (visible ? '' : 'object-not-in-your-view'),
            nextAction: side === ''
              ? `先在 ${prefix}/identity/ 登录：版本与预览按侧隔离，未登录看不到任何一侧的件`
              : (visible ? '' : `本侧看不到这个 ${policy.label}（${id}）：先让对方投给你，或换一个对象`) })
          const extra = latestPreviewable.length > renderable.length
            ? `还有 ${latestPreviewable.length - renderable.length} 个可预览的没内联渲染（界面上限 ${limits.max_preview_render} 个：不把一页撑爆）——` 
              + '在下面「附件」面板里点文件名下载，或在版本表里逐个「预览」'
            : ''
          return { ok: true, kind: 'html', html,
            degraded: side === '' || !visible,
            reason: side === '' ? 'identity-required' : (visible ? null : 'object-not-in-your-view'),
            counts: { groups: groups.length,
              versions: groups.reduce((sum, group) => sum + (group.version_count ?? 0), 0),
              versioned_groups: groups.filter((group) => (group.version_count ?? 0) > 1).length,
              previewable: latestPreviewable.length, previewed: renderable.length,
              not_previewable: skipped.length },
            ledger_added: 0,
            note: `预览与版本都是读：不写账本、不改索引（正文在 ${store.dir} 的 0600 存储里）`
              + `${extra ? `｜${extra}` : ''}`,
            next_action: extra || (skipped.length
              ? '这一类没有浏览器自带渲染器：点文件名下载来看（预览不假装加载中）'
              : (renderable.length ? '要换一版：在「附件」面板里把新文件拖进来（同名 = 新版本，旧版保留）'
                : '传一张图片 / 一份 PDF / 一份 txt 就能在这里不下载直接看')) }
        },
      }))
    }
  }

  // ---------------------------------------------------------------- 状态栏：附件读数（权限/上限一眼可核）
  out.push(surface.statusItem({ plugin_id: me, id: 'status.attachments', title: '附件', order: 62, read: () => {
    const info = store.describe()
    const mode = info.index_mode
    return { text: `附件 ${info.counts.live} 个（已删 ${info.counts.deleted}）· ${info.counts.blob_bytes} B · `
      + `存储 ${mode}${mode === '0600' ? ' ✓' : '（应为 0600）'}`,
      level: mode === '0600' ? 'ok' : 'warn',
      next_action: info.counts.live ? '' : '在对象页的附件面板里拖一个文件试试（PDF/图片/CSV 都行）' }
  } }))

  // ---------------------------------------------------------------- 通知源：**本侧可见的附件被删**（留痕的可见面）
  out.push(surface.notificationSource({ plugin_id: me, id: 'notify.attachments', title: '附件（删除留痕）',
    order: 62,
    poll: (ctx) => {
      const side = ctx.identity?.side ?? ''
      if (side === '') return []
      const items = []
      for (const line of store.journalLines(40)) {
        if (asText(line.event) !== 'deleted') continue
        const kind = asText(line.object?.kind)
        const id = asText(line.object?.id)
        const mine = asText(line.side) === side
        if (!mine && !(kind !== '' && id !== '' && store.objectVisible(side, kind, id))) continue
        items.push({ id: `attach-deleted:${line.id}:${line.at}`, level: mine ? 'warn' : 'info', at: line.at,
          title: `附件被删除：${line.name}（${kind} ${id}）`,
          body: `${line.actor} 删除了 ${line.bytes} B 的附件（sha256 ${String(line.sha256).slice(7, 19)}…）；`
            + `留痕：墓碑 + trash/ 原件 + journal.jsonl`,
          next_action: `打开对象看留下的墓碑：${prefix}/app/${side}/${kind}/${encodeURIComponent(id)}/`,
          ref: kind && id ? { kind, id, title: `${kind} ${id}` } : null })
      }
      return items.slice(0, 8)
    } }))

  // ---------------------------------------------------------------- 视图级提示：附件面自述（给运维/走查看）
  out.push(surface.panel({ plugin_id: me, id: 'attach.store-home', title: '附件存储（文件交换的落点）',
    view: 'home', order: 62, kind: 'kv',
    data: () => {
      const info = store.describe()
      return { ok: true, kind: 'kv', items: [
        { key: '落点', value: info.root, code: true },
        { key: '权限', value: `目录 ${info.dir_mode} · 索引 ${info.index_mode} · 正文按 sha256 命名（内容寻址）` },
        { key: '读数', value: `活的 ${info.counts.live} · 已删（留痕）${info.counts.deleted} · ` +
          `正文份数 ${info.counts.blobs}（${humanBytes(info.counts.blob_bytes)}）· 日志 ${info.journal_lines} 行` },
        { key: '上限', value: `单文件 ≤ ${humanBytes(info.limits.max_bytes)} · 每对象 ≤ ${info.limits.max_per_object} 个 · ` +
          `类型：${info.allowed_types.slice(0, 10).join('/')}…（共 ${info.allowed_types.length} 种）` },
        // **多版本 + 界内预览**（本批）：口径与入口都写在这里（界面/脚本都不必猜）
        { key: '版本（不覆盖历史）', value: `${info.versions.rule}｜同一份字节只存一份正文；`
          + `同名多版的逐条版本读 \`${prefix}/api/attachments/versions?kind=<对象类>&id=<对象 id>\``,
          code: true },
        { key: '预览（不下载也能看）', value: `只做 ${PREVIEW_KINDS.join(' / ')}（${Object.keys(info.preview.types)
          .sort().join(' ')}）：图片与 PDF 交给浏览器自带渲染器，文本按 UTF-8 解码后进纯文本；`
          + `其余类型如实说"不预览"并给下载。不引 CDN / 外网字体 / 第三方解析器` },
        { key: '预览的身份判据', value: info.preview.identity_rule },
        { key: '对象类', value: Object.values(info.object_policy)
          .map((policy) => `${policy.label}（上传方 ${policy.upload_sides.join('/')}）`).join(' · ') },
        { key: '为什么不是账本', value: info.why_not_ledger },
        { key: '跨侧规则', value: info.visibility_rule },
      ],
      note: '这一块是只读读数：它证明附件本体没进账本（ledger_added=0）、正文与索引都在 0600 存储里；'
        + '版本链与预览都只读同一份索引',
      next_action: '要传文件：打开一个对象页（RFQ 包/报价/变更/PO），在「附件」面板里拖文件进来；'
        + '同名文件再传一次就是新版本（旧版保留），图片/PDF/文本可在「附件：预览与版本」里直接看' }
    } }))

  return out
}

/** 纯函数样本（A5 确定性采样用；不读任何文件、不起进程）。 */
export const fixture = {
  sampleVisibilityOptions: () => VISIBILITY_OPTIONS.map((item) => item.value),
  samplePolicy: () => Object.fromEntries(Object.entries(OBJECT_POLICY)
    .map(([kind, policy]) => [kind, policy.upload_sides])),
  sampleEsc: () => esc('<script>x</script>'),
  sampleHumanBytes: () => [humanBytes(0), humanBytes(2048), humanBytes(3 * 1024 * 1024)],
  sampleVisibilities: () => [...VISIBILITIES],
  /** 预览分流（纯函数）：图片/PDF/文本能预览，Office/压缩包/图纸**如实不预览**。 */
  samplePreviewKinds: () => ['shot.png', 'spec.pdf', 'notes.txt', 'data.csv', 'x.docx', 'y.zip', 'z.dwg']
    .map((name) => [name, previewKindOf(name)]),
  /** 版本+预览面板的 HTML（纯函数；用最小样本，用来对"必须转义/不许有脚本"做静态断言）。 */
  sampleReviewHtml: () => renderReviewPanel({ prefix: '/quotagent', kind: 'po', id: 'po-0001',
    identity: { side: 'contractor', human: 'human:wanglei' }, policy: OBJECT_POLICY.po,
    limits: LIMITS,
    groups: [{ name: 'spec.txt', version_count: 2, versions: [
      { id: 'att-000000000001', name: 'spec.txt', version: 2, is_latest: true, uploader: 'human:wanglei',
        at: '2026-09-23T08:00:00Z', bytes: 12, sha256: `sha256:${'a'.repeat(64)}`, visibility: 'both',
        previewable: true, deleted: false },
      { id: 'att-000000000002', name: 'spec.txt', version: 1, is_latest: false, uploader: 'human:limin',
        at: '2026-09-22T08:00:00Z', bytes: 10, sha256: `sha256:${'b'.repeat(64)}`, visibility: 'both',
        previewable: true, deleted: false }] }],
    previews: [{ id: 'att-000000000001', name: 'spec.txt', kind: 'text', version: 2, uploader: 'human:wanglei',
      bytes: 12, latest: true, text: '<script>alert(1)</script>\n第二行', truncated: false,
      previewed_bytes: 12, total_bytes: 12 }],
    skipped: [{ name: 'report.docx' }] }),
}
