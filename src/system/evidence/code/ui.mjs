/**
 * `system/evidence` 的 **GUI 贡献** —— 审计证据包：**导出**与**逐项验证**搬进 APP（DEF-029）。
 *
 * 修的是哪一条：证据面在 APP 内只有"计数与类型分布"，导出/验证两个动作**没有界面入口**，
 * 终端也只有 `tools/audit-verify.py`（校验**已存在**的包）—— 没有面向用户的导出入口。
 * 现在：本视图上的「审计证据包」面板能
 *   · 看**本侧账本**的导出留痕（`evidence/pack-exported`：谁在何时导了哪一段、包哈希与 Merkle 根）；
 *   · **导出一份包**（范围 = 行号区间，带署名）→ 既有唯一写者
 *     `src/system/evidence/tools/evidence-pack-export.py`：只读账本切片 → 落 0600 包文件 → 账本留痕一条；
 *   · **逐项验证一个包**（本侧导出的、或别人给的路径）→ `evidence-pack-verify.py`：逐项 pass/fail 表，
 *     失败指出**第几条**与失败类型；每个包还有自己的对象页（`/app/<view>/evidence-pack/<包 id>/`，可分享）。
 *
 * 纪律：本文件**不写账本、不落包文件**（只 spawn 唯一写者/只读取证）；验证是**只读**的；
 * 不新造事件类型（留痕用既有的 `evidence/pack-exported`）。
 */
export const plugin_id = 'system/evidence'

const asText = (value) => (typeof value === 'string' ? value.trim() : '')
const bodyOf = (row) => (row && typeof row.body === 'object' && row.body !== null ? row.body : {})
const PACK_DIR = 'evidence-packs'

/** 本侧账本里的导出留痕（一个包一条；同一 package_id 取最后一次写入）。 */
const exportsOf = (rows) => {
  const order = []
  const map = new Map()
  for (const row of rows) {
    if (String(row?.type ?? '') !== 'evidence/pack-exported') continue
    const body = bodyOf(row)
    const id = asText(body.package_id) || `(无 id·seq ${row.seq})`
    if (!map.has(id)) order.push(id)
    map.set(id, { package_id: id, scope: asText(body.scope), count: Number(body.count ?? 0),
      pack_hash: asText(body.pack_hash), merkle_root: asText(body.merkle_root),
      signed_by: body.signed_by ?? null, from_seq: body.from_seq ?? null, to_seq: body.to_seq ?? null,
      actor: asText(row.actor), at: String(row.ts ?? '') })
  }
  return order.map((id) => map.get(id))
}

/** 事件类型分布（只数行，不出正文——聚合不得成为侧信道）。 */
const typesOf = (rows) => {
  const counts = new Map()
  for (const row of rows) {
    const type = String(row?.type ?? '(unknown)')
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
}

export async function register(surface, host) {
  const me = plugin_id
  const out = []
  const exportTool = 'src/system/evidence/tools/evidence-pack-export.py'
  const verifyTool = 'src/system/evidence/tools/evidence-pack-verify.py'
  const packDir = () => host.sharedFile(PACK_DIR)
  const ledgerFor = (view) => asText(view === 'supplier' ? host.config?.ledger_supplier : host.config?.ledger_contractor)

  // ------------------------------------------------------------------ 面板：证据面 + 已导出的包
  const surfacePanel = (view, order) => surface.panel({
    plugin_id: me, id: view === 'supplier' ? 'evidence.surface.supplier' : 'evidence.surface',
    title: '审计证据包（导出 / 验证一个包）', view, order, kind: 'table',
    actions: ['evidence.export', 'evidence.verify'],
    data: () => {
      const rows = host.rows(view)
      const packs = exportsOf(rows)
      const types = typesOf(rows)
      return { ok: true, kind: 'table',
        columns: [
          { key: 'package_id', label: '包', type: 'code' },
          { key: 'range', label: '范围（行号）', type: 'code' },
          { key: 'count', label: '事件条数', filter: 'number' },
          { key: 'scope', label: '范围名（scope）', type: 'code', filter: 'enum' },
          { key: 'actor', label: '谁导出的（人签）', type: 'code' },
          { key: 'at', label: '导出时刻（账本 ts）', filter: 'date' },
          { key: 'pack_hash', label: '包哈希', type: 'code' },
          { key: 'merkle_root', label: 'Merkle 根', type: 'code' },
          { key: 'digest_short', label: '短指纹（对账用）', type: 'code' },
        ],
        rows: packs.map((pack) => ({ id: pack.package_id, ...pack,
          range: `${pack.from_seq ?? '—'} … ${pack.to_seq ?? '—'}`,
          digest_short: String(pack.pack_hash).slice(7, 19) })),
        row_actions: ['evidence.verify'],
        counts: { packs: packs.length, events: rows.length, types: types.length },
        degraded: packs.length === 0,
        reason: packs.length === 0
          ? `这一侧还没有导出过证据包（机器码 no-exported-pack）—— 账本里有 ${rows.length} 行、`
            + `${types.length} 种事件，随时可以导一份`
          : '',
        next_action: packs.length === 0
          ? '用「导出证据包」选一个行号范围（默认全量）导出：会落一个 0600 的包文件，并在账本留一条'
            + ' `evidence/pack-exported`；导完点行内「验证这一个包」逐项看结果'
          : '点行内「验证这一个包」看逐项 pass/fail；要给别人一份就把包文件（或这个包的对象页深链）发出去',
        note: `事实时刻按账本最大 ts；导出的包不覆盖留痕那一行（包的切片以导出时给的 to_seq 为准，`
          + `0 = 导出到当时的最后一行）。包文件落 ${packDir()}（0600）。`
          + `本侧账本事件类型前 5 名：${types.slice(0, 5).map(([t, n]) => `${t}×${n}`).join('、') || '（没有行）'}` }
    } })

  /** 对象页：**一个包**的验证结果（逐项 pass/fail + 包自述）—— 深链可分享。 */
  out.push(surface.panel({
    plugin_id: me, id: 'evidence.pack', title: '证据包（逐项验证）', view: 'contractor', order: 60,
    kind: 'table', object_kind: 'evidence-pack', actions: ['evidence.verify'], when: (ctx) => Boolean(ctx?.route?.id),
    data: (ctx) => {
      const packId = asText(ctx?.route?.id)
      const rows = host.rows(ctx?.view ?? 'contractor')
      const known = exportsOf(rows).find((pack) => pack.package_id === packId) ?? null
      const verdict = host.runPython(verifyTool, [`${packDir()}/${packId}.json`], { read: true })
      const said = verdict.json ?? {}
      const checks = Array.isArray(said.checks) ? said.checks : []
      if (!verdict.ok || !said.ok) {
        const refusals = { 'pack-missing': '本侧导出目录里没有这个包文件', 'pack-not-json': '包文件不是合法 JSON' }
        const code = said.code ?? (verdict.ok ? 'verify-failed' : 'verify-tool-failed')
        return { ok: true, kind: 'table', degraded: true, reason: said.first_failure || code,
          next_action: said.next_action ?? (refusals[code] ?? '重新导出一份（包文件可能已被删/被改）'),
          object: {
            title: `证据包 ${packId}`, found: code !== 'pack-missing',
            subtitle: code === 'pack-missing' ? '本侧导出目录里找不到这个包文件'
              : `验证没通过（${said.first_failure || code}）`,
            facts: [{ key: 'code', value: code },
              { key: '原因', value: said.reason || said.first_failure || '看 checks 里 ok=false 的那几条' },
              { key: '包文件', value: `${packDir()}/${packId}.json` }],
            reason: code, next_action: said.next_action
              ?? (refusals[code] ?? '重新导出一份（包文件可能已被删/被改）') },
          columns: [{ key: 'name', label: '检查项' }, { key: 'ok', label: '通过？' }, { key: 'detail', label: '说明' }],
          rows: checks.map((check) => ({ id: check.name, name: check.name,
            ok: check.ok ? '✅ 通过' : '❌ 未通过', detail: check.detail || '' })),
          counts: { checks: checks.length, failed: checks.filter((c) => !c.ok).length } }
      }
      return { ok: true, kind: 'table', object: {
        title: `证据包 ${packId}`, found: true,
        subtitle: `${said.pack?.count ?? 0} 条事件 · ${said.pack?.from_seq ?? '—'} … ${said.pack?.to_seq ?? '—'} · `
          + `scope=${said.pack?.scope ?? '—'}`,
        facts: [
          { key: '结论', value: said.ok ? '全部检查通过（可交给第三方独立复算）' : '有不通过项' },
          { key: 'Merkle 根', value: String(said.pack?.merkle_root ?? '') },
          { key: '包哈希', value: String(said.pack?.pack_hash ?? '') },
          { key: '生成时刻', value: String(said.pack?.generated_at ?? '') },
          { key: '签名', value: said.pack?.signed_by ? `${said.pack.signed_by}（${said.pack.signature_algo}）`
            : '未签名（未提供密钥时不把"有签名"当"签名通过"）' },
          { key: '账本留痕', value: known ? `${known.actor} @${known.at}` : '本侧账本里没有这个包的留痕' },
        ] },
        columns: [{ key: 'name', label: '检查项' }, { key: 'ok', label: '通过？' }, { key: 'detail', label: '说明' }],
        rows: checks.map((check) => ({ id: check.name, name: check.name,
          ok: check.ok ? '✅ 通过' : '❌ 未通过', detail: check.detail || '' })),
        counts: { checks: checks.length, failed: checks.filter((c) => !c.ok).length },
        note: '验证只读：不看导出方状态、不碰账本；别人给你的包只要放在本侧导出目录（或把路径填进'
          + '「验证一个包」）就能逐项复算 —— 这就是"独立验证不需信任导出方"的样子。' }
    } }))

  out.push(surface.view({ plugin_id: me, id: 'evidence.workspace', title: '审计证据', order: 9,
    view: 'contractor', hint: '导出证据包 / 验证一个包（哈希链 + Merkle + 签名逐项给结论）' }))
  out.push(surfacePanel('contractor', 9))
  out.push(surfacePanel('supplier', 9))

  // ------------------------------------------------------------------ 动作
  out.push(surface.action({ plugin_id: me, id: 'evidence.export', title: '导出证据包（人签，账本留痕）',
    views: ['contractor', 'supplier'], group: '证据', order: 5, permission: 'human-signature',
    confirm: { required: true, message: '导出一份审计证据包：确认以你的署名导出？'
      + '（只读账本切片 → 落一个 0600 包文件 → 账本留一条留痕）' },
    hint: '落 `evidence/pack-exported`（既有事件）+ 一个 0600 包文件；写者 = '
      + '`src/system/evidence/tools/evidence-pack-export.py`；冻结的账本不得导出对外证据',
    input: { fields: [
      { name: 'from_seq', label: '起始行号（from_seq）', type: 'number', required: true, min: 1, default: 1 },
      { name: 'to_seq', label: '结束行号（to_seq；0 = 到当时最后一行）', type: 'number', required: false, min: 0 },
      { name: 'scope', label: '范围名（scope，可读即可）', type: 'text',
        help: '缺省 ledger:<本侧 realm>；例：ledger:contractor:g1 / pkg-g1-2026-09' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true,
        help: 'human:<你的名字> —— 服务端要求它等于会话身份' },
      { name: 'note', label: '说明（进待办件，不上账本正文）', type: 'textarea', required: false },
    ] },
    server: async (ctx, input) => {
      const asked = String(ctx.view ?? 'contractor')
      const mine = asText(ctx?.identity?.side)
      if (mine !== '' && mine !== asked) {
        return { ok: false, code: 'cross-side-action',
          reason: `你的会话是 ${mine} 侧，却在 ${asked} 侧导出：侧只认会话（导的是哪本账由会话决定）`,
          next_action: `在 ${mine} 侧自己的「审计证据包」面板里导出` }
      }
      const view = mine === '' ? asked : mine
      const staged = host.stage('evidence-pack-export', { action: 'export', view,
        from_seq: Number(input.from_seq ?? 1), to_seq: Number(input.to_seq ?? 0),
        scope: asText(input.scope), actor: asText(input.signature), note: String(input.note ?? '') })
      if (!staged.ok) return staged
      const run = host.runPython(exportTool, ['--request', staged.path, '--inbox', `${host.sharedDir}/evidence-pack-export`,
        '--ui-shared', host.sharedDir, '--ledger-contractor', ledgerFor(view), '--view', view,
        '--out-dir', packDir(), '--now', host.now()])
      const json = run.json ?? {}
      const refusal = json.refusal ?? null
      const ok = Boolean(run.ok && json.ok === true)
      const added = Number(json.ledger_added ?? 0)
      return { ok, code: refusal?.code ?? (ok ? 'exported' : (json.code ?? 'writer-failed')),
        reason: refusal?.reason ?? (ok ? '' : (run.reason ?? '')),
        next_action: refusal?.next_action ?? json.next_action_runtime
          ?? (ok ? `包 ${json.package_id} 已落（${json.count} 条事件，本动作账本 +${added} 行留痕）：`
              + '在面板行内点「验证这一个包」逐项看 pass/fail'
            : '看 result.stdout 定位后重提（本动作零落盘、账本零新增）'),
        result: {
          pending: staged.file, pending_file: staged.name, view,
          package_id: json.package_id ?? '', pack_file: json.pack_file ?? '',
          count: json.count ?? 0, from_seq: json.from_seq ?? null, to_seq: json.to_seq ?? null,
          pack_hash: json.pack_hash ?? '', merkle_root: json.merkle_root ?? '',
          event: json.event ?? '', ledger_added: added, self_check: json.self_check ?? null,
          applied: json.applied ?? [], stdout: run.stdout ? run.stdout.slice(-400) : '' } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'evidence.verify', title: '验证一个包（只读，逐项给结论）',
    views: ['contractor', 'supplier'], group: '证据', order: 6, permission: 'none', inline: true,
    confirm: { required: false },
    hint: '只读：不看导出方状态、不碰账本；未提供密钥时不把"有签名"当"签名通过"（run 既有语义）',
    input: { fields: [
      { name: 'package_id', label: '包 id', type: 'text', required: true,
        help: '从面板行内点「验证」会自动带上（ep-…）；也可以填本侧导出目录里的文件名（不含 .json）' },
    ] },
    server: async (ctx, input) => {
      const packId = asText(input.package_id)
      if (packId === '') {
        return { ok: false, code: 'package-id-missing', reason: '没给包 id',
          next_action: '在「审计证据包」面板的行内点「验证这一个包」（包 id 会自动带上）' }
      }
      const run = host.runPython(verifyTool, [`${packDir()}/${packId}.json`], { read: true })
      const json = run.json ?? {}
      const checks = Array.isArray(json.checks) ? json.checks : []
      const failed = checks.filter((check) => !check.ok)
      const ok = Boolean(run.ok && json.ok === true)
      return { ok, code: json.code ?? (ok ? 'verified' : 'verify-failed'),
        reason: ok ? '' : (json.reason ?? json.first_failure ?? run.reason ?? ''),
        next_action: json.next_action ?? (ok
          ? '全部检查通过：这份包可以交给第三方（他们只需包文件与（可选）密钥）'
          : '逐项看 result.checks 里 ok=false 的那几条（失败会指出是哪个检查、第几条对不上）'),
        result: { package_id: packId, pack_file: `${packDir()}/${packId}.json`,
          checks: checks.map((check) => ({ name: check.name, ok: check.ok === true, detail: check.detail ?? '' })),
          failed: failed.map((check) => check.name), first_failure: json.first_failure ?? '',
          pack: json.pack ?? null, inclusion: json.inclusion ?? null, ledger_added: 0 } }
    } }))

  out.push(surface.statusItem({ plugin_id: me, id: 'status.evidence', title: '证据包', order: 9, read: () => {
    const packs = exportsOf(host.rows('contractor')).length + exportsOf(host.rows('supplier')).length
    return { text: `已导出 ${packs} 个包（两侧合计）`,
      level: 'ok',
      next_action: packs ? '在「审计证据包」面板里验证 / 再导一份' : '还没有导出过：面板里「导出证据包」' } } }))

  return out
}
