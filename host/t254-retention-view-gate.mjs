/**
 * t254-retention-view-gate —— T-254「留存计划的只读聚合视图」候选产物的**围栏门**
 * （宿主侧人工维护，不由被围对象自己写；ADR-0016 / D-036）。
 *
 * 被围对象：`retention-view`（tmp 阶段是 `./../tmp/t254-retention-view.mjs`，晋升后是 `./modules/retention-view.mjs`）。
 * 两阶段都能跑：先试进树产物，再回退到候选源码；**实际加载到的绝对路径、字节数与 sha256 写进第 1 条断言的
 * detail**（变异自证就是靠这一行确认「红的是我改的那一份」，而不是"看着红"）。
 *
 * 已知坑（必须处理，否则直接 ERR_MODULE_NOT_FOUND）：候选按契约 `import ... from '../lib/std-schema.mjs'`，
 * 而从 `tmp/` 看 `../lib` = **仓库根**的 `lib/`，它并不存在（仓库根 lib/ 是运行时产物目录，被 .gitignore 忽略）。
 * 这里照抄本仓既有做法（`tools/evolve-module.mjs` 的影子目录、`host/t247-idem-gate.mjs`、
 * `host/t250-approval-gate.mjs`）：在 gitignored 的 `tmp/t254-retention-view-gate-shadow/` 里把 `host/lib`
 * 软链过去、把候选**按字节复制**进去，再 import 影子里的那一份，并断言「复制前后字节一致」。
 * 影子只落在 tmp/ 内，仓库里其它文件一个字不动，也不在仓库外写文件。
 *
 * 断言（12 条，其中 7 条是**负控**；每条都写清「什么情况下必须变红」）：
 *   1 契约正控：manifest 齐备（name/inject=[]/builtin/usedServices/provides=['retentionView']/Config/apply/fixture）
 *      + 只 import `../lib` 白名单 + 打印实际加载路径/字节数/sha256
 *   2 挂载正控：cordis 挂载后 provide 拦截拿得到句柄（键恰好 headline/snapshot）；dispose 后 ctx.get 不存在、effect 归零
 *   3 手算正控：**真样例计划**（判定器真实输出，见标记区）七项计数 + action_mix + oldest 逐条对账（不用实现验实现）
 *   4 只组合不自算正控：counts 与 items 故意不一致 → 照抄 counts、绝不重算；已决的人工门不计入 pending
 *   5 headline 正控：四段数字（待归档/待销毁副本/需人工门/已拒）+ 字节数 ≤ max_bytes（小上限被夹取且是前缀）
 *   6 五动作正控：一份**含五种动作名（destroy/refuse/keep/archive/purge-copy）+ 2 条待人工门 + 1 条 refused** 的
 *      计划 → 计数/action_mix/pending/refused 等于手算值；动作名原样按名排序（视图不预设动作词表）
 *   7 泄漏负控：正文/私域键（键名、键值、以及**保留字段里**的私域标记值）一个都不出现在输出里
 *   8 降级负控：null / {} / 字段类型错 → 不抛、`degraded:true`、全零同形状；合法零计数计划**不**被误判降级
 *   9 有界负控：max_items=3 + 10 条 → oldest 只 3 条、omitted=7；max_items=0 → 空列表、omitted=10
 *  10 确定性负控：同输入两次 snapshot 字节一致、跨实例一致、冻结输入不抛错且结果一致
 *  11 静态负控：源码零副作用（墙钟/定时器/文件读写/事件订阅/随机/环境变量）+ 扫描器**非空转**对照
 *  12 配置契约负控：未知键/错误类型/非对象入参被拒；max_items 与 max_bytes 越界夹取（1e9→200、-5→0、NaN→默认、5.7→5）
 *
 * 输出：**一行** JSON `{"checks":[{name,ok,detail}],"passed":N,"total":N,"failures":N}`；全绿 exit 0，否则 exit 1。
 * 用法：`node host/t254-retention-view-gate.mjs`（cwd 无关：路径都由 import.meta.url 推出）。
 */
import { Context, EventsService } from 'cordis'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const IN_TREE = join(HERE, 'modules', 'retention-view.mjs')            // 晋升后的位置
const FROM_TMP = join(ROOT, 'tmp', 't254-retention-view.mjs')          // ← './../tmp/t254-retention-view.mjs'
const SHADOW = join(ROOT, 'tmp', 't254-retention-view-gate-shadow')

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
  const copyPath = join(SHADOW, 'modules', 'retention-view.mjs')
  copyFileSync(FROM_TMP, copyPath)
  const source = readFileSync(FROM_TMP, 'utf8')
  const copied = readFileSync(copyPath, 'utf8') === source
  return { mod: await import(pathToFileURL(copyPath).href), source, path: FROM_TMP, copied, copyPath }
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

/** 递归找非有限数（`JSON.stringify` 会把 NaN 写成 null，扫 JSON 文本抓不到）。 */
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

// ---------------------------------------------------------------------------
// 真样例计划（**判定器的真实输出**，不是手抄的形状）—— 标记区内是逐字段原样的 JSON。
//
// 生成方式（判定器只读、不修改；`now` 显式传入 —— 判定器不读墙钟）：
//   PYTHONPATH=src python3 - <<'PY'
//   from quotagent.services.retention import RetentionPolicy
//   RULES = {"approval/granted": {"retain_days": 30, "after": "archive"},
//            "audit/decision": {"retain_days": 90, "after": "keep"},
//            "cache/projection": {"retain_days": 1, "after": "purge-copy"},
//            "export/bundle": {"retain_days": 7, "after": "purge-copy"}}
//   ENTRIES = [{"seq": 1, "type": "approval/granted", "ts": "2026-06-01T00:00:00Z", "body": {...},
//               "reserve_price": 1234.5},                       # 账本行：到期也只 keep（refused）
//              {"seq": 2, "type": "cache/projection", "ts": "2026-09-21T00:00:00Z"},
//              {"id": "copy:proj-7", "kind": "derived-copy", "type": "cache/projection", "ts": "2026-09-01T00:00:00Z"},
//              {"id": "copy:export-3", "kind": "derived-copy", "type": "export/bundle", "ts": "2026-09-10T00:00:00Z"},
//              {"seq": 5, "type": "audit/decision", "ts": "2026-01-01T00:00:00Z"},
//              {"id": "copy:mirror-9", "kind": "derived-copy", "type": "ledger/mirror", "ts": "2026-01-01T00:00:00Z"},
//              {"id": "copy:approval-pack-1", "kind": "derived-copy", "type": "approval/granted", "ts": "2026-01-01T00:00:00Z"},
//              {"seq": 4, "type": "cache/projection", "ts": "2026-09-21T00:00:00Z"},
//              "garbage"]                                       # 非法条目 → counts.rejected
//   print(RetentionPolicy(RULES, max_items=20).plan(ENTRIES, "2026-09-21T12:00:00Z"))
//   PY
// 开发期已用脚本把本文件标记区内的 JSON 与上面这段重跑的结果**逐字段 deep-equal**（见交付报告）。
// ---------------------------------------------------------------------------
const REAL_PLAN = /* T254-FIXTURE-START */
{
 "approvals": [
  {
   "auto_approve": false,
   "decided_by": null,
   "reason": "purge-copy 需要人工门：到期：已 20.5 天 ≥ 留存 1 天 → 对**派生副本**执行 purge-copy",
   "ref": "id:copy:proj-7",
   "scope": "evidence.purge-copy",
   "status": "pending",
   "timeout_policy": "remind"
  },
  {
   "auto_approve": false,
   "decided_by": null,
   "reason": "purge-copy 需要人工门：到期：已 11.5 天 ≥ 留存 7 天 → 对**派生副本**执行 purge-copy",
   "ref": "id:copy:export-3",
   "scope": "evidence.purge-copy",
   "status": "pending",
   "timeout_policy": "remind"
  }
 ],
 "approvals_bounded": {
  "limit": 20,
  "listed": 2,
  "omitted": 0,
  "truncated": false
 },
 "auto_approved": 0,
 "bounded": {
  "limit": 20,
  "listed": 8,
  "omitted": 0,
  "truncated": false
 },
 "counts": {
  "accepted": 8,
  "approval_required": 2,
  "archive": 1,
  "keep": 5,
  "purge-copy": 2,
  "refused": 1,
  "rejected": 1,
  "total": 9,
  "undecided": 1
 },
 "evaluated_at": "2026-09-21T12:00:00Z",
 "items": [
  {
   "action": "keep",
   "age_days": 112.5,
   "approval": null,
   "approval_required": false,
   "id": null,
   "kind": "ledger-row",
   "ledger_row": true,
   "object": "seq:1",
   "reason": "拒绝销毁账本行 seq=1：账本 append-only（`Ledger.append` 是唯一写入口，FR-LEDGER-001），历史不可删、不可移出账本；销毁只能针对派生副本",
   "redacted_fields": 1,
   "refused": true,
   "retain_days": 30.0,
   "seq": 1,
   "trace_event": null,
   "type": "approval/granted",
   "undecided": false
  },
  {
   "action": "keep",
   "age_days": 0.5,
   "approval": null,
   "approval_required": false,
   "id": null,
   "kind": "ledger-row",
   "ledger_row": true,
   "object": "seq:2",
   "reason": "未到期：已 0.5 天 < 留存 1 天",
   "redacted_fields": 0,
   "refused": false,
   "retain_days": 1.0,
   "seq": 2,
   "trace_event": null,
   "type": "cache/projection",
   "undecided": false
  },
  {
   "action": "purge-copy",
   "age_days": 20.5,
   "approval": {
    "auto_approve": false,
    "decided_by": null,
    "reason": "purge-copy 需要人工门：到期：已 20.5 天 ≥ 留存 1 天 → 对**派生副本**执行 purge-copy",
    "ref": "id:copy:proj-7",
    "scope": "evidence.purge-copy",
    "status": "pending",
    "timeout_policy": "remind"
   },
   "approval_required": true,
   "id": "copy:proj-7",
   "kind": "derived-copy",
   "ledger_row": false,
   "object": "id:copy:proj-7",
   "reason": "到期：已 20.5 天 ≥ 留存 1 天 → 对**派生副本**执行 purge-copy",
   "redacted_fields": 0,
   "refused": false,
   "retain_days": 1.0,
   "seq": null,
   "trace_event": "evidence/retention-copy-purged",
   "type": "cache/projection",
   "undecided": false
  },
  {
   "action": "purge-copy",
   "age_days": 11.5,
   "approval": {
    "auto_approve": false,
    "decided_by": null,
    "reason": "purge-copy 需要人工门：到期：已 11.5 天 ≥ 留存 7 天 → 对**派生副本**执行 purge-copy",
    "ref": "id:copy:export-3",
    "scope": "evidence.purge-copy",
    "status": "pending",
    "timeout_policy": "remind"
   },
   "approval_required": true,
   "id": "copy:export-3",
   "kind": "derived-copy",
   "ledger_row": false,
   "object": "id:copy:export-3",
   "reason": "到期：已 11.5 天 ≥ 留存 7 天 → 对**派生副本**执行 purge-copy",
   "redacted_fields": 0,
   "refused": false,
   "retain_days": 7.0,
   "seq": null,
   "trace_event": "evidence/retention-copy-purged",
   "type": "export/bundle",
   "undecided": false
  },
  {
   "action": "keep",
   "age_days": 263.5,
   "approval": null,
   "approval_required": false,
   "id": null,
   "kind": "ledger-row",
   "ledger_row": true,
   "object": "seq:5",
   "reason": "策略声明到期后仍保留（after=keep，'audit/decision' 永不动）",
   "redacted_fields": 0,
   "refused": false,
   "retain_days": 90.0,
   "seq": 5,
   "trace_event": null,
   "type": "audit/decision",
   "undecided": false
  },
  {
   "action": "keep",
   "age_days": 263.5,
   "approval": null,
   "approval_required": false,
   "id": "copy:mirror-9",
   "kind": "derived-copy",
   "ledger_row": false,
   "object": "id:copy:mirror-9",
   "reason": "未知事件类型 'ledger/mirror'：留存策略未声明，按「宁可不判」处理（不默认放行销毁；default_days=未声明 只用于报告）",
   "redacted_fields": 0,
   "refused": false,
   "retain_days": null,
   "seq": null,
   "trace_event": null,
   "type": "ledger/mirror",
   "undecided": true
  },
  {
   "action": "archive",
   "age_days": 263.5,
   "approval": null,
   "approval_required": false,
   "id": "copy:approval-pack-1",
   "kind": "derived-copy",
   "ledger_row": false,
   "object": "id:copy:approval-pack-1",
   "reason": "到期：已 263.5 天 ≥ 留存 30 天 → 对**派生副本**执行 archive",
   "redacted_fields": 0,
   "refused": false,
   "retain_days": 30.0,
   "seq": null,
   "trace_event": "evidence/retention-archived",
   "type": "approval/granted",
   "undecided": false
  },
  {
   "action": "keep",
   "age_days": 0.5,
   "approval": null,
   "approval_required": false,
   "id": null,
   "kind": "ledger-row",
   "ledger_row": true,
   "object": "seq:4",
   "reason": "未到期：已 0.5 天 < 留存 1 天",
   "redacted_fields": 0,
   "refused": false,
   "retain_days": 1.0,
   "seq": 4,
   "trace_event": null,
   "type": "cache/projection",
   "undecided": false
  }
 ],
 "ledger_rows_destroyed": 0,
 "note": "只读计划：不写文件、不删文件、不追加账本、不批准任何动作；账本行永不销毁（purge-copy 只针对派生副本）；需要门的动作须经 ctx.approval 由人决定（无超时自动批准）",
 "policy_digest": "sha256:f56736a1fb6e5beec83f26ed1ba9c21e4131e28161174dbdc14a3eb4c95a8341",
 "rejected": [
  {
   "at": 8,
   "reason": "条目必须是对象（dict），收到 str"
  }
 ],
 "rejected_bounded": {
  "limit": 20,
  "listed": 1,
  "omitted": 0,
  "truncated": false
 },
 "side_effects": {
  "files_deleted": 0,
  "files_written": 0,
  "ledger_appends": 0
 },
 "trace_events": [
  {
   "reason": "purge-copy 执行后留痕（含对象、动作、执行人）",
   "ref": "id:copy:proj-7",
   "type": "evidence/retention-copy-purged"
  },
  {
   "reason": "purge-copy 执行后留痕（含对象、动作、执行人）",
   "ref": "id:copy:export-3",
   "type": "evidence/retention-copy-purged"
  },
  {
   "reason": "archive 执行后留痕（含对象、动作、执行人）",
   "ref": "id:copy:approval-pack-1",
   "type": "evidence/retention-archived"
  }
 ]
}
/* T254-FIXTURE-END */

// 手算表（**不跑实现算出来的**；年龄＝(2026-09-21T12:00Z − ts)/86400，判定器已 round 到 6 位）：
//   keep        5 = seq:1（账本行到期但只 keep）、seq:2、seq:5、copy:mirror-9、seq:4
//   archive     1 = copy:approval-pack-1（派生副本，策略 after=archive，无需人工门）
//   purge-copy  2 = copy:proj-7、copy:export-3（两者都 requires_approval → 人工门 2 条）
//   accepted    8、rejected 1（"garbage" 非对象）、refused 1（seq:1 被判 refuse 销毁账本行 → keep + refused）
//   approval_required 2（= count 里那一项，也 = approvals 数组长度）
//   oldest 排序（age 降序，平手用 id 升序兜底）：
//     263.5 = copy:approval-pack-1 / copy:mirror-9 / seq:5（**三条平手**，"c" < "s"）
//     112.5 = seq:1；20.5 = copy:proj-7；11.5 = copy:export-3；0.5 = seq:2 / seq:4
//   action_mix（按动作名排序，归纳自条目）：archive 1 / keep 5 / purge-copy 2
const HAND = {
  counts: { keep: 5, archive: 1, 'purge-copy': 2, accepted: 8, rejected: 1, refused: 1, approval_required: 2 },
  pending_approvals: 2,
  refused: 1,
  oldest: [
    { id: 'copy:approval-pack-1', type: 'approval/granted', age_days: 263.5, action: 'archive' },
    { id: 'copy:mirror-9', type: 'ledger/mirror', age_days: 263.5, action: 'keep' },
    { id: 'seq:5', type: 'audit/decision', age_days: 263.5, action: 'keep' },
    { id: 'seq:1', type: 'approval/granted', age_days: 112.5, action: 'keep' },
    { id: 'copy:proj-7', type: 'cache/projection', age_days: 20.5, action: 'purge-copy' },
    { id: 'copy:export-3', type: 'export/bundle', age_days: 11.5, action: 'purge-copy' },
    { id: 'seq:2', type: 'cache/projection', age_days: 0.5, action: 'keep' },
    { id: 'seq:4', type: 'cache/projection', age_days: 0.5, action: 'keep' },
  ],
  action_mix: [{ action: 'archive', count: 1 }, { action: 'keep', count: 5 }, { action: 'purge-copy', count: 2 }],
  headline: '待归档 1 / 待销毁副本 2 / 需人工门 2 / 已拒 1',
}

const countsShape = (over = {}) => ({ keep: 0, archive: 0, 'purge-copy': 0, accepted: 0, rejected: 0,
  refused: 0, approval_required: 0, ...over })

// 只组合不自算的探针：**counts 与 items 故意不一致**（counts 说 archive=9，条目只给 1 条 archive）。
// 视图必须照抄 counts（权威计数），重算就会把 9 变成 1 → 本条变红。
const MISMATCH_PLAN = {
  counts: countsShape({ keep: 40, archive: 9, 'purge-copy': 0, accepted: 50, refused: 5, approval_required: 3 }),
  items: [{ id: 'only-one', type: 'export/bundle', age_days: 3, action: 'archive' }],
  approvals: [{ status: 'pending' }, { status: 'approved' }, 'garbage'],
  rejected: [],
}
const HAND_MISMATCH = { counts: countsShape({ keep: 40, archive: 9, accepted: 50, refused: 5, approval_required: 3 }),
  action_mix: [{ action: 'archive', count: 1 }], pending_approvals: 1, refused: 5 }

// 有界探针：10 条（年龄 1..10 天）；max_items=3 → 只列最老的 3 条（10/9/8 天）、omitted=7
const BOUND_PLAN = {
  counts: countsShape({ keep: 5, archive: 5, accepted: 10 }),
  items: Array.from({ length: 10 }, (_, index) => ({ id: `bound-${index + 1}`, type: 'cache/projection',
    age_days: index + 1, action: index % 2 === 0 ? 'keep' : 'archive' })),
  approvals: [], rejected: [],
}

// 动作通用性探针：五种动作名（含 ADR-0018 §1 的 destroy/refuse 用语）+ 2 条待人工门 + 1 条 refused
// —— 判定器当前只产 keep/archive/purge-copy，这里的 5 种动作是**合成**输入，用来证明视图**不预设动作词表**。
const MIX_PLAN = {
  counts: countsShape({ keep: 2, archive: 1, 'purge-copy': 1, accepted: 6, rejected: 1, refused: 1,
    approval_required: 2 }),
  items: [
    { id: 'mix-keep', type: 'audit/decision', age_days: 5, action: 'keep' },
    { id: 'mix-archive', type: 'export/bundle', age_days: 4, action: 'archive' },
    { id: 'mix-purge', type: 'cache/projection', age_days: 3, action: 'purge-copy' },
    { id: 'mix-destroy', type: 'attachment/original', age_days: 2, action: 'destroy' },
    { id: 'mix-refuse', type: 'ledger/row', age_days: 1, action: 'refuse' },
    { id: 'mix-ledger-row-7', type: 'approval/granted', age_days: 6, action: 'keep' },   // 账本行：到期也只 keep
  ],
  approvals: [{ scope: 'evidence.purge-copy', ref: 'id:mix-purge', status: 'pending' },
    { scope: 'evidence.archive', ref: 'id:mix-archive', status: 'pending' }],
  rejected: [{ at: 6, reason: '（合成的非法条目：视图只照抄计数，不读 rejected 内容）' }],
}
const HAND_MIX = {
  counts: countsShape({ keep: 2, archive: 1, 'purge-copy': 1, accepted: 6, rejected: 1, refused: 1,
    approval_required: 2 }),
  action_mix: [{ action: 'archive', count: 1 }, { action: 'destroy', count: 1 }, { action: 'keep', count: 2 },
    { action: 'purge-copy', count: 1 }, { action: 'refuse', count: 1 }],
  pending_approvals: 2, refused: 1,
}

// 泄漏探针（合成）：正文/私域键当**键**放，标记值当**保留字段**放，控制字符放 id —— 三路都不得漏
const SENTINEL = 'SENTINEL-RETENTION-9f3'
const DIRTY_PLAN = {
  counts: { ...countsShape({ keep: 1, archive: 1, 'purge-copy': 2, accepted: 3, approval_required: 1 }),
    'private:note': `${SENTINEL}-counts` },
  items: [
    { id: 'dirty-1', type: 'cache/projection', age_days: 9, action: 'purge-copy',
      body: `${SENTINEL}-body`, reserve_price: `${SENTINEL}-price`, cost_model: `${SENTINEL}-cost`,
      signature: `${SENTINEL}-signature`, 'private:cost': `${SENTINEL}-private` },
    { id: 'dirty-2', type: `private:cost_model=${SENTINEL}-type`, age_days: 8, action: 'archive',
      body: `${SENTINEL}-body2` },
    { id: `dirty\u00003${SENTINEL}`, type: 'export/bundle', age_days: 7, action: `keep\u0001${SENTINEL}` },
    null, 'garbage',
  ],
  approvals: [{ scope: 'evidence.purge-copy', ref: 'id:dirty-1', status: 'pending',
    'private:reason': `${SENTINEL}-approval` }],
  rejected: [{ at: 4, reason: `${SENTINEL}-rejected` }],
}

// 静态扫描（只扫候选源码；扫的是**产物**，不是本门）
const NEEDLES = ['Date.now', 'new Date', 'setInterval(', 'setTimeout(', 'readFileSync', 'writeFileSync',
  'appendFile', 'ctx.events', 'ctx.on(', 'Math.random', 'process.env', "from 'node:"]
const scanSource = (src, needles = NEEDLES) => needles.filter((needle) => src.includes(needle))

const artifact = await loadArtifact()
const fibers = []
let mod = null

try {
  // ---------- 1. 契约正控（含实际加载路径 / 字节数 / sha256） ----------
  const source = artifact ? artifact.source : ''
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  const importLeaks = imports.filter((spec) => !(spec === '../lib/std-schema.mjs'))
  mod = artifact ? artifact.mod : null
  const manifest = {
    name: mod?.name === 'retention-view',
    inject: Array.isArray(mod?.inject) && mod.inject.length === 0,
    builtin: Array.isArray(mod?.builtin) && mod.builtin.length === 0,
    usedServices: Array.isArray(mod?.usedServices) && mod.usedServices.length === 0,
    provides: Array.isArray(mod?.provides) && mod.provides.join(',') === 'retentionView',
    Config: typeof mod?.Config?.parse === 'function' && typeof mod?.Config?.['~standard']?.validate === 'function',
    apply: typeof mod?.apply === 'function',
    fixture: typeof mod?.fixture?.sample === 'function',
  }
  const manifestBad = Object.entries(manifest).filter(([, ok]) => !ok).map(([key]) => key)
  check('1 契约正控：manifest 齐备（name/inject=[]/builtin/usedServices/provides=[retentionView]/Config/apply/fixture）'
    + '且只 import ../lib 白名单（打印实际加载路径/字节数/sha256）',
  mod !== null && manifestBad.length === 0 && importLeaks.length === 0,
  `载入=${artifact ? artifact.path : '未加载'}；字节=${Buffer.byteLength(source, 'utf8')}；`
  + `sha256=${sha256(source).slice(0, 16)}…；影子副本字节一致=${artifact?.copied === null ? '（无影子，进树产物）' : artifact?.copied}；`
  + `imports=${imports.join(',') || '无'}；越界 import=${importLeaks.join(',') || '无'}；问题键=${manifestBad.join(',') || '无'}`)
  if (!mod) finish()

  // ---------- 2. 挂载正控 + 卸载（effect 回收） ----------
  const probe = await mountWith(mod, {})
  fibers.push(probe.fiber)
  const effectsBefore = probe.fiber.getEffects().length
  const probeHandle = probe.box.handle
  const handleKeys = Object.keys(probeHandle ?? {}).sort().join('|')
  const methodsOk = Boolean(probeHandle) && handleKeys === 'headline|snapshot'
    && typeof probe.ctx.get('retentionView')?.snapshot === 'function'
  await probe.fiber.dispose()
  const effectsAfter = probe.fiber.getEffects().length
  check('2 挂载正控：cordis 挂载后 provide 拦截拿得到句柄（键恰好 headline/snapshot）；'
    + 'dispose 后 ctx.get(\'retentionView\') 不存在且 effect 归零',
  methodsOk && effectsBefore > 0 && effectsAfter === 0 && probe.ctx.get('retentionView') === undefined,
  `句柄键=${handleKeys || '空'}；effect ${effectsBefore} → ${effectsAfter}；`
  + `dispose 后 ctx.get=${String(probe.ctx.get('retentionView'))}`)

  const live = await mountWith(mod, {})
  fibers.push(live.fiber)
  const view = live.box.handle

  // ---------- 3. 手算正控（真样例计划） ----------
  const snap = view.snapshot(REAL_PLAN)
  const countsOk = JSON.stringify(snap.counts) === JSON.stringify(HAND.counts)
  const mixOk = JSON.stringify(snap.action_mix) === JSON.stringify(HAND.action_mix)
  const oldestOk = JSON.stringify(snap.oldest) === JSON.stringify(HAND.oldest)
  const flagsOk = snap.pending_approvals === HAND.pending_approvals && snap.refused === HAND.refused
    && snap.degraded === false && snap.bounded === false && snap.omitted === 0 && snap.source === 'retention-view'
  check('3 手算正控：真样例计划（判定器真实输出）七项计数 + action_mix + oldest 顺序逐条等于手算值'
    + '（含 263.5 天三条平手按 id 升序、账本行 id 退回 object）',
  countsOk && mixOk && oldestOk && flagsOk,
  `counts 对账=${countsOk}（实际 keep=${snap.counts.keep}/archive=${snap.counts.archive}/`
  + `purge-copy=${snap.counts['purge-copy']}/refused=${snap.counts.refused}/approval_required=${snap.counts.approval_required}）；`
  + `mix=${mixOk ? '一致' : JSON.stringify(snap.action_mix)}；oldest[0..2]=`
  + `${snap.oldest.slice(0, 3).map((item) => `${item.id}@${item.age_days}`).join(' ')}（共 ${snap.oldest.length} 条）；`
  + `pending=${snap.pending_approvals} refused=${snap.refused} degraded=${snap.degraded} bounded=${snap.bounded} omitted=${snap.omitted}`)

  // ---------- 4. 只组合不自算（照抄 counts；已决人工门不计） ----------
  const mismatch = view.snapshot(MISMATCH_PLAN)
  check('4 只组合不自算正控：counts 与 items 故意不一致时**照抄 counts**（archive 仍 9，不重算成 1）；'
    + '人工门只数未决的（pending 1 / approved 1 / 垃圾 1 → 1）',
  JSON.stringify(mismatch.counts) === JSON.stringify(HAND_MISMATCH.counts)
  && JSON.stringify(mismatch.action_mix) === JSON.stringify(HAND_MISMATCH.action_mix)
  && mismatch.pending_approvals === HAND_MISMATCH.pending_approvals && mismatch.refused === HAND_MISMATCH.refused,
  `counts.archive=${mismatch.counts.archive}（手算 9）；mix=${JSON.stringify(mismatch.action_mix)}；`
  + `pending=${mismatch.pending_approvals}（手算 1）；refused=${mismatch.refused}（手算 5）`)

  // ---------- 5. headline 正控（四段数字 + 字节上界） ----------
  const headline = view.headline(REAL_PLAN)
  const digits = headline.match(/\d+/g) ?? []
  const tight = await mountWith(mod, { max_bytes: 12 })
  fibers.push(tight.fiber)
  const clipped = tight.box.handle.headline(REAL_PLAN)
  const tightOk = Buffer.byteLength(clipped, 'utf8') <= 12 && headline.startsWith(clipped) && clipped.length > 0
  check('5 headline 正控：四段数字（待归档/待销毁副本/需人工门/已拒）与手算一致、字节数 ≤ max_bytes；'
    + 'max_bytes=12 时被夹取且是完整摘要的前缀（不劈开多字节字符）',
  headline === HAND.headline && digits.length === 4
  && Buffer.byteLength(headline, 'utf8') <= 4096 && tightOk,
  `headline="${headline}"（数字=${digits.join('/')}，字节=${Buffer.byteLength(headline, 'utf8')}）；`
  + `max_bytes=12 → "${clipped}"（字节=${Buffer.byteLength(clipped, 'utf8')}，前缀=${headline.startsWith(clipped)}）`)

  // ---------- 6. 五动作/人工门/refused 的形状正控（不预设动作词表） ----------
  const mixSnap = view.snapshot(MIX_PLAN)
  const mixPlanOk = JSON.stringify(mixSnap.counts) === JSON.stringify(HAND_MIX.counts)
    && JSON.stringify(mixSnap.action_mix) === JSON.stringify(HAND_MIX.action_mix)
    && mixSnap.pending_approvals === HAND_MIX.pending_approvals && mixSnap.refused === HAND_MIX.refused
  const expectedActions = HAND_MIX.action_mix.map((item) => item.action)
  check('6 五动作正控：一份**含五种动作名（含 ADR-0018 §1 的 destroy/refuse）+ 2 条待人工门 + 1 条 refused** 的'
    + '样例计划 → 计数/action_mix/pending/refused 逐一等于手算值；动作名原样按名排序（视图不白名单、不翻译、不重判）',
  mixPlanOk && mixSnap.action_mix.map((item) => item.action).join(',') === expectedActions.join(','),
  `counts=${JSON.stringify(mixSnap.counts)}；mix=${JSON.stringify(mixSnap.action_mix)}；`
  + `pending=${mixSnap.pending_approvals}（手算 ${HAND_MIX.pending_approvals}）refused=${mixSnap.refused}（手算 ${HAND_MIX.refused}）`)

  // ---------- 7. 泄漏负控 ----------
  const dirtyText = JSON.stringify(view.snapshot(DIRTY_PLAN)) + JSON.stringify(view.headline(DIRTY_PLAN))
  const forbiddenKeys = ['body', 'reserve_price', 'cost_model', 'signature']
    .filter((key) => new RegExp(`"${key}"\\s*:`).test(dirtyText))
  const leaks = [SENTINEL, ...forbiddenKeys].filter((needle) => dirtyText.includes(needle))
  const dirtySnap = view.snapshot(DIRTY_PLAN)
  const redactedRows = dirtySnap.oldest.filter((item) => item.id === '(redacted)' || item.type === '(redacted)'
    || item.action === '(redacted)').length
  check('7 泄漏负控：正文/私域键的**键名**与**键值**（含保留字段里的 private:/body/ 标记值、id 里的控制字符）'
    + '一个都不出现在输出里，且被过滤的保留字段统一显示 (redacted)（干净条目照常可读）',
  leaks.length === 0 && !dirtyText.includes('private:') && dirtyText.includes('(redacted)')
  && dirtySnap.oldest.length === 3 && dirtySnap.oldest[0].id === 'dirty-1' && redactedRows === 2,
  `泄漏=${leaks.join(',') || '无'}；含 private:=${dirtyText.includes('private:')}；`
  + `含 (redacted)=${dirtyText.includes('(redacted)')}；oldest=${JSON.stringify(dirtySnap.oldest)}`)

  // ---------- 8. 降级负控（不崩 + 全零同形状） ----------
  const goodZero = view.snapshot({ counts: countsShape(), items: [], approvals: [], rejected: [] })
  const broken = [null, undefined, {}, 42, 'garbage', [],
    { counts: { ...countsShape(), keep: '5' }, items: [], approvals: [], rejected: [] },
    { counts: countsShape(), items: {}, approvals: [], rejected: [] },
    { counts: countsShape(), items: [], approvals: {} , rejected: [] }]
  let degradedOk = true
  let degradedDetail = ''
  const shapeOf = (obj) => Object.keys(obj).sort().join('|')
  for (const plan of broken) {
    let out = null
    try {
      out = view.snapshot(plan)
    } catch (err) {
      degradedOk = false; degradedDetail = `抛出 ${err.name}（plan=${JSON.stringify(plan)?.slice(0, 40)}）`; break
    }
    const zero = Object.values(out.counts).every((value) => value === 0) && out.oldest.length === 0
      && out.action_mix.length === 0 && out.omitted === 0 && out.pending_approvals === 0 && out.refused === 0
    const sameShape = shapeOf(out) === shapeOf(snap) && shapeOf(out.counts) === shapeOf(snap.counts)
    const text = view.headline(plan)
    if (!(out.degraded === true && zero && sameShape && badNumbers(out).length === 0
      && typeof text === 'string' && !/\d/.test(text))) {
      degradedOk = false
      degradedDetail = `plan=${JSON.stringify(plan)?.slice(0, 40)} → degraded=${out.degraded} 零值=${zero} `
        + `同形状=${sameShape} headline="${text}"`
      break
    }
  }
  check('8 降级负控：null/undefined/{}/数字/字符串/数组/计数类型错/items 非数组 → **不抛**、degraded:true、'
    + '全零且与正常输出**同形状**、headline 仍是一行且不含数字；合法零计数计划不降级（degraded 是唯一区别）',
  degradedOk && goodZero.degraded === false && JSON.stringify(goodZero.counts) === JSON.stringify(countsShape())
  && goodZero.oldest.length === 0,
  `坏输入全部降级=${degradedOk}${degradedDetail ? `；首个不合规：${degradedDetail}` : ''}；`
  + `合法零计数计划 degraded=${goodZero.degraded}（counts 全零=${JSON.stringify(goodZero.counts) === JSON.stringify(countsShape())}）`)

  // ---------- 9. 有界负控 ----------
  const bound3 = await mountWith(mod, { max_items: 3 })
  fibers.push(bound3.fiber)
  const small = bound3.box.handle.snapshot(BOUND_PLAN)
  const bound0 = await mountWith(mod, { max_items: 0 })
  fibers.push(bound0.fiber)
  const none = bound0.box.handle.snapshot(BOUND_PLAN)
  check('9 有界负控：max_items=3 + 10 条 → oldest 只 3 条（最老的 3 条）且 omitted=7、bounded:true；'
    + 'max_items=0 → oldest 空、omitted=10（计数一条不少，仍照抄 counts）',
  small.oldest.length === 3 && small.omitted === 7 && small.bounded === true
  && small.oldest.map((item) => item.id).join(',') === 'bound-10,bound-9,bound-8'
  && small.counts.accepted === 10
  && none.oldest.length === 0 && none.omitted === 10 && none.bounded === true && none.counts.keep === 5,
  `max_items=3 → ${small.oldest.length} 条（${small.oldest.map((item) => item.id).join(',')}）omitted=${small.omitted} `
  + `bounded=${small.bounded}；max_items=0 → ${none.oldest.length} 条 omitted=${none.omitted} bounded=${none.bounded}`)

  // ---------- 10. 确定性负控 ----------
  const once = JSON.stringify(view.snapshot(REAL_PLAN))
  const twice = JSON.stringify(view.snapshot(REAL_PLAN))
  const other = await mountWith(mod, { max_items: 12, max_bytes: 4096 })
  fibers.push(other.fiber)
  const otherSnap = JSON.stringify(other.box.handle.snapshot(REAL_PLAN))
  const frozen = deepFreeze(JSON.parse(JSON.stringify(REAL_PLAN)))
  let frozenOk = true
  try {
    frozenOk = JSON.stringify(view.snapshot(frozen)) === once
  } catch {
    frozenOk = false
  }
  check('10 确定性负控：同输入两次 snapshot **字节一致**、跨实例一致、冻结输入不抛错且结果一致'
    + '（不读墙钟、不随机、不依赖入参顺序）',
  once === twice && once === otherSnap && frozenOk && badNumbers(view.snapshot(REAL_PLAN)).length === 0,
  `两次一致=${once === twice}（${once.length} 字节）；跨实例一致=${once === otherSnap}；冻结输入一致=${frozenOk}；`
  + `headline 两次一致=${view.headline(REAL_PLAN) === view.headline(REAL_PLAN)}`)

  // ---------- 11. 静态负控（零副作用 + 扫描器非空转） ----------
  const hits = scanSource(source)
  const planted = "const a = Date.now(); setInterval(() => {}, 1); fs.readFileSync('x'); ctx.events.on('y')"
  const plantedHits = scanSource(planted)
  check('11 静态负控：候选源码零副作用（墙钟/定时器/文件读写/事件订阅/随机/环境变量/直接 import node:）'
    + '—— 且扫描器**非空转**（在合成的坏源码上必须命中）',
  hits.length === 0 && plantedHits.length >= 4,
  `命中=${hits.join(',') || '无'}；非空转对照命中 ${plantedHits.length} 处=${plantedHits.join(',')}`)

  // ---------- 12. 配置契约负控 ----------
  const refuses = (raw) => {
    try {
      mod.Config.parse(raw)
      return 'accepted'
    } catch {
      return 'refused'
    }
  }
  const unknownKey = refuses({ max_items: 3, typo_key: 1 })
  const wrongType = refuses({ max_items: 'many' })
  const notObject = refuses(42)
  const defaults = mod.Config.parse({})
  const bigItems = await mountWith(mod, { max_items: 1e9 })
  fibers.push(bigItems.fiber)
  const many = bigItems.box.handle.snapshot({ counts: countsShape({ accepted: 250, keep: 250 }),
    items: Array.from({ length: 250 }, (_, index) => ({ id: `many-${index + 1}`, type: 'cache/projection',
      age_days: index + 1, action: 'keep' })), approvals: [], rejected: [] })
  const negative = await mountWith(mod, { max_items: -5 })
  fibers.push(negative.fiber)
  const negSnap = negative.box.handle.snapshot(BOUND_PLAN)
  const fractional = await mountWith(mod, { max_items: 5.7 })
  fibers.push(fractional.fiber)
  const rightSnap = await mountWith(mod, { max_bytes: -5 })
  fibers.push(rightSnap.fiber)
  const nanBytes = await mountWith(mod, { max_bytes: NaN })
  fibers.push(nanBytes.fiber)
  check('12 配置契约负控：未知键/错误类型/非对象入参一律被拒（不得静默放行）；max_items 越界夹取'
    + '（1e9→200：250 条只列 200、omitted 50；-5→0）且 max_bytes 越界夹取（-5→0 得空串；NaN→默认 4096 得完整摘要）',
  unknownKey === 'refused' && wrongType === 'refused' && notObject === 'refused'
  && defaults.max_items === 12 && defaults.max_bytes === 4096
  && many.oldest.length === 200 && many.omitted === 50
  && negSnap.oldest.length === 0 && negSnap.omitted === 10
  && rightSnap.box.handle.headline(REAL_PLAN) === '' && nanBytes.box.handle.headline(REAL_PLAN) === HAND.headline,
  `未知键=${unknownKey} 错类型=${wrongType} 非对象=${notObject}；默认=${defaults.max_items}/${defaults.max_bytes}；`
  + `1e9 → ${many.oldest.length} 条 omitted=${many.omitted}；-5 → ${negSnap.oldest.length} 条；`
  + `max_bytes=-5 → "${rightSnap.box.handle.headline(REAL_PLAN)}"；NaN → 摘要长度 ${nanBytes.box.handle.headline(REAL_PLAN).length}`)
} catch (err) {
  check('门执行异常（不得静默通过）', false, `${err.name}: ${String(err.message).slice(0, 200)}`)
}

for (const fiber of fibers) {
  try {
    await fiber.dispose()
  } catch { /* 卸载失败不影响断言结果 */ }
}

finish()
