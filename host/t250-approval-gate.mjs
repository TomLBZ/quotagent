/**
 * t250-approval-gate —— T-250「人工门待批摘要」候选产物的**围栏门**（宿主侧人工维护，不由被围对象自己写；
 * 可写面纪律见 ADR-0016：门不能由被围的产物自己写）。
 *
 * 被围对象：`approval-digest`（tmp 阶段是 `./../tmp/t250-approval.mjs`，晋升后是 `./modules/approval-digest.mjs`）。
 * 两阶段都能跑：先试进树产物，再回退到候选源码；**实际加载到的绝对路径、字节数与 sha256 写进第 1 条断言的 detail**
 * （不许「看着通过」—— 变异测试就是靠这一行确认「红的是我改的那一份」）。
 *
 * 已知坑（必须处理，否则直接 ERR_MODULE_NOT_FOUND）：产物按契约 `import ... from '../lib/std-schema.mjs'`，
 * 而从 `tmp/` 看 `../lib` = **仓库根**的 `lib/`，它并不存在（仓库根 lib/ 是运行时产物目录，被 .gitignore 忽略）。
 * 这里用仓库既有做法（同 `tools/evolve-module.mjs` 的影子目录、`t247-idem-gate.mjs`）：在 gitignored 的
 * `tmp/t250-approval-gate-shadow/` 里把 `host/lib` 软链过去、把产物**按字节复制**进去，再 import 影子里的那一份，
 * 并断言「复制前后字节一致」。影子只落在 tmp/ 内，仓库里其它文件一个字不动，也不在仓库外写文件。
 *
 * 断言（10 条，其中 6 条是**负控**；每条都写清「什么情况下必须变红」）：
 *   1 契约正控：manifest 齐备（name/inject/builtin/usedServices/provides=['approvalDigest']/Config/apply/fixture）
 *      + 只 import `../lib` 白名单 + **打印实际加载路径/字节数/sha256**
 *   2 挂载正控：cordis 挂载后 provide 拦截拿得到句柄（键恰好 digest/byPolicy/oldest）；dispose 后 effect 归零（规则 1）
 *   3 手算正控：6 条真形状待批行逐字段等于**手算**值（算式见注释，不用实现验实现）+ 桶边界（w 恰为 24h）+ 阈值
 *   4 负控：坏输入（null/undefined/非数组/垃圾行/NaN/Infinity/字符串数字/负等待）不崩，输出里无非有限数
 *   5 负控：缺字段**不编造**（缺等待时间的行整行跳过、**不当 0**；缺置信度归 none；缺 id/动作跳过；行优先于 body；别名）
 *   6 负控：确定性（同输入两次字节一致 / 跨实例一致 / 逆序输入一致 / 输出无时间字段 / 最长项平手不依赖入参顺序）
 *   7 负控：静态扫描产物零副作用（无墙钟/定时器/文件/事件订阅/环境变量/网络/随机）+ **扫描器非空转对照**
 *   8 负控：输出里**不得出现正文**（喂带 summary/payload/refs/token 的敏感行，输出里搜不到键名与值）
 *   9 负控：配置契约 —— 越界被夹取（1e9→8、0/-5→1、NaN→4、5.7→5，且夹取可从 `limits` 与桶数核对）
 *      且未知键/错误类型/非对象入参一律被拒（不得静默放行）
 *  10 正控：fixture 纯读取（连跑两次字节一致、不改变句柄行为）+ 冻结输入不抛错（没偷偷改调用方的行）
 *
 * 输出：**一行** JSON `{"checks":[{name,ok,detail}],"passed":N,"total":N,"failures":N}`；全绿 exit 0，否则 exit 1。
 * 用法：`tools/cordis.sh run ../host/t250-approval-gate.mjs`（cwd 无关：路径都由 import.meta.url 推出）。
 */
import { Context, EventsService } from 'cordis'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const IN_TREE = join(HERE, 'modules', 'approval-digest.mjs')          // 晋升后的位置
const FROM_TMP = join(ROOT, 'tmp', 't250-approval.mjs')               // ← './../tmp/t250-approval.mjs'
const SHADOW = join(ROOT, 'tmp', 't250-approval-gate-shadow')

const CHECKS = []
const check = (name, ok, detail = '') => { CHECKS.push({ name, ok: Boolean(ok), detail }) }

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

const finish = () => {
  // 空集合守卫：一条断言都没跑 = 红的（「没跑到」不得当成「通过」，本仓已有教训）
  if (CHECKS.length === 0) check('空集合守卫：门至少跑了一条断言', false, 'CHECKS 为空')
  const failures = CHECKS.filter((item) => !item.ok).length
  writeSync(1, JSON.stringify({ checks: CHECKS, passed: CHECKS.length - failures,
    total: CHECKS.length, failures }) + '\n')
  process.exit(failures === 0 ? 0 : 1)
}

/** 定位并加载产物：晋升前从 tmp/（经影子目录），晋升后直接是同目录的 modules/。 */
const loadArtifact = async () => {
  if (existsSync(IN_TREE)) {
    return { mod: await import(pathToFileURL(IN_TREE).href), source: readFileSync(IN_TREE, 'utf8'),
      path: IN_TREE, copied: null }
  }
  if (!existsSync(FROM_TMP)) return null
  mkdirSync(join(SHADOW, 'modules'), { recursive: true })
  const libLink = join(SHADOW, 'lib')
  if (!existsSync(libLink)) symlinkSync(join(ROOT, 'host', 'lib'), libLink, 'dir')
  const copyPath = join(SHADOW, 'modules', 'approval-digest.mjs')
  copyFileSync(FROM_TMP, copyPath)
  const source = readFileSync(FROM_TMP, 'utf8')
  const copied = readFileSync(copyPath, 'utf8') === source
  return { mod: await import(pathToFileURL(copyPath).href), source, path: FROM_TMP, copied,
    copyPath }
}

/** 挂载：照抄产物声明的 `inject`（写成 [] 会让它取不到依赖），并包装 `provide` 抓句柄。 */
const mountWith = async (mod, raw = {}) => {
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

/** 递归找非有限数（`JSON.stringify` 会把 NaN 写成 null，扫 JSON 文本是抓不到的）。 */
const badNumbers = (value, path = '') => {
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [path || '(root)']
  if (Array.isArray(value)) return value.flatMap((item, index) => badNumbers(item, `${path}[${index}]`))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => badNumbers(item, path ? `${path}.${key}` : key))
  }
  return []
}

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

// 主样例：6 条真形状待批行（不同动作 / 置信度 / 策略 / 等待秒数）+ 1 条缺等待时间 + 3 条垃圾行
const ROWS = [
  { approval_id: 'ap-0001', action: 'quote.submit', model_confidence: 0.72, timeout_policy: 'remind',
    waited_seconds: 300 },                                                     // 300s → <1h；0.72 → mid
  { approval_id: 'ap-0002', action: 'award.commit', model_confidence: 0.55, timeout_policy: 'escalate',
    waited_seconds: 7200 },                                                    // 7200s → 1-6h；0.55 → low
  { approval_id: 'ap-0003', action: 'po.issue', model_confidence: 0.91, timeout_policy: 'abort',
    waited_seconds: 43200 },                                                   // 43200s → 6-24h；0.91 → high
  { approval_id: 'ap-0004', action: 'quote.submit', model_confidence: 0.8, timeout_policy: 'remind',
    waited_seconds: 90000 },                                                   // 90000s → >24h；0.80 → high（≥0.8）
  { approval_id: 'ap-0005', action: 'award.commit', timeout_policy: 'remind', waited_seconds: 86401 },
                                                                              // 86401s → >24h；缺置信度 → none
  { body: { approval_id: 'ap-0006', action: 'change.approve', model_confidence: 0.6,
    timeout_policy: 'escalate', waited_seconds: 86400 } },                     // body 回退；86400s 恰为 24h → 6-24h（右闭）
  { approval_id: 'ap-0007', action: 'quote.submit', timeout_policy: 'abort' },  // 缺 waited_seconds → 整行跳过
  null, 'garbage', 42,                                                        // 非对象行 → 跳过
]
// 手算（**不跑实现算出来的**）：
//   行数 = 10；计入 = 6（ap-0001..0006）；跳过 = 4（ap-0007、null、'garbage'、42）
//   by_action（字典序）：award.commit=2（0002,0005）；change.approve=1；po.issue=1；quote.submit=2（0001,0004）
//   by_age（右闭）：<1h = {300} = 1；1-6h = {7200} = 1；6-24h = {43200, 86400} = 2；>24h = {90000, 86401} = 2
//   by_confidence：none = 1（0005 缺）；low = 1（0.55）；mid = 2（0.72, 0.60）；high = 2（0.91, 0.80）
//   oldest：最大等待 90000（ap-0004）
//   stale（**严格** > 24h=86400）：90000 ✓、86401 ✓、86400 ✗（右闭区间让 86400 归属唯一，不被两个口径各说一遍）→ 2
//   byPolicy：remind = 3（0001,0004,0005）；escalate = 2（0002,0006）；abort = 1（0003）→ 固定枚举序输出
const HAND = {
  rows: 10, total: 6, skipped: 4,
  by_action: [{ action: 'award.commit', count: 2 }, { action: 'change.approve', count: 1 },
    { action: 'po.issue', count: 1 }, { action: 'quote.submit', count: 2 }],
  by_age: [{ bucket: '<1h', count: 1 }, { bucket: '1-6h', count: 1 }, { bucket: '6-24h', count: 2 },
    { bucket: '>24h', count: 2 }],
  by_confidence: { none: 1, low: 1, mid: 2, high: 2 },
  oldest: { id: 'ap-0004', action: 'quote.submit', waited_seconds: 90000 },
  stale: 2,
  limits: { stale_hours: 24, max_buckets: 4 },
}
const HAND_POLICY = [{ policy: 'remind', count: 3 }, { policy: 'escalate', count: 2 },
  { policy: 'abort', count: 1 }]
const DIGEST_KEYS = Object.keys(HAND)
const EMPTY = {
  rows: 0, total: 0, skipped: 0, by_action: [],
  by_age: [{ bucket: '<1h', count: 0 }, { bucket: '1-6h', count: 0 }, { bucket: '6-24h', count: 0 },
    { bucket: '>24h', count: 0 }],
  by_confidence: { none: 0, low: 0, mid: 0, high: 0 }, oldest: null, stale: 0,
  limits: { stale_hours: 24, max_buckets: 4 },
}

const artifact = await loadArtifact()
const fibers = []
let mod = null

try {
  // ---------- 1. 契约正控（含实际加载路径 / 字节数 / sha256） ----------
  const source = artifact ? artifact.source : ''
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  const importLeaks = imports.filter((spec) => !(spec === '../lib/std-schema.mjs' || spec.startsWith('node:')))
  mod = artifact ? artifact.mod : null
  const manifest = {
    name: mod?.name === 'approval-digest',
    inject: Array.isArray(mod?.inject) && mod.inject.length === 0,
    builtin: Array.isArray(mod?.builtin) && mod.builtin.length === 0,
    usedServices: Array.isArray(mod?.usedServices) && mod.usedServices.length === 0,
    provides: JSON.stringify(mod?.provides) === JSON.stringify(['approvalDigest']),
    config: typeof mod?.Config?.['~standard']?.validate === 'function',
    apply: typeof mod?.apply === 'function',
    fixture: typeof mod?.fixture?.sample === 'function',
  }
  const manifestBad = Object.entries(manifest).filter(([, ok]) => !ok).map(([key]) => key)
  check('1 契约正控：manifest 齐备（name=approval-digest / inject=[] / builtin=[] / usedServices=[] / '
    + 'provides=[approvalDigest] / Config / apply / fixture）且只 import ../lib 白名单',
  mod !== null && manifestBad.length === 0 && importLeaks.length === 0,
  `载入路径=${artifact ? artifact.path : '（未找到产物）'}；字节=${Buffer.byteLength(source, 'utf8')}；`
  + `sha256=${sha256(source)}；影子副本=${artifact?.copyPath ?? '（进树，无需影子）'}；`
  + `影子字节一致=${artifact?.copied ?? 'n/a'}；import=${JSON.stringify(imports)}；越界=${importLeaks.join(',') || '无'}；`
  + `问题键=${manifestBad.join(',') || '无'}`)
  if (!mod) finish()

  // ---------- 2. 挂载正控 + 零残留 ----------
  const probe = await mountWith(mod, {})
  fibers.push(probe.fiber)
  const effectsBefore = probe.fiber.getEffects().length
  const handle = probe.box.handle
  const handleKeys = Object.keys(handle ?? {}).sort().join('|')
  const methodsOk = Boolean(handle) && handleKeys === 'byPolicy|digest|oldest'
  await probe.fiber.dispose()
  const effectsAfter = probe.fiber.getEffects().length
  check('2 挂载正控：cordis 挂载后 provide 拦截拿得到句柄（键恰好 digest/byPolicy/oldest），dispose 后 effect 归零',
    methodsOk && effectsBefore > 0 && effectsAfter === 0,
    `句柄键=${handleKeys || '空'}；effect ${effectsBefore} → ${effectsAfter}`)

  const live = await mountWith(mod, {})
  fibers.push(live.fiber)
  const score = live.box.handle

  // ---------- 3. 手算正控 ----------
  const digest = score.digest(ROWS)
  const projected = Object.fromEntries(DIGEST_KEYS.map((key) => [key, digest[key]]))
  const keysFixed = DIGEST_KEYS.every((key) => key in digest)
    && Object.keys(digest).length === DIGEST_KEYS.length
  const handOk = JSON.stringify(projected) === JSON.stringify(HAND) && keysFixed
  const policies = score.byPolicy(ROWS)
  const oldest = score.oldest(ROWS)
  const crossOk = JSON.stringify(policies) === JSON.stringify(HAND_POLICY)
    && JSON.stringify(oldest) === JSON.stringify(HAND.oldest)
    && Object.keys(oldest).sort().join('|') === 'action|id|waited_seconds'
  // 桶边界（右闭）：w 恰为 24h → 落 `6-24h` 且**不**计 stale；24h+1s → `>24h` 且计 stale
  const boundary = score.digest([
    { approval_id: 'ap-b1', action: 'quote.submit', waited_seconds: 86400 },
    { approval_id: 'ap-b2', action: 'quote.submit', waited_seconds: 86401 },
    { approval_id: 'ap-b3', action: 'quote.submit', waited_seconds: 3600 },
    { approval_id: 'ap-b4', action: 'quote.submit', waited_seconds: 3601 },
  ])
  const boundaryOk = JSON.stringify(boundary.by_age) === JSON.stringify([
    { bucket: '<1h', count: 1 }, { bucket: '1-6h', count: 1 }, { bucket: '6-24h', count: 1 },
    { bucket: '>24h', count: 1 }]) && boundary.stale === 1
  check('3 手算正控：6 条真形状待批行逐字段等于手算值（算式见注释）+ byPolicy 固定枚举序 + oldest 与 digest.oldest 同一份 + 右闭桶边界',
    handOk && crossOk && boundaryOk,
    `digest=${JSON.stringify(projected)}；期望=${JSON.stringify(HAND)}；键集固定=${keysFixed}；`
    + `byPolicy=${JSON.stringify(policies)}；oldest=${JSON.stringify(oldest)}；边界=${JSON.stringify(boundary.by_age)} stale=${boundary.stale}`)

  // ---------- 4. 负控：坏输入不崩 ----------
  const garbage = [null, undefined, 'garbage', 42, [1, 2], {}]
  const badInputs = [undefined, null, 'nope', 42, {}, { approval_id: 'x' }, garbage, [null, 'junk', [3]]]
  let threw = null
  const outputs = []
  for (const input of badInputs) {
    try {
      outputs.push(score.digest(input), score.byPolicy(input), score.oldest(input))
    } catch (err) {
      threw = `${JSON.stringify(input)?.slice(0, 24) ?? 'undefined'} → ${err.name}: ${String(err.message).slice(0, 80)}`
      break
    }
  }
  // 有形状但取值是坏数字：整行都不该进统计（不解析字符串数字、不把负等待当 0、不把 NaN 当数）
  const weirdRows = [
    { approval_id: 'ap-w1', action: 'quote.submit', waited_seconds: NaN },
    { approval_id: 'ap-w2', action: 'quote.submit', waited_seconds: Infinity },
    { approval_id: 'ap-w3', action: 'quote.submit', waited_seconds: '12' },
    { approval_id: 'ap-w4', action: 'quote.submit', waited_seconds: -1 },
    { approval_id: 'ap-w5', action: 'quote.submit', waited_seconds: 10, model_confidence: NaN },
  ]
  let weird = null
  let weirdThrew = null
  try {
    weird = score.digest(weirdRows)
  } catch (err) {
    weirdThrew = `${err.name}: ${String(err.message).slice(0, 80)}`
  }
  const nonFinite = [...outputs, weird].flatMap((out) => (out === null ? [] : badNumbers(out)))
  const emptyish = outputs.every((out) => (Array.isArray(out)
    ? out.length === 0
    : (out && typeof out === 'object'
      ? out.total === 0 && out.skipped === out.rows && out.oldest === null && out.by_action.length === 0
        && Object.values(out.by_confidence).every((count) => count === 0)
      : out === null)))
  const undefinedLike = JSON.stringify(score.digest(undefined))
  // 非空转对照：坏值行里那条**置信度 NaN** 的仍应被计入（等待时间有效）→ none+1，验证「不崩」不是靠「全丢」
  const weirdOk = weird !== null && weird.total === 1 && weird.rows === 5 && weird.skipped === 4
    && weird.by_confidence.none === 1 && weird.by_age[0].count === 1
  check('4 负控：坏输入（null/undefined/非数组/垃圾行/NaN/Infinity/字符串数字/负等待）不崩，'
    + '坏值行整行跳过、输出里没有非有限数',
  threw === null && weirdThrew === null && nonFinite.length === 0 && emptyish && weirdOk
    && undefinedLike === JSON.stringify(EMPTY),
  `抛错=${threw ?? weirdThrew ?? '无'}；非有限数=${nonFinite.join(',') || '无'}；`
  + `非数组/垃圾输入全空=${emptyish}；空输入形状=${undefinedLike === JSON.stringify(EMPTY)}；坏值单测=${JSON.stringify(weird)}`)

  // ---------- 5. 负控：缺字段不编造 ----------
  // 负控：缺字段不编造。手算（**不跑实现算出来的**）：
  //   9 行：m1/m2（缺 waited）跳过、m3（body 里也缺 waited）跳过、m9（缺 id）跳过 → 计入 5 = {m4,m5,m6,m7,m8}
  //   by_action（字典序）：award.commit=1（m7 用别名 scope）；quote.submit=3（m4,m5,m8）；row-wins=1（m6 行上的动作胜过 body）
  //   by_age：`<1h` = 5（m4 的 0 是**真值**、m5/m6/m7/m8 的 10）→ 缺 waited 的行没有被当成 0 塞进这里
  //   by_confidence：none = 3（m4,m5,m8 缺）；high = 2（m6 的 0.9 来自 body、m7 的 0.9 来自别名 confidence）
  //   oldest：最大等待 10，平手取最小 id → ap-m5
  //   byPolicy：只有 m7 是合法策略 abort；m8 的 auto_approve 不是三选一（不造占位桶），m1/m2 因缺 waited 被跳过
  const missing = [
    { approval_id: 'ap-m1', action: 'quote.submit', timeout_policy: 'remind' },        // 缺 waited → 跳过
    { approval_id: 'ap-m2', action: 'quote.submit', timeout_policy: 'abort' },
    { body: { approval_id: 'ap-m3', action: 'quote.submit' } },                        // body 里也缺 → 跳过
    { approval_id: 'ap-m4', action: 'quote.submit', waited_seconds: 0 },               // 0 是真值（非空转对照）
    { approval_id: 'ap-m5', action: 'quote.submit', waited_seconds: 10 },              // 缺置信度 → none
    { action: 'row-wins', body: { approval_id: 'ap-m6', action: 'body-loses', waited_seconds: 10,
      model_confidence: 0.9 } },                                                      // 行优先于 body
    { id: 'ap-m7', scope: 'award.commit', confidence: 0.9, policy: 'abort', waited_seconds: 10 },
    { approval_id: 'ap-m8', action: 'quote.submit', waited_seconds: 10, timeout_policy: 'auto_approve' },
    { waited_seconds: 10, action: 'quote.submit' },                                    // 缺 id → 跳过
  ]
  const missingDigest = score.digest(missing)
  const missingOldest = score.oldest(missing)
  const missingOk = missingDigest.rows === 9 && missingDigest.total === 5 && missingDigest.skipped === 4
    && missingDigest.total + missingDigest.skipped === missingDigest.rows
    && missingDigest.by_action.length === 3
    && JSON.stringify(missingDigest.by_action.map((item) => item.action)) === JSON.stringify(['award.commit', 'quote.submit', 'row-wins'])
    && missingDigest.by_age[0].count === 5 && missingDigest.by_age[1].count === 0
    && missingDigest.by_confidence.none === 3 && missingDigest.by_confidence.high === 2
    && missingDigest.stale === 0 && missingOldest.id === 'ap-m5' && missingOldest.waited_seconds === 10
    // 未知策略不造占位桶：9 行里唯一合法的策略只有 ap-m7 的 abort（ap-m8 是 auto_approve）
    && JSON.stringify(score.byPolicy(missing)) === JSON.stringify([{ policy: 'abort', count: 1 }])
  check('5 负控：字段取不到就跳过（缺等待时间的行整行不计、**不当 0**；缺置信度归 none；缺 id/动作跳过；'
    + '行优先于 body；别名 id/scope/confidence/policy 认；未知策略不造占位桶）',
  missingOk,
  `digest=${JSON.stringify(missingDigest)}；byPolicy=${JSON.stringify(score.byPolicy(missing))}；oldest=${JSON.stringify(missingOldest)}`)

  // ---------- 6. 负控：确定性 ----------
  const s1 = JSON.stringify(score.digest(ROWS))
  const s2 = JSON.stringify(score.digest(ROWS))
  const s3 = JSON.stringify(score.digest([...ROWS].reverse()))
  const other = await mountWith(mod, {})
  fibers.push(other.fiber)
  const s4 = JSON.stringify(other.box.handle.digest(ROWS))
  const timeKeys = /"(ts|at|now|time|elapsed|date|seq|generated_at)":/.test(s1)
  // 最长项平手：定序用 (等待秒数, id, 动作)，与入参顺序无关
  const tieRows = [{ approval_id: 'ap-t9', action: 'z', waited_seconds: 10 },
    { approval_id: 'ap-t1', action: 'a', waited_seconds: 10 }]
  const tieOk = score.oldest(tieRows).id === 'ap-t1' && score.oldest([...tieRows].reverse()).id === 'ap-t1'
  check('6 负控：确定性（同输入两次字节一致 / 跨实例一致 / 逆序输入一致 / 输出无时间字段 / 平手定序不依赖入参顺序）',
    s1 === s2 && s2 === s3 && s3 === s4 && s1.length > 10 && !timeKeys && tieOk,
    `两次一致=${s1 === s2}；逆序一致=${s2 === s3}；跨实例一致=${s3 === s4}；长度=${s1.length}；`
    + `含时间键=${timeKeys}；平手定序=${JSON.stringify(score.oldest(tieRows))}`)

  // ---------- 7. 负控：静态扫描零副作用 + 扫描器非空转对照 ----------
  const FORBIDDEN = ['Date.now', 'new Date', 'setInterval(', 'setTimeout(', 'writeFile', 'readFile',
    'appendFile', 'createWriteStream', 'ctx.on(', 'ctx.events', 'events.on(', 'Math.random', 'process.env',
    'fetch(', "require(", 'child_process']
  const scan = (text) => FORBIDDEN.filter((needle) => text.includes(needle))
  const hits = scan(source)
  const selfTest = scan(`const tick = set${'Interval'}(() => {}, 1000); const t = Date${'.now'}()`)
  check('7 负控：产物零副作用（无墙钟/定时器/文件读写/事件订阅/环境变量/网络/随机）且扫描器非空转（对照样本必须命中）',
    hits.length === 0 && selfTest.length >= 2,
    `产物命中=${hits.join(',') || '无'}；对照样本命中=${selfTest.join(',') || '（空转！）'}`)

  // ---------- 8. 负控：输出里不得出现正文 ----------
  const SECRET = 'sen-9f2b7c41'
  const sensitive = [
    { approval_id: 'ap-secret-1', action: 'quote.submit', waited_seconds: 10, timeout_policy: 'remind',
      summary: `摘要-${SECRET}`, payload: { token: SECRET }, refs: ['q-0007'], payload_hash: `sha256:${SECRET}`,
      body: { summary: SECRET, note: SECRET } },
    // 第二条的正文与字段都藏在 body 里（聚合照常，但输出里不得带出来）
    { body: { approval_id: 'ap-secret-2', action: 'award.commit', waited_seconds: 20, model_confidence: 0.9,
      summary: SECRET, note: SECRET } },
  ]
  const secretText = JSON.stringify([score.digest(sensitive), score.byPolicy(sensitive), score.oldest(sensitive)])
  const LEAKS = ['summary', 'payload', 'refs', 'note', 'token', 'payload_hash', 'body', SECRET]
  const leaked = LEAKS.filter((needle) => secretText.includes(needle))
  const secretAgg = score.digest(sensitive)
  const secretOk = leaked.length === 0 && secretAgg.total === 2 && secretAgg.stale === 0
    && secretAgg.oldest.id === 'ap-secret-2' && secretAgg.oldest.waited_seconds === 20
    && Object.keys(secretAgg.oldest).sort().join('|') === 'action|id|waited_seconds'
  check('8 负控：**输出里不得出现正文**（喂带 summary/payload/refs/token 的敏感行，输出里既搜不到键名也搜不到值）',
    secretOk,
    `泄漏项=${leaked.join(',') || '无'}；聚合仍正确=${secretAgg.total}/${JSON.stringify(secretAgg.oldest)}；`
    + `oldest 键=${Object.keys(secretAgg.oldest).sort().join('|')}`)

  // ---------- 9. 负控：配置契约（越界夹取 + 不得静默放行） ----------
  const big = await mountWith(mod, { max_buckets: 10 ** 9 })
  const zero = await mountWith(mod, { max_buckets: 0 })
  const negative = await mountWith(mod, { max_buckets: -5 })
  const nan = await mountWith(mod, { max_buckets: Number.NaN })
  const fractional = await mountWith(mod, { max_buckets: 5.7 })
  const staleSix = await mountWith(mod, { stale_hours: 6 })
  fibers.push(big.fiber, zero.fiber, negative.fiber, nan.fiber, fractional.fiber, staleSix.fiber)
  const bigAge = big.box.handle.digest(ROWS).by_age
  const clampOk = bigAge.length === 8 && big.box.handle.digest(ROWS).limits.max_buckets === 8
    && JSON.stringify(bigAge.map((item) => item.bucket)) === JSON.stringify(
      ['<1h', '1-6h', '6-24h', '24-72h', '72-168h', '168-720h', '720-2160h', '>2160h'])
    && JSON.stringify(bigAge.map((item) => item.count)) === JSON.stringify([1, 1, 2, 2, 0, 0, 0, 0])
    && zero.box.handle.digest(ROWS).by_age.length === 1
    && zero.box.handle.digest(ROWS).by_age[0].count === 6
    && zero.box.handle.digest(ROWS).limits.max_buckets === 1
    && negative.box.handle.digest(ROWS).by_age.length === 1
    && JSON.stringify(nan.box.handle.digest(ROWS).by_age) === JSON.stringify(HAND.by_age)
    && fractional.box.handle.digest(ROWS).by_age.length === 5
    && fractional.box.handle.digest(ROWS).limits.max_buckets === 5
    // stale_hours 是被真正使用的阈值：6h → 4 项（43200/86400/86401/90000 都严格 > 6h）
    && staleSix.box.handle.digest(ROWS).stale === 4
    && staleSix.box.handle.digest(ROWS).limits.stale_hours === 6
  const refuses = (raw) => {
    try {
      mod.Config.parse(raw)
      return 'accepted'
    } catch {
      return 'refused'
    }
  }
  const defaults = mod.Config.parse({})
  const unknownKey = refuses({ mystery_key: 1 })
  const wrongType = refuses({ max_buckets: 'many' })
  const notObject = refuses(42)
  const wrongFieldType = refuses({ id_field: 7 })
  const rejectOk = unknownKey === 'refused' && wrongType === 'refused' && notObject === 'refused'
    && wrongFieldType === 'refused' && defaults.stale_hours === 24 && defaults.max_buckets === 4
    && defaults.id_field === 'approval_id'
  check('9 负控：配置契约 —— 越界被夹取（1e9→8 桶、0/-5→1 桶、NaN→默认 4、5.7→5，夹取可从 limits 核对）'
    + '且未知键/错误类型/非对象入参一律被拒（不得静默放行）',
  clampOk && rejectOk,
  `1e9 → ${bigAge.length} 桶（limits=${big.box.handle.digest(ROWS).limits.max_buckets}）；0/-5 → `
  + `${zero.box.handle.digest(ROWS).by_age.length}/${negative.box.handle.digest(ROWS).by_age.length} 桶；`
  + `NaN → ${nan.box.handle.digest(ROWS).by_age.length} 桶（默认桶=${JSON.stringify(nan.box.handle.digest(ROWS).by_age.map((item) => item.bucket))}）；`
  + `5.7 → ${fractional.box.handle.digest(ROWS).by_age.length} 桶；stale_hours=6 → stale=${staleSix.box.handle.digest(ROWS).stale}；`
  + `未知键=${unknownKey} 错类型=${wrongType} 非对象=${notObject} 字段错类型=${wrongFieldType}；`
  + `默认=${defaults.stale_hours}/${defaults.max_buckets}/${defaults.id_field}`)

  // ---------- 10. 正控：fixture 纯读取 + 冻结输入 ----------
  const reference = JSON.stringify(score.digest(ROWS))
  const first = JSON.stringify(mod.fixture.sample(score))
  const second = JSON.stringify(mod.fixture.sample(score))
  const afterFixture = JSON.stringify(score.digest(ROWS))
  const frozenRows = ROWS.map((row) => (row && typeof row === 'object' && !Array.isArray(row) ? { ...row } : row))
  deepFreeze(frozenRows)
  // 冻结输入必须与原输入给出同一份结果：ESM 是严格模式，任何对入参的写入都会抛 TypeError
  const frozenOut = JSON.stringify(score.digest(frozenRows))
  check('10 正控：fixture 纯读取（连跑两次字节一致、不改变句柄行为），且冻结输入不抛错（没偷偷改调用方的行）',
    first === second && first.length > 10 && afterFixture === reference && frozenOut === reference,
    `fixture 两次一致=${first === second} 长度=${first.length}；句柄未变=${afterFixture === reference}；`
    + `冻结输入一致=${frozenOut === reference}`)
} catch (err) {
  check('门执行异常（不得静默通过）', false, `${err.name}: ${String(err.message).slice(0, 200)}`)
}

for (const fiber of fibers) {
  try {
    await fiber.dispose()
  } catch { /* 卸载失败不影响断言结果 */ }
}

finish()
