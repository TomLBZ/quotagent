/**
 * `delivery-receipts` —— **投递的已读回执**（「东西发出去之后，对方到底看了没有」），system 层的**协作面机制**。
 *
 * 为什么它长在 `system/attachments` 里：它和对象级附件是同一类东西 —— **对象级的投递/可见性留痕**，
 * 不属于任何业务域，也不是任何一条合同事实。`system/attachments` 已经拥有「谁在何时对哪个对象做了
 * 什么（上传/删除）且 **不进账本**」这套存储纪律（0600 索引 + journal），回执是它的近亲。
 * 域插件（发包 / 报价准备 / 授标与订单）只**声明**「我要记一条已读」与「我要看已读」，语义不在这里。
 *
 * 【为什么不写账本（**这一条是硬约束，不是取舍**）】
 *   · 账本是**合同事实**的 append-only 链条：进了账本的东西，模型可见（AGENTS.md 规则 2）、进投影、
 *     进证据包、进哈希链、能被审计取证。而「某人在某时刻打开过某一页」是**人对界面的读取痕迹**，
 *     不是任何一方对另一方作出的承诺 —— 把它写进账本会**篡改事实集合的语义**（谁承诺了什么）与
 *     证据包哈希，属于规则 10「不碰内核语义」的禁区。
 *   · 与协作面（`src/system/webui/code/collab.mjs` 的指派/关注/评论/已读）、名册（`people.mjs`）、
 *     附件索引同一口径：**运营痕迹落 0600 文件、不进账本、不进投影、不进模型输入**。
 *   · 因此本模块提供的写面**只写自己这一个文件**：`<ui_shared>/receipts/deliveries.json`
 *     （目录 0700 / 文件 0600、原子写、有界）。任何代码路径都**不**通过它落账本（`ledger_added` 恒 0）。
 *
 * 【跨侧可见性是**设计意图**，不是泄漏】
 *   「对方收到了吗 / 看了吗」这个问题只有**发送侧**能回答 —— `rfq/distributed` 与 `po/distributed`
 *   已经把「投给哪个 realm、何时投的」写成了两侧账本的**事实**，回执只是在这条事实上补一句
 *   「对面的人（名字）在何时把它打开了」。所以回执里只有「对象 id + 人 + 时刻 + 计数」这四样，
 *   **不含任何报价/成本/评分/私域字段** —— 读侧按对象 id 取，取不到的对象 id 根本不进输出（不是过滤）。
 *
 * 【读侧纪律】
 *   · 未登录 ⇒ **不记**（`identity-required`；身份只认会话，不由表单给）。
 *   · 文件在、但读不成形状 ⇒ 如实报 `broken` 并且**拒绝写入**（读不出来 ≠ 可以覆盖掉：与协作面
 *     「坏形状原样留在文件里」同一纪律）。
 *   · 有界：每个对象最多 `LIMITS.readers_per_object` 个读者、每类对象最多 `LIMITS.objects_per_kind`
 *     个对象；超限**有名拒绝**（`receipt-limit-reached`），不静默丢。
 *   · 去抖：同一人同一对象在 `DEDUPE_MS` 内的重复查看**不写盘**（`unchanged`）—— 一次页面渲染会
 *     碰好几次面板，回执不该因此长大。
 */

import { existsSync, mkdirSync, chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export const RECEIPT_SCHEMA = 'quotagent/delivery-receipts/v1'
/** 落点目录（在 `<ui_shared>` 下）。 */
export const RECEIPT_DIR = 'receipts'
/** 落点文件名。 */
export const RECEIPT_FILE = 'deliveries.json'
/** 可记回执的对象类（闭合集合：多一类就在这里加一个 —— 免得键名各处漂移）。 */
export const RECEIPT_KINDS = ['package', 'po']
/** 同一人 + 同一对象的重复查看在这个窗口内**不写盘**（60 s）。 */
export const DEDUPE_MS = 60_000
/** 有界（超限**有名拒绝**，不静默丢）。 */
export const LIMITS = { objects_per_kind: 500, readers_per_object: 64, bytes: 512 * 1024 }
/** 拒绝码（闭合集合；面板/动作照抄，不自己造词）。 */
export const REFUSAL_CODES = ['identity-required', 'kind-not-receiptable', 'id-malformed', 'at-required',
  'receipt-store-unreadable', 'receipt-write-failed', 'receipt-limit-reached']
/** 文件头与自述面共用的那句理由（**唯一一处**：别处重复即漂移）。 */
export const RECEIPT_WHY_NOT_LEDGER = '已读回执是**人对界面的读取痕迹**，不是合同事实：'
  + '「谁在何时打开过哪个包/哪张采购单」不产生任何一方的义务，也不该进哈希链与证据包。'
  + '所以它只落 `<ui_shared>/receipts/deliveries.json`（目录 0700 / 文件 0600、原子写、有界），'
  + '不进账本（本模块不含任何账本写路径）、不进投影、不进模型输入；'
  + '投递与回签**本身**仍是账本事实（`rfq/distributed` / `po/distributed` / `po/acknowledged`），回执只是在它们旁边补一句「看了没有」。'

const text = (value) => (typeof value === 'string' ? value.trim() : '')
const plain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const flat = (err) => String(err && err.message ? err.message : err).slice(0, 200)
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/

const emptyDoc = () => ({ schema: RECEIPT_SCHEMA,
  // 两个对象类**都要有桶**（缺桶会让 `objects[kind][id]` 读成 undefined 再炸 —— 修前实测就是这个 TypeError）
  objects: Object.fromEntries(RECEIPT_KINDS.map((kind) => [kind, {}])),
  updated_at: '', note: RECEIPT_WHY_NOT_LEDGER })

const refusal = (code, reason, nextAction) => ({ ok: false, code, reason, next_action: nextAction,
  ledger_added: 0 })

/**
 * 一份「读得出来的」文档 → 归一化后的文档（坏形状**跳过并计数**，绝不因为一次正常保存就抹掉读不懂的内容 ——
 * 与协作面同一纪律；区别是这里更严：**整份读不出来时连写都拒绝**）。
 */
const sanitizeDoc = (raw) => {
  const objects = {}
  const problems = []
  const container = plain(raw.objects) ? raw.objects : {}
  for (const kind of RECEIPT_KINDS) {
    const bucket = plain(container[kind]) ? container[kind] : (container[kind] === undefined ? {} : null)
    if (bucket === null) {
      problems.push({ field: `objects.${kind}`, why: '要是「对象 id → 该对象的回执」的键值表' })
      continue
    }
    objects[kind] = {}
    for (const [id, entry] of Object.entries(bucket)) {
      if (!plain(entry)) {
        problems.push({ field: `objects.${kind}.${id}`, why: '要是一条对象（含 `readers` 键值表）' })
        continue
      }
      const readers = {}
      let dropped = 0
      for (const [human, row] of Object.entries(plain(entry.readers) ? entry.readers : {})) {
        if (!plain(row) || text(row.first_at) === '' || text(row.last_at) === '') { dropped += 1; continue }
        readers[human] = { side: text(row.side), first_at: text(row.first_at), last_at: text(row.last_at),
          count: Number.isFinite(Number(row.count)) && Number(row.count) > 0 ? Number(row.count) : 1,
          source: text(row.source) }
      }
      if (dropped) problems.push({ field: `objects.${kind}.${id}.readers`, why: `有 ${dropped} 条读者记录读不出来（缺时刻）—— 已跳过，原文仍在文件里` })
      objects[kind][id] = { readers }
    }
  }
  return { doc: { schema: RECEIPT_SCHEMA, objects, updated_at: text(raw.updated_at),
    note: RECEIPT_WHY_NOT_LEDGER }, problems }
}

export function createReceiptStore({ root = '.', sharedDir, log } = {}) {
  const base = resolve(String(root ?? '.'), String(sharedDir ?? 'tmp/ui-shared'))
  const dir = join(base, RECEIPT_DIR)
  const file = join(dir, RECEIPT_FILE)
  const say = (msg) => { if (typeof log === 'function') log(`[receipts] ${msg}`) }

  /** 读：`{ doc, broken, problems, exists }`。**读不出来 ≠ 是空的**（`broken` 非空时如实说读不出来）。 */
  const load = () => {
    if (!existsSync(file)) return { doc: emptyDoc(), broken: null, problems: [], exists: false }
    let raw = null
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      return { doc: emptyDoc(), problems: [],
        broken: { code: 'receipt-store-unreadable', file: rel(), reason: flat(err),
          how_to_fix: '这份回执文件（0600）是**配置/痕迹**不是账本：要么把它改回 '
            + `\`{"schema":"${RECEIPT_SCHEMA}","objects":{}}\`，要么把它移走（回执会从空开始，账本一个字节不动）` },
        exists: true }
    }
    if (!plain(raw)) {
      return { doc: emptyDoc(), problems: [],
        broken: { code: 'receipt-store-not-an-object', file: rel(),
          reason: `顶层不是对象（收到 ${Array.isArray(raw) ? 'array' : typeof raw}）`,
          how_to_fix: `顶层要是 \`{"schema":"${RECEIPT_SCHEMA}","objects":{...}}\`` }, exists: true }
    }
    const shaped = sanitizeDoc(raw)
    return { doc: shaped.doc, broken: null, problems: shaped.problems, exists: true }
  }

  const rel = () => relative(resolve(String(root ?? '.')), file).split('\\').join('/')

  /** 原子写（同目录 tmp → chmod 0600 → rename；目录 0700）—— 与身份会话/协作文件同一口径。 */
  const save = (doc) => {
    doc.updated_at = text(doc.updated_at)
    const payload = JSON.stringify({ schema: RECEIPT_SCHEMA, objects: doc.objects,
      updated_at: doc.updated_at, note: RECEIPT_WHY_NOT_LEDGER }, null, 1) + '\n'
    const bytes = Buffer.byteLength(payload, 'utf8')
    if (bytes > LIMITS.bytes) {
      return refusal('receipt-limit-reached',
        `回执文件将长到 ${bytes} B（上限 ${LIMITS.bytes} B）`,
        '对象类各自有对象数上限；这是痕迹不是事实 —— 超了先清掉不再关心的对象（删文件即从空开始，账本不受影响）')
    }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch (err) { /* 文件系统不支持时尽力而为 */ }
      const tmp = join(dir, `.${RECEIPT_FILE}.${process.pid}.tmp`)
      writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, file)
      return { ok: true, file: rel(), mode: '0600', bytes }
    } catch (err) {
      return refusal('receipt-write-failed', flat(err),
        `先修 ${relative(resolve(String(root ?? '.')), dir)} 目录权限（回执必须 0600 且只写这里；写不进去时如实报，不假装成功）`)
    }
  }

  /**
   * **记一条已读**（唯一的写面）。身份**只由调用方从会话给进来**（`side`/`human`）。
   * 回执：`{ ok, code, recorded|unchanged, first_at, last_at, count_for_object, readers, file, mode }`。
   */
  const record = ({ kind, id, human, side, at, source = '' } = {}) => {
    const objKind = text(kind)
    const objId = text(id)
    const me2 = text(human)
    const when = text(at)
    if (me2 === '') {
      return { ...refusal('identity-required',
        '已读回执按**会话身份**记（没有身份就不知道"谁看过"）',
        '先在界面里登录（顶栏「身份」），再打开对方的包/采购单'), ledger_added: 0 }
    }
    if (!RECEIPT_KINDS.includes(objKind)) {
      return { ...refusal('kind-not-receiptable', `对象类 ${JSON.stringify(kind)} 不在可记回执的集合里`,
        `可记回执的对象类：${RECEIPT_KINDS.join(' / ')}`), ledger_added: 0 }
    }
    if (!ID_RE.test(objId)) {
      return { ...refusal('id-malformed', `对象 id 形状非法：${JSON.stringify(id)}`,
        '对象 id 来自账本/投递登记（字母数字开头，≤120 字符）'), ledger_added: 0 }
    }
    if (when === '') {
      return { ...refusal('at-required', '记回执必须给 `at`（时刻）—— 本模块**不取墙钟**，由调用方给',
        '调用方用 `host.now()`；这样"何时看过"与页面上的时刻是同一把尺子'), ledger_added: 0 }
    }
    const loaded = load()
    if (loaded.broken) {
      return { ...refusal('receipt-store-unreadable',
        `回执文件读不出来（${loaded.broken.code}）：${loaded.broken.reason}`,
        `${loaded.broken.how_to_fix} —— **不覆盖读不出来的文件**（原样留着），所以这一次没有写`), ledger_added: 0 }
    }
    const bucket = loaded.doc.objects[objKind] ?? (loaded.doc.objects[objKind] = {})
    const known = bucket[objId]
    if (known === undefined && Object.keys(bucket).length >= LIMITS.objects_per_kind) {
      return { ...refusal('receipt-limit-reached',
        `${objKind} 类已有 ${Object.keys(bucket).length} 个对象（上限 ${LIMITS.objects_per_kind}）`,
        '回执是痕迹不是事实：清掉不再关心的对象（删文件即从空开始，账本不受影响）'), ledger_added: 0 }
    }
    const entry = known ?? { readers: {} }
    const before = entry.readers[me2] ?? null
    if (before === null && Object.keys(entry.readers).length >= LIMITS.readers_per_object) {
      return { ...refusal('receipt-limit-reached',
        `这个对象上已有 ${Object.keys(entry.readers).length} 个读者（上限 ${LIMITS.readers_per_object}）`,
        '回执按对象聚合：先清掉不再关心的对象'), ledger_added: 0 }
    }
    if (before !== null) {
      const lastMs = Date.parse(before.last_at)
      const atMs = Date.parse(when)
      const withinWindow = Number.isFinite(lastMs) && Number.isFinite(atMs)
        && atMs - lastMs >= 0 && atMs - lastMs < DEDUPE_MS
      if (withinWindow) {
        say(`已读去抖（${DEDUPE_MS} ms 内重复查看不写盘）：${objKind}/${objId} by ${me2}`)
        return { ok: true, code: 'unchanged', recorded: false, unchanged: true, ledger_added: 0,
          missing: false, file: rel(), mode: '0600', first_at: before.first_at, last_at: before.last_at,
          count: before.count, readers: Object.keys(entry.readers).length, object: `${objKind}/${objId}`,
          note: `${DEDUPE_MS} ms 内你已经看过这个对象：这一次不写盘（回执不该因为页面反复渲染而长大）` }
      }
    }
    entry.readers[me2] = { side: text(side), first_at: before ? before.first_at : when,
      last_at: when, count: (before?.count ?? 0) + 1, source: text(source) }
    loaded.doc.objects[objKind][objId] = entry
    loaded.doc.updated_at = when
    const saved = save(loaded.doc)
    if (!saved.ok) return saved
    say(`记一条已读：${objKind}/${objId} by ${me2} @ ${when}`)
    return { ok: true, code: 'recorded', recorded: true, unchanged: false, ledger_added: 0,
      missing: false, file: saved.file, mode: saved.mode,
      first_at: entry.readers[me2].first_at, last_at: entry.readers[me2].last_at,
      count: entry.readers[me2].count, readers: Object.keys(entry.readers).length,
      object: `${objKind}/${objId}`, at: when, note: '已读回执（不进账本：它是读取痕迹，不是合同事实）' }
  }

  /** 一个对象的读者（按**首次看过**升序 ⇒ 先看的是谁一眼可见）。 */
  const list = ({ kind, id } = {}) => {
    const loaded = load()
    const row = loaded.doc.objects[text(kind)]?.[text(id)]
    const readers = Object.entries(row?.readers ?? {}).map(([human, item]) => ({ human, ...item }))
      .sort((left, right) => (left.first_at < right.first_at ? -1 : left.first_at > right.first_at ? 1 : 0))
    return { ok: true, readers, exists: Boolean(row), broken: loaded.broken, problems: loaded.problems,
      file: rel() }
  }

  /** 一批对象一次的读者表（面板一次渲染只为这一批对象读一次盘）：`Map<对象 id, 读者数组>`。 */
  const forObjects = (kind, ids = []) => {
    const loaded = load()
    const bucket = loaded.doc.objects[text(kind)] ?? {}
    const out = new Map()
    for (const id of ids.map(text).filter((item) => item !== '')) {
      const row = bucket[id]
      if (!row) { out.set(id, []); continue }
      out.set(id, Object.entries(row.readers).map(([human, item]) => ({ human, ...item }))
        .sort((left, right) => (left.first_at < right.first_at ? -1 : left.first_at > right.first_at ? 1 : 0)))
    }
    return { readers: out, broken: loaded.broken, problems: loaded.problems, file: rel() }
  }

  /** 自述读数（**证据**：文件在哪、什么权限、多少对象、为什么不在账本里）。 */
  const describe = () => {
    const loaded = load()
    const perKind = {}
    for (const kind of RECEIPT_KINDS) {
      const bucket = loaded.doc.objects[kind] ?? {}
      perKind[kind] = { objects: Object.keys(bucket).length,
        readers: Object.values(bucket).reduce((sum, row) => sum + Object.keys(row.readers ?? {}).length, 0) }
    }
    let mode = '（还没有这个文件）'
    try { mode = oct(statSync(file).mode & 0o777) } catch (err) { /* 不存在就照实说 */ }
    return { schema: RECEIPT_SCHEMA, dir: relative(resolve(String(root ?? '.')), dir), file: rel(),
      mode, exists: loaded.exists, per_kind: perKind, broken: loaded.broken, problems: loaded.problems,
      bounded: { objects_per_kind: LIMITS.objects_per_kind, readers_per_object: LIMITS.readers_per_object,
        bytes: LIMITS.bytes, dedupe_ms: DEDUPE_MS },
      kinds: RECEIPT_KINDS.slice(), why_not_ledger: RECEIPT_WHY_NOT_LEDGER,
      note: '回执按对象聚合（「谁 / 首次 / 最近 / 次数 / 从哪看的」）：只有对象 id + 人 + 时刻 + 计数，'
        + '没有报价/成本/评分/私域字段；读不出对象 id 就根本不进输出' }
  }

  return { dir, file, rel, load, save, record, list, forObjects, describe, refused: REFUSAL_CODES }
}

const oct = (value) => value.toString(8).padStart(4, '0')
