# EV-191 — 身份门槛（P3）导致的红断言：门夹具**先登录再取业务路由**（12 个门，断言只增不减）

<!-- budget: 8 KB（`docs/work/evidence/*.md`）；原始输出在 `tmp/sa-fix9/{before,after,final}/`（验证与计数脚本一并放 `tmp/`，不进树） -->

判据真源：`AGENTS.md` 规则 11/12、`docs/design/29-webui-gui-app.md` §2.2、`EV-190` §5 的冲击清单。
口径（主 agent 定）：**夹具先 `POST /identity/login` 再取业务路由** —— 判据从「谁能打开」变成
「**登录后按侧放行**」；不删断言、不放松判据；仅当某条断言**本质上在断言「未登录也能看业务页」**时按规则 12 删除。
本批**删除 0 条断言**（§4）。

## 0 结论

- `EV-190` 登记的 9 个门 **63 条红**全部转绿；**未删任何断言**，也未把 `200` 放宽成 `200|401`。
- 同一根因**还遮住了 4 个门的后半**（前半先红即 `exit 1`，后半根本没跑）：单独跑 HEAD 版测得
  `advice` 红 6、`bid-heuristics` 红 7、`authority` 红 8、`gates` 红 8，`change-detail` 后半**直接崩**
  （`KeyError: 'subtotal'`）。
- 同一根因下**另有 3 个门**红：`ui-feedback`（红 7 + 后半红 8）、`admin-route`（红 2）、`rfq-visibility`（红 5）
  —— `EV-190` §5 未登记（第 10/11/12 个门），本批一并修好（同样不动产品面）。
- 每个门**新增 1–2 条身份门槛机检**断言（未登录两种形状都拒 / 登录后按侧放行 / 越侧 403）：
  没有它，业务路由 200 的断言在门槛被误删时照样绿（门就白修了）。

## 1 命令与原始 RESULT

```
sh tools/verify.sh webui|quote-draft|rfq-deadline|bid-heuristics|plugin-lifecycle|advice|authority|gates|change-detail
sh tools/verify.sh ui-feedback|rfq-visibility|admin-route        # 同一根因、EV-190 漏登记
sh tools/verify.sh canary|plugin-assets|docs|modules|wiring      # 邻接面复核（本轮未改它们）
sh tools/verify.sh events|invariants|ac-registry|v               # 另 4 道轻门（全绿）
sh tools/run.sh -m quotagent.qa all                              # 全量 AC：83/84，唯一红 = AC-ADMIN-004（既有红）
python3 tmp/sa-fix9/counts.py tmp/sa-fix9/final                  # 断言计数（只读）
```

修后原始 RESULT（`tmp/sa-fix9/final/`；* = 分半门，两半分别给数）：

| 门 | RESULT |
|---|---|
| webui | `RESULT: PASS（webui 门 53/53）` |
| plugin-lifecycle | `RESULT: PASS（plugin-lifecycle 门 69/69）` |
| rfq-visibility * | `passed 26/26` + `RESULT: PASS（rfq-visibility 路由门 12/12）` |
| quote-draft * | `17/17` + `16/16` |
| rfq-deadline * | `23/23` + `13/13` |
| bid-heuristics * | `33/33` + `14/14` |
| advice * | `31/31` + `16/16` |
| authority * | `23/23` + `14/14` |
| gates * | `34/34` + `13/13` |
| change-detail * | `23/23` + `11/11` |
| ui-feedback * | `29/29` + `13/13` |
| admin-route * | `18/18` + `14/14` |
| canary / plugin-assets / docs / modules / wiring | 全 PASS（11/11、20/20、PASS、521/521、PASS） |

## 2 修前 / 修后断言计数对照（修后**只增不减**）

| 门 | 修前（`verify.sh` 可见） | 修前：被遮住的后半 / 漏登记门 | 修后 |
|---|---|---|---|
| webui | 26/52（红 26） | — | **53/53** |
| quote-draft | 17/17 + 2/14（红 12） | 已含 | **33/33** |
| rfq-deadline | 23/23 + 2/11（红 9） | 已含 | **36/36** |
| bid-heuristics | 27/32（红 5）⇒ 门在此退出 | 5/12（红 7） | **47/47** |
| plugin-lifecycle | 64/68（红 4） | — | **69/69** |
| advice | 19/21（红 2）⇒ 退出 | 8/14（红 6） | **47/47** |
| authority | 13/15（红 2）⇒ 退出 | 4/12（红 8） | **37/37** |
| gates | 22/24（红 2）⇒ 退出 | 3/11（红 8） | **47/47** |
| change-detail | 11/12（红 1）⇒ 退出 | 崩（无计数） | **34/34** |
| ui-feedback | 12/19（红 7）⇒ 退出 | 3/11（红 8） | **42/42** |
| admin-route | 18/18 + 11/13（红 2） | 已含 | **32/32** |
| rfq-visibility | 26/26 + 5/10（红 5） | 已含 | **38/38** |

（`bid-heuristics`/`advice`/`authority`/`gates`/`change-detail`/`ui-feedback` 修后总数上升不只因我加的断言：
修前断言在半红/异常处**整段中断**，后半与其后的检查**根本没跑到**；修后跑到了。）

## 3 逐处修改（判据**变强**还是变弱）

统一形状：`get/post/raw_request` 按 URL 判侧（`^/(contractor|supplier)(/|$)`）**自动带本侧 cookie**；
cookie 由**真入口** `POST /identity/login?format=json`（表单体 `name=gate-<门>-<侧>&side=<侧>`）取得并缓存；
浏览器形状用**不跟 303** 的 opener（urllib 跟过去会把 303 变成 200 登录页）。

| 文件 | 改了什么 | 判据 |
|---|---|---|
| `host/webui.mjs` | 登录夹具 + `get/getBytes`/`brokenView` 带 cookie + **2 条** | 变强 |
| `src/domain/quote-prepare/tests/check-quote-draft-route.py` | `raw_request` 增 `headers`/`follow_redirects` + **2 条** | 变强 |
| `src/domain/rfq-deadline/tests/check-rfq-deadline-route.py` | 同上 + **2 条** | 变强 |
| `src/domain/bid-heuristics/tests/t279-heuristics-gate.mjs` | 登录夹具 + `get` 带 cookie + **1 条** | 变强 |
| `src/domain/bid-heuristics/tests/check-heuristics-route.py` | `_fetch` 带 headers/data + **2 条** | 变强 |
| `src/system/runtime/tests/check-plugin-lifecycle.py` | `http_get_page`/`login_as`（两服务各 `(base, side)`）；L 段**快照前**登录（L13「数据根逐字节不变」判据原样）+ **1 条**（C7） | 变强 |
| `src/domain/advice/tests/{t281-advice-gate.mjs,check-advice-route.py}` | 登录夹具 + **2 条**；`ui_shared` 移出被监视的 `SHARED`（保 ⑫「目录一元不增」原样） | 变强 |
| `src/domain/authority-band/tests/{t284-authority-gate.mjs,check-authority-route.py}` | 登录夹具 + **2 条** | 变强 |
| `src/domain/gate-timeline/tests/{t282-gate-timeline-gate.mjs,check-gate-timeline-route.py}` | 登录夹具 + **2 条**；催办写路由 POST 带 cookie | 变强 |
| `src/domain/gate-timeline/tests/{t283-change-detail-gate.mjs,check-change-detail-route.py}` | 登录夹具 + **2 条** | 变强 |
| `src/system/ui-feedback/tests/{t280-ui-feedback-gate.mjs,check-ui-feedback.py}` | 登录夹具（GET/POST 都带）+ **3 条** | 变强 |
| `src/system/admin/tests/check-admin-route.py` | 业务路径自动带本侧 cookie（经同一代理登录）+ **1 条**（⑧b） | 变强 |
| `src/system/projection/tests/check-rfq-visibility-route.py` | 同上（两服务共用会话文件）+ **2 条** | 变强 |

**未改**的既有断言：`/api/routes` 台账里业务路由的 `auth` 仍写 `none`（`EV-190` §6 已登记的产品侧偏差），
门读的是台账原文 ⇒ 那几条 `auth == "none"` 断言**仍为真、照旧通过**，不改也不删；台账与行为不一致属产品面。

## 4 按规则 12 删除的断言：**0 条**（逐条登记为空）

12 个门里没有一条断言本质上在断言「未登录也能看业务页」：两侧页面/JSON 的 200、逐字对账、逐字节一致、
哨兵 0 命中、零写面等都是**内容判据**，与「谁在什么身份下取」正交。逐条登记：`（空）`。

## 5 未做 / 遗留

- `docs/work/progress-checklist.md` **未加行**：该文件当前 **32572 B / 预算 32768 B**（99.4%），预算由 `docs` 门
  **硬判**（超限即红）；加行需先按既有归档机制搬一行（＝另一批的范围）。`EV-190`（P3 那批）同样没加行；证据即本文件。
- 门夹具的会话文件落在 `<ui_shared>/identity/sessions.json`：多数门用**私有** `--ui-shared`
  （`plugin-lifecycle` 落在 `./run up --data-dir` 的数据根）；`webui`/`bid-heuristics`/`t28x`/`admin-route`
  用仓库 `tmp/ui-shared`（gitignored 的开发共享目录，`gate-nudges/`、`quote-drafts/` 等既有产物同处）——
  这是**产品行为**（服务端会话落盘）而非门放宽。
- 未修的邻接面：`/api/routes` 台账（见上）、`AC-ADMIN-004` 与 `p0-no-node` 的既有红（`EV-190` §5 已归因，与本批无关；
  这两个重门本轮未跑）。
