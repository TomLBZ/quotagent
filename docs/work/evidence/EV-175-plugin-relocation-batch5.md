# EV-175 — ① 修 `AC-COMPARE-004`（读**定义集合**）+ ② 阶段 5 第三小片（余下 18 个服务实体 + 读方改指实体）

> 本页是**本批 ①② 的真跑原始行**（长输出与逐行清单在 [`EV-175-batch5-raw.json`](EV-175-batch5-raw.json)）；
> ③（10 项 `tools/**`）另见 [`EV-175b-tools-relocation.md`](EV-175b-tools-relocation.md)。
> 全部命令带 `env -u QUOTAGENT_PLUGIN_CONTROL_TOKEN`（本仓纪律；`run-clone`/`clean-copy` 校验 HEAD ⇒ 提交之后跑）。

## 一、① `AC-COMPARE-004`（P1，**搬前即红**；只改读取面，**判据未放宽**）

病根：断言只读 `docs/work/decisions.md`，而 `D-016` 早已归档进 `docs/work/decisions-archive-b.md`
（`grep -c D-016 docs/work/decisions.md` = 0）—— 与本批搬迁无关的遗留红。

```text
# 修前（同一工作树实测）
"first_failure": "`.xlsx` 的取舍已登记在案（D-016：P1 以 CSV 交付，xlsx 走宿主层）: decisions.md 缺 D-016"
  FAIL `.xlsx` 的取舍已登记在案（D-016：P1 以 CSV 交付，xlsx 走宿主层） — decisions.md 缺 D-016

# 修后：$ tools/verify.sh ac AC-COMPARE-004 ⇒ rc=0
  ok   `.xlsx` 的取舍已登记在案（D-016：P1 以 CSV 交付，xlsx 走宿主层）
  "exit_code": 0

# 反向验证：把归档里的 'D-016' 全量换成 'D-9ZZ'（1 处）后重跑 ⇒ 同一条断言必红
  rc=1
  FAIL `.xlsx` 的取舍已登记在案（D-016：P1 以 CSV 交付，xlsx 走宿主层） — 决策定义集合缺 D-016（或其定义后 400 字节内没有 CSV）：查了 ['decisions.md', 'decisions-archive-b.md', 'decisions-archive.md']
  # 归档复原：sha256 c40b8704d93a7dba… == c40b8704d93a7dba… ⇒ True
```

修法：改读**决策定义集合** = `decisions.md` + 同目录 `decisions-archive*.md`（与 `tools/check-docs.py`
的 `DEF_SETS` 同一归档口径）；判据仍是「集合里读到 `D-016` **且**其后 400 字节内有 `CSV`」。
门：`ac AC-COMPARE-004` rc=0；`p0-no-node` rc=0（见 `EV-175b`）。

## 二、② 阶段 5 第三小片：余下 **18/18** 服务实体进 `src/<层>/<插件>/code/`（旧路径**薄重导**）

### 2.1 字节守恒（`git hash-object <新位置>` == `git rev-parse HEAD:<旧路径>`）

| # | 旧位置 → 新位置（相对 `src/`；归属插件见新位置头两段） | blob sha |
|---|---|---|
| 1 | `quotagent/services/admin_blocks.py` → `system/admin/code/admin_blocks.py` | `9be89f288a13`==`9be89f288a13` ✅ |
| 2 | `quotagent/services/approval.py` → `system/approval/code/approval.py` | `bbf944471dd4`==`bbf944471dd4` ✅ |
| 3 | `quotagent/services/evaldata.py` → `system/eval/code/evaldata.py` | `90000939bdb6`==`90000939bdb6` ✅ |
| 4 | `quotagent/services/evalmetrics.py` → `system/eval/code/evalmetrics.py` | `28cfd22a7805`==`28cfd22a7805` ✅ |
| 5 | `quotagent/services/faq.py` → `domain/faq/code/faq.py` | `039f5a6db438`==`039f5a6db438` ✅ |
| 6 | `quotagent/services/mail.py` → `system/mail/code/mail.py` | `a9ceeead9bc6`==`a9ceeead9bc6` ✅ |
| 7 | `quotagent/services/mail_transport.py` → `system/mail/code/mail_transport.py` | `a66127e0bfef`==`a66127e0bfef` ✅ |
| 8 | `quotagent/services/negotiation.py` → `domain/negotiation/code/negotiation.py` | `e9c998350ad7`==`e9c998350ad7` ✅ |
| 9 | `quotagent/services/pricing.py` → `domain/pricing/code/pricing.py` | `6fec53aaf533`==`6fec53aaf533` ✅ |
| 10 | `quotagent/services/quotes.py` → `domain/quotes/code/quotes.py` | `f6792d03b73f`==`f6792d03b73f` ✅ |
| 11 | `quotagent/services/realm.py` → `system/realm/code/realm.py` | `eb72ed77a51e`==`eb72ed77a51e` ✅ |
| 12 | `quotagent/services/relay.py` → `system/relay/code/relay.py` | `228b5502001f`==`228b5502001f` ✅ |
| 13 | `quotagent/services/retention.py` → `system/retention/code/retention.py` | `4f15065abb4b`==`4f15065abb4b` ✅ |
| 14 | `quotagent/services/retention_exec.py` → `system/retention/code/retention_exec.py` | `327beb973704`==`327beb973704` ✅ |
| 15 | `quotagent/services/rfq.py` → `domain/rfq/code/rfq.py` | `b98eb1d14947`==`b98eb1d14947` ✅ |
| 16 | `quotagent/services/scenarios.py` → `system/eval/code/scenarios.py` | `7165e5ef461e`==`7165e5ef461e` ✅ |
| 17 | `quotagent/services/sync.py` → `domain/sync/code/sync.py` | `abdc1ba63e2d`==`abdc1ba63e2d` ✅ |
| 18 | `quotagent/services/terms.py` → `domain/terms/code/terms.py` | `4fa3f14b8494`==`4fa3f14b8494` ✅ |

**守恒 18/18**；旧位置只剩薄重导（888–961 B，标记「薄重导（迁移阶段 5）」）。

### 2.2 两半边：旧导入路径可用 + 实现确实来自实体

口径：① 旧路径 `import quotagent.services.<name>` 成功；② `__file__` == 旧路径（重导的家）；
③ 模块内 code 对象的 `co_filename` == 新位置实体（不是副本/陈旧 `.pyc`）；④ HEAD 那一份的**每个顶层
定义名**搬后仍在模块命名空间里（API 面逐名对拍）。逐行 18 条在 raw.json 的 `two_halves_lines`。

```text
两半边：18/18 通过（旧导入路径可用 + 实现来自实体 + API 面不变）
```

### 2.3 **先改读方再搬**：8 处按旧路径读源码的读方（否则静态断言在薄重导上静默判绿）

| 读方 | 改法 |
|---|---|
| `src/system/mail/tests/checks_mail.py` | 新增 `_impl_source()`：`__file__` 是薄重导 ⇒ 跟到实体 |
| `src/domain/faq/tests/checks_faq.py` | 同上 |
| `src/domain/negotiation/tests/checks_negotiation.py` | 同上 |
| `src/system/retention/tests/checks_retention_exec.py` | 同上（`scanned` 走 `_impl_source()`） |
| `src/system/retention/tests/checks_retention.py` | 常量 `RETENTION_SOURCE` 直接指实体 |
| `src/system/admin/tests/checks_admin.py` | 常量 `SERVICE` 指实体 + `git show HEAD:<新路径>` |
| `tools/check-mail-transport.py` | G1 的 AST 扫描路径改指 `src/system/mail/code/mail.py` |
| `src/system/mail/tests/checks_mail_transport.py` | 常量 `FILES['transport'/'mail']` 指实体（实测：`p0-no-node` 的 AC-MAIL-002 因此红过） |
| `tools/check-plugin-inventory.py` | P3 改 `service_names()` = 旧路径 ∪ 实体（名字集合同口径） |

### 2.4 反向验证（实体变异**必红** / 薄重导变异**仍绿**；7 例逐条真跑，原始行在 raw.json）

```text
AC-AUDIT-003  实体 `+import subprocess` ⇒ rc=1（零残留·静态·文本）｜薄重导同变异 ⇒ rc=0
AC-AUDIT-005  实体 ⇒ rc=1（scanned=src/system/retention/code/retention_exec.py …）｜重导 ⇒ rc=0
AC-ADMIN-006  实体 `+import shutil` ⇒ rc=1（命中=['shutil']）｜重导 ⇒ rc=0
AC-MAIL-001   实体 `+import smtplib` ⇒ rc=1（实现=…code/mail.py net_imports=['smtplib']）｜重导 ⇒ rc=0
mail-transport 实体 ⇒ rc=1（[FAIL] G1 … imports=[…'smtplib'…]）｜重导 ⇒ rc=0（27/27）
AC-FAQ-001    实体 `+import subprocess` ⇒ rc=1（path=…/src/domain/faq/code/faq.py）｜重导 ⇒ rc=0
AC-NEGO-003   实体 `+import subprocess` ⇒ rc=1（io_imports=['subprocess']）｜重导 ⇒ rc=0
7/7 通过；每例两次变异都逐字节复原并核对 sha256（见 raw.json 的 negative_control_lines）
```

### 2.5 受影响的门：搬前（HEAD 干净副本 `git archive HEAD`）↔ 搬后（工作树）

| 门 | 搬前 rc / passed/total | 搬后 rc / passed/total |
|---|---|---|
| `plugins` | rc=0；`服务 30 个；未归属=[]`；PASS 5/5 | rc=0；`服务 30 个；未归属=[]`；PASS 5/5 |
| `faq` | rc=0；AC-FAQ-001 20/20 | rc=0；AC-FAQ-001 20/20 |
| `negotiation` | rc=0；AC-NEGO-003 30/30 | rc=0；AC-NEGO-003 30/30 |
| `retention` | rc=0；AC-AUDIT-003 21/21 + AC-AUDIT-005 22/22 | rc=0；同左 |
| `mail` | rc=0；AC-MAIL-001 20/20 | rc=0；AC-MAIL-001 20/20 |
| `mail-transport` | rc=0；27/27（HEAD 副本缺 `host/node_modules` ⇒ 25/27，仅 G3/G4 的 node 面） | rc=0；27/27 |
| `AC-ADMIN-004/005/006`、`AC-MAIL-001/002`、`AC-FAQ-001`、`AC-NEGO-003`、`AC-AUDIT-003/005` | 绿 | 每例 rc=0 |

清单登记：`docs/work/plans/plugin-file-map.md`（服务映射行备注）+ `plugin-file-map-batches.md`
（本批 18 项与 8 处读方的台账）。至此 `src/quotagent/services/**` 的 **30/30** 实体都在 `code/` 下。
