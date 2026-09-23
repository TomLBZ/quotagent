# 行内/批量动作的预填：**字段名必须能在行对象里找到同名键**

<!-- 预算：8 KB。机制真源：外壳 `code/assets/app.js#openAction`（`values = {…routePreset, …identityPreset, …presets}`，
     `presets` 就是那一行的对象）+ `#submitEdits`（批量走 `data.editable_action`）。本页讲一条**给插件作者**的规矩：
     字段名与行键名对不上 = 用户在表单里看到一个空字段，而值其实就在他刚点的那一行上。
     全插件自查脚本与 P22 的逐条读数：`src/system/webui/docs/prefill-and-selection.md` §4。 -->

## 0. 一句话

外壳**不认业务语义**：它把「你点的那一行」整对象当预填值传进动作表单（`presets`），
每个字段**只能按自己的 `name` 在行里取值**。所以：

> **行内（`row_actions`）或批量（`editable_action`）能点到的动作，它的每一个字段名，
> 都必须与那一行 `data()` 产出的键名**字面一致**（`identity`/`signature`/`from_route`/`readonly`/
> `version_field`/有非空 `default` 的字段除外）。**

对不上时**不报错**：字段是空的，用户只能回到表格里把值**人肉抄一遍**——而有些值（下面的例 2）
**在屏幕上根本没有那一列**，于是这一步在界面上**做不完**。

## 1. 两个真实案例（P15 走查，已修）

| 面板 | 动作字段 | 行里当时有什么 | 后果 | 修法 |
|---|---|---|---|---|
| `exchange.inbox`（我收到的包） | `seen_rev`（认收）、`rfq_rev`（提问） | 只有 `rev`（表格列名就是「最新 rev」） | 用户看着「rev = 1」，还要在弹层里手打一个 1 | 行里补 `seen_rev: rev ?? ''`、`rfq_rev: rev ?? ''` |
| `exchange.requote-rail`（我的报价状态轨） | `package_id`、`lead_time_days` | 只有 `quote_id`/`item_id`/`unit_price_cents`/`based_on_rev`/`latest_rev` | **表里没有「包」这一列** —— 包 id 无从抄起，这一步在界面上做不完 | 行里补 `package_id: quote.package_id`、`lead_time_days: quote.lead_time_days ?? ''` |

改后浏览器实测（表单字段值）：`seen_rev=1`、`rfq_rev=1`、`package_id=SCALE-PKG-0002`、`lead_time_days=4`；
原始输出与截图见 `tmp/p15-report.md` §2。

## 2. 自查（**可重跑**：一条命令扫全部视图 + 全部对象页）

```bash
python3 tmp/p22-shots/check-row-fields.py --base http://127.0.0.1:8491/quotagent
# → 必填挡住 N 条 / 可选手填 M 条 + JSON 留档（覆盖面、逐条面板·动作·字段、行里相近的键）
```

它扫 `/api/ui/panels`（全部视图）× `/api/ui/object`（对象 id 从面板行里现取），对每个能点到的动作逐个字段判
「行里能不能取到值」，分两档：**`必填挡住`**（required 且取不到 ⇒ 用户被一个空字段挡在提交前）与
**`可选手填`**（人还能手打，但按 §0 那条规矩该对齐）。P22 覆盖面：3 视图 · 223 块面板 · 71 个对象页 · 125 处字段；
逐条读数与**修前/修后**在 `prefill-and-selection.md` §4。手工对账的老版本（只扫一个视图、只拿第一行）：

```bash
# ① 行数据（服务端算出来的那一份）   ② 注册面（每个动作的 fields）
curl -s "$BASE/api/ui/panels?view=supplier" -o /tmp/panels.json
curl -s "$BASE/api/ui/surface" -o /tmp/surface.json
python3 - <<'PY'
import json
S=json.load(open('/tmp/surface.json')); A={a['id']:a for a in S['actions']}
P=json.load(open('/tmp/panels.json'))
def empty(v): return v is None or (isinstance(v,str) and not v.strip()) or v in ([],{})
for p in P['panels']:
    d=p.get('data') or {}; rows=[r for r in (d.get('rows') or []) if isinstance(r,dict)]
    if not rows: continue
    row=rows[0]
    for aid in (d.get('row_actions') or []):
        a=A.get(aid) or {}
        for f in ((a.get('input') or {}).get('fields') or []):
            n=f['name']
            if f.get('from_route') or f.get('from_route_kind') or f.get('identity') or f.get('readonly') \
               or f.get('version_field') or f.get('type') in ('signature',) or f.get('default') not in (None,''):
                continue
            if empty(row.get(n)):
                print(f"{p['id']} · {aid}: 字段 {n} 在行里没有值（{'必填' if f.get('required') else '可选'}）")
PY
```

打印出「必填」的行 = **用户会被一个空字段挡住**（P3 走查教训：批量受理曾被「报价 id 必填」挡在确认层之前）；
只打印「可选」的，人还能手填，但按上面那条规矩也该对齐（例：`new_qty` 可以预填行里的 `qty` 当前值）。
**P22 的两处真缺口就是这么抓到的**：多行报价的标量三键在账本里本来就是空的（`item_id: ""` /
`unit_price_cents: null`）⇒ 状态轨上三个必填字段全空（修法：回落到首行）；`from_rev` 要的值就在
「当前 rev」那一列上（修法：行里补同名键）。

## 3. 边界（别把这条规矩用错）

* **不是所有字段都该从行里取**：`reason` / `comment` / `letter` / `note` 这类**要人写的话**，
  行里没有是对的（写了才算"人表过态"）；`due_at` 这类**未来时刻**也不该拿旧值预填。
* **不要为了预填而把敏感值塞进行**：行数据会进 `/api/ui/panels` 的响应（按侧与身份投影过）——
  供应商成本模型、标底、内部评分**永远不出各自 realm**（`29 §1` 数据主权），预填只能预填"这一侧本来就看得到"的值。
* **`from_route` 是对象页那条路**：对象页工具栏上的动作靠 `field.from_route = true` 拿地址里的 id；
  行内动作走的是本页这条规矩（行对象）。两条路别混用。
