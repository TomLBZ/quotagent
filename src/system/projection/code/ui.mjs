/**
 * `system/projection` 的 **GUI 贡献** —— **投递事实读数**（P33 修的"投影层静默过滤"的显示那一半）。
 *
 * 修的是哪一条：`code/projection.mjs#projectDeliveries` 修前对 `spec.items[]` 里的坏行是一句
 * `filter(isPlainDelivery)` —— 坏行**静默消失**，下游（SSR 页面 / 面板 / 接口）拿到的是一个
 * **已经干净**的数组，于是"这份包有 3 条行项目"与"信封里 5 条、2 条读不出来"在屏幕上长得一模一样
 * （P32 §6.2 登记的 `data-rfq-items-dropped="0"`）。现在投影层**逐条报数**（丢了几条 / 为什么 / 怎么修），
 * 这块面板就是把它**摆到屏幕上**：两侧的界面口径一致（渲染层不自己重算、不自己编文案）。
 *
 * 纪律：
 *   · 本文件**只读**（不写账本、不落文件、不 spawn 任何东西）—— 它读的是**已有的只读出口**：
 *     本视角账本行（拿 realm）、投递信封（`host.readJson`，与 `domain/change`/`domain/quote-prepare`
 *     读同一份配置项 `rfq_delivery`）与 `projection` 服务（纯函数 `deliveries`，**同一真源**，
 *     不在界面侧另抄一份白名单/作用域规则）。
 *   · 读不出来就**如实降级**（具名 reason + next_action）：绝不把"读不到"画成"没有包"。
 *   · 它是**读数面板**（`not_data: true`）：一屏没有业务数据时，这块不该把空态顶掉。
 */
export const plugin_id = 'system/projection'

const asText = (value) => (typeof value === 'string' ? value.trim() : '')
const isRow = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const typeRows = (rows, type) => (Array.isArray(rows) ? rows : [])
  .filter((row) => isRow(row) && String(row.type ?? '') === type)
const bodyOf = (row) => (isRow(row?.body) ? row.body : {})
/** 一串收件人：不是数组就只认标量（字符串/数字），**不猜**（与 `domain/quote-prepare` 同一读法）。 */
const scalarListOf = (value) => {
  if (Array.isArray(value)) return value.map(asText).filter((item) => item !== '')
  const one = typeof value === 'string' || typeof value === 'number' ? asText(String(value)) : ''
  return one === '' ? [] : [one]
}

/**
 * 本侧 realm（**与 `domain/quote-prepare#registrationRealmOf` / `domain/commitments#realmOf`
 * 逐条同源**，界面侧不另立一条取值规则）：① 行级 `realm`（夹具/单账本模式下才有；机制给的投影
 * 默认只出 `seq/type/correlation_id/actor/ts/body`，真实面上这一条通常取不到）；
 * ② **投递登记**里的收件人（`po/distributed` / `rfq/distributed` 的 `recipients[]` 或 `supplier`）。
 * 取不到 ⇒ `''`（调用方按 `no-ledger-identity` **如实降级**，不编一个假身份）。
 */
const realmOf = (rows) => {
  const direct = (Array.isArray(rows) ? rows : []).find((row) => isRow(row) && asText(row.realm) !== '')
  if (direct) return asText(direct.realm)
  for (const type of ['po/distributed', 'rfq/distributed']) {
    for (const row of typeRows(rows, type)) {
      const body = bodyOf(row)
      const mine = [asText(body.supplier), ...scalarListOf(body.recipients)].find((item) => item !== '')
      if (mine) return mine
    }
  }
  return ''
}

/** 投递信封（数组形态与单封形态都收；与 `webui.mjs#deliveryEnvelopes` 的口径一致：只认对象，坏的跳过）。 */
const envelopesOf = (target, host) => {
  if (target === '') return { envelopes: [], reason: 'no-delivery-target' }
  const raw = host.readJson(target)
  if (raw === null || raw === undefined) return { envelopes: [], reason: 'delivery-unreadable' }
  const list = Array.isArray(raw) ? raw : [raw]
  const envelopes = list.filter((item) => isRow(item))
  if (!envelopes.length) return { envelopes: [], reason: 'delivery-unreadable' }
  return { envelopes, reason: '' }
}

export async function register(surface, host) {
  const me = plugin_id
  const out = []
  const view = 'supplier'

  const degrade = (reason, next_action) => ({
    ok: true, kind: 'table', degraded: true, reason, next_action,
    columns: [{ key: 'package_id', label: '包' }], rows: [],
  })

  out.push(surface.panel({ plugin_id: me, id: 'projection.delivery-truth',
    title: '投递事实读数（发给我的包 · 坏行丢了几条）', view, order: 9, kind: 'table',
    // 读数面板：不参与"这一屏有没有业务数据"的判断（口径见 29 §23：读数/说明行不算数据）
    not_data: true,
    hint: '这块面板只回答一件事：**投递信封里的行项目，本视角读到几条、丢了几条、为什么丢、怎么修**。'
      + '口径只有一条 —— 逐字照抄投影层（`system/projection`）的返回值：读取用它的纯函数 `deliveries`，'
      + '作用域/字段白名单/私域纪律都在那里，本面板不重算、不补编。'
      + '"丢"与"夹取"是两件事：`丢` = 信封里那条**读不成一行**（不是对象）⇒ 跳过并计数；'
      + '`夹取` = 好行但超过每包上限（那在上面的「发往本视角的 RFQ 包」里照样说明）。',
    data: () => {
      const target = asText(host.config?.rfq_delivery)
      const realm = realmOf(host.rows(view))
      const found = envelopesOf(target, host)
      const service = host.service('projection')
      if (!service || typeof service.deliveries !== 'function') {
        return degrade('projection-service-missing',
          '投影服务没挂上（插件被卸载/未装配）⇒ 刷新页面看当前的注册面；这一段读数由 `system/projection` 提供')
      }
      if (found.reason !== '') {
        return degrade(found.reason, found.reason === 'no-delivery-target'
          ? '本视角还没有投递配置（`rfq_delivery` 为空）—— 等对方发布并投递之后这一段才有读数'
          : `投递信封读不出来（${target}）：确认这一份 JSON 存在且可读、且是投递信封（对象或对象数组）`
            + '；读不出来时这段**不冒充**"没有包"')
      }
      if (realm === '') {
        return degrade('no-ledger-identity',
          '本视角账本里还没有任何带 realm 的事实 ⇒ 认不出"我是谁"，投递作用域无从判定（发布/投递之后自然会读到）')
      }
      const maxPackages = Number(host.config?.rfq_delivery_max ?? 8)
      const report = service.deliveries(view, [realm], found.envelopes,
        Number.isFinite(maxPackages) ? { maxPackages } : {})
      const dropped = Number(report.counts?.items_dropped ?? 0)
      const rows = (Array.isArray(report.packages) ? report.packages : []).map((pkg) => ({
        id: asText(pkg?.rfq?.package_id),
        package_id: asText(pkg?.rfq?.package_id),
        rev: pkg?.rfq?.rev === null || pkg?.rfq?.rev === undefined ? '—' : pkg.rfq.rev,
        // **声明条数**（信封里有多少条）与**读到条数**并排：两个数不一样时，差额就是下面那一列
        declared: Number(pkg?.items_declared ?? 0),
        read: Array.isArray(pkg?.rfq?.items) ? pkg.rfq.items.length : 0,
        dropped: Number(pkg?.items_dropped ?? 0),
        why: asText(pkg?.items_dropped_reason) || (Number(pkg?.items_dropped ?? 0) ? '(未命名原因)' : '—'),
        fix: asText(pkg?.items_dropped_fix) || '—',
        note: asText(pkg?.items_dropped_note),
      }))
      return { ok: true, kind: 'table',
        columns: [
          { key: 'package_id', label: '包', type: 'code', pin: 'left' },
          { key: 'rev', label: '版本' },
          { key: 'declared', label: '信封声明条数', filter: 'number' },
          { key: 'read', label: '读到条数', filter: 'number' },
          { key: 'dropped', label: '丢了几条', filter: 'number' },
          { key: 'why', label: '为什么', type: 'code' },
          { key: 'fix', label: '怎么修' },
        ],
        rows,
        counts: { packages: rows.length, declared: rows.reduce((sum, row) => sum + row.declared, 0),
          read: rows.reduce((sum, row) => sum + row.read, 0), dropped },
        // 有坏行 ⇒ 这块面板**如实标降级**（好行照列，不是把整块藏起来）
        degraded: dropped > 0 || report.degraded === true,
        reason: dropped > 0 ? `items-dropped:${dropped}` : (report.degraded ? asText(report.reason) : null),
        next_action: dropped > 0
          ? `按上面那一列修投递信封：${asText(rows[0]?.fix) || '逐条把坏的那几条改成对象行'}`
          : (report.degraded
            ? '这一份投递事实对不上本视角（看 reason）：读数由投影层给，界面不代它猜'
            : undefined),
        note: `口径：只出**发给本视角**（realm ${realm}）的包；行项目的字段白名单是 `
          + '`item_id`/`code`/`qty`/`unit`，私域键与其他供应商数据**读都不读**（投影层两条结构性负控）。'
          + `${dropped > 0
            ? ` 本次读数：信封里共声明 ${rows.reduce((sum, row) => sum + row.declared, 0)} 条行项目，`
              + `读到 ${rows.reduce((sum, row) => sum + row.read, 0)} 条，**丢 ${dropped} 条**`
              + `（原因：${asText(rows.find((row) => row.dropped > 0)?.why)}）——`
              + `坏条整条跳过并计数（不静默丢、不猜内容），好条照常列出。`
            : ' 本次读数：信封里的行项目**没有一条读不出来**（`items_dropped=0`）。'}`
          + `${Number(report.counts?.items_omitted ?? 0) > 0
            ? ` 另有 ${report.counts.items_omitted} 条好行因每包上限被夹取（那是"夹取"，不是"坏行"）。` : ''}`,
      }
    } }))

  return out
}
