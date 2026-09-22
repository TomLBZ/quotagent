/**
 * `system/attachments` 的 **GUI 贡献**（`docs/design/29-webui-gui-app.md` §3 的注册面：视图/面板/交互/
 * 动作与命令/通知与状态）—— 对象级附件在界面上的那一半。
 *
 * 注册的东西（**全部是声明**；外壳按形状渲染，不认识"附件"这个业务概念）：
 *   · 面板 `attach.files-<view>-<kind>`（形状 `files`，`object_kind` = package / quote / po / change）：
 *     对象页上的**附件区** —— 拖拽上传（多文件）+ 文件列表（文件名/大小/上传人/时间/sha256）+
 *     每行的下载链接 + 每行的删除入口（`row_actions: ['attach.delete']`，与可编辑表格同一套行内动作机制）。
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
import { attachmentStore, ALLOWED_TYPES, OBJECT_POLICY, VISIBILITIES } from './attachments.mjs'

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
const humanBytes = (value) => {
  const bytes = Number(value) || 0
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
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
  const uploadUrl = `${prefix}/api/attachments/upload`
  const listUrl = `${prefix}/api/attachments/list`
  const deleteRoute = `${prefix}/api/attachments/delete`

  // ---------------------------------------------------------------- 动作：删除（留痕）
  out.push(surface.action({
    plugin_id: me, id: 'attach.delete', title: '删除这个附件（留痕）', views: ['contractor', 'supplier'],
    group: '附件', order: 62, icon: 'trash', context_menu: true,
    hint: '只能删**自己上传**的附件；删除**留痕**：索引留墓碑、原件进 trash/、journal.jsonl 记一行（不是静默清除）',
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
        hint: '文件名/大小/上传人/时间/sha256 都可核；正文**不进账本**（只落 0600 存储）',
        data: (ctx) => {
          const id = asText(ctx.route?.id)
          const side = ctx.identity?.side ?? ''
          if (id === '') {
            return { ok: true, kind: 'files', degraded: true, reason: 'object-address-incomplete',
              files: [], upload: null, object: { kind, id: '' },
              next_action: `附件挂在**对象**上：打开 ${prefix}/app/${view}/${kind}/<id>/ 再传` }
          }
          const seen = store.visibleObjects(side)
          const visible = side !== '' && store.objectVisible(side, kind, id)
          const listed = side === ''
            ? { ok: false, files: [], counts: { total: 0, live: 0, deleted: 0, mine: 0 } }
            : store.list({ side, kind, id })
          const files = (listed.files ?? []).map((row) => ({ ...row, url: fileUrl(row.id),
            bytes_label: humanBytes(row.bytes), sha256_short: String(row.sha256 ?? '').slice(0, 19),
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
            counts: { ...(listed.counts ?? {}), visible_ids: (seen.ids[kind] ?? new Set()).size },
            degraded: reason !== '',
            reason,
            visibility_rule: '下载与删除都要**会话身份**（未登录 401）；跨侧只在「交付件 + 对方是该对象当事方」'
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
        { key: '对象类', value: Object.values(info.object_policy)
          .map((policy) => `${policy.label}（上传方 ${policy.upload_sides.join('/')}）`).join(' · ') },
        { key: '为什么不是账本', value: info.why_not_ledger },
        { key: '跨侧规则', value: info.visibility_rule },
      ],
      note: '这一块是**只读读数**：它证明附件本体没进账本（ledger_added=0）、正文与索引都在 0600 存储里',
      next_action: '要传文件：打开一个对象页（RFQ 包/报价/变更/PO），在「附件」面板里拖文件进来' }
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
}
