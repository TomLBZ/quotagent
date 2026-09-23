/**
 * `domain/authority-band` 的 **GUI 贡献** —— 「授权区间（谁能批到多少）」搬进 APP 外壳（DEF-036 / DEF-023）。
 *
 * 修的是哪一条：`gate.escalate` 的字段帮助让你「去看授权区间那一页」，而那一页是旧 SSR 页
 * （`/<view>/authority/`，**它教用户回终端** —— 该页已按 `docs/design/29-webui-gui-app.md` §2
 * 退役为 **303 → `/app/<view>/`**，见 `RETIRED_SUBVIEWS`）；APP 外壳里当时**一个面板都没有**
 * ⇒ 越界了不知道该找谁。
 * 现在：本视图上就有一块面板，读的是**同一份口径**（`authority-band` 插件自己的 `checkOf`，
 * 确定性规则，不读账本、不取墙钟、不能批准），并且**越界时一键真的开一条人工门**（`authority.escalate`
 * → 既有唯一写者 `system/approval/tools/gate-actions.py --step request` 落 `approval/requested`）。
 *
 * 纪律（与插件本体逐条对齐）：
 *   · **只读配置快照**：`authority.*` 那些行从**受管 YAML** 读（与 `config-view` 的只读总览同一来源、
 *     同一个解析器）；非 `authority.` 前缀的键**读都不读**（私域零泄漏，由插件的 `readConfig` 保证）；
 *   · **未配置不得编限额**：`authority.bands.<角色>` 为 null/缺省 ⇒ `unconfigured` + `required_role`/
 *     `next_role` 留空，面板照实说「不知道就是不知道」，并且明写「**未配置 ≠ 额度无限**」；
 *   · **本插件不能批准、不能放行**：面板只算「这笔钱落在谁的区间里 / 越界多少 / 下一个能批的人是谁」；
 *     真正改判定的只有审批队列里的「批准 / 驳回」（人签）；
 *   · 金额一律**整数分**（`unit=cents`）：负数 / 非整数 / 超上限一律具名拒（不折算、不四舍五入）。
 *
 * 复跑：`python3 tmp/p16-verify.py authority`（截图与读数在 `tmp/p16-shots/`）。
 */
import { statSync } from 'node:fs'

import { readConfigFile, projectView, flattenDoc } from '../../../system/config/code/config-ui.mjs'
import {
  AMOUNT_MAX, BAND_PREFIX, CONFIG_PREFIX, MONEY_NOTE, MONEY_UNIT, REGISTERED_ROLES,
  UNCONFIGURED_NOTE, checkOf,
} from './authority-band.mjs'

export const plugin_id = 'domain/authority-band'

const asText = (value) => (typeof value === 'string' ? value.trim() : '')
/**
 * **纯文本**（`**加粗**` 这类 markdown 标记一律去掉）：外壳把面板/回执文案当**纯文本**渲染
 * （不解读 markdown）⇒ 留着星号就等于让用户读到 `**人工专属键**` 这种原样标记。
 */
const plain = (value) => asText(value).replace(/\*\*/g, '')
const CONFIG_ENV = 'QUOTAGENT_UI_CONFIG'
const CONFIG_DEFAULT = '/workspace/config.yaml'

/**
 * **角色术语的唯一定义处**（P43 打掉「两套角色名」的那条）。
 *
 * 界面上原来有两种写法：授权区间这一页列 `buyer / lead / director`（受管 YAML 的键），
 * 名册面板列 `采购员 / 主管 / 管理员`（名册自己的标签）—— 同一个人在两块面板上看到两套名字，
 * 无从判断它们是同一件事还是两件事。现在：**人话名只有这一份映射**，界面（本面板、审批队列、
 * 状态栏）一律用它；`buyer/lead/director` 这些内部 id 照旧留在**机读面**（动作入参、`result`、
 * 配置键列 `authority.bands.<角色>`）里，一个字都没改。
 *
 * **两套角色 id 不是同一套**（不许为好看抹平）：
 *   · 授权区间（受管 YAML `authority.bands.<id>`）：`buyer` / `lead` / `director` —— 管「**这一笔钱**谁能批」；
 *   · 名册（`<ui_shared>/people/roster.json` 的 `roles[].id`）：`pending` / `buyer` / `supervisor` / `admin`
 *     —— 管「谁能**执行受额度限制的动作**」（`role-limit-exceeded`）。
 * 两条链**互不影响**：`lead`（授权区间的主管档）与 `supervisor`（名册的主管）**不是同一个角色 id**，
 * 改一处不会改另一处 —— 所以这里的映射是**两个角色集的对照表**，不是「同一个角色的两种写法」。
 * 名册那一侧的标签真源仍是名册自己（`system/people` 的 `DEFAULT_ROLES[].label`）；本表只在
 * 「授权区间的角色 id 怎么说成人话」这件事上是权威，并把名册的 id→人话一并列出来供对照。
 */
export const ROLE_TERMS = Object.freeze({
  // 授权区间（受管 YAML 的键；机读面照旧用这些 id）
  buyer: '采购员', lead: '主管', director: '管理员',
  // 名册（对照用；真源是名册自己，这里只保证**同一句人话**不出现两种写法）
  pending: '待指派', supervisor: '主管', admin: '管理员',
})

/** 角色 id → 人话。**不认识的角色 id 原样显示**（不编一个好听的名字冒充已知角色）。 */
export const roleTerm = (id) => ROLE_TERMS[asText(id)] ?? (asText(id) || '—')

/**
 * 反向映射：人话（或内部 id）→ 内部 id。动作的 `role` 入参**同时接受三种写法**：
 * `buyer`（机读面：脚本/门/既有调用方）、`采购员`（人话）、`采购员（buyer）`（界面上给的那种，
 * 见 `roleOptions`）—— 三者走同一条判据。认不出来就**原样返回**（不猜一个角色，由插件/服务如实拒）。
 */
export const roleIdOf = (value) => {
  const raw = asText(value)
  if (raw === '') return ''
  if (Object.prototype.hasOwnProperty.call(ROLE_TERMS, raw)) return raw
  const inner = asText((raw.match(/[（(]([^（()）]+)[)）]/) ?? [])[1] ?? '')
  if (inner !== '') {
    if (Object.prototype.hasOwnProperty.call(ROLE_TERMS, inner)) return inner
    const byInnerLabel = Object.entries(ROLE_TERMS).find(([, label]) => label === inner)
    if (byInnerLabel) return byInnerLabel[0]
  }
  const hit = Object.entries(ROLE_TERMS).find(([, label]) => label === raw)
  return hit ? hit[0] : raw
}

/** 动作入参里的「我的角色」选项：人话在前，内部 id 放括号里（机读面仍认 id；`roleIdOf` 反解）。 */
export const roleOptions = () => [...new Set(REGISTERED_ROLES.map((role) => `${roleTerm(role)}（${role}）`))]

/** 表格里的角色写法（与名册面板同一约定：`采购员(buyer)` —— 人话在前、内部 id 在括号，两边都不藏）。 */
export const roleCell = (id) => (ROLE_TERMS[asText(id)] ? `${ROLE_TERMS[asText(id)]}（${asText(id)}）` : (asText(id) || '—'))

/**
 * 受管配置文件的路径（**P49：现在真的从宿主下传下来了**）。
 *
 * 历史：P41 主管走查实测：壳给的 `host.config` **不带** `config_file`（装配点 `host/cli.mjs` 的壳配置块
 * 里当时没有这个键），而服务进程里也**没有** `QUOTAGENT_UI_CONFIG` ⇒ 用 `--config-file` 起的服务，
 * 本面板读的其实是 `/workspace/config.yaml`：**面板说"未配置"，而宿主实际在用的受管配置里
 * `authority.bands.*` 是登记好的** —— "这笔钱越没越界"界面上答不出。
 *
 * 现在：`src/system/webui/code/webui.mjs` 把**本进程真在用的那一份**解析出来（取值链见那边导出的
 * `resolveManagedConfigFile`：宿主显式给 → 配置面 `configView.stats().config_file` → 本进程参数
 * `--config-file` → `QUOTAGENT_UI_CONFIG` → 缺省），随 `host.config.config_file` 交给每个插件，
 * 并**同时发布到进程级**（`webui.mjs` 的 `MANAGED_CONFIG_GLOBAL_KEY`）。
 * 本文件仍保留"宿主给的路径 → 进程级事实 → 环境变量 → 缺省"的兜底，并把**实际读的那个路径**写进面板
 * （降级时也写在原因里）——用户能一眼看出它读的是哪一份文件。
 *
 * **为什么必须有"进程级"这一层**（P49 实测的真因）：`authoritySnapshot()` 也被 `system/approval` 的
 * `code/ui.mjs`（审批队列的「越界？」列）import，而装载面按 `<file>?v=<mtime>` 重复 import 插件代码 ⇒
 * 两边拿到的是**两个模块实例**，模块级变量不共享：队列那一份读到空路径 ⇒ 退回 `/workspace/config.yaml`
 * ⇒ 面板说"buyer 限额 500000"，队列同一笔钱仍说"未配置"。进程级只读事实让两处读同一份文件。
 */
let hostConfigFile = ''
/** 进程级那份受管配置路径（宿主下传；`webui.mjs` 发布、disposer 删除）。 */
const MANAGED_CONFIG_GLOBAL_KEY = '__QUOTAGENT_MANAGED_CONFIG_FILE'
const processConfigFile = () => asText(globalThis[MANAGED_CONFIG_GLOBAL_KEY])
const configPath = (configFile = '') => asText(configFile) || asText(hostConfigFile)
  || processConfigFile() || asText(process.env[CONFIG_ENV]) || CONFIG_DEFAULT

/**
 * 只读配置快照（**按 mtime 备忘**：面板每次渲染都会调 `data()`，9KB 的 YAML 解析一次够了）。
 * 读不到 ⇒ `{}`（插件据此报 `config-missing`，**不假装**区间存在）。
 *
 * **导出给别的插件用**（P43：审批队列的「越界？」列要按**同一份**区间口径算）：调用方把宿主给的
 * `config_file` 传进来即可（不传就是本进程的「宿主给的路径 → 环境变量 → 缺省」），读法与缓存
 * **只有这一份**——不允许在第二个插件里再写一个读受管 YAML 的解析器。
 */
let snapshotCache = { at: -1, size: -1, path: '', snapshot: null, reason: '' }
export const authoritySnapshot = (configFile = '') => {
  const path = configPath(configFile)
  let stat = null
  try {
    stat = statSync(path)          // 只为了拿 mtime/size 做缓存判据；读取与解析都在 `config-ui.mjs`（同一份实现）
  } catch (err) {
    snapshotCache = { at: -1, size: -1, path, snapshot: null, reason: 'config-file-missing' }
    return { snapshot: null, reason: 'config-file-missing', path }
  }
  if (snapshotCache.snapshot && snapshotCache.path === path
    && snapshotCache.at === stat.mtimeMs && snapshotCache.size === stat.size) {
    return { snapshot: snapshotCache.snapshot, reason: snapshotCache.reason, path }
  }
  const file = readConfigFile(path)
  if (!file.ok) {
    snapshotCache = { at: stat.mtimeMs, size: stat.size, path, snapshot: null,
      reason: file.reason || 'config-unreadable' }
    return { snapshot: null, reason: file.reason || 'config-unreadable', path }
  }
  // 受管 YAML 的 `project:` 段在本仓库里是**嵌套**写的（`./run config init` 与 `tools/config-apply.py`
  // 的渲染约定：缩进 2 空格），而 `projectView` 的**文件层**是按**点分扁平键**取值的
  // （`hasOwnProperty(fileLayer, 'authority.bands.buyer')`）⇒ 这里先用 `flattenDoc`（**同一个模块导出的**）
  // 把嵌套展平，两种写法（嵌套 / 已经是点分键）都能读到。
  // 读的是**同一份** `PROJECT_KEYS` 登记表：`authority.*` 之外的键一个都不取。
  const rows = projectView({ doc: { project: flattenDoc(file.value?.project ?? {}) } }).rows
  const snapshot = {}
  for (const row of rows) {
    const key = String(row?.key ?? '')
    if (!key.startsWith(CONFIG_PREFIX)) continue
    snapshot[key] = row.value === undefined ? null : row.value
  }
  snapshotCache = { at: stat.mtimeMs, size: stat.size, path, snapshot, reason: '' }
  return { snapshot, reason: '', path }
}

/**
 * **已登记限额最小的那一档角色**（就是"最严的那一档"）—— 审批队列判断「这笔钱越没越界」时用的参照角色。
 * 由**配置**决定（不写死角色名）：一条 `authority.bands.*` 都没登记 ⇒ 空串（调用方据此如实说「未配置」）。
 */
export const lowestBandRole = (snapshot) => {
  const probe = checkOf({ view: 'contractor', role: REGISTERED_ROLES[0] ?? 'buyer', amount: 1, config: snapshot }, {})
  const bands = (Array.isArray(probe.bands) ? probe.bands : [])
    .filter((band) => Number.isFinite(Number(band?.limit_cents)))
  if (!bands.length) return ''
  return String(bands.reduce((low, band) => (Number(band.limit_cents) < Number(low.limit_cents) ? band : low)).role)
}

/**
 * 一笔金额（整数分）的**结论行**（人话）：在区间内 / 越界多少 / 未配置。
 *
 * **审批队列的「越界？」列用的就是这个函数** ⇒ 队列与「授权区间」面板的「按金额查该谁批」
 * 是同一份口径（同一个 `checkOf`），两边对同一笔钱给出的结论必然一致（逐条可对账）。
 * 判据里没有任何"猜"：未配置就说未配置，不编限额也不假装越界。
 */
export const bandLineFromLowest = (view, cents, snapshot) => {
  const role = lowestBandRole(snapshot)
  if (role === '') {
    return { role: '', text: '未配置（一条 authority.bands.* 都没登记：一律走人工门，判不出越界）' }
  }
  const run = checkOf({ view, role, amount: cents, config: snapshot }, {})
  const band = (Array.isArray(run.bands) ? run.bands : []).find((item) => item.role === role)
  if (run.status === 'inside-band') {
    return { role, text: `在区间内（最严的一档 ${roleTerm(role)} 限额 ${band?.limit_cents ?? '—'} 分覆盖这笔）` }
  }
  if (run.status === 'over-band') {
    return { role, text: `越界 ${run.over_by} 分 ⇒ 下一个能批的是 `
      + `${run.next_role ? `${roleTerm(run.next_role)}（${run.next_role}）` : '（没有角色的限额覆盖这笔金额）'}` }
  }
  if (run.status === 'unconfigured') return { role, text: `未配置（${run.code}）——不知道就是不知道` }
  return { role, text: `输入被拒（${run.code}）` }
}

/** 一笔金额的**结论行**（人话）：在区间内 / 越界多少 / 未配置 / 输入被拒。 */
const verdictOf = (run) => {
  if (run.status === 'inside-band') return `在区间内（还差 ${run.bands.find((b) => b.role === run.role)?.remaining_cents ?? '—'} 分到限额）`
  if (run.status === 'over-band') return `越界 ${run.over_by} 分`
  if (run.status === 'unconfigured') return `未配置（${run.code}）——不知道就是不知道`
  return `输入被拒（${run.code}）`
}

export async function register(surface, host) {
  const me = plugin_id
  // **受管配置的真实路径**（宿主给的就是它在用的那一份）：面板/动作按它读 `authority.*`。
  hostConfigFile = asText(host?.config?.config_file)
  const out = []
  const gateTool = 'src/system/approval/tools/gate-actions.py'
  const ledgerC = () => asText(host.config?.ledger_contractor)
  const ledgerS = () => asText(host.config?.ledger_supplier)
  const ledgerFor = (view) => (view === 'supplier' ? ledgerS() : ledgerC())

  /** 面板的共用数据：区间全表 + 口径 + 出处 + 「这里不能批」的人话。 */
  const panel = (view, order) => surface.panel({
    plugin_id: me, id: view === 'supplier' ? 'authority.bands.supplier' : 'authority.bands',
    title: '授权区间（谁能批到多少 / 越界找谁）', view, order, kind: 'table',
    actions: ['authority.check', 'authority.escalate'],
    // **这块面板读的是哪一份受管 YAML 必须随时看得见**（P49）：登记/未登记两种状态都要能答
    // 「你现在按哪份文件算」。降级时它写在 reason 里；一切正常时写在这里（`hint` 在界面上是可展开的那句
    // "这块怎么用"）。路径由宿主下传（见本文件头与 `webui.mjs#resolveManagedConfigFile`）。
    hint: `这一页按受管配置里的 authority.bands.<角色> 算「这一笔钱谁能批」：`
      + `本面板读的受管配置 = ${configPath()}（只读那一段；越界只是提示，改判定永远在审批队列里由人签）。`
      + `承包商侧改某一档的限额走「人工门 + 另一人复核」：行内「① 提交变更（开人工门）」→ 同事在`
      + `「审批队列」里批准（批的人不能是提交人）→ 回来点「② 把已复核的变更落盘」；`
      + `写的是同一份受管配置（唯一落盘者 config-apply.py）。`,
    data: () => {
      const { snapshot, reason, path } = authoritySnapshot()
      const meta = { unit: MONEY_UNIT, registered_roles: [...REGISTERED_ROLES] }
      // **本面板读的到底是哪一份**（P50，① 的机读读数）：把取值链的每一节都摆出来 ——
      // 宿主下传的 `host.config.config_file`（就是机制给每个插件的那一份）、进程级只读事实、
      // 环境变量、以及**最终生效**的那一个。三处一致时它们同值；不一致时**如实并列**（不挑好看的报）。
      const readout = { host_config_file: asText(host?.config?.config_file),
        process_global: processConfigFile(), env: asText(process.env[CONFIG_ENV]),
        effective: configPath(), file_readable: reason === '' }
      const probe = checkOf({ view, role: REGISTERED_ROLES[0] ?? 'buyer', amount: 1, config: snapshot }, {})
      const configured = Array.isArray(probe.bands) ? probe.bands : []
      const rows = (meta.registered_roles ?? []).map((role) => {
        const found = configured.find((item) => item.role === role) ?? null
        return {
          id: role, role: roleCell(role), role_id: role, band_key: `${BAND_PREFIX}${role}`,
          limit_cents: found ? found.limit_cents : null,
          // **逐行都写清"未配置 ≠ 0 ≠ 无限"**：这是 DEF-036 点名的那条误导
          limit_label: found ? `${found.limit_cents} 分（= ${(found.limit_cents / 100).toFixed(2)} 元）`
            : '未配置 ⇒ 这个角色不是"不限"，而是"一律走人工门"',
          status: probe.status, can_approve: '否（本面板不能批准、不能放行）',
        }
      })
      const unset = probe.status === 'unconfigured'
      return { ok: true, kind: 'table', degraded: unset, readout,
        // **降级原因第一行是人话**（机器码放括号里）：读配置读出了"还没登记"这件事，不是坏了
        reason: unset
          ? `授权区间还没登记（机器码 ${probe.code || 'band-unconfigured'}）—— 未配置 ≠ 额度无限：一律走人工门`
            + `；本页读的受管配置：${path}`
          : '',
        next_action: unset
          ? `这一页的限额还没登记：登记 authority.bands.<角色>（整数分）之后本页立刻按它算。`
            + `界面上就能改：点这一行行内的「① 提交变更（开人工门）」提交（人签），`
            + `再让另一个人在「审批队列」里批准，然后回来点「② 把已复核的变更落盘」——`
            + `人工门事实 → 0600 待办件 → 唯一落盘者落受管 YAML，写的就是上面那一份 ${path}；`
            + `先不改配置也能干活：用下面的「按金额查该谁批」算一笔，越界就点「提交给下一角色审批」开人工门`
          : '按金额查谁批（表单），越界就一键开人工门；改判定永远在审批队列里由人签批准/驳回；'
            + '要改某一档的限额：行内「① 提交变更（开人工门）」→ 另一人批准 → 「② 把已复核的变更落盘」',
        columns: [
          { key: 'role', label: '角色（人话 + 内部 id）', type: 'code' },
          { key: 'limit_cents', label: '限额（整数分）', filter: 'number' },
          { key: 'limit_label', label: '这一行到底什么意思' },
          { key: 'band_key', label: '配置键（人工专属）', type: 'code' },
        ],
        rows,
        // 行内入口：**承包商侧**（主管）那一屏多两颗（**① 提交变更 / ② 复核后落盘**，人签 + 落受管 YAML）；
        // 供应商侧的同一块面板是**看**的那一面（改限额不是投标方的事）。
        row_actions: view === 'contractor'
          ? ['authority.bands.set', 'authority.bands.apply', 'authority.check', 'authority.escalate']
          : ['authority.check', 'authority.escalate'],
        counts: { registered_roles: rows.length, configured: configured.length },
        // 口径常数（`MONEY_NOTE`/`UNCONFIGURED_NOTE`）自带 markdown 星号 —— 外壳把文案当**纯文本**渲染，
        // 原样贴上去用户会读到 `**整数分**`（P41 登记的同一类"机制噪音"）⇒ 过一遍 `plain()`。
        note: `口径：${plain(MONEY_NOTE)}。`
          + `单位声明 ${MONEY_UNIT}；配置来源 = 受管 YAML ${path}（只读 \`${CONFIG_PREFIX}\` 那些行，`
          + '别的键读都不读）'
          + `${reason ? `；本次读取降级：${reason}` : ''}。`
          + (unset ? `${plain(UNCONFIGURED_NOTE)}。` : '')
          // 主管/审批人最容易混的一点：「授权区间」与「名册角色额度」是**两套口径、两处入口**。
          // 这一页读的是受管配置（业务界面里改不了）；名册那套在「人员名册与角色」面板里改、立刻生效。
          // P43：术语**只有一份映射**（`ROLE_TERMS`：界面上人话在前、内部 id 在括号里），下面把两个
          // 角色集的对照**逐条列出来**——不靠一句"两套口径"让用户自己去猜谁是谁。
          + '术语对照（两个角色集不是同一套，改一处不会改另一处）：'
          + `① 授权区间 = 受管 YAML 的 \`${BAND_PREFIX}<角色>\`，管「这一笔钱谁能批」，`
          + `角色是 ${REGISTERED_ROLES.map((role) => `${roleTerm(role)}（${role}）`).join(' / ')}；`
          + '② 名册角色额度 = 「人员名册与角色」面板里的角色，管「谁能执行受额度限制的动作」'
          + '（role-limit-exceeded），角色是 待指派（pending）/ 采购员（buyer）/ 主管（supervisor）/ 管理员（admin）。'
          + '两边都叫「主管」的 lead 与 supervisor 是两个不同的角色 id：'
          + '本页这一栏的 lead 只在这一页管钱，名册里的 supervisor 只在那套管动作。'
          + '本面板由确定性规则派生（source=authority-band）：不读账本、不取墙钟、不调模型、'
          + '不能批准——越界的唯一出路是人工门（提交后去「审批队列」由人签批准/驳回）。' }
    } })

  out.push(surface.view({ plugin_id: me, id: 'authority.workspace', title: '授权区间', order: 8,
    view: 'contractor', hint: '谁能批到多少 / 越界多少 / 下一个能批的人是谁；一键把越界的事提成人工门' }))
  out.push(surface.view({ plugin_id: me, id: 'authority.workspace.supplier', title: '授权区间', order: 8,
    view: 'supplier', hint: '谁能批到多少 / 越界多少 / 下一个能批的人是谁；一键把越界的事提成人工门' }))
  out.push(panel('contractor', 8))
  out.push(panel('supplier', 8))

  // ------------------------------------------------------------------ 动作
  /**
   * **授权区间变更 = 人工门 + 另一人复核**（P50；P49 是自助登记，本批按 P48 同口径改）。
   *
   * 两个动作，一条写路径（**没有第二条**）：
   *
   *   · `authority.bands.set`（**① 提交变更**）：身份门（署名 == 会话身份）→ 白名单/类型门 →
   *     **点名另一个复核人**（本侧名册里除自己以外的人）→ 落 `approval/requested`
   *     （`scope=config.authority`、`ref=authority-band:<request_id>`）→ 落一份 **0600 暂存件**。
   *     **受管配置一个字都不改**（暂存件不进 config 收件箱 ⇒ 唯一落盘者扫不到它）。
   *   · `authority.bands.apply`（**② 复核后落盘**）：等复核人在「审批队列」里批准之后，由**任何一方**签名
   *     再点一下；判据是**一处**（`src/system/approval/code/approval.py#signoff_verdict`，与承诺/发 PO 同源）：
   *     批的人必须**不是**提交的人、必须是人、必须是开单时点名的那位；通过后 0600 待办件 → 唯一落盘者
   *     `config-apply.py` 落受管 YAML（回读 sha256 前后：\"真的变了\"是读数）。
   *
   * **唯一的放行开关**（**默认关闭**、界面上没有它、只有运营侧文件）：`<ui-shared>/authority-bands/policy.json`
   * 的 `{"allow_self_approval": true}`；开着时 ② 会**如实**回执「批准人 == 提交人（自签自批：显式开关已开）」。
   *
   * 它**不改任何判定**：限额落盘之后，越界结论仍由 `checkOf` 算、批准仍只在审批队列里由人签（本插件不能批准）。
   */
  const bandsApplyTool = 'src/system/config/tools/authority-bands-apply.py'
  /** **本侧名册里除我以外的人**（复核人候选；名册是 0600 配置，不进账本、不进模型输入）。 */
  const otherMembers = (side, me) => {
    const store = host.people
    if (!store || typeof store.members !== 'function' || side === '') return []
    try {
      return store.members(side).map((member) => asText(member?.human)).filter((who) => who && who !== me)
    } catch (err) { return [] }
  }
  /** 动作入参的公共前置（身份/侧/署名/角色/限额）——两个动作**同一串判据**，不各写一份。 */
  const bandInputs = (ctx, input, view) => {
    const side = asText(ctx?.identity?.side)
    if (side !== '' && side !== view) {
      return { refusal: { ok: false, code: 'cross-side-action',
        reason: `你的会话是 ${side} 侧，却在 ${view} 侧改授权区间：侧只认会话`,
        next_action: `在 ${side} 侧自己的「授权区间」面板里改` } }
    }
    const signature = asText(input.signature)
    if (!signature) {
      return { refusal: { ok: false, code: 'human-required', reason: '改授权区间要有人认领：署名不能空',
        next_action: '署名写 human:<你的名字>（服务端要求它等于会话身份）' } }
    }
    const role = roleIdOf(input.role)
    if (role === '' || !REGISTERED_ROLES.includes(role)) {
      return { refusal: { ok: false, code: 'unknown-band-role',
        reason: `授权区间的角色只有 ${REGISTERED_ROLES.join(' / ')}（收到 ${JSON.stringify(input.role)}）`,
        next_action: '从下拉里挑一个登记过的角色（新增角色要先改配置键登记表，不是在这里编）' } }
    }
    const cents = Number(input.limit_cents)
    if (!Number.isInteger(cents) || cents < 0 || cents > AMOUNT_MAX) {
      return { refusal: { ok: false, code: 'limit-not-integer',
        reason: `限额必须是 [0, ${AMOUNT_MAX}] 内的整数分（收到 ${JSON.stringify(input.limit_cents)}）`,
        next_action: '写整数分（500000 = 5000.00 元）：本页不折算、不四舍五入' } }
    }
    const configView = host.service('configView')
    const stats = configView && typeof configView.stats === 'function' ? configView.stats() : null
    if (!stats) {
      return { refusal: { ok: false, code: 'config-service-missing',
        reason: '本进程没有配置面（configView）句柄：拿不到受管配置文件与待办件目录',
        next_action: '确认 system/config 插件已装载（本页不做第二条写路径、也不自己猜路径）' } }
    }
    const configFile = asText(stats.config_file) || asText(host.config?.config_file)
    const inbox = asText(stats.config_inbox)
    const ledger = asText(stats.config_ledger)
    if (configFile === '' || inbox === '' || ledger === '') {
      return { refusal: { ok: false, code: 'config-surface-unconfigured',
        reason: `配置面缺路径（config_file=${configFile || '（空）'} · config_inbox=${inbox || '（空）'} · `
          + `config_ledger=${ledger || '（空）'}）`,
        next_action: '让服务端把 configView 的这三个路径配上（宿主侧未挂时不假装成功）' } }
    }
    return { side, signature, role, cents, configFile, inbox, ledger, view }
  }
  /** 写者回执 → 界面回执（两个动作共用；`code`/`reason`/`next_action` 一律**照抄写者**的原话）。 */
  const bandReceipt = (run, fields, extra = {}) => {
    const json = run.json ?? {}
    const ok = Boolean(run.ok && json.ok === true)
    const refusal = json.refusal ?? null
    return { ok, code: refusal?.code ?? (ok ? extra.ok_code ?? 'band-registered' : 'writer-failed'),
      reason: refusal?.reason ?? (ok ? '' : (run.reason ?? '唯一落盘者没给出 JSON')),
      next_action: refusal?.next_action ?? (ok ? extra.next_action : '看 result.stdout / 落盘者回执定位后重提（本页账本零新增）'),
      result: { ...fields, ...extra.result,
        approval_id: json.approval_id ?? '', approval_ref_kind: json.approval_ref_kind ?? '',
        ref: json.ref ?? '', approvers: json.approvers ?? [], approved_by: json.approved_by ?? '',
        submitted_by: json.submitted_by ?? '', self_approved: json.self_approved === true,
        allow_self_approval: json.allow_self_approval === true,
        config_file: json.config_file ?? fields.configFile,
        config_sha256_before: json.config_sha256_before ?? '', config_sha256_after: json.config_sha256_after ?? '',
        persisted: json.persisted === true, staged_file: json.staged_file ?? '',
        item_file: json.item_file ?? '', item_mode: json.item_mode ?? '',
        ledger_added: Number(json.ledger_added ?? 0), applied: json.applied ?? [], refused: json.refused ?? [],
        writer: json.writer ?? '', stdout: run.stdout ? run.stdout.slice(-400) : '' } }
  }
  out.push(surface.action({ plugin_id: me, id: 'authority.bands.set',
    title: '① 提交授权区间变更（开人工门，等另一个人复核）',
    views: ['contractor'], group: '审批', order: 4, permission: 'human-signature',
    confirm: { required: true, message: '这条只开一条人工门（approval/requested，scope=config.authority）'
      + '并落一份 0600 暂存件 —— 受管配置一个字节都不改。确认以你的署名提交给另一个人复核？' },
    hint: '限额一律整数分（500000 = 5000.00 元；不折算、不四舍五入）。提交后：同事在「审批队列」里'
      + '批准 / 驳回（批的人必须不是提交人，判据与承诺/发 PO 的人门同源）→ 回来点'
      + '「② 把已复核的变更落盘」。本动作不改任何判定，也不能批准任何事。',
    input: { fields: [
      { name: 'role', label: '角色（改哪一档）', type: 'select', options: roleOptions(), required: true,
        help: '键是受管 YAML 的 authority.bands.<角色>；这里给人话名，括号里是机读面的角色 id（两种写法都认）' },
      { name: 'limit_cents', label: '这一档的新限额（整数分）', type: 'number', required: true,
        min: 0, max: AMOUNT_MAX,
        help: '500000 = 5000.00 元。整数分：把「元」当「分」写，数字会大 100 倍并被判越界' },
      { name: 'approvers', label: '点名给谁复核（本侧同事，可多个逗号分隔）', type: 'text', required: true,
        help: '必须是另一个人的名字（本侧名册里的同事）；自提自批会被拒（除非运营侧显式开开关）。'
          + '名册里没有第二个人？先让同事登录一次（登录即登记）或去「人员名册与角色」加人' },
      { name: 'signature', label: '署名（人签，提交人）', type: 'signature', required: true,
        help: 'human:<你的名字> —— 服务端要求它等于会话身份；提交人是谁会进账本' },
      { name: 'note', label: '一句话说明（进待办件，不上账本正文）', type: 'textarea', required: false },
    ] },
    server: async (ctx, input) => {
      const view = String(ctx?.view ?? 'contractor')
      const parsed = bandInputs(ctx, input, view)
      if (parsed.refusal) return parsed.refusal
      const { signature, role, cents, configFile, inbox, ledger } = parsed
      const me_ = asText(ctx?.identity?.human)
      const side = parsed.side || (view === 'supplier' ? 'supplier' : 'contractor')
      const others = otherMembers(side, me_)
      // 点名复核人：填了就照填；没填 = 本侧名册里除我以外的**所有人**（谁先看到谁批）。
      const named = String(input.approvers ?? '').split(/[,\s]+/).map(asText).filter(Boolean)
      const approvers = named.length ? named : others
      const bad = approvers.filter((who) => !who.startsWith('human:'))
      if (bad.length) {
        return { ok: false, code: 'approver-not-human',
          reason: `点名复核人必须是 human:<名字>（收到 ${JSON.stringify(bad.join(','))}）`,
          next_action: '从名册里挑一个人（本侧同事），或留空让我按名册自动点名' }
      }
      const run = host.runPython(bandsApplyTool, ['--step', 'request',
        '--session-human', me_ || signature, '--actor', signature, '--now', host.now(),
        '--role', role, '--limit-cents', String(cents), '--file', configFile, '--inbox', inbox,
        '--ledger', ledger, '--ui-shared', host.sharedDir, '--approvers', approvers.join(',')])
      const json = run.json ?? {}
      return bandReceipt(run, { role, role_label: roleTerm(role), band_key: `${BAND_PREFIX}${role}`,
        limit_cents: cents, config_file: configFile, approvers_candidates: others, view,
        self_approval_note: '授权区间变更走「人工门 + 另一人复核」：批的人不能是提交的人'
          + '（唯一开关 <ui-shared>/authority-bands/policy.json 的 allow_self_approval，默认关闭）',
        writer: 'src/system/config/tools/authority-bands-apply.py' }, {
        ok_code: 'band-change-submitted',
        next_action: `已提交（本动作账本 +${Number(json.ledger_added ?? 0)} 行）：受管配置没改。`
          + `去「审批队列」让 ${approvers.join('、') || '（本侧同事）'} 批准 / 驳回这条门；`
          + `批准之后回来点「② 把已复核的变更落盘」` })
    } }))

  out.push(surface.action({ plugin_id: me, id: 'authority.bands.apply',
    title: '② 把已复核的变更落盘（消费另一人的批准）',
    views: ['contractor'], group: '审批', order: 5, permission: 'human-signature',
    confirm: { required: true, message: '这一步把已复核的授权区间变更落进受管配置：'
      + '唯一落盘者 config-apply.py 写 YAML（回读 sha256 前后）。确认以你的署名落盘？' },
    hint: '只消费一扇已批准、且批的人不是提交人的人工门（判据与承诺/发 PO 同源）：'
      + '还没批 / 被驳回 / 被终止 / 自己批自己 ⇒ 具名拒 + 账本零新增 + 不改文件。'
      + '落盘后「授权区间」面板与审批队列的「越界？」列下一次读就按新限额算（同一个文件、同一份口径）。',
    input: { fields: [
      { name: 'role', label: '角色（哪一档，与提交时一致）', type: 'select', options: roleOptions(), required: true },
      { name: 'limit_cents', label: '这一档的新限额（整数分，与提交时一致）', type: 'number', required: true,
        min: 0, max: AMOUNT_MAX, help: '提交时的字段与摘要要对得上，否则如实拒（不让落一份对不上的件）' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true,
        help: 'human:<你的名字> —— 服务端要求它等于会话身份；谁落盘也会进账本' },
    ] },
    server: async (ctx, input) => {
      const view = String(ctx?.view ?? 'contractor')
      const parsed = bandInputs(ctx, input, view)
      if (parsed.refusal) return parsed.refusal
      const { signature, role, cents, configFile, inbox, ledger } = parsed
      const run = host.runPython(bandsApplyTool, ['--step', 'apply',
        '--session-human', asText(ctx?.identity?.human) || signature, '--actor', signature,
        '--now', host.now(), '--role', role, '--limit-cents', String(cents), '--file', configFile,
        '--inbox', inbox, '--ledger', ledger, '--ui-shared', host.sharedDir])
      const json = run.json ?? {}
      const ok = Boolean(run.ok && json.ok === true)
      // **放行开关开着就必须如实说**（P48 同口径）：批准人 == 提交人 ⇒ 这不是双人复核。
      const selfApproved = Boolean(json.approved_by) && json.approved_by === json.submitted_by
      return bandReceipt(run, { role, role_label: roleTerm(role), band_key: `${BAND_PREFIX}${role}`,
        limit_cents: cents, config_file: configFile, view,
        self_approval_note: selfApproved
          ? '⚠ 自签自批：运营侧显式开关已开（批准人 == 提交人）—— 这一次不算「另一个人复核过」'
          : '这一条落盘的门由另一个人批过（谁批的 ≠ 谁提交的）' }, {
        ok_code: 'band-change-applied',
        next_action: `已写进受管配置 ${json.config_file ?? configFile}（受管文件 sha256 `
          + `${String(json.config_sha256_before ?? '').slice(7, 19)} → ${String(json.config_sha256_after ?? '').slice(7, 19)}`
          + `，账本 +${Number(json.ledger_added ?? 0)} 行）：谁批的 ${json.approved_by ?? '—'}`
          + `${json.approved_by && json.approved_by !== json.submitted_by
            ? `（≠ 谁提交的 ${json.submitted_by}）` : '（⚠ 自签自批：开关已开）'}` })
    } }))

  out.push(surface.action({ plugin_id: me, id: 'authority.check', title: '按金额查该谁批（只读，账本零新增）',
    views: ['contractor', 'supplier'], group: '审批', order: 5, permission: 'none', inline: true,
    confirm: { required: false },
    hint: '跑的是插件自己的确定性规则（不读账本、不取墙钟）；本动作不改任何判定、账本零新增',
    input: { fields: [
      { name: 'role', label: '我的角色', type: 'select', options: roleOptions(), required: true,
        help: '限额是按角色登记的（受管 YAML 的 authority.bands.<角色>）；这里给人话名，'
          + '括号里是机读面用的角色 id（两种写法都认）' },
      { name: 'amount', label: '金额（整数分：500000 = 5000.00 元）', type: 'number', required: true,
        min: 0, max: AMOUNT_MAX, help: '不折算、不四舍五入：把元写成分会被判越界' },
    ] },
    server: async (ctx, input) => {
      const { snapshot, reason } = authoritySnapshot()
      // 入参同时接受人话与内部 id（见 `roleIdOf`）：判据只有一条，机读面照旧用 `buyer/lead/director`。
      const role = roleIdOf(input.role)
      const run = checkOf({ view: String(ctx.view ?? 'contractor'), role,
        amount: input.amount, config: snapshot }, {})
      const bad = ['input-rejected'].includes(run.status)
      return { ok: !bad, code: bad ? (run.code || 'input-rejected') : `authority-${run.status}`,
        reason: bad ? run.reason : '',
        next_action: bad ? run.next_action
          : (run.status === 'over-band'
            ? `越界 ${run.over_by} 分：用「提交给下一角色审批」把这件事提成人工门`
              + `${run.next_role ? `（下一个能批的是 ${roleTerm(run.next_role)}（${run.next_role}））` : '（没有角色的限额覆盖这笔金额：只能改配置或走人工门）'}`
            : (run.status === 'inside-band'
              ? `${roleTerm(run.role)}（${run.role}）的限额覆盖这笔金额：继续既有流程；批准仍在审批队列里由人签（本面板不能批准）`
              : `${plain(run.next_action)}${reason ? `（配置读取降级：${reason}）` : ''}`)),
        result: { status: run.status, verdict: verdictOf(run), role: run.role, role_label: roleTerm(run.role),
          amount: run.amount, required_role: run.required_role, next_role: run.next_role, over_by: run.over_by,
          bands: run.bands, within: run.within, unit: run.unit, can_approve: run.can_approve,
          unconfigured: run.unconfigured, blocked_by: run.blocked_by, config_where: run.config_where,
          approval_note: run.approval_note, notes: run.notes, ledger_added: 0 } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'authority.escalate',
    title: '提交给下一角色审批（越界 → 开一条人工门）',
    views: ['contractor', 'supplier'], group: '审批', order: 6, permission: 'human-signature',
    confirm: { required: true, message: '越界的金额要提成人工门：确认以你的署名开这条门？'
      + '（门本身不改判定；谁批它由点名的审批人决定）' },
    hint: '落 `approval/requested`（既有事件，scope=authority.escalate）—— 写者仍是 '
      + '`tools/gate-actions.py`；门开出来后去「审批队列」由点名的审批人批准/驳回',
    input: { fields: [
      { name: 'role', label: '我的角色', type: 'select', options: roleOptions(), required: true },
      { name: 'amount', label: '金额（整数分）', type: 'number', required: true },
      { name: 'ref', label: '这笔钱挂在哪条事实上（被批对象的 id）', type: 'text', required: true,
        help: '如 q-… / aw-… / chg-…（门要挂在一个真对象上，不许凭空的金额）' },
      { name: 'approvers', label: '点名给谁批（human:<名字>）', type: 'text', required: true,
        help: '越界时面板给出的下一档角色决定"该找哪个角色"，这里写那个角色的具体人' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true,
        help: 'human:<你的名字> —— 服务端要求它等于会话身份' },
      { name: 'note', label: '一句话说明（进待办件，不上账本正文）', type: 'textarea', required: false },
    ] },
    server: async (ctx, input) => {
      const role = roleIdOf(input.role)          // 人话与内部 id 都认（判据只有一条）
      const ref = asText(input.ref)
      const asked = String(ctx.view ?? 'contractor')
      const mine = asText(ctx?.identity?.side)
      if (mine !== '' && mine !== asked) {
        return { ok: false, code: 'cross-side-action',
          reason: `你的会话是 ${mine} 侧，却在 ${asked} 侧发起升级：侧只认会话`,
          next_action: `在 ${mine} 侧自己的「授权区间」面板里发起` }
      }
      const view = mine === '' ? asked : mine
      const { snapshot } = authoritySnapshot()
      const run = checkOf({ view, role, amount: input.amount, config: snapshot }, {})
      if (run.status === 'inside-band') {
        return { ok: false, code: 'not-over-band',
          reason: `${roleTerm(run.role)}（${run.role}）的限额 ${run.bands.find((b) => b.role === run.role)?.limit_cents} 分`
            + `覆盖这笔 ${run.amount} 分：没有越界，不需要升级`,
          next_action: '直接走既有流程；整笔的批准仍在「审批队列」里由人签（本面板不能批准）' }
      }
      if (run.status !== 'over-band') {
        return { ok: false, code: run.code || 'authority-unconfigured',
          reason: `拿不到区间结论（${run.status}）：不编一个限额，也不假装这笔越界了`,
          next_action: run.next_action }
      }
      const approvers = String(input.approvers ?? '').split(/[,\s]+/).map(asText).filter(Boolean)
      const bad = approvers.filter((who) => !who.startsWith('human:'))
      if (!approvers.length || bad.length) {
        return { ok: false, code: 'approver-not-human',
          reason: `点名审批人必须是 human:<名字>（收到 ${JSON.stringify(input.approvers)}）`,
          next_action: '写 human:<名字>；越界时该找哪个角色看面板给出的「下一个能批的是」'
            + `${run.next_role ? `（本题是 ${roleTerm(run.next_role)}（${run.next_role}））` : '（本题没有角色能批这笔金额）'}` }
      }
      const staged = host.stage('gate-actions', { kind: 'gate-actions', action: 'request', view,
        scope: 'authority.escalate', ref, summary: `越界 ${run.over_by} 分（角色 ${roleTerm(run.role)}）待批`,
        timeout_policy: 'escalate', timeout_s: 86400, escalate_to: approvers[0], approvers,
        actor: asText(input.signature), note: String(input.note ?? '') })
      if (!staged.ok) return staged
      const runTool = host.runPython(gateTool, ['--step', 'request', '--request', staged.path,
        '--ui-shared', host.sharedDir, '--ledger-contractor', ledgerFor(view), '--view', view, '--now', host.now()])
      const json = runTool.json ?? {}
      const refusal = json.refusal ?? null
      const ok = Boolean(runTool.ok && json.ok === true)
      return { ok, code: refusal?.code ?? (ok ? 'gate-opened' : 'writer-failed'),
        reason: refusal?.reason ?? (ok ? '' : (runTool.reason ?? '')),
        next_action: refusal?.next_action ?? json.next_action_runtime
          ?? (ok ? `门 ${json.approval_id} 已开（approval/requested，本动作账本 +${Number(json.ledger_added ?? 0)} 行）：`
              + `去「审批队列」让 ${approvers.join('、')} 批准/驳回`
            : '看 result.stdout 定位后重提（本动作账本零新增）'),
        result: { pending: staged.file, pending_file: staged.name, view,
          approval_id: json.approval_id ?? '', scope: 'authority.escalate', ref,
          over_by: run.over_by, role: run.role, next_role: run.next_role, approvers,
          ledger_added: Number(json.ledger_added ?? 0), applied: json.applied ?? [],
          stdout: runTool.stdout ? runTool.stdout.slice(-400) : '' } }
    } }))

  out.push(surface.statusItem({ plugin_id: me, id: 'status.authority', title: '授权区间', order: 8, read: () => {
    const { snapshot, reason } = authoritySnapshot()
    const probe = checkOf({ view: 'contractor', role: REGISTERED_ROLES[0] ?? 'buyer', amount: 1, config: snapshot }, {})
    const configured = Array.isArray(probe.bands) ? probe.bands.length : 0
    // 术语**只有一份**（`ROLE_TERMS`/`roleTerm`）：状态栏也写人话，内部 id 留在机读面与面板的配置键列里。
    const ladder = REGISTERED_ROLES.map((role) => `${roleTerm(role)}（${role}）`).join(' / ')
    return { text: probe.status === 'unconfigured'
      ? `未配置（${configured}/${REGISTERED_ROLES.length} 个角色登记了授权区间；未配置 ≠ 不限额；`
        + `这是「授权区间」（${ladder}），与「名册角色额度」不是同一处）`
      : `已登记 ${configured} 个角色：${ladder}`,
      level: probe.status === 'unconfigured' ? 'warn' : 'ok',
      next_action: probe.status === 'unconfigured'
        ? '在「授权区间」面板登记 authority.bands.<角色>（整数分），或先按金额算一笔再开人工门'
        : (reason || '') } } }))

  return out
}
