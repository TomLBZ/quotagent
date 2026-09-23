# 入口策略（只摆能跑的动作）与空态（读数/说明行不算数据）

<!-- 预算：16 KB（`src/*/*/docs/*.md`）。机制真源：`src/system/webui/code/assets/app.js`
     （`partitionActions`/`contextMissing`/`contextCandidates`/`openActionEntry`/`panelHasData`/
     `viewEmptiness`/`workbenchHasNothing`/`todoItems`）与 `src/system/webui/code/ui-surface.mjs`
     （字段来源声明 → `actions[].needs`、`action_entry[].affinity`、`guides`）。口径真源：
     `docs/design/29-webui-gui-app.md` §23（能力/禁止）；逐条判据 = `29-webui-gui-app-archive.md` §23。
     本页是给**插件作者**看的那一面：你声明什么，外壳就把什么摆对地方。 -->

## 0. 一句话

> 插件只声明**两件事**——「这个字段的值从哪来」与「这块面板是不是读数」——外壳负责让**每个动作都有一条
> 可发现、跑得起来的入口**，并且**不摆按下去必然被拒或必然撞「必填」的按钮**；空账本的首屏说人话 + 真能
> 做的下一步，而不是一面空面板墙。

## 1. 插件声明什么（就这两样）

### 1.1 字段来源（每个动作的每个入参字段）

| 声明 | 含义 | 外壳据此 |
|---|---|---|
| `from_row: true` | 值来自**那一行 / 选中行** | 进「缺 `row` 上下文」；给候选行（挑一条 = 按整行预填） |
| `row_field: '<列名>'` | 值来自行里**另一列**（同名不必写） | 候选行的取值按这个列名取 |
| `from_route: true` | 值来自**当前对象地址**（`/app/<视图>/<对象类>/<id>/`） | 在对象页上直接可开；不在对象页 ⇒ 缺 `route` |
| `from_route_kind: true` | 同上，但只取**对象类**（对任何对象类都成立） | 对象页页头工具栏摆它 |
| `new_value: true` | 这是**人自己起的新名字**（不是引用已有对象） | **不算**缺上下文（工具栏直接摆） |
| `bulk: 'ids'` / `bulk: 'rows'` | 批量动作 | 需要勾选（`selection`），表头出批量按钮 |

兜底规则（机制，`ui-surface.mjs#REFERENCE_FIELD_RE`）：名字形如 `*_id` / `id` 的**必填**字段、且没声明
`new_value` ⇒ 默认算「引用已有对象」（缺 `row` 上下文）。**显式声明优先于兜底**。

### 1.2 面板是不是「读数」（`not_data`）

`not_data: true` = 这块面板**不参与空态判断**（说明类 / 运营配置类：沙盘入口、名册与角色、导出偏好、
规则自述…）。它照旧渲染、照旧有数据，只是不会把「这一屏是空的」挤掉。

## 2. 外壳据此做什么（三条入口，一个不少）

每个动作**至少有一条**可发现、真能跑的入口；同一动作在不同地址走不同的那条：

1. **工具栏**：只摆**当前地址跑得起来**的动作（判据 = `needs` 里那几组上下文在这一地址上都齐）。
2. **「这些动作要先有一个对象（N 个）」引导区**（`[data-need-context]`）：缺上下文的动作进这里，
   逐条写明**它该在哪跑**（依据是你声明的行内归属 `affinity` + 真实候选），点一下出**候选清单**：
   * **给得出所需字段名的行**（挑一条 ⇒ 按整行预填 ⇒ 开表单，与行内那颗按钮**同一条路**）；
   * **带 `ref` 的对象行**（打开那条对象的页面，并在那一页上自动打开这个动作，对象地址预填）；
   * 一条候选都没有 ⇒ 如实说「现在这一页没有可挑的（不是坏了）」+ 给能做的下一步。
   * **候选的粒度 = 这一行会带进表单的值的粒度，不是标签的粒度**（P33 修）：去重键是
     `(面板, 那一行给这几个字段取的值)` 的**预填指纹**，不是 `(面板, 标签)` —— 修前标签优先取
     `package_id`/`quote_id` 这类"一份对象一个名字"的字段，**一份多行报价的几行会塌成一条候选**
     （实测：`award.propose` 的多行报价只挑得到首行，第二行 `L-002` 得先回表格用查询条筛到那一行）。
     现在两条行**只有预填指纹完全一样**才算同一个候选；按钮文字里再补上**能区分行的那几个字段值**
     （`名字=值`，只列不等于标签的那些），否则清单上会并排出现几个一模一样的名字（等于没修）。
   * **每类最多 12 条**（`CANDIDATE_CAP`），**上限要可见**：命中超过上限时清单里写明「命中 N 条，
     只列前 M 条（余 K 条没列出来 —— 不是没有）」并给出下一步（先在上面那块表里筛一下，候选跟着变），
     不是把多出来的悄悄藏掉（`[data-entry-capped="rows"|"objects"]`；函数读数见
     `window.__Q_GUI_ENTRY.candidates(id).counts`）。
3. **命令面板**（`#q-palette-list`，键盘 `Ctrl/⌘+K`）：列**全部动作一个不少**，每条带判词
   「就绪：点了就开表单」或「要先挑一条（字段名）」。缺上下文的进去**不是空表单**，而是同一份候选清单。

**行内动作按行状态给**（`row_actions` 按行声明）：一行现在**真能落账**才摆那颗按钮；不能落账的行写明
「缺什么、下一步该谁办」。这条**不放松任何判据** —— 判据与唯一写者一字不差，只是不摆按下去必被拒的按钮。

## 3. 空态判据（哪些算「有业务数据」）

一块面板判「有数据」当且仅当（`panelHasData`，只按通用形状与声明，外壳不认识业务名词）：

* `counts` 里有非零；或
* `table.rows` 非空；或
* 有**活的**文件（`files`，`deleted !== true`）；或
* `list.items` 里**至少有一行能指得出对象**：`id` / `ref` / `action` / `bucket` 四者之一非空。

**不算**数据的四类：① `panel.not_data === true`（插件声明）；② `degraded`（读不到 ≠ 有数据）；
③ **读数**（`html` 说明 / `metrics` 读数 / **`kv` 键值读数**：落点、权限、上限、版本口径…）；
④ **说明行**（面板自己在说"我这里没有东西"或给下一步的行：没有可指认对象）。

**工作台（`home`）再叠一条**（它是导向页，面板全是读数 + 下一步）：还要**没有任何一条待办
指得出对象（`ref.kind` + `ref.id`）或标了急（`warn`/`bad`）**，这一屏才算空。

**同口径的一条修**：待办聚合（「有 N 件需要你处理」）**跳过降级面板**（它给的是"未登录 / 读不到"的说明行），
并把跳过几块**如实写进卡头**（数字变小不能被读成"事情变少了"）。

### 3.1 机读读数（截图之外逐条对账用）

| 读数 | 在哪 |
|---|---|
| 这一屏空不空 + 哪几块算有数据 | `[data-view-emptiness]` 的 `data-view-emptiness` / `data-panels-with-data` / `data-panels-total` / `data-emptiness-basis` / `data-home-nothing` |
| 同一份判定的函数读数 | `window.__Q_GUI_ENTRY.emptiness()` |
| 入口策略的函数读数 | `window.__Q_GUI_ENTRY.{needs,missingHere,candidates,toolbar,needsContext}` |
| 注册面（服务端） | `/api/ui/surface` 的 `actions[].needs` / `action_entry` / `guides` |
| 待办聚合（含降级块数） | `[data-workbench][data-todo-count][data-todo-urgent][data-todo-degraded-panels]` |

## 4. 不许做的（插件作者与外壳都适用）

* **不得靠"藏起来"过关**：每个动作必须有**可发现、能跑**的入口（引导区/命令面板里都写清它在哪跑）。
* **不得靠改判据让按钮变得可点**：人签门（署名 == 会话身份）与权限/角色判据**一条不松**。
* **不得用读数或说明行把空账本说成有活**，也不得反过来把有活说成空（两个方向都算错）。

## 5. 复跑（P31 走查）

```bash
# 空账本首屏（8442 = 全新空白数据目录）：先复算判据，再截首屏
python3 tmp/p31-shots/emptiness.py 8442 home      # 修前 HAS-DATA（gate.todo/attach.store-home）→ 修后 EMPTY
sh tmp/p31-shots/start-8442-empty.sh &
python3 tmp/p31-shots/drive.py tmp/p31-shots/steps-empty.json    # 截图 + data-view-emptiness 读数
# 三条动作 × 两条入口（8441 = 有夹具的那一份）
python3 tmp/p31-shots/drive.py tmp/p31-shots/steps-chain1.json   # 工具栏引导区：quote.submit / award.propose / award.confirm
python3 tmp/p31-shots/drive.py tmp/p31-shots/steps-chain2a.json  # 命令面板：quote.submit（含备第二份草稿）
python3 tmp/p31-shots/drive.py tmp/p31-shots/steps-chain2c.json  # 命令面板：award.propose
python3 tmp/p31-shots/drive.py tmp/p31-shots/steps-chain2d.json  # 命令面板：award.confirm
# 负控三项（错署名 / 越侧 / 未登录）+ 账本零新增
python3 tmp/p31-shots/drive.py tmp/p31-shots/steps-neg.json
```

读数与截图落 `tmp/p31-shots/`（报告 `tmp/p31-shots/REPORT.md`）。

### 5.1 候选粒度（P33）的复跑

```bash
sh tmp/p33-shots/start-8453.sh &        # 工作树（修后）；start-8454-head.sh 是 git archive HEAD（修前）
# 浏览器（身份 wanglei，承包商道）逐条读：
#   JSON.stringify(window.__Q_GUI_ENTRY.candidates('award.propose'))
#   修前：rfq.responses:报价 q-ecb2094776bd（多行报价塌成 1 条）
#   修后：… — package_id=… · quote_id=… · item_id=L-002 · qty=40 · unit_price_cents=4200（第二行可挑）
# 再从引导入口真提交第二行（回执 + 账本行数记在 tmp/p33-shots/REPORT.md）
```

原始读数与截图落 `tmp/p33-shots/`（报告 `tmp/p33-shots/REPORT.md`）。

## 6. 最小上下文集**必须能被一行满足**（P49：`compare.save-weights` 的四条入口）

**判据（新增一条，与 §2 的三条入口是同一条纪律的加强版）**：一个动作声明的**全部**上下文需求
（`needs.row` / `needs.route` / `needs.selection`，以及由机制带上的 `expected_version`），必须**能被
同一行**（或同一条对象 / 同一次勾选）**同时满足**；否则"引导区"能给出一条候选、表单也开得出来，但那一行
**永远凑不齐**，动作在全视图里等于 0 个可用入口。**版本源（`version_for`）必须落在"能给出所需字段的那一行
所在的那块面板"上，或让那块面板的行自己带上那些字段。**

**实测的那条**（P47 §4.1 登记、P49 修）：`compare.save-weights` 要 `package_id`（引用标识兜底 ⇒ `needs.row`）
**且**受版本保护（机制自动加 `expected_version`）。版本源挂在「比价排名」面板上（`version_for: 'compare.save-weights'`），
而那块面板的行只有 `quote_id`/`supplier`/`score`… ⇒ **没有任何一行同时给出这两样**：

| 地址 | 修前 | 修后 |
|---|---|---|
| 承包商视图（本侧数据里有报价） | 候选 10 条，**没有一条来自版本源那块面板**（`compare.ranking` 不在候选里） | 候选 8~11 条，**含 `compare.ranking`**（那一行给出 `package_id`，版本由同一块面板的 `version_for` 带上） |
| 报价对象页 `/app/<view>/quote/<id>/` | 候选 **0 条** ⇒「现在这一页没有可挑的（不是坏了）`no-context-candidate`」，表单开不出 | 候选 **1 条**（该页的「报价逐行明细」面板的行现在带 `package_id`，并声明同一份权重版本） |

**修法（两处，都在插件自己的 `code/ui.mjs` 里）**：
① 只读复算（`src/domain/compare/tools/compare-rank.py`）把**本包 id / 包版本逐行复述**，面板把 `package_id`
当**一列**摆出来（它本来就是"这一行属于哪个包"的事实），并在行上挂同一份动作（`row_actions`）⇒ 行内那颗
按钮 = 按整行预填（包 id 来自行、「你看到的那一版」来自本面板的 `version_for`）；
② 报价对象页的「报价逐行明细」行也带上 `package_id`（它自己早就读到了 `bagOf.package_id`），并声明
`version: host.versions.current('contractor','compare-weights','current')` + `version_for` ⇒ 那一页的候选
**带着真版本**进表单（否则会带一个空版本，服务端只能按安全默认判）。

**读数（复跑见 §7）**：`window.__Q_GUI_ENTRY.{needs,missingHere,candidates,toolbar}` 与
`/api/ui/surface` 的 `actions[].needs` 是**同一份**判定；入口的有无**不看 DOM**（DOM 里同一动作还有
`data-pick-action`（引导区）/`data-row-action`（行内）/命令面板条目三种形态，只按前两种数会数成 0）。

## 7. 复跑（P49）

```bash
# 修前 = git archive HEAD（/tmp/p49-before/tree）；修后 = 工作树
sh tmp/p49-shots/start.sh <树根> 8586 <数据目录> <受管YAML> before   # 修改前后用同一份数据目录的副本
sh tmp/p49-shots/start.sh <仓库根> 8587 tmp/p49-run/shared tmp/p49-run/managed-config.yaml after
# 浏览器（人类身份 human:limin，承包商道）逐条读：
#   JSON.stringify(window.__Q_GUI_ENTRY.candidates('compare.save-weights'))
#   引导区 → 挑「比价排名」那一行 ⇒ 表单里 package_id 已预填、expected_version 是**真版本**
#   真保存：账本 +1 行；把只读版本字段改回上一版再提交 ⇒ 明确拒 object-changed（逐字段差异 + 三个出口）
```

原始读数与截图落 `tmp/p49-shots/REPORT.md`（§1/§4）。
