# 员工工作流驱动的 UI 重做规格 · 第 3 部分（§4 视觉规格 + §5–§7）

- 这是 `docs/work/plans/ui-workflow-rework.md` 的**第 3 部分**。§3.0 的硬约束 `R-1..R-8` 同样约束本部分（尤其 `R-1`：页面零内联脚本——§4 的所有样式规则都靠 SSR 内联 `<style>` 实现，不引入任何 JS）。
- 主文件 = §0/§1/§2；第 2 部分 = §3。
- 视觉量测原始输出（26 页 × 16 项）见 `docs/work/evidence/EV-158-ui-workflow-rework.txt` §5。

---

## 4. 视觉规格（现代 app 观感：逐条可执行的规则）

### 4.1 现状诊断（先量，再判）

26 个页面 × 16 项 CSS 事实实测（EV-158 §5，服务 8093）：

| 事实 | 实测 |
|---|---|
| CSS 变量（`--*`） | **0**（全部 26 页） |
| `:focus` 规则 | **0** |
| `:hover` 规则 | **0** |
| `@media`（响应式） | **0** |
| `<button>` 元素 | **0**（全站只有 `<input type="submit">`） |
| `class="…"` 属性 | 业务页 0..3 处；**0 处 `card`/`panel`/`tile`** |
| `aria-*` | 业务页 0..3 处 |
| `display:grid` / `flex` | **0** |
| `border-radius` / `box-shadow` / `transition` | 0 / 0 / 0 |
| `<style>` 块 | **每页 1 个，26 页共用同一份 6 条规则**（逐字）：`body{font:14px/1.6 system-ui,sans-serif;margin:2rem;max-width:60rem}` `code{background:#f3f3f3;padding:.1em .3em;border-radius:3px}` `table{border-collapse:collapse;width:100%}` `td,th{border:1px solid #ddd;padding:.35rem .5rem;text-align:left;font-size:13px}` `nav a{margin-right:1rem}` `details{margin:.6rem 0}summary{cursor:pointer}` |

**为什么这就是"上世纪的表单"**（每条都能追到上面某一行）：

1. **唯一的视觉容器是"表格 + 1px 灰边框"**（`td,th{border:1px solid #ddd}`）：`table{width:100%}` + `border-collapse:collapse` 是 1990 年代报表的配方——没有卡片、没有分组、没有区块背景，所有信息平铺在一张网格里，视觉层级只能靠标题文字。**没有 `class=` 就说明没有组件**：26 页里有 0 处 card/panel/tile。
2. **没有色彩系统**：整站只有 1 个前景色 + 3 个灰色（`#f3f3f3`/`#ddd`/默认黑），0 个 CSS 变量，0 个强调色/成功色/警示色/危险色 token。状态标签（已批/待批/越界/降级）**全靠文字**，人扫一屏认不出"哪些在等我"。
3. **没有间距阶梯**：`margin:2rem` 一档 + `padding:.35rem .5rem` 一档 + `details{margin:.6rem 0}` 一档，三个数字互不成比例（32 / 5.6 与 8 / 9.6 px）。没有 4px 基数，所以"哪里是一组、哪里是另一组"无法从空白读出来。
4. **没有字号阶梯**：`font:14px/1.6` 定死正文字号，表格被单独压到 `13px`——只有两档，且第二档是"更小"而不是"更弱"。标题、标签、数值、辅助文字同号同级。
5. **没有交互态**：0 个 `:hover`、0 个 `:focus`、按钮是浏览器默认的 `<input type="submit">` 凸起方块。**键盘用户看不到焦点在哪**（`NFR-UX-001..004` 的可访问性口径在这里是空的）。
6. **没有响应式**：`max-width:60rem` 固定，0 个 `@media`；手机上表格横向溢出，而两边的员工"一台电脑 + 一部手机"（`ux-双方痛点与交互需求` 的角色画像原文——**草稿来源，非正式定义文件**）在工地是常态。
7. **没有空态/错误态/加载态组件**：空态是一句 `<p>`（`data-empty` 只在 approvals 出现 2 次），错误态是浏览器默认红字或裸 JSON（`{"error":"not-found", …}` 直接投给员工看），降级态是一长段中文说明——**信息诚实，但没有"可扫"的形状**。
8. **没有应用外壳**：`<nav>` 是 5 个裸 `<a>`（`margin-right:1rem`），页面标题是 `<h1>` 文本，没有顶栏/侧栏/面包屑/当前页高亮。所以打开任何一页都"像一篇文档的第 N 节"，不像一个 app 的一个视图。

**结论**：视觉问题不是配色不好看，而是**没有设计系统**——0 token、0 组件、0 状态、0 栅格。用户说"像上世纪的表单"是准确的描述，不是主观感受。

### 4.2 设计 token（CSS 变量，逐条）

实现方式（**与零内联脚本兼容**）：在 `host/modules/webui.mjs` 的 `html()` 帮助函数里，把现有那 1 个 `<style>` 块替换为下面这份（同一处、单一真源、SSR 内联样式，**仍然 0 行 `<script>`**）；若未来要外置，只允许加一条 `GET P/app.css` 的纯文本只读路由（同样零脚本），并同步登记进 `/api/routes`。

```css
:root{
  /* ── 4.2.1 色彩（深色优先；对比度按 WCAG AA：正文 ≥4.5:1，大字 ≥3:1） ── */
  --qa-bg:#0f1115;            /* 应用底 */
  --qa-surface:#161a21;       /* 卡片/面板 */
  --qa-surface-2:#1d222b;     /* 卡片内嵌块 / 表头 */
  --qa-surface-3:#232936;     /* hover / 选中行 */
  --qa-border:#262c37;        /* 1px 分隔 */
  --qa-border-strong:#39404e; /* 输入框边框 */
  --qa-text:#e6e9ef;
  --qa-text-muted:#9aa4b2;
  --qa-text-faint:#6b7480;
  --qa-accent:#4c8dff;        /* 唯一强调色：主按钮 / 当前页 / 链接 */
  --qa-accent-hover:#6ba0ff;
  --qa-accent-ink:#0b1220;    /* 强调色上的字 */
  --qa-ok:#31c48d;            /* 已批准 / 在区间内 */
  --qa-warn:#f0b429;          /* 待批 / 越界前提醒 */
  --qa-danger:#f0524b;        /* 拒绝 / 超期 / 降级 */
  --qa-info:#7aa2f7;          /* 只读/中性提示 */
  /* ── 4.2.2 间距（4px 基数；只用这七档，不许出现 5/7/9/13px） ── */
  --qa-s1:4px; --qa-s2:8px; --qa-s3:12px; --qa-s4:16px; --qa-s5:24px; --qa-s6:32px; --qa-s7:48px;
  /* ── 4.2.3 字号阶梯（1.25 比例；标题用 clamp 保手机可用） ── */
  --qa-fs-xs:11px;   /* 标签/角标（只用于全大写+字距） */
  --qa-fs-sm:12px;   /* 辅助文字/表头 */
  --qa-fs-base:14px; /* 正文/表单/表格单元格 */
  --qa-fs-lg:16px;   /* 卡片标题 */
  --qa-fs-xl:20px;   /* 区块标题 */
  --qa-fs-2xl:clamp(22px,2.4vw,28px); /* 页面标题 */
  /* ── 4.2.4 行高 / 字距 ── */
  --qa-lh-tight:1.25; --qa-lh-base:1.55; --qa-ls-label:.06em;
  /* ── 4.2.5 圆角 / 阴影 ── */
  --qa-r-sm:4px; --qa-r-md:8px; --qa-r-lg:12px; --qa-r-pill:999px;
  --qa-shadow-1:0 1px 2px rgba(0,0,0,.32);
  --qa-shadow-2:0 8px 24px rgba(0,0,0,.36);
  /* ── 4.2.6 栅格 / 外壳 ── */
  --qa-maxw:1200px; --qa-gutter:var(--qa-s5); --qa-sidebar:224px; --qa-topbar:56px;
  /* ── 4.2.7 焦点 / 动效 ── */
  --qa-ring:0 0 0 2px var(--qa-bg), 0 0 0 4px var(--qa-accent);
  --qa-t-fast:120ms; --qa-t-base:200ms; --qa-ease:cubic-bezier(.2,.8,.2,1);
  /* ── 4.2.8 状态色映射（语义层，页面只用语义变量） ── */
  --qa-state-pending:var(--qa-warn);   /* 待批/待落账 */
  --qa-state-done:var(--qa-ok);        /* 已批准/已生效 */
  --qa-state-blocked:var(--qa-danger); /* 降级/超期/拒绝 */
  --qa-state-readonly:var(--qa-info);  /* 只读/信息 */
}
```

### 4.3 视觉规则（逐条可执行；编号 `VIS-nn`，共 **40** 条）

**栅格与外壳（VIS-01..08）**

| # | 规则 |
|---|---|
| VIS-01 | 应用外壳 = 顶栏 `var(--qa-topbar)` + 左侧导航 `var(--qa-sidebar)` + 主区；主区 `max-width:var(--qa-maxw)`、水平内边距 `var(--qa-gutter)`。`@media (max-width:900px)` 时导航折叠为顶栏下的横向滚动条（`overflow-x:auto`，无脚本）。 |
| VIS-02 | 页面标题一律 `<h1>`（`--qa-fs-2xl` / `--qa-lh-tight` / `margin:0 0 var(--qa-s5)`），其下必须有一行"这一页能做什么"的 `--qa-text-muted`（`--qa-fs-sm`）副标题。 |
| VIS-03 | 首屏三块用 `display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:var(--qa-s4)`（响应式靠 `auto-fit`，不靠 `@media`）。 |
| VIS-04 | 行级列表：`display:grid; grid-template-columns:repeat(12,1fr); gap:var(--qa-s4)`；表体单元格不许再出现**纵向** 1px 分隔线。 |
| VIS-05 | 当前页导航项 `[aria-current="page"]` 用 `background:var(--qa-surface-3)` + 左侧 3px `var(--qa-accent)` 竖条（`box-shadow:inset 3px 0 0 var(--qa-accent)`）。 |
| VIS-06 | 面包屑：`<nav aria-label="面包屑">` 用 `--qa-text-faint` 分隔符 `/`，末项 `--qa-text` 且不可点。 |
| VIS-07 | 垂直节奏唯一来源：区块之间 `var(--qa-s6)`，区块内元素之间 `var(--qa-s3)`，表单项之间 `var(--qa-s4)`。禁止字面量像素。 |
| VIS-08 | 手机（≤640px）：表格必须转成卡片列表（`.qa-table--stack`：每个 `<tr>` 变一块，`<td>` 前置 `<span class="qa-th">` 标签，靠 `::before` 取 `data-label` 文本——纯 CSS，无脚本）。 |

**卡片与分组（VIS-09..14）**

| # | 规则 |
|---|---|
| VIS-09 | 卡片：`background:var(--qa-surface); border:1px solid var(--qa-border); border-radius:var(--qa-r-lg); padding:var(--qa-s5)`；卡片之间 `gap:var(--qa-s4)`。 |
| VIS-10 | 卡片标题：`--qa-fs-lg` + `--qa-lh-tight`，与正文间距 `var(--qa-s2)`；卡片标题右侧固定放"动作/口径来源"链接（`--qa-fs-sm`，`--qa-text-muted`）。 |
| VIS-11 | 卡片内**不再嵌卡片**（禁止三层背景）；需要分组时用 `border-top:1px solid var(--qa-border)` + `padding-top:var(--qa-s4)`。 |
| VIS-12 | 折叠区 `<details>`：`background:var(--qa-surface-2); border-radius:var(--qa-r-md); padding:var(--qa-s3) var(--qa-s4)`；`summary` 用 `--qa-fs-base` + `--qa-text`，`list-style:none` 并用 `::before` 画三角。 |
| VIS-13 | 引用/口径说明块（本仓大量"口径是什么"的文字）：`background:var(--qa-surface-2); border-left:3px solid var(--qa-info); border-radius:0 var(--qa-r-md) var(--qa-r-md) 0; padding:var(--qa-s3) var(--qa-s4)`；正文 `--qa-fs-sm` + `--qa-text-muted`。 |
| VIS-14 | 降级块 `[data-degraded]`：`border-left-color:var(--qa-danger)`、`background:rgba(240,82,75,.08)`；块首固定一个 `--qa-fs-xs` 全大写的 `降级 / DEGRADED` 标签（`letter-spacing:var(--qa-ls-label)`）。**降级块不得与空态块同形**。 |

**表格（VIS-15..21）**

| # | 规则 |
|---|---|
| VIS-15 | 表格只用**横向**分隔线：`border-collapse:collapse` + `td,th{border:0;border-bottom:1px solid var(--qa-border)}`；去除所有竖线与外框；表格整体包在卡片里。 |
| VIS-16 | 表头：`background:var(--qa-surface-2)`、`--qa-fs-sm`、`--qa-text-muted`、`letter-spacing:var(--qa-ls-label)`、`text-transform:none`（中文不做大写）。 |
| VIS-17 | 行高：单元格 `padding:var(--qa-s2) var(--qa-s4)`；`tbody tr:hover{background:var(--qa-surface-3)}`；`tbody tr:focus-within{background:var(--qa-surface-3)}`。 |
| VIS-18 | 数值列右对齐 + `font-variant-numeric:tabular-nums`；金额一律显示"整数分 + 等值元"两段：`<td data-money-cents="9743" data-money-unit="cents">97.43 元 <span class="qa-u">(9743 分)</span></td>`。 |
| VIS-19 | 时间列显示事实时刻 + 相对量：`2026-09-21T22:37:12Z` + `<span class="qa-u">（按事实时刻差：1 天 8 小时）</span>`；**不得**出现基于墙钟的"刚刚/N 分钟前"。 |
| VIS-20 | 长键值摘要列必须可折行且不撑破：`overflow-wrap:anywhere; max-width:48ch`。 |
| VIS-21 | 表格必须有 `<caption>`（屏幕阅读器用）与 `data-rows="<n>"`（门用来核对"页面行数 == 派生行数"）；0 行时渲染空态块而不是空 `<table>`。 |

**标签 / 徽标 / 状态（VIS-22..26）**

| # | 规则 |
|---|---|
| VIS-22 | 状态标签基形：`display:inline-flex; align-items:center; gap:var(--qa-s1); border-radius:var(--qa-r-pill); padding:2px var(--qa-s2); font-size:var(--qa-fs-xs); letter-spacing:var(--qa-ls-label); border:1px solid`。 |
| VIS-23 | 语义色映射（**只允许这四族**）：待处理 `--qa-state-pending`；已完成 `--qa-state-done`；被阻断/降级 `--qa-state-blocked`；只读/信息 `--qa-state-readonly`。文字用本色，背景用同色 `rgba(...,.12)`。 |
| VIS-24 | 颜色**不得是唯一信息载体**：每个标签必须同时带一个 `data-state="pending\|done\|blocked\|readonly"` 与一个中文词（如"待落账""已批准""降级""只读"）。 |
| VIS-25 | 计数徽标：`background:var(--qa-surface-3)`、`border-radius:var(--qa-r-pill)`、`min-width:1.8em`、居中；数字 ≥1 且属于"待我处理"时改用 `--qa-state-pending` 底色。 |
| VIS-26 | 私域/敏感提示标签：`border-style:dashed`，文案"私域（本视角可见）"/"对方不可见"，颜色固定 `--qa-text-faint`。 |

**按钮与表单（VIS-27..33）**

| # | 规则 |
|---|---|
| VIS-27 | 每页**最多一个**主按钮（`background:var(--qa-accent); color:var(--qa-accent-ink)`）；次按钮 `background:transparent; border:1px solid var(--qa-border-strong); color:var(--qa-text)`；危险动作 `border-color:var(--qa-danger); color:var(--qa-danger)`。 |
| VIS-28 | 按钮基形：`display:inline-flex; align-items:center; gap:var(--qa-s2); min-height:36px; padding:var(--qa-s2) var(--qa-s4); border-radius:var(--qa-r-md); font-size:var(--qa-fs-base); transition:background var(--qa-t-fast) var(--qa-ease), border-color var(--qa-t-fast) var(--qa-ease)`；`:hover` 换底色；`:active` `transform:translateY(1px)`；`:disabled` `opacity:.5; cursor:not-allowed`。 |
| VIS-29 | 表单标签在输入**上方**（不在右侧），`--qa-fs-sm` + `--qa-text-muted`；必填项标签后加 `<span aria-hidden="true">*</span>` 并在输入上加 `required`（同时给 `<label for>`）。 |
| VIS-30 | 输入基形：`background:var(--qa-surface-2); border:1px solid var(--qa-border-strong); border-radius:var(--qa-r-md); color:var(--qa-text); min-height:36px; padding:var(--qa-s2) var(--qa-s3); font-size:var(--qa-fs-base); width:100%`。 |
| VIS-31 | **聚焦态（必做）**：`:focus-visible{outline:none; box-shadow:var(--qa-ring)}`；对 `<a>`、`<button>`、`input`、`select`、`textarea`、`summary` 六类元素全部生效。**当前 0 条 `:focus` 规则必须清零。** |
| VIS-32 | 错误态：输入 `[aria-invalid="true"]{border-color:var(--qa-danger); box-shadow:0 0 0 1px var(--qa-danger)}`；错误文字紧跟其下 `--qa-fs-sm` + `--qa-danger`，以 `<p data-error-for="<name>">` 标识；**服务端返回的错误必须回填到字段原位**（不许只把裸 JSON 甩给员工）。 |
| VIS-33 | 帮助文字：`--qa-fs-sm` + `--qa-text-faint`，放在输入下方；**每个时间/金额字段都必须有口径帮助**（"按事实时刻，不取墙钟"/"金额一律整数分"）。 |

**空态 / 错误态 / 降级 / 待办（VIS-34..37）**

| # | 规则 |
|---|---|
| VIS-34 | 空态块统一形态：`border:1px dashed var(--qa-border-strong); border-radius:var(--qa-r-md); padding:var(--qa-s6); text-align:center`；内容固定三行——人话（`--qa-fs-lg`）、原因码（`<code>reason=…</code>`，`--qa-fs-sm`）、下一步（`next_action`，可复制命令用 `<pre>`）。容器带 `data-empty` + `data-empty-reason`。 |
| VIS-35 | **区分"空"与"读不到"**：真零条 ⇒ `data-empty`（中性色）；快照缺失/投影为空 ⇒ `data-degraded="1"`（`--qa-state-blocked` 色）**且必须有 `reason`**。两者**不得**用同一套文案或同一套颜色。 |
| VIS-36 | 待办件徽标（新组件，配合 §3 的 `data-pending`）：`background:rgba(240,180,41,.12); border:1px solid var(--qa-state-pending); border-radius:var(--qa-r-md); padding:var(--qa-s3) var(--qa-s4)`，内容 = 待办件 id / 落点 / `next_action`（`<pre>` 可复制）。 |
| VIS-37 | "网页做不到"区块（对应 R-5）：`border:1px solid var(--qa-border); border-radius:var(--qa-r-md); padding:var(--qa-s4); background:var(--qa-surface-2)`，标题固定句式「这五件事只能在终端由人签：…」，命令用 `<pre>`，**区块内 0 个提交控件**。 |

**排版细节（VIS-38..40）**

| # | 规则 |
|---|---|
| VIS-38 | 全站字体栈唯一：`font-family:system-ui,-apple-system,"Segoe UI","Noto Sans SC",sans-serif`；`body{font-size:var(--qa-fs-base); line-height:var(--qa-lh-base); background:var(--qa-bg); color:var(--qa-text)}`。**不许**再出现 `font:14px/1.6 …` 这种把字号与行高塞在一起的写法（无法被 token 覆盖）。 |
| VIS-39 | `<code>` / `<pre>`：`background:var(--qa-surface-2); border:1px solid var(--qa-border); border-radius:var(--qa-r-sm); font-family:ui-monospace,"JetBrains Mono",monospace; font-size:var(--qa-fs-sm)`；`<pre>` 必须 `overflow-x:auto; white-space:pre-wrap`（长命令在手机上不能撑破布局）。 |
| VIS-40 | 深色为默认；若将来加浅色主题，只允许**换 `:root` 的 token 值**（不许在组件规则里出现字面色）。所有颜色必须来自 `--qa-*`；门可断言 `host/modules/webui.mjs` 的样式块里除 token 定义外 **0 个字面 hex**。 |

### 4.4 现状 → 目标的对照（哪条规则修哪个"上世纪"症状）

| 症状（§4.1） | 对应规则 |
|---|---|
| 只有 `1px solid #ddd` 表格 | VIS-15/16/17/21（横向线 + 卡片包裹 + hover + caption） |
| 0 色彩 token、状态靠文字 | VIS-22/23/24（四族语义色 + `data-state` + 中文词） |
| 三档互不成比例的间距 | VIS-07（4px 基数七档，禁字面量） |
| 两档字号、标题与正文同级 | VIS-02/10/29（字号阶梯 + 层级职责） |
| 0 `:hover` / 0 `:focus` | VIS-17/28/31（三个交互态全部补上，重点补 focus ring） |
| 0 `@media`、手机溢出 | VIS-01/03/08（auto-fit 栅格 + 表格转卡片） |
| 空态/错误态只有一段文字 | VIS-14/32/34/35（空态、降级、错误三套不同形态） |
| `<nav>` 五个裸链接、无外壳 | VIS-01/05/06（顶栏 + 侧栏 + 当前页 + 面包屑） |

---

## 5. 分批建议（不排期，只给依赖序）

1. **B-1（投影层，无新写面）**：修 S-gap-1 / S-gap-6 / S-gap-8 / C-gap-10 —— 让供应商看见包与授标、让承包商看见澄清。**这一批不改任何写面、不动老路由字节**，但它是后面一切的前提（否则供应商侧的页面全是空页）。
2. **B-2（视觉系统，零新写面）**：§4.2/4.3 的 token 与规则替换那 1 个 `<style>` 块 + 外壳（顶栏/侧栏/面包屑）。断言：0 `<script>`、0 内联事件、24 页仍 200、`FROZEN_SHA` 的 JSON 路由字节不变。
3. **B-3（只读视图补齐）**：`GET /<view>/packages/`、`/packages/<id>/`、`/award/`、`/po/`、`/compare/`、`/pending/`（全部 GET，零写面）。
4. **B-4（写面第一批，最保守）**：`packages/new`（建包草稿）、`packages/<id>/ack`（认收）、`clarifications/ask` + `<ticket>/answer`、`changes/<id>/respond` —— 四个都"不产生义务/不签收"，各配一个 `tools/*.py` 消费者，每批只加 1..2 个。
5. **B-5（写面第二批）**：`award/intent`、`compare/weights`、`quotes/review`、`changes/new`（产生事实但不签收）。
6. **B-6（永远只做载荷）**：§3.5 的五个 `data-human-gate-action` 组件（只准备、只可复制，永不加 POST 路由）。

## 6. 与既有需求文档的关系（不重复造、不抢先落表）

- 本文**不新增 FR/AC 定义**；`§3.5` 与 `§4.3` 里给出的断言形状可直接作为未来 AC 的候选文本，但按 `D-059`，只有门与证据真实存在时才可迁进 `docs/work/acceptance-criteria.md`。
- 与 `FR-UX-001`/`FR-UX-002`、`AC-APPROVE-003`、`AC-TRUST-001`、`FR-GATE-001`/`AC-GATE-001`、`FR-RFQ-001..004`、`FR-CLARIFY-001..004`、`FR-COMPARE-001..003`、`NFR-UX-001..004` 的关系是**实现层细化**，不是替代。
- 已有三份 `tmp/` 阶段草稿（`gui-交互规格` / `ux-双方痛点与交互需求` / `config-凭据UX规格`）的**路由表仍然有效**；本文的差异有二：(a) 以**员工每一步**为单位组织，且每步都带"能不能推进状态"的实测；(b) 补上视觉规格（既有草稿只给结构不给样式）与投影层根因（S-gap-1/6/8）。
- 本文件按 `D-058` 的精神放在 `docs/work/plans/`（受文档门扫描），所以**全文只引用已存在的 ID**，不引用任何未落表的草案编号。

## 7. 未决（不猜、不编）

1. **「提交报价」的边界**：`ADR-0013 §3` 把"提交报价"列为网页永不做的动作。本文按此把它做成"准备载荷 + 终端命令"。若业务上认为"员工在网页填完报价、按一下就要生效"，需要先改 `ADR-0013`（**需人决策**），本文不擅自放宽。
2. **「供应商确认中标」是不是承诺动作**：本文按"声明载荷 + Python 落 `award/supplier-confirmed`"处理（不签收）。若认为它也属人工门，则 §3.3-S4 也降级为纯载荷。**需人决策**。
3. **投影放宽的边界**：S-gap-1 要让供应商看到 `rfq/distributed` 里命中自己的行。白名单键的具体集合（是否含 `subject`、`items` 摘要）需与现有私域负控断言一起定，**建议先只放 `package_id/rev/quote_by/sent_at`**。
4. **深色 vs 浅色**：§4.2 默认深色。若用户要浅色，只需替换 `:root` 的一层 token（VIS-40 已把这条写死为唯一合法路径）。
5. **`app.css` 外置 vs 内联**：本文推荐继续内联（零新路由、零新机制）；若样式体积增长，再加只读 `GET P/app.css`（仍零脚本）。
