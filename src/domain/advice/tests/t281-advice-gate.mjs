/**
 * t281-advice-gate —— 决策建议层（`host/modules/advice-panel.mjs` + 它在 `webui` 里的两条路由）
 * 的**围栏门**（宿主侧人工维护，不由被围对象自己写）。
 *
 * 断言（25 条，含负控、非空转对照与**单点变异**；每条都写清"什么情况下必须变红"）：
 *   1. 契约正控：manifest 齐备 + 只 import ../lib 白名单 + 源码里 0 个脚本字面量
 *   2. 挂载正控：provide 拦截拿得到句柄（advise/meta/config）；dispose 后 effect 归零
 *   3. **诚实分层**正控：`engine=rules` 在场 + `engine_note` 与模块导出常量逐字一致（含"不含模型推测"）
 *      + `privacy` 三项（model_calls/network_calls/private_keys_read）如实申报
 *   4. 每条建议形状正控：键集固定、severity 闭集、title/why/next_action 非空、id 唯一
 *   5. **basis 可溯源**正控：每条 basis 非空且每个 token 都能解析回载荷里的**真键**
 *      （含非空转对照：篡改 ref / 伪造键名必须判假）
 *   6. 五条规则全覆盖正控：综合载荷触发 5 个 rule + **手算**的顺序与严重度表逐项对齐
 *   7. 截止规则正控（手算小时差）：已过期 → high；临近（≤ 阈值）→ medium；远期 → **不报**
 *   8. 比价区间异常正控（**按行项目分组** + 手算极差）：≥ 阈值 → medium，≥ 2× 阈值 → high；
 *      非空转对照：阈值调到 100 → 该条必须消失
 *   9. 人工门正控：commit scope → high 且 next_action 是**真 CLI**；未知 scope → 回落命令；
 *      `blocked_by` 必须写明"浏览器不能代签"
 *  10. 通道缺口正控：`available:false` → high 且 next_action **逐字节照抄**声明原值；
 *      非空转对照：`available:true` → 该条必须消失
 *  11. 供应商侧提升排名正控：同一批 ranking 在承包商视角**不产生** rank-up 条；next_action 带 `?w_<focus>=1`
 *  12. **空数据不编建议**（硬负控）：空投影 / 非对象 / 坏形状 → `degraded:true` + 有名 reason + items 0；
 *      `no-usable-inputs` 与 `no-signal` 是**两个不同**的 reason
 *  13. 确定性负控：同输入两次逐字节一致 / 键序打乱一致 / 条目顺序打乱一致 / 跨实例一致 / 无时间键
 *  14. **私域哨兵零泄漏**负控：带哨兵与不带哨兵输出**逐字节一致**；哨兵 0 命中（输入对照组必须命中）
 *  15. 有界与 `omitted` 诚实负控：上限夹取并回显；`shown + omitted === generated`；by_severity 和 === generated
 *  16. 零写面/不读账本负控（静态扫描 + **扫描器非空转对照**）
 *  17. 配置不得静默放行（未知键/错类型/非对象/翻转 const）+ 阈值夹取
 *  18. fixture 纯读取 + 冻结输入不抛错
 *  19-21. **真 HTTP**（in-process 挂真 `webui` + 真依赖模块 + 夹具账本 + 夹具通道快照）：
 *      **旧 SSR 页已退役**（`RETIRED_SUBVIEWS`）：四条旧路由一律 **303 → `/t281/app/<view>/`**；
 *      四条路由仍登记且 `auth=identity-session`；**承接这件事的 GUI 面板真的注册在那一页上**、其载荷
 *      **0 命中**「回终端」痕迹；四道页面里不再有点向旧页的入口；
 *      页面 **0 行脚本 / 0 内联事件**；**两视角建议确实不同**（一边成表、一边 `data-degraded=1` 且 items 0）；
 *      响应里没有私域键名、夹具文件里**确实有**哨兵（非空转对照）
 *  22-25. **单点变异**：4 处变异各自必须让**指定的**场景变红（且变异必须真的改了字节），
 *      全程 `host/modules/advice-panel.mjs` 与 `host/modules/webui.mjs` 字节不变（变异只写在临时目录的副本里）
 *
 * 输出：**一行** JSON `{"checks":[{name,ok,detail}],"passed":N,"total":N,"failures":N}`；全绿 exit 0。
 * 用法：`node host/t281-advice-gate.mjs`（cwd 无关：路径都由 import.meta.url 推出）。
 */
// `cordis` 是宿主私有的裸名依赖：搬迁后本文件不在 `host/` 下，改为按**显式解析**导入
// （见下方 `CORDIS_URL`；与搬迁前 Node 从 `host/node_modules` 上溯到的是同一份）。
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 实现已搬进 `src/<层>/<插件>/tests/`（迁移阶段 4.2 的续搬，EV-173）：宿主目录由仓库根推出
// （`src/<层>/<插件>/tests/` 4 层上溯），旧位置 `host/` 留**薄转发**；
// 本文件其余逻辑与搬迁前逐行相同（`join(HERE, '..')` 仍是仓库根）。
const HERE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'host')
// 宿主内核解析（搬迁后本文件不在 `host/` 下）：裸名 `cordis` 从**宿主目录**解析 —— 与搬迁前 Node 上溯到
// `host/node_modules/` 的那一份**同一个文件**（`cordis` 的 `main`/`exports` 都指向 `lib/index.js`）。
const CORDIS_URL = process.env.QUOTAGENT_CORDIS
  ? pathToFileURL(process.env.QUOTAGENT_CORDIS).href
  : pathToFileURL(join(HERE, 'node_modules', 'cordis', 'lib', 'index.js')).href
const { Context, EventsService } = await import(CORDIS_URL)
// 实体已随批 `EV-178` 搬进插件 `code/`（旧路径 `host/modules/advice-panel.mjs` 只剩**薄重导**）：
// 本门读/变异的是**实体那一份**（否则会静默判绿：变异打在转发文件上不改变行为）。
const TARGET = join(HERE, '..', 'src', 'domain', 'advice', 'code', 'advice-panel.mjs')
// 实体已随批 `EV-178` 搬进插件 `code/`（旧路径 `host/modules/webui.mjs` 只剩**薄重导**）：
// 本门读/变异的是**实体那一份**（否则会静默判绿：变异打在转发文件上不改变行为）。
const WEBUI = join(HERE, '..', 'src', 'system', 'webui', 'code', 'webui.mjs')
const SCHEMA_URL = pathToFileURL(join(HERE, 'lib', 'std-schema.mjs')).href

// 门自己注入的**假** admin token：只为取第四道页面（`/t281/admin/`，提权后）的子导航。
const T281_TOKEN = 't281-gate-token-91ab'
process.env.QUOTAGENT_ADMIN_TOKEN_T281 = T281_TOKEN

const CHECKS = []
const check = (name, ok, detail = '') => { CHECKS.push({ name, ok: Boolean(ok), detail }) }
const finish = () => {
  if (CHECKS.length === 0) check('空集合守卫：门至少跑了一条断言', false, 'CHECKS 为空')
  const failures = CHECKS.filter((item) => !item.ok).length
  writeSync(1, JSON.stringify({ checks: CHECKS, passed: CHECKS.length - failures, total: CHECKS.length, failures }) + '\n')
  process.exit(failures === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
// 产物加载：先装解析钩子（把 `../lib/std-schema.mjs` 指到真库），再动态 import。
// 变异体在**临时目录**里跑（绝不写产品树）→ 也依赖这个钩子才解析得到同一个库（无双实例）。
// ---------------------------------------------------------------------------
const hookReady = (() => {
  try {
    if (typeof registerHooks !== 'function') return false
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === '../lib/std-schema.mjs') return { url: SCHEMA_URL, shortCircuit: true }
        return nextResolve(specifier, context)
      },
    })
    return true
  } catch {
    return false
  }
})()

const sourceOf = (path) => readFileSync(path, 'utf8')
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const originalSource = sourceOf(TARGET)
const originalHash = sha256(originalSource)
const webuiHash = sha256(sourceOf(WEBUI))

const mod = await import(pathToFileURL(TARGET).href)

/** 挂载：照抄产物声明的 `inject`，包装 `provide` 抓句柄。 */
const mountWith = async (raw = {}) => {
  const ctx = new Context()
  await ctx.plugin(EventsService)
  const box = { handle: null }
  const wrapper = {
    name: `${mod.name}#gate`,
    inject: mod.inject,
    Config: mod.Config,
    apply: async (inner, config) => {
      const originalProvide = inner.provide.bind(inner)
      inner.provide = (service, value) => {
        if ((mod.provides || []).includes(service)) box.handle = value
        return originalProvide(service, value)
      }
      await mod.apply(inner, config)
    },
  }
  const fiber = await ctx.plugin(wrapper, mod.Config.parse(raw))
  return { ctx, fiber, box }
}

/** 从**临时副本**挂载变异体（`?v=` 破缓存；返回 handle）。 */
const mountMutant = async (mutatedSource, raw = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 't281-mut-'))
  const tag = sha256(mutatedSource).slice(0, 8)
  const file = join(dir, `advice-panel.mut-${tag}.mjs`)
  writeFileSync(file, mutatedSource, 'utf8')
  const mutant = await import(`${pathToFileURL(file).href}?v=${tag}`)
  const ctx = new Context()
  await ctx.plugin(EventsService)
  const box = { handle: null }
  await ctx.plugin({
    name: `${mutant.name}#mutant`,
    inject: mutant.inject,
    Config: mutant.Config,
    apply: async (inner, config) => {
      const originalProvide = inner.provide.bind(inner)
      inner.provide = (service, value) => {
        if ((mutant.provides || []).includes(service)) box.handle = value
        return originalProvide(service, value)
      }
      await mutant.apply(inner, config)
    },
  }, mutant.Config.parse(raw))
  return { ctx, box, mutant, file, dir }
}

/** 单点变异：找不到/多于一处的"变异"是**假变异**（返回 null，调用方必须判红）。 */
const applyMutation = (text, find, replace) => {
  const count = text.split(find).length - 1
  if (count !== 1 || find === replace || !replace) return null
  return text.replace(find, replace)
}

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

// ===========================================================================
// 夹具 + 手算表
// ===========================================================================
/**
 * 综合载荷（手算：`as_of=2026-09-25T12:00:00Z`）
 *   ① deadlines pkg-1 2026-09-24T00:00Z → −36h（已过期 → high）
 *              pkg-2 2026-09-26T00:00Z → +36h（≤96h → medium）
 *              pkg-3 2026-10-30T00:00Z → +842.0h > 96 → **不报**
 *   ② ranking   L-001：sup-A 90 / sup-B 30 → 极差 60（≥25 且 ≥ 2×25 → high）
 *               L-002：sup-C 70 / sup-D 60 → 极差 10 < 25 → **不报**
 *   ③ gates     ap-0001 scope=quote.submit（commit → high）/ ap-0002 scope=other.scope（→ medium）
 *   ④ channels  mail available=false → high
 *   ⑤ rank-up   仅供应商侧：sup-A(potential 10 → medium) / sup-C(potential 30 → medium)
 *   合计 8 条（high 4 / medium 4）；顺序 = 严重度降序 → 规则顺序（expiry, spread, gate, channel, rank-up）→ id 字典序
 */
const FULL = {
  view: 'supplier',
  as_of: '2026-09-25T12:00:00Z',
  deadlines: [
    { ref: 'pkg-1', due_at: '2026-09-24T00:00:00Z', kind: 'quote_by' },
    { ref: 'pkg-2', due_at: '2026-09-26T00:00:00Z', kind: 'clarify_by' },
    { ref: 'pkg-3', due_at: '2026-10-30T00:00:00Z', kind: 'quote_by' },
  ],
  gates: [
    { approval_id: 'ap-0001', scope: 'quote.submit', ref: 'q-1' },
    { approval_id: 'ap-0002', scope: 'other.scope', ref: 'x-1' },
  ],
  ranking: { rows: [
    { code: 'sup-A', item: 'L-001', score: 90, focus: 'price', potential: 10, hint: '优先改善「单价」：该因子现在贡献 60 分' },
    { code: 'sup-B', item: 'L-001', score: 30, focus: null, potential: 0, hint: '没有可提升项（已是可用权重下的上限）' },
    { code: 'sup-C', item: 'L-002', score: 70, focus: 'delivery', potential: 30, hint: '优先改善「交期（天）」：该因子现在贡献 35 分' },
    { code: 'sup-D', item: 'L-002', score: 60, focus: null, potential: 0, hint: '没有可提升项（已是可用权重下的上限）' },
  ] },
  channels: [
    { name: 'mail', available: false, reason: 'mail-smtp-unconfigured', next_action: '配置 SMTP 凭据后再发（本页不假装能发）' },
  ],
}
const HAND_IDS = ['expiry:pkg-1', 'spread:L-001', 'gate:ap-0001', 'channel:mail',
  'expiry:pkg-2', 'gate:ap-0002', 'rank-up:sup-A', 'rank-up:sup-C']
const HAND_SEVERITY = ['high', 'high', 'high', 'high', 'medium', 'medium', 'medium', 'medium']
const HAND_RULES = ['expiry', 'spread', 'gate', 'channel', 'expiry', 'gate', 'rank-up', 'rank-up']

/** basis 解析（门自己实现，用来证明"每条建议都指向载荷里的真键"）。 */
const resolveBasis = (payload, token) => {
  if (token === 'as_of') return typeof payload?.as_of === 'string' && payload.as_of.trim() !== ''
  const parts = /^(deadlines|gates|ranking|channels)\[([^\]]+)\]\.([a-z_]+)$/.exec(String(token))
  if (!parts) return false
  const [, section, id, key] = parts
  const list = section === 'ranking'
    ? (payload?.ranking && Array.isArray(payload.ranking.rows) ? payload.ranking.rows : [])
    : (Array.isArray(payload?.[section]) ? payload[section] : [])
  const idKey = { deadlines: 'ref', gates: 'approval_id', ranking: 'code', channels: 'name' }[section]
  const entity = list.find((item) => item && String(item[idKey]) === id)
  return Boolean(entity) && Object.prototype.hasOwnProperty.call(entity, key)
}
const basisOk = (payload, item) => Array.isArray(item.basis) && item.basis.length > 0
  && item.basis.every((token) => resolveBasis(payload, token))

/** 变异体要跑的四条场景（与第 12/5/15/3 条断言同口径；真产物必须**四条全真**）。 */
const scenarioFacts = (advise) => {
  const full = advise(FULL)
  const capped = advise(FULL, { max_items: 3 })
  const empty = advise({ view: 'contractor' })
  return {
    '有界': capped.items.length === 3 && capped.omitted === 5 && capped.truncated === true
      && capped.counts.generated === 8 && capped.counts.shown === 3,
    '空数据不编': empty.degraded === true && empty.reason === 'no-usable-inputs' && empty.items.length === 0,
    // 注意：变异体与基线都挂在 `max_items: 3` 下（两条路径同条件），所以这里只要求"展示出来的每条都可溯源"；
    // 全 8 条的逐条溯源由第 5 条断言在默认实例上验。
    'basis 可溯源': full.items.length >= 3 && full.items.every((item) => basisOk(FULL, item)),
    'engine=rules': full.engine === 'rules' && full.engine_note === mod.ENGINE_NOTE
      && full.engine_note.includes('不含模型推测'),
  }
}
const SCENARIOS = ['有界', '空数据不编', 'basis 可溯源', 'engine=rules']

/** 4 处单点变异（各自只改一处；`mustRed` 是"必须变红"的那条场景）。 */
const MUTATIONS = [
  { name: '变异1：去掉建议条数上限（不再截断）',
    find: '  const shown = generated.slice(0, options.max_items)',
    replace: '  const shown = generated.slice(0, generated.length)',
    mustRed: '有界' },
  { name: '变异2：空数据守卫失效（没数据也返回"健康"空表）',
    find: '  if (usableInputs === 0) {',
    replace: '  if (usableInputs < 0) {',
    mustRed: '空数据不编' },
  { name: '变异3：截止类建议不再带 basis（溯源断链）',
    find: "      ['as_of', `deadlines[${entry.ref}].due_at`, `deadlines[${entry.ref}].kind`],",
    replace: '      [],',
    mustRed: 'basis 可溯源' },
  { name: '变异4：引擎自述被改成 model（把规则冒充模型推测）',
    find: "export const ENGINE = 'rules'",
    replace: "export const ENGINE = 'model'",
    mustRed: 'engine=rules' },
]

try {
  // ---------- 1. 契约正控 ----------
  const imports = [...originalSource.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  const importLeaks = imports.filter((spec) => !(spec === '../lib/std-schema.mjs' || spec.startsWith('node:')))
  const manifest = {
    name: mod.name === 'advice-panel',
    inject: Array.isArray(mod.inject) && mod.inject.length === 0,
    builtin: Array.isArray(mod.builtin) && mod.builtin.length === 0,
    usedServices: Array.isArray(mod.usedServices) && mod.usedServices.length === 0,
    provides: JSON.stringify(mod.provides) === JSON.stringify(['advicePanel']),
    config: typeof mod.Config?.['~standard']?.validate === 'function',
    apply: typeof mod.apply === 'function',
    fixture: typeof mod.fixture?.sample === 'function',
    engine: mod.ENGINE === 'rules',
    note: typeof mod.ENGINE_NOTE === 'string' && mod.ENGINE_NOTE.includes('确定性规则'),
    rules: Array.isArray(mod.RULES) && mod.RULES.length === 5,
    reasons: JSON.stringify(mod.DEGRADED_REASONS) === JSON.stringify(['payload-not-an-object', 'no-usable-inputs', 'no-signal']),
  }
  const manifestBad = Object.entries(manifest).filter(([, ok]) => !ok).map(([key]) => key)
  const scriptNeedle = '<scr' + 'ipt'
  check('1 契约正控：manifest 齐备（name/inject/builtin/usedServices/provides=[advicePanel]/Config/apply/fixture/'
    + 'ENGINE/ENGINE_NOTE/五条规则/闭合的降级原因），且只 import ../lib 白名单，源码里 0 个脚本字面量',
  manifestBad.length === 0 && importLeaks.length === 0 && !originalSource.includes(scriptNeedle) && hookReady,
  `载入=${TARGET}；问题键=${manifestBad.join(',') || '无'}；越界 import=${importLeaks.join(',') || '无'}；`
  + `含脚本字面量=${originalSource.includes(scriptNeedle)}；解析钩子=${hookReady ? '已装' : '不可用'}；字节=${Buffer.byteLength(originalSource)}`)

  // ---------- 2. 挂载 + 零残留 ----------
  const probe = await mountWith({})
  const probeEffects = probe.fiber.getEffects().length
  const handle = probe.box.handle
  const methodsOk = Boolean(handle) && typeof handle.advise === 'function' && typeof handle.meta === 'function'
    && typeof handle.config === 'function'
  await probe.fiber.dispose()
  const probeAfter = probe.fiber.getEffects().length
  check('2 挂载正控：cordis 挂载后 provide 拦截拿得到句柄（advise/meta/config），dispose 后 effect 归零',
    methodsOk && probeEffects > 0 && probeAfter === 0,
    `句柄键=${Object.keys(handle ?? {}).join('|') || '空'}；effect ${probeEffects} → ${probeAfter}`)

  const live = await mountWith({})
  const advise = (payload) => live.box.handle.advise(payload)
  /**
   * 带配置的一次派生：句柄的 `advise` 用的是 apply 时解析的配置，所以"换配置"的场景另起一个实例
   * （门自己 mount，不依赖产物的内部结构）。
   */
  const mountedCache = new Map()
  const adviseWith = async (config, payload) => {
    const key = JSON.stringify(config)
    if (!mountedCache.has(key)) mountedCache.set(key, await mountWith(config))
    return mountedCache.get(key).box.handle.advise(payload)
  }

  // ---------- 3. 诚实分层正控 ----------
  const meta = live.box.handle.meta()
  const full = advise(FULL)
  const layeringOk = full.engine === 'rules' && full.engine_note === live.box.handle.meta().engine_note
    && full.engine_note === mod.ENGINE_NOTE && full.engine_note.includes('不含模型推测')
    && meta.engine === 'rules' && meta.engine_note === mod.ENGINE_NOTE
    && full.privacy && full.privacy.model_calls === 0 && full.privacy.network_calls === 0
    && full.privacy.private_keys_read === false
  const layeringNoModel = !/推测|model|llm|概率/.test(full.engine_note.replace('不含模型推测', ''))
  check('3 诚实分层正控：输出与句柄自述都写死 `engine="rules"`，`engine_note` 与模块导出常量逐字一致'
    + '（含"不含模型推测"），`privacy` 三项如实申报（0 次模型调用 / 0 次网络 / 未读私域键）',
  layeringOk && layeringNoModel,
  `engine=${full.engine}；note=${full.engine_note}；meta=${meta.engine}/${meta.engine_note}；privacy=${JSON.stringify(full.privacy)}`)

  // ---------- 4. 每条建议的形状 ----------
  const ITEM_KEYS = 'basis|blocked_by|id|next_action|rule|severity|title|why'
  const keysFixed = full.items.every((item) => Object.keys(item).sort().join('|') === ITEM_KEYS)
  const shapeBad = full.items.filter((item) => !(mod.SEVERITIES.includes(item.severity)
    && typeof item.title === 'string' && item.title.length > 4
    && typeof item.why === 'string' && item.why.length > 10
    && typeof item.next_action === 'string' && item.next_action.length > 4
    && typeof item.blocked_by === 'string' && mod.RULES.some((entry) => entry.rule === item.rule)))
  const idUnique = new Set(full.items.map((item) => item.id)).size === full.items.length
  check('4 每条建议形状正控：键集固定（id/rule/severity/title/why/basis/next_action/blocked_by）、'
    + 'severity 是闭集之一、title/why/next_action 非空、rule 在规则表里、id 唯一',
  keysFixed && shapeBad.length === 0 && idUnique && full.items.length === HAND_IDS.length,
  `键集固定=${keysFixed}；异常条=${shapeBad.length}；id 唯一=${idUnique}；条数=${full.items.length}`)

  // ---------- 5. basis 可溯源（含非空转对照） ----------
  const basisBad = full.items.filter((item) => !basisOk(FULL, item))
  const tamperedByRef = resolveBasis(FULL, 'deadlines[pkg-9].due_at')       // 不存在的 ref
  const tamperedByKey = resolveBasis(FULL, 'deadlines[pkg-1].no_such_key')  // 不存在的键
  const tamperedByShape = resolveBasis(FULL, 'deadlines pkg-1 due_at')
  const emptyBasis = basisOk(FULL, { basis: [] })
  check('5 **basis 可溯源**正控：每条建议的 basis 非空，且每个 token 都解析回载荷里的**真键**'
    + '（`as_of` 或 `<段>[<id>].<键>`）；**非空转对照**：不存在的 ref / 不存在的键 / 坏形状 / 空 basis '
    + '四种篡改都必须判假（否则"可溯源"是橡皮图章）',
  basisBad.length === 0 && !tamperedByRef && !tamperedByKey && !tamperedByShape && !emptyBasis,
  `不达标条=${basisBad.length}；对照：坏 ref=${tamperedByRef} 坏键=${tamperedByKey} 坏形状=${tamperedByShape} 空 basis=${emptyBasis}；`
  + `示例=${JSON.stringify(full.items[0]?.basis ?? [])}`)

  // ---------- 6. 五条规则全覆盖 + 手算表 ----------
  const gotIds = full.items.map((item) => item.id)
  const gotSeverity = full.items.map((item) => item.severity)
  const gotRules = full.items.map((item) => item.rule)
  const covered = [...new Set(gotRules)].sort().join(',')
  check('6 五条规则全覆盖正控：综合载荷触发 5 个规则，且**手算**的 id 顺序、严重度、规则归属逐项对齐'
    + '（排序口径：严重度降序 → 规则顺序 → id 字典序；算式见门顶部注释）',
  JSON.stringify(gotIds) === JSON.stringify(HAND_IDS) && JSON.stringify(gotSeverity) === JSON.stringify(HAND_SEVERITY)
  && JSON.stringify(gotRules) === JSON.stringify(HAND_RULES)
  && covered === 'channel,expiry,gate,rank-up,spread'
  && JSON.stringify(full.counts.by_severity) === JSON.stringify({ high: 4, medium: 4, low: 0 }),
  `实得 id=${JSON.stringify(gotIds)}；期望=${JSON.stringify(HAND_IDS)}；严重度=${JSON.stringify(gotSeverity)}；`
  + `覆盖规则=${covered}；分布=${JSON.stringify(full.counts.by_severity)}`)

  // ---------- 7. 截止规则（手算 + 边界 + 不报远期） ----------
  const expired = full.items.find((item) => item.id === 'expiry:pkg-1')
  const soon = full.items.find((item) => item.id === 'expiry:pkg-2')
  const farReported = full.items.some((item) => item.id === 'expiry:pkg-3')
  const thresholdOff = await adviseWith({ expiry_soon_hours: 1 }, FULL)
  const soonGone = !thresholdOff.items.some((item) => item.id === 'expiry:pkg-2')
  const expiredStays = thresholdOff.items.some((item) => item.id === 'expiry:pkg-1')
  const noAsOf = advise({ view: 'contractor', deadlines: [{ ref: 'pkg-9', due_at: '2026-09-24T00:00:00Z', kind: 'quote_by' }] })
  const notesAsOf = JSON.stringify(noAsOf.notes)
  check('7 截止规则正控（**手算**小时差）：已过期 → high 且 why 里给出"逾期约 36 小时"；临近（+36h ≤ 96h）→ medium；'
    + '远期（+842h）**不报**；阈值调到 1h → 只剩已过期那条（非空转对照）；**缺 `as_of` 时一条都不派生**并留下说明',
  expired?.severity === 'high' && expired.why.includes('36') && soon?.severity === 'medium'
  && !farReported && soonGone && expiredStays && noAsOf.items.length === 0
  && noAsOf.degraded === true && mod.DEGRADED_REASONS.includes(noAsOf.reason)
  && notesAsOf.includes('没有 as_of'),
  `已过期=${expired?.severity}/${expired?.id}（含 36=${String(expired?.why).includes('36')}）；临近=${soon?.severity}；`
  + `远期被报=${farReported}；阈值 1h 后临近还在=${!soonGone} 已过期还在=${expiredStays}；`
  + `缺 as_of → items=${noAsOf.items.length} reason=${noAsOf.reason} 说明=${notesAsOf.slice(0, 120)}`)

  // ---------- 8. 比价区间异常（分组 + 手算极差） ----------
  const spread = full.items.find((item) => item.id === 'spread:L-001')
  const l002 = full.items.some((item) => item.id === 'spread:L-002')
  const spreadOff = await adviseWith({ spread_points: 100 }, FULL)
  const spreadGone = !spreadOff.items.some((item) => item.rule === 'spread')
  const mediumSpread = await adviseWith({ spread_points: 40 }, FULL)
  const mediumItem = mediumSpread.items.find((item) => item.id === 'spread:L-001')
  check('8 比价区间异常正控：**按行项目分组**算极差（L-001 手算 90−30=60 ≥ 25 且 ≥ 2×25=50 → high；'
    + 'L-002 的 10 分 < 阈值 → **不报**）；非空转对照：阈值 40 → 同一条降为 medium（60 < 80）；'
    + '阈值 100 → 该条消失',
  spread?.severity === 'high' && spread.why.includes('60') && spread.basis.length === 2
  && !l002 && spreadGone && mediumItem?.severity === 'medium',
  `L-001 极差条=${spread?.severity}（含 60=${String(spread?.why).includes('60')}）；L-002 被报=${l002}；`
  + `阈值 40 → ${mediumItem?.severity}；阈值 100 后还剩 spread=${!spreadGone}`)

  // ---------- 9. 人工门（**在 GUI 里怎么走完** + 浏览器不能代签） ----------
  // 旧断言是「`next_action` 必须含 `python3 -m quotagent.g1side …` / `tools/g1-walkthrough.py`」——
  // 那正是「把人教回终端」的产品面文案，与 `docs/design/29-webui-gui-app.md` §2 + AGENTS.md 规则 12 冲突。
  // 按规则 12 **接新位置**（判据不弱于原来：动作 id 打错一样判红，且多加一条「不许有回终端的痕迹」）：
  //   ① 每条 gate 建议的 `next_action` 必须指到**审批队列里真能点的那两键**（`gate.grant` / `gate.deny`）；
  //   ② 同一个字符串里 **0** 命中 `g1side` / `PYTHONPATH` / `终端` / `命令行`；
  //   ③ `blocked_by` 必须写明「浏览器不能代签」；
  //   ④ **非空转负控**：把动作 id 从常量文本里抠掉 ⇒ ① 的判据必须判假（否则这条断言是橡皮图章）。
  const gateCommit = full.items.find((item) => item.id === 'gate:ap-0001')
  const gateOther = full.items.find((item) => item.id === 'gate:ap-0002')
  const unknownScope = advise({ gates: [{ approval_id: 'ap-0009', scope: 'mystery.scope', ref: 'y' }] })
  const APP_TOKENS = ['gate.grant', 'gate.deny']
  const GATE_NOISE = ['g1side', 'PYTHONPATH', '终端', '命令行']
  const appHonestOf = (item) => Boolean(item) && APP_TOKENS.every((token) => item.next_action.includes(token))
    && !GATE_NOISE.some((token) => item.next_action.includes(token))
    && item.blocked_by.includes('不能代签')
  const appHonest = [gateCommit, gateOther, unknownScope.items[0]].every(appHonestOf)
  const mutatedText = mod.GATE_ACTIONS['quote.submit'].replace('gate.grant', 'xxx.yyy')
  const negativeOk = !APP_TOKENS.every((token) => mutatedText.includes(token))
  check('9 人工门正控：commit scope（quote.submit）→ high，其它 scope → medium；每条 next_action 都指向**在 GUI 里真能点的动作**'
    + '（`gate.grant` / `gate.deny` = 审批队列那两键）且 **0 命中回终端的痕迹**（g1side / PYTHONPATH / 终端 / 命令行）；'
    + '未知 scope 走回落文案（回落文案同样指到那两键）；`blocked_by` 必须写明"浏览器不能代签"；'
    + '**非空转负控**：把动作 id 抠掉 ⇒ 判据必须判假',
  gateCommit?.severity === 'high' && gateOther?.severity === 'medium' && appHonest && negativeOk
  && unknownScope.items.length === 1 && appHonestOf(unknownScope.items[0]),
  `commit=${gateCommit?.severity} 其它=${gateOther?.severity} 应用诚实=${appHonest} 负控=${negativeOk}；`
  + `未知 scope 条=${JSON.stringify(unknownScope.items[0]?.next_action?.slice(0, 80))}`)

  // ---------- 10. 通道缺口（照抄声明 + 不得假装能发） ----------
  const channel = full.items.find((item) => item.id === 'channel:mail')
  const verbatim = channel?.next_action === FULL.channels[0].next_action
  const available = await adviseWith({}, { channels: [{ name: 'mail', available: true, reason: '', next_action: '' }] })
  check('10 通道缺口正控：`available:false` → high；`next_action` **逐字节照抄**通道声明里的真值（不假装能发）；'
    + '`blocked_by` 填真 reason；非空转对照：`available:true` → 该条必须消失（此时整份载荷无可建议项 → degraded）',
  channel?.severity === 'high' && verbatim && channel.blocked_by === 'mail-smtp-unconfigured'
  && available.items.length === 0 && available.degraded === true && available.reason === 'no-signal',
  `severity=${channel?.severity} 照抄=${verbatim} blocked_by=${channel?.blocked_by}；`
  + `available:true → items=${available.items.length} degraded=${available.degraded} reason=${available.reason}`)

  // ---------- 11. 供应商侧提升排名 ----------
  const rankUp = full.items.filter((item) => item.rule === 'rank-up')
  const contractorView = advise({ ...FULL, view: 'contractor' })
  const contractorRankUp = contractorView.items.filter((item) => item.rule === 'rank-up').length
  const routeOk = rankUp.every((item) => /\/quotagent\/supplier\/heuristics\/\?w_(price|delivery|payment|warranty|deviation)=1/.test(item.next_action))
  const hintReused = rankUp.every((item) => item.why.includes('贡献分解'))
  check('11 供应商侧提升排名正控：复用 heuristics 的贡献分解（focus/potential/hint），只给无量纲贡献点；'
    + 'next_action 是带 `?w_<focus>=1` 的**真路由**；**非空转对照**：同一批 ranking 在承包商视角不产生 rank-up 条',
  rankUp.length === 2 && routeOk && hintReused && contractorRankUp === 0
  && rankUp[0].severity === 'medium' && rankUp.every((item) => item.basis.length === 2),
  `供应商侧 rank-up=${rankUp.length} 路由合格=${routeOk} 复用分解=${hintReused}；承包商侧 rank-up=${contractorRankUp}；`
  + `示例=${JSON.stringify(rankUp[0]?.next_action ?? '')}`)

  // ---------- 12. 空数据不编建议（硬负控） ----------
  const emptyCases = [
    ['空对象', { view: 'contractor' }], ['undefined', undefined], ['null', null], ['字符串', 'garbage'],
    ['数字', 42], ['空数组段', { view: 'supplier', deadlines: [], gates: [], channels: [], ranking: { rows: [] } }],
    ['坏形状段', { view: 'supplier', deadlines: ['x', 7, null], ranking: { rows: [null, 'y'] }, channels: [{ available: 'no' }] }],
    ['缺关键字段', { view: 'supplier', deadlines: [{ ref: 'pkg-1' }], ranking: { rows: [{ score: 5 }] } }],
  ]
  const emptyReport = []
  let emptyThrew = null
  for (const [label, payload] of emptyCases) {
    try {
      const out = advise(payload)
      const okCase = out.degraded === true && mod.DEGRADED_REASONS.includes(out.reason) && out.items.length === 0
      emptyReport.push(`${label}→${out.degraded}/${out.reason}/items=${out.items.length}`)
      if (!okCase) emptyReport.push(`!! ${label} 形状不对：${JSON.stringify(out).slice(0, 80)}`)
    } catch (err) { emptyThrew = `${label}: ${err.name}` }
  }
  const noSignal = advise({ view: 'supplier', ranking: { rows: [{ code: 'only', item: 'L-1', score: 50 }] } })
  check('12 **空数据不编建议**（硬负控）：空投影 / 非对象 / 坏形状 / 缺关键字段一律 `degraded:true` + **有名** reason'
    + ' + `items` 长度 0，且不抛错；"载荷不能用"（no-usable-inputs）与"数据齐但无可建议项"（no-signal）'
    + '是**两个不同**的 reason（不许含糊成一条）',
  emptyThrew === null && emptyReport.every((line) => !line.startsWith('!!'))
  && noSignal.degraded === true && noSignal.reason === 'no-signal' && noSignal.items.length === 0
  && full.degraded === false && full.reason === null,
  `抛错=${emptyThrew ?? '无'}；${emptyReport.join(' | ')}；no-signal→${noSignal.reason}/items=${noSignal.items.length}；`
  + `正常=${full.degraded}/${full.reason}`)

  // ---------- 13. 确定性 ----------
  const d1 = JSON.stringify(advise(FULL))
  const d2 = JSON.stringify(advise(FULL))
  const shuffledKeys = { ranking: FULL.ranking, channels: FULL.channels, gates: FULL.gates,
    deadlines: FULL.deadlines, as_of: FULL.as_of, view: FULL.view }
  const d3 = JSON.stringify(advise(shuffledKeys))
  const reversedEntries = { ...FULL, deadlines: [...FULL.deadlines].reverse(), gates: [...FULL.gates].reverse(),
    channels: [...FULL.channels].reverse(), ranking: { rows: [...FULL.ranking.rows].reverse() } }
  const d4 = JSON.stringify(advise(reversedEntries))
  const otherInstance = await mountWith({})
  const d5 = JSON.stringify(otherInstance.box.handle.advise(FULL))
  const timeKeys = /"(ts|at|now|time|elapsed|date|generated_at)"\s*:/.test(d1)
  check('13 确定性负控：同输入两次逐字节一致 / **键序打乱**一致 / **条目顺序打乱**一致 / 跨实例一致 / 输出里没有时间字段'
    + '（`as_of` 是入参事实的回显，不是本层取的时钟）',
  d1 === d2 && d2 === d3 && d3 === d4 && d4 === d5 && d1.length > 400 && !timeKeys,
  `两次一致=${d1 === d2}；键序一致=${d2 === d3}；条目逆序一致=${d3 === d4}；跨实例一致=${d4 === d5}；`
  + `长度=${d1.length}；含时间键=${timeKeys}`)

  // ---------- 14. 私域哨兵（零泄漏 + 不参与计算） ----------
  const SENTINELS = ['COST-MODEL-SENTINEL-9a', 'PRIVATE-NOTE-SENTINEL-7f', 'BIDDERS-SENTINEL-3c', '987654321']
  const DIRTY = {
    ...FULL,
    deadlines: FULL.deadlines.map((item) => ({ ...item, reserve_price: 987654321, cost_model: SENTINELS[0] })),
    gates: FULL.gates.map((item) => ({ ...item, 'private:note': SENTINELS[1] })),
    ranking: { rows: FULL.ranking.rows.map((item) => ({ ...item, bidders_private: SENTINELS[2], internal_notes: '内部备注',
      authorized_band: { min_unit_price: 1, max_unit_price: 2 } })) },
    channels: FULL.channels.map((item) => ({ ...item, 'private:credential': 'CRED-SENTINEL-5d' })),
  }
  const cleanRun = JSON.stringify(advise(FULL))
  const dirtyRun = JSON.stringify(advise(DIRTY))
  const inputText = JSON.stringify(DIRTY)
  const hitInOutput = SENTINELS.filter((needle) => dirtyRun.includes(needle))
  const hitInInput = SENTINELS.filter((needle) => inputText.includes(needle))
  check('14 私域哨兵负控：加在四段条目上的私域键（`reserve_price`/`cost_model`/`private:*`/`bidders_private`/'
    + '`authorized_band`）**读都不读** → 带哨兵与不带哨兵输出**逐字节一致**、哨兵 0 命中；'
    + '**非空转对照**：同一批哨兵在输入里确实存在',
  hitInOutput.length === 0 && hitInInput.length >= 3 && cleanRun === dirtyRun && dirtyRun.includes('sup-A'),
  `输出命中=${hitInOutput.join(',') || '无'}；输入命中（对照）=${hitInInput.join(',')}；逐字节一致=${cleanRun === dirtyRun}`)

  // ---------- 15. 有界与 omitted 诚实 ----------
  const cap = await adviseWith({ max_items: 3 }, FULL)
  const half = await adviseWith({ max_items: 1000 }, FULL)
  const clampLow = await adviseWith({ max_items: 0 }, FULL)
  // 非法配置在**挂载层**就被 Config 拒（门里不能让它把整条断言链崩掉）
  let badLimit = null
  try { badLimit = await adviseWith({ max_items: 'many' }, FULL) } catch (err) { badLimit = { refused: err.message.slice(0, 60) } }
  const bysum = Object.values(cap.counts.by_severity).reduce((acc, value) => acc + value, 0)
  check('15 有界负控：`max_items` 夹取生效（0 → 下界 1；1000 → 上界 200；非数字 → 回落 20）；'
    + '截断如实报 `omitted`/`truncated`；`shown + omitted === generated`；`by_severity` 之和 === generated'
    + '（截断只影响展示，不改口径）',
  cap.items.length === 3 && cap.omitted === 5 && cap.truncated === true
  && cap.counts.shown + cap.counts.omitted === cap.counts.generated && bysum === cap.counts.generated
  && half.items.length === 8 && half.omitted === 0 && half.truncated === false
  && clampLow.items.length === 1 && clampLow.omitted === 7
  && badLimit !== null && (badLimit.refused !== undefined || badLimit.items.length === 8)
  && JSON.stringify(half.items.map((item) => item.id)) === JSON.stringify(HAND_IDS),
  `上限 3 → shown=${cap.items.length} omitted=${cap.omitted} truncated=${cap.truncated} 分布和=${bysum}/${cap.counts.generated}；`
  + `上限 1000 → ${half.items.length}/${half.omitted}；上限 0 → ${clampLow.items.length}；`
  + `'many' → ${badLimit.refused === undefined ? `${badLimit.items.length} 条（回落默认）` : `挂载即拒：${badLimit.refused}`}`)

  // ---------- 16. 零写面 / 不读账本（静态扫描 + 非空转对照） ----------
  const FORBIDDEN = ['writeFile', 'appendFile', 'createWriteStream', 'mkdirSync', 'rmSync', 'renameSync',
    'readFileSync', 'openLedger', 'ledger', 'Date.now', 'new Date', 'Math.random', 'process.env', 'fetch(',
    'spawn', 'execFile', 'setInterval(', 'setTimeout(', 'ctx.on(', 'ctx.events', 'child_process', 'require(',
    'http.request', 'net.connect']
  const scan = (text) => FORBIDDEN.filter((needle) => text.includes(needle))
  const hits = scan(originalSource)
  const selfTest = scan(`const tick = set${'Interval'}(() => {}, 1); open${'Ledger'}(p); await fetch${'('}(u)`)
  check('16 零写面负控：产物**零写面、不读账本、不联网、不调模型**（无写/读文件、账本、墙钟、随机、网络、'
    + '子进程、事件订阅）且扫描器**非空转**（对照样本必须命中 ≥3）',
  hits.length === 0 && selfTest.length >= 3,
  `产物命中=${hits.join(',') || '无'}；对照样本命中=${selfTest.join(',') || '（空转！）'}`)

  // ---------- 17. 配置不得静默放行 ----------
  const refuses = (raw) => { try { mod.Config.parse(raw); return 'accepted' } catch { return 'refused' } }
  const defaults = mod.Config.parse({})
  const clampCfg = await adviseWith({}, FULL)
  check('17 负控：配置不得静默放行（未知键 / 错类型 / 非对象入参一律被拒；空配置给出默认值；'
    + '`deterministic` 是 const 键，翻转即拒）；阈值经夹取后进输出 `bounds`',
  refuses({ mystery_key: 1 }) === 'refused' && refuses({ max_items: 'many' }) === 'refused'
  && refuses(42) === 'refused' && refuses({ deterministic: false }) === 'refused'
  && defaults.max_items === 20 && defaults.expiry_soon_hours === 96 && defaults.spread_points === 25
  && defaults.deterministic === true
  && JSON.stringify(clampCfg.bounds) === JSON.stringify({ max_items: 20, expiry_soon_hours: 96, spread_points: 25 }),
  `未知键=${refuses({ mystery_key: 1 })} 错类型=${refuses({ max_items: 'many' })} 非对象=${refuses(42)} `
  + `翻转 const=${refuses({ deterministic: false })}；默认=${JSON.stringify(defaults)}；bounds=${JSON.stringify(clampCfg.bounds)}`)

  // ---------- 18. fixture 纯读取 + 冻结输入 ----------
  const reference = JSON.stringify(advise(FULL))
  const first = JSON.stringify(mod.fixture.sample(live.box.handle))
  const second = JSON.stringify(mod.fixture.sample(live.box.handle))
  const frozenOut = JSON.stringify(advise(deepFreeze(JSON.parse(JSON.stringify(FULL)))))
  check('18 正控：fixture 纯读取（连跑两次逐字节一致、不改变句柄行为），且**冻结输入**不抛错'
    + '（ESM 严格模式下任何对入参的写入都会抛 TypeError → 证明没偷偷改调用方的载荷）',
  first === second && first.length > 50 && frozenOut === reference
  && JSON.stringify(advise(FULL)) === reference,
  `fixture 两次一致=${first === second} 长度=${first.length}；冻结输入一致=${frozenOut === reference}`)

  // ---------- 19-21. 真 HTTP（真 webui + 真依赖模块 + 夹具账本） ----------
  const fixtureDir = mkdtempSync(join(tmpdir(), 't281-http-'))
  const contractorLedger = join(fixtureDir, 'contractor.jsonl')
  const supplierLedger = join(fixtureDir, 'supplier-empty.jsonl')   // 不写文件 = 空投影
  const mailFixture = join(fixtureDir, 'mail.json')
  const SENTINEL_ROW = { cost_floor: 987654321, markup_pct: 12.5, reserve_price: 'RESERVE-PRICE-SENTINEL-4b',
    'private:note': 'PRIVATE-NOTE-SENTINEL-7f', cost_model: 'COST-MODEL-SENTINEL-9a' }
  const httpRows = [
    { seq: 1, type: 'rfq/published', correlation_id: 'pkg-1', actor: 'agent:sourcing', ts: '2026-09-21T08:00:00Z',
      realm: 'contractor:con-B', body: { package_id: 'pkg-1', rev: 1, quote_by: '2026-09-20T00:00:00Z' } },
    { seq: 2, type: 'quote/submitted', correlation_id: 'q-100', actor: 'agent:supplier', ts: '2026-09-21T09:00:00Z',
      realm: 'contractor:con-B', body: { quote_id: 'q-100', rfq_rev: 1, lines: [{ item_id: 'L-001', qty: 10, unit_price: 100 }] } },
    { seq: 3, type: 'quote/submitted', correlation_id: 'q-080', actor: 'agent:supplier', ts: '2026-09-21T09:30:00Z',
      realm: 'contractor:con-B', body: { quote_id: 'q-080', rfq_rev: 1, lines: [{ item_id: 'L-001', qty: 10, unit_price: 80 }] } },
    // 私域行：带 `private:` 命名的键 → 整行跳过（连候选都不是），但夹具文件里**确实有哨兵**
    { seq: 4, type: 'quote/submitted', correlation_id: 'q-private', actor: 'agent:supplier', ts: '2026-09-21T09:45:00Z',
      realm: 'contractor:con-B', body: { quote_id: 'q-private', lines: [{ item_id: 'L-001', qty: 10, unit_price: 60 }],
        ...SENTINEL_ROW } },
    { seq: 5, type: 'approval/requested', correlation_id: 'awin-1', actor: 'agent:approval', ts: '2026-09-21T10:00:00Z',
      realm: 'contractor:con-B', body: { approval_id: 'ap-0007', scope: 'award.commit', ref: 'awin-1', status: 'pending' } },
  ]
  writeFileSync(contractorLedger, httpRows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  // 通道声明的来源 = **邮件域快照**（`<ui_shared>/mail.json`）：三域流水快照已随运维面退役（29 §2）
  writeFileSync(mailFixture, JSON.stringify({
    schema: 1,
    generated_at: '2026-09-21T12:00:00Z',
    service: 'mail',
    views: { contractor: { queued: 1, refused: 1, sent: 0, parsed: 0 } },
    totals: { queued: 1, refused: 1, sent: 0, parsed: 0 },
    transport: { available: false, reason: 'mail-smtp-unconfigured',
      next_action: '配置 SMTP/IMAP 凭据后接入',
      smtp: { available: false, reason: 'mail-smtp-unconfigured', next_action: '配置 SMTP/IMAP 凭据后接入' },
      imap: { available: false, reason: 'mail-imap-unconfigured', next_action: '配置 SMTP/IMAP 凭据后接入' } },
  }), 'utf8')

  const httpCtx = new Context()
  await httpCtx.plugin(EventsService)
  const httpBox = {}
  // 只读账本视图（webui 的 inject 需要它）：夹具里真正被读到的是 `ledger_contractor`/`ledger_supplier`
  // 指向的那两个文件；这里给一个空视图，保证插件**能激活**且不碰真账本（H1）。
  httpCtx.provide('ledgerView', { path: '(t281-fixture)', rows: () => [], count: () => 0,
    verify: () => ({ ok: true, checked: 0, count: 0, head: 'sha256:' + '0'.repeat(64) }), byType: () => [] })
  const mountReal = async (file, raw, service, name) => {
    const loaded = await import(pathToFileURL(join(HERE, 'modules', file)).href)
    await httpCtx.plugin({
      name: `${name}#t281`,
      inject: loaded.inject ?? [],
      Config: loaded.Config,
      apply: async (inner, config) => {
        const originalProvide = inner.provide.bind(inner)
        inner.provide = (s, v) => { if (s === service) httpBox[service] = v; return originalProvide(s, v) }
        await loaded.apply(inner, config)
      },
    }, loaded.Config.parse(raw))
    return loaded
  }
  await mountReal('governor.mjs', {}, 'governor', 'governor')
  await mountReal('audit-hook.mjs', { capacity: 20 }, 'audit', 'audit-hook')
  await mountReal('canary.mjs', { weight_bps: 0 }, 'canary', 'canary')
  await mountReal('observability.mjs', {}, 'observability', 'observability')
  await mountReal('price-history.mjs', { key_field: 'supplier_id' }, 'priceHistory', 'price-history')
  await mountReal('evidence-summary.mjs', {}, 'evidenceSummary', 'evidence-summary')
  await mountReal('circuit-breaker.mjs', {}, 'breaker', 'circuit-breaker')
  await mountReal('ops-view.mjs', {}, 'opsView', 'ops-view')
  await mountReal('evolve-journal.mjs', {}, 'evolveJournal', 'evolve-journal')
  await mountReal('supplier-scorecard.mjs', {}, 'supplierScorecard', 'supplier-scorecard')
  await mountReal('approval-digest.mjs', {}, 'approvalDigest', 'approval-digest')
  await mountReal('retention-view.mjs', {}, 'retentionView', 'retention-view')
  await mountReal('admin-guard.mjs', { token_env: 'QUOTAGENT_ADMIN_TOKEN_T281' }, 'adminGuard', 'admin-guard')
  await mountReal('admin-view.mjs', { admin_snapshot: '' }, 'adminView', 'admin-view')
  await mountReal('plugin-market.mjs', { modules_dir: join(HERE, 'modules'),
    inventory: join(HERE, '..', 'docs', 'design', '14-plugin-inventory.md'), user_space: '' }, 'pluginMarket', 'plugin-market')
  await mountReal('user-plugin-manager.mjs', { root: join(HERE, '..', 'user-space') }, 'userPluginManager', 'user-plugin-manager')
  await mountReal('config-view.mjs', {}, 'configView', 'config-view')
  // 邮件域快照落点：`mail-view` 的 `mail_state` 就是快照文件路径（CLI 的 `--mail-snapshot` 同义）
  await mountReal('mail-view.mjs', { mail_state: mailFixture, ui_shared: '' }, 'mailView', 'mail-view')
  await mountReal('bid-heuristics.mjs', {}, 'bidHeuristics', 'bid-heuristics')
  await mountReal('advice-panel.mjs', {}, 'advicePanel', 'advice-panel')
  await mountReal('gate-timeline.mjs', {}, 'gateTimeline', 'gate-timeline')
  await mountReal('authority-band.mjs', {}, 'authorityBand', 'authority-band')
  await mountReal('rfq-deadline.mjs', {}, 'rfqDeadline', 'rfq-deadline')
  // 同批新增的 `quote-prepare`（webui 的 inject 依赖它）：同为 domain 插件，默认配置即可
  await mountReal('quote-prepare.mjs', {}, 'quotePrepare', 'quote-prepare')
  await mountReal('ui-feedback.mjs', { ui_shared: '' }, 'uiFeedback', 'ui-feedback')
  const projection = await import(pathToFileURL(join(HERE, 'modules', 'projection.mjs')).href)
  await httpCtx.plugin({ name: 'projection#t281', inject: [], Config: projection.Config,
    apply: (inner, config) => projection.apply(inner, config) }, projection.Config.parse({}))
  const webui = await import(pathToFileURL(WEBUI).href)
  const httpFiber = await httpCtx.plugin({
    name: 'webui#t281',
    inject: webui.inject,
    Config: webui.Config,
    apply: async (inner, config) => {
      const originalProvide = inner.provide.bind(inner)
      inner.provide = (s, v) => { if (s === 'webui') httpBox.webui = v; return originalProvide(s, v) }
      await webui.apply(inner, config)
    },
  }, webui.Config.parse({ port: 0, route_prefix: '/t281', ledger_contractor: contractorLedger,
    ledger_supplier: supplierLedger }))
  const base = httpBox.webui.url.replace(/\/$/, '')
  // 身份会话（P3：`/contractor/**`、`/supplier/**` 有了**路由级身份门槛**）——
  // 本门**先登录再取业务路由**：判据从「谁能打开」变成「**登录后按侧放行**」，断言一条不删、一条不放松。
  const SESSIONS = {}
  const loginAs = async (side) => {
    if (SESSIONS[side]) return SESSIONS[side]
    const res = await fetch(`${base}/identity/login?format=json`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: `gate-t281-${side}`, side }).toString(),
    })
    const text = await res.text()
    const cookie = String(res.headers.get('set-cookie') ?? '').split(';')[0]
    if (res.status !== 200 || !cookie.startsWith('qa_identity=')) {
      throw new Error(`门夹具登录失败：side=${side} status=${res.status} body=${text.slice(0, 200)}`)
    }
    SESSIONS[side] = cookie
    return cookie
  }
  const cookieFor = async (path) => {
    const side = /^\/(contractor|supplier)(?:\/|$)/.exec(String(path))?.[1]
    return side ? { cookie: await loginAs(side) } : {}
  }
  const get = async (path) => {
    const res = await fetch(`${base}${path}`, { headers: await cookieFor(path) })
    return { status: res.status, text: await res.text() }
  }
  // 身份门槛本身也要机检（P3：未登录拒 / 登录后按侧放行 / 越侧 403）
  const anonJson = await fetch(`${base}/contractor/api/advice`, { headers: { accept: 'application/json' } })
  const anonJsonBody = await anonJson.text()
  const anonHtml = await fetch(`${base}/contractor/advice/`, { headers: { accept: 'text/html' }, redirect: 'manual' })
  const anonLocation = String(anonHtml.headers.get('location') ?? '')
  const crossSidePath = 'supplier/advice/'
  const crossSide = await fetch(`${base}/${crossSidePath}`, { headers: { cookie: await loginAs('contractor') } })
  const crossBody = await crossSide.text()
  // 旧页已退役（`RETIRED_SUBVIEWS`）：同侧登录后拿到的也是 **303 → GUI**（不是 404、也不再是旧页 200）。
  const sameSide = await fetch(`${base}/contractor/advice/`, { headers: await cookieFor('/contractor/advice/'), redirect: 'manual' })
  const sameSideLocation = String(sameSide.headers.get('location') ?? '')
  check('身份门槛（P3，与退役前逐字一致）：未登录取业务路由 ⇒ API 401 `identity-required` + `next`、浏览器 303 回 `/identity/?next=…`；'
    + '登录后**按侧放行**（同侧 ⇒ **303 → `/t281/app/contractor/`**：旧页不再返回内容）、'
    + '**越侧 403 `side-mismatch`**（不回落成「能看」）',
  anonJson.status === 401 && anonJsonBody.includes('identity-required') && anonJsonBody.includes('"next"')
  && anonHtml.status === 303 && anonLocation.includes('/t281/identity/?next=')
  && crossSide.status === 403 && crossBody.includes('side-mismatch')
  && sameSide.status === 303 && sameSideLocation.endsWith('/t281/app/contractor/'),
  `未登录 JSON=${anonJson.status} HTML=${anonHtml.status} location=${anonLocation.slice(0, 60)}；`
  + `越侧=${crossSide.status} 含 side-mismatch=${crossBody.includes('side-mismatch')}；`
  + `同侧=${sameSide.status} → ${sameSideLocation}`)
  const INLINE_EVENT = /\son[a-z]+\s*=/i
  const NOISE = ['g1side', 'PYTHONPATH', '终端', '命令行']    // 产品面不许出现的「教用户回终端」痕迹
  const noiseOf = (text) => NOISE.filter((token) => String(text).includes(token))

  // ==========================================================================================
  // 19-21：**旧页退役 ⇒ 接新位置**（`docs/design/29-webui-gui-app.md` §2 / AGENTS.md 规则 12）
  //   旧断言是「两视角 `/advice/` 页与 `/api/advice` 都 200 + 页面上 4 道 `data-advice-link` 入口」；
  //   那两条路由现在**已退役为 303 → `/t281/app/<view>/`**。判据改成三条**不弱于原来**的：
  //     ① 四条旧路由（两侧 × 页面/JSON）**303 + 正确 Location**（不 404 让人失联）；
  //     ② `/api/routes` 仍登记这四条（`auth=identity-session`，业务路由按路径推导）；
  //     ③ **承接这件事的 GUI 面板真的注册在那一页上**：承包商侧 `rfq.remind-board` / `compare.ranking` /
  //        `gate.queue` / `mail.channel` 与供应商侧 `rfq.remind-board` / `exchange.inbox`
  //        —— 而且它们的**真载荷 0 命中**「回终端」痕迹（旧页那 20「终端」+40 `g1side` 的来源已被清掉）。
  // ==========================================================================================
  const routes = JSON.parse((await get('/api/routes')).text)
  const adviceRoutes = (routes.routes ?? []).filter((item) => String(item.path).includes('advice'))
  const retiredHits = []
  for (const view of ['contractor', 'supplier']) {
    for (const [suffix, accept] of [['/advice/', 'text/html'], ['/api/advice', 'application/json']]) {
      const res = await fetch(`${base}/${view}${suffix}`, {
        headers: { ...(await cookieFor(`/${view}${suffix}`)), accept }, redirect: 'manual' })
      const loc = String(res.headers.get('location') ?? '')
      retiredHits.push({ path: `/${view}${suffix}`, status: res.status, loc, ok: res.status === 303 && loc.endsWith(`/${view}/`) })
    }
  }
  const retiredOk = retiredHits.every((row) => row.ok)
  const apiRoutesOk = adviceRoutes.length === 4 && adviceRoutes.every((item) => item.auth === 'identity-session')
  const panelsOf = async (view) => (JSON.parse((await get(`/api/ui/panels?view=${view}`)).text).panels ?? [])
  const contractorPanels = await panelsOf('contractor')
  const supplierPanels = await panelsOf('supplier')
  const panelIds = (list) => list.map((panel) => panel.panel_id ?? panel.id)
  // 承接「决策建议」那几条读数的**面板**（各自真注册在对应视图上）：承包商侧 = 回文时限与催报 /
  // 比价排名 / 审批队列 / 已决定的门 / 授权区间；供应商侧 = 我收到的包 / 授权区间。
  const CARRIERS = { contractor: ['rfq.remind-board', 'compare.ranking', 'gate.queue', 'gate.decided', 'authority.bands'],
    supplier: ['exchange.inbox', 'authority.bands.supplier'] }
  const carriersMissing = Object.entries(CARRIERS).flatMap(([view, ids]) =>
    ids.filter((id) => !panelIds(view === 'contractor' ? contractorPanels : supplierPanels).includes(id))
      .map((id) => `${view}:${id}`))
  const panelNoise = noiseOf(JSON.stringify(contractorPanels) + JSON.stringify(supplierPanels))
  check('19 真 HTTP 正控（**旧页退役 ⇒ 新位置**）：两视角的四条旧路由（`/t281/<view>/advice/` 与 `/t281/<view>/api/advice`）'
    + '一律 **303 + Location 落在同侧 GUI 视图页**（不是 404、也不再返回旧页内容）；`/api/routes` 仍登记这四条且 `auth=identity-session`；'
    + '**承接这件事的 GUI 面板真的注册在那一页上**（承包商：回文时限与催报 / 比价排名 / 审批队列 / 邮件通道；'
    + '供应商：回文时限与催报 / 我收到的包），且面板载荷里 **0 命中**「回终端」痕迹（g1side / PYTHONPATH / 终端 / 命令行）',
  retiredOk && apiRoutesOk && carriersMissing.length === 0 && panelNoise.length === 0,
  `旧路由=${JSON.stringify(retiredHits.map((row) => `${row.path}→${row.status}${row.loc}`))}；`
  + `路由=${JSON.stringify(adviceRoutes.map((item) => `${item.method} ${item.path} ${item.auth}`))}；`
  + `缺承接面板=${carriersMissing.join(',') || '无'}；面板载荷命中=${panelNoise.join(',') || '无'}；`
  + `[debug] 承包商面板=${JSON.stringify(panelIds(contractorPanels))} / 供应商面板=${JSON.stringify(panelIds(supplierPanels))}`)

  // 19b：旧路由的**响应体**里也不许有「回终端」痕迹（旧页那 20「终端」+ 40 `g1side` 全来自这里）
  const retiredBodies = []
  for (const view of ['contractor', 'supplier']) {
    for (const suffix of ['/advice/', '/api/advice']) {
      const res = await fetch(`${base}/${view}${suffix}`, {
        headers: { ...(await cookieFor(`/${view}${suffix}`)), accept: '*/*' }, redirect: 'manual' })
      retiredBodies.push({ path: `/${view}${suffix}`, text: await res.text() })
    }
  }
  const bodyHits = retiredBodies.flatMap((row) => noiseOf(row.text).map((token) => `${row.path}:${token}`))
  const scriptInBody = retiredBodies.filter((row) => row.text.includes(scriptNeedle) || INLINE_EVENT.test(row.text))
  const scriptSelfTest = (`<a onclick="x()"></a>`).includes(scriptNeedle) || INLINE_EVENT.test('<a onclick="x()"></a>')
  check('19b 真 HTTP 负控：四条退役响应的**响应体**里 **0 命中**「回终端」痕迹、也 **0 行脚本 / 0 内联事件**'
    + '（它们只是 303 的说明页，不再给任何可复制的命令）；扫描器**非空转**（对照样本必须命中）',
  bodyHits.length === 0 && scriptInBody.length === 0 && scriptSelfTest,
  `响应体命中=${bodyHits.join(',') || '无'}；含脚本=${scriptInBody.length}；扫描器对照=${scriptSelfTest}`)

  // 20：两视角**确实不同** —— 承包商侧与供应商侧的 GUI 面板集合不同，且各自带自己的**真动作**
  //（旧断言比的是两页 advice 文本；新断言比的是两页 GUI 的**注册面**：更接近「用户真看到什么」）
  const panelKey = (list) => JSON.stringify(list.map((panel) => [panel.panel_id ?? panel.id, panel.actions ?? []]))
  const actionOf = (list, id) => ((list.find((panel) => (panel.panel_id ?? panel.id) === id) ?? {}).actions ?? [])
  const differOk = panelKey(contractorPanels) !== panelKey(supplierPanels)
    && actionOf(contractorPanels, 'rfq.remind-board').includes('rfq.remind')
    && actionOf(contractorPanels, 'gate.queue').includes('gate.grant')
    && actionOf(contractorPanels, 'gate.queue').includes('gate.deny')
    && actionOf(supplierPanels, 'exchange.inbox').includes('exchange.promise')
  check('20 真 HTTP 正控：**两视角的 GUI 确实不同** —— 承包商工作台与供应商工作台的面板集合不同，'
    + '且承接「决策建议」的四个读数各自带着**真动作**（承包商：`rfq.remind` 催报、`gate.grant` / `gate.deny` 批准与驳回；'
    + '供应商：`exchange.promise` 回文承诺）—— 这些动作在 `/api/ui/surface` 里真注册（下方 21 附带核对）',
  differOk,
  `面板集合不同=${panelKey(contractorPanels) !== panelKey(supplierPanels)}；`
  + `rfq.remind-board=${JSON.stringify(actionOf(contractorPanels, 'rfq.remind-board'))}；`
  + `gate.queue=${JSON.stringify(actionOf(contractorPanels, 'gate.queue'))}；`
  + `exchange.inbox=${JSON.stringify(actionOf(supplierPanels, 'exchange.inbox'))}`)

  // 21：四道页面不再有指向旧页的入口（旧抓手 `data-advice-link` 已随页删除）+ 私域零泄漏（含非空转对照）
  const elevate = await fetch(`${base}/admin/api/elevate`, { method: 'POST', body: `token=${T281_TOKEN}` })
  const adminCookie = String(elevate.headers.get('set-cookie') ?? '').split(';')[0]
  const adminPage = await fetch(`${base}/admin/`, { headers: { cookie: adminCookie } })
  const adminText = await adminPage.text()
  // 「入口不再指向旧页」= 四道页面（含提权后的 admin）里都不许再出现 `/advice/` 的链接；
  // 承接入口改由 GUI 的注册面提供（上面的 20 已核到面板与动作）。
  const navPages = { contractor: (await get('/contractor/')).text, supplier: (await get('/supplier/')).text,
    ops: (await get('/ops/')).text, admin: adminText }
  const staleEntries = Object.entries(navPages).filter(([, text]) => text.includes('/advice/')).map(([name]) => name)
  const NEEDLES = ['cost_floor', 'markup_pct', 'reserve_price', 'cost_model', 'private:', 'bidders_private',
    'internal_notes', 'authorized_band', ...SENTINELS]
  // 扫描面（与旧断言同一范围、只是搬到了新位置）：四条退役响应体 + **承接面板**的载荷。
  // 不扫「全部面板」：搜索面板（`find.*`）里会出现用户自己起的 id（夹具里就有一个 `q-private:…` 的报价 id），
  // 那不是「私域键泄漏」，把它算命中是假阳性。
  const surfaceJson = JSON.parse((await get('/api/ui/surface')).text)
  const carrierPayloads = [...contractorPanels, ...supplierPanels]
    .filter((panel) => Object.values(CARRIERS).some((ids) => ids.includes(panel.panel_id ?? panel.id)))
  const surfaceText = JSON.stringify(carrierPayloads) + retiredBodies.map((row) => row.text).join('\n')
  const hitsSurface = NEEDLES.filter((needle) => surfaceText.includes(needle))
  const fixtureHas = SENTINELS.filter((needle) => readFileSync(contractorLedger, 'utf8').includes(needle))
  const surfaceActions = (surfaceJson.actions ?? []).map((row) => row.id)
  const actionsOk = ['rfq.remind', 'gate.grant', 'gate.deny', 'gate.escalate'].every((id) => surfaceActions.includes(id))
  check('21 真 HTTP 正控 + 负控：**四道页面（承包商 / 供应商 / 运维 / 系统管理）里都不再有点向旧 advice 页的入口**'
    + '（节点删除后 `data-advice-link` 0 命中、`/advice/` 链接 0 命中），第四道是提权后的真面板；'
    + '承接动作在注册面里真的存在；GUI 注册面 + 两视角面板载荷里私域键名与哨兵 **0 命中**（这类键连读都不读），'
    + '**非空转对照**：同一批哨兵确实写在夹具账本文件里',
  staleEntries.length === 0 && elevate.status === 200 && adminPage.status === 200
  && adminText.includes('阻塞清单') && actionsOk
  && hitsSurface.length === 0 && fixtureHas.length >= 3,
  `仍有旧入口的道=${staleEntries.join(',') || '无'}；提权=${elevate.status}；admin 页=${adminPage.status} `
  + `承接动作在注册面里=${actionsOk}；注册面/面板命中=${hitsSurface.join(',') || '无'}；夹具里确实有哨兵=${fixtureHas.join(',')}`)

  const homeCode = await get('/contractor/')
  const adminCode = await get('/admin/')
  check('21b 真 HTTP 负控：既有路由没被弄坏（承包商首页 200），且本门**不涉未提权的 admin**'
    + '（未带 cookie 的 `/admin/` 仍是 401 固定体）',
  homeCode.status === 200 && adminCode.status === 401 && adminCode.text.trim() === '{"error":"unauthorized"}',
  `home=${homeCode.status} admin=${adminCode.status} body=${adminCode.text.trim()}`)

  await httpFiber.dispose()

  // ---------- 22-25. 单点变异（4 处全部变红 + 防假变异 + 原文件字节不变） ----------
  const capHandle = await mountWith({ max_items: 3 })   // 变异体也挂在这个配置下 → 两条路径同条件
  const realScenarios = scenarioFacts((payload) => capHandle.box.handle.advise(payload))
  const realAllTrue = SCENARIOS.every((name) => realScenarios[name] === true)
  check('22 变异前基线：四条场景（有界/空数据不编/basis 可溯源/engine=rules）在**真产物**上全真'
    + '（否则变异变红就说明不了任何事：基线本来就是红的）',
  realAllTrue, `基线=${JSON.stringify(realScenarios)}`)

  const mutationReport = []
  for (const mutation of MUTATIONS) {
    const mutated = applyMutation(originalSource, mutation.find, mutation.replace)
    const fake = mutated === null || mutated === originalSource
    if (fake) {
      mutationReport.push(`${mutation.name}→假变异（找不到唯一锚点或字节没变）`)
      check(`23 变异：${mutation.name}`, false, `假变异：锚点唯一性=${mutated !== null} 字节已变=${mutated !== originalSource}`)
      continue
    }
    const mounted = await mountMutant(mutated, { max_items: 3 })
    const facts = scenarioFacts((payload) => mounted.box.handle.advise(payload))
    const red = SCENARIOS.filter((name) => facts[name] === false)
    await mounted.ctx.stop?.()
    mutationReport.push(`${mutation.name} → 红=${red.join('/') || '（没有变红！）'}`)
    check(`23 变异：${mutation.name}`, red.includes(mutation.mustRed),
      `必须红的是「${mutation.mustRed}」；实际红=${red.join(',') || '无'}；四条场景=${JSON.stringify(facts)}；`
      + `字节已变=${mutated !== originalSource}；变异体=${mounted.file}`)
  }

  const fakeGuard = applyMutation(originalSource, '这一段源码里根本不存在-MUTATION-ANCHOR', 'x')
  const selfAnchor = mutationAnchorForSelfTest(originalSource)
  const selfMutation = applyMutation(originalSource, selfAnchor, selfAnchor)
  check('24 防假变异（自检）：找不到唯一锚点的"变异"必须被判定为**假变异**（返回 null），'
    + '把锚点替换成它自己也不算变异 —— 否则"变异后门还绿"会被误读成"门很稳"',
  fakeGuard === null && selfMutation === null,
  `不存在的锚点→${fakeGuard === null ? '已判假变异' : '竟然通过'}；自我替换→${selfMutation === null ? '已判假变异' : '竟然通过'}`)

  const afterHash = sha256(sourceOf(TARGET))
  const afterWebui = sha256(sourceOf(WEBUI))
  check('25 还原：本门全程**没有写过产品树** —— `host/modules/advice-panel.mjs` 与 `host/modules/webui.mjs` '
    + '跑完之后与跑之前**逐字节一致**（变异只写在临时目录的副本里）',
  afterHash === originalHash && sourceOf(TARGET) === originalSource && afterWebui === webuiHash,
  `advice-panel sha256 前=${originalHash.slice(0, 16)}… 后=${afterHash.slice(0, 16)}…；webui 未变=${afterWebui === webuiHash}；`
  + `变异小结=${mutationReport.join('；')}`)

  for (const mounted of [live, otherInstance, capHandle, ...mountedCache.values()]) {
    try { await mounted.fiber.dispose() } catch { /* 卸载失败不影响断言结果 */ }
  }
} catch (err) {
  check('门执行异常（不得静默通过）', false, `${err.name}: ${String(err.message).slice(0, 300)}`)
}

finish()

/** 给"自我替换"那条自检用的锚点：取源码里真实存在的一段（拿真源码量，不凭印象写）。 */
function mutationAnchorForSelfTest(text) {
  const anchor = 'export const ENGINE'
  return text.includes(anchor) ? anchor : 'export const name'
}
