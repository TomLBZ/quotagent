# EV-175b — ③ 阶段 4.2 续搬：10 个外圈 `tools/**` 非薄入口进各自插件的 `tests/` + 全量门

> 与 [`EV-175-plugin-relocation-batch5.md`](EV-175-plugin-relocation-batch5.md) 同批（①②）。
> 全部命令带 `env -u QUOTAGENT_PLUGIN_CONTROL_TOKEN`。

## 一、搬的 10 项：两半边（旧位置只剩薄转发 / HEAD 有新位置 / **旧调用路径真跑**）

| 旧位置 → 新位置 | 薄转发字节/行 | ≤ 目标 1/4 | 旧调用 rc | 新位置直跑 rc | 门 |
|---|---|---|---|---|---|
| `tools/check-faq.py` → `src/domain/faq/tests/check-faq.py` | 228 B/4 行 | 912 ≤ 931 | 0 | 0 | `tools/verify.sh faq` |
| `tools/check-negotiation.py` → `src/domain/negotiation/tests/check-negotiation.py` | 260 B/4 行 | 1040 ≤ 1047 | 0 | 0 | `tools/verify.sh negotiation` |
| `tools/check-retention.py` → `src/system/retention/tests/check-retention.py` | 252 B/4 行 | 1008 ≤ 1777 | 0 | 0 | `tools/verify.sh retention` |
| `tools/check-mail.py` → `src/system/mail/tests/check-mail.py` | 232 B/4 行 | 928 ≤ 1013 | 0 | 0 | `tools/verify.sh mail` |
| `tools/check-canary.py` → `src/system/canary/tests/check-canary.py` | 240 B/4 行 | 960 ≤ 1433 | 0 | 0 | `tools/verify.sh canary` |
| `tools/check-canary-dispatch.py` → `src/system/canary/tests/check-canary-dispatch.py` | 258 B/4 行 | 1032 ≤ 1380 | 0 | 0 | `tools/verify.sh canary-route` |
| `tools/check-bridge-canary.py` → `src/system/canary/tests/check-bridge-canary.py` | 254 B/4 行 | 1016 ≤ 1354 | 0 | 0 | `tools/verify.sh bridge-canary` |
| `tools/check-governor.py` → `src/system/governor/tests/check-governor.py` | 248 B/4 行 | 992 ≤ 1322 | 0 | 0 | `tools/verify.sh governor` |
| `tools/check-audit-hook.py` → `src/system/audit-hook/tests/check-audit-hook.py` | 256 B/4 行 | 1024 ≤ 1333 | 0 | 0 | `tools/verify.sh audit-hook` |
| `tools/check-breaker-route.py` → `src/system/circuit-breaker/tests/check-breaker-route.py` | 272 B/4 行 | 1088 ≤ 3973 | 0 | 0 | `tools/verify.sh breaker-route` |

判定口径：① `git cat-file -e HEAD:<新位置>` 存在；② `git show HEAD:<旧位置>` 含标记
「薄转发（迁移阶段 4.1）」、≤ 20 行、≤ 1200 B、且 ≤ 目标 1/4（PA2）；③ 实体只改了**一处** —— 仓根推导
`Path(__file__).resolve().parents[1]`（`tools/` 下）→ `parents[4]`（`src/<层>/<插件>/tests/` 下）；
④ **旧调用路径仍可用**：真跑 `python3 tools/<旧名>` 与 `python3 <新位置>`，两者 rc 一致且都为 0
（`tools/verify.sh` 的 `case` 分支调的就是旧路径 ⇒ 门名与分支一行未改）。

```text
$ python3 tmp/batch6/prove_tools.py（逐项两半边，真跑 20 次）
  [ok  ] tools/check-faq.py → src/domain/faq/tests/check-faq.py
  HEAD 新位置=True 标记=True 228 B/4 行 ≤1/4(232)=True 指向=True 只改仓根推导=True
  [ok  ] tools/check-negotiation.py → src/domain/negotiation/tests/check-negotiation.py
  HEAD 新位置=True 标记=True 260 B/4 行 ≤1/4(261)=True 指向=True 只改仓根推导=True
  [ok  ] tools/check-retention.py → src/system/retention/tests/check-retention.py
  HEAD 新位置=True 标记=True 252 B/4 行 ≤1/4(444)=True 指向=True 只改仓根推导=True
  [ok  ] tools/check-mail.py → src/system/mail/tests/check-mail.py
  HEAD 新位置=True 标记=True 232 B/4 行 ≤1/4(253)=True 指向=True 只改仓根推导=True
  [ok  ] tools/check-canary.py → src/system/canary/tests/check-canary.py
  HEAD 新位置=True 标记=True 240 B/4 行 ≤1/4(358)=True 指向=True 只改仓根推导=True
  [ok  ] tools/check-canary-dispatch.py → src/system/canary/tests/check-canary-dispatch.py
  HEAD 新位置=True 标记=True 258 B/4 行 ≤1/4(345)=True 指向=True 只改仓根推导=True
  [ok  ] tools/check-bridge-canary.py → src/system/canary/tests/check-bridge-canary.py
  HEAD 新位置=True 标记=True 254 B/4 行 ≤1/4(338)=True 指向=True 只改仓根推导=True
  [ok  ] tools/check-governor.py → src/system/governor/tests/check-governor.py
  HEAD 新位置=True 标记=True 248 B/4 行 ≤1/4(330)=True 指向=True 只改仓根推导=True
  [ok  ] tools/check-audit-hook.py → src/system/audit-hook/tests/check-audit-hook.py
  HEAD 新位置=True 标记=True 256 B/4 行 ≤1/4(333)=True 指向=True 只改仓根推导=True
  [ok  ] tools/check-breaker-route.py → src/system/circuit-breaker/tests/check-breaker-route.py
  HEAD 新位置=True 标记=True 272 B/4 行 ≤1/4(993)=True 指向=True 只改仓根推导=True
  两半边：10/10 通过
```

## 二、逐门对拍：`rc` 与 `passed/total` **逐项不变**

| 门 | 搬前（②之后、③之前） | 搬后 |
|---|---|---|
| `faq` | rc=0；AC-FAQ-001 20/20 | rc=0；AC-FAQ-001 20/20 |
| `negotiation` | rc=0；AC-NEGO-003 30/30 | rc=0；AC-NEGO-003 30/30 |
| `retention` | rc=0；AC-AUDIT-003 21/21 + AC-AUDIT-005 22/22 | rc=0；同左 |
| `mail` | rc=0；AC-MAIL-001 20/20 | rc=0；AC-MAIL-001 20/20 |
| `canary` | rc=0；11/11 | rc=0；11/11 |
| `canary-route` | rc=0；8/8 | rc=0；8/8 |
| `bridge-canary` | rc=0；11/11 | rc=0；11/11 |
| `governor` | rc=0；9/9 | rc=0；9/9 |
| `audit-hook` | rc=0；7/7 | rc=0；7/7 |
| `breaker-route` | rc=0；4/4（JSON `passed: 4 / total: 4`） | rc=0；4/4 |
| `plugin-assets` | rc=0；14/14（非薄入口 64） | rc=0；14/14（非薄入口 **54**） |
| `docs` | rc=0；PASS | rc=0；PASS |

原始行（`sh tmp/batch6/run.sh` 的汇总行，`rc=` 后为退出码）：

```text
搬前 pre3：canary                     rc=0 ｜ canary-route               rc=0 ｜ bridge-canary              rc=0 ｜ governor                   rc=0 ｜ audit-hook                 rc=0 ｜ breaker-route              rc=0
搬后 post3：canary                     rc=0 ｜ canary-route               rc=0 ｜ bridge-canary              rc=0 ｜ governor                   rc=0 ｜ audit-hook                 rc=0 ｜ breaker-route              rc=0
```

## 三、`plugin-assets` 同步（**只减不增，禁放宽**）

```text
PA7 `tools/**` 的散落不再增长（非薄入口 == §分类 的待搬集合 54 项，且 ≤ 基线 54）
RELOCATED 74 → 84（10 条新增：PA1 目标在 + 旧位置只剩薄转发；PA2 字节 ≤ 目标 1/4 且 sha256 ≠ 目标；
PA3 分类表「已搬」行 == 门内登记；PA5 basename 在 src/** 唯一且在归属插件目录）
BASELINE_NONTHIN 64 → 54（**收紧**；不是放宽 ✗）
RESULT: PASS（plugin-assets 门 14/14）
```

主文件 `plugin-file-map.md` §分类 A 节：10 行 `插件·待搬` → `插件·已搬`；A 节计数行与 §分类 口径第 4 条
同步为 `已搬 10 + 待搬 54`；台账叙事见 `plugin-file-map-batches.md`。
