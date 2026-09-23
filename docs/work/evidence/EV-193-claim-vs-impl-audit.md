# EV-193 · 29（主文件 + 归档）「承诺 ↔ 实现」对账审计（P45 批；P46 补登记 §24 并复跑）

口径（不许放宽）：把 29 主文件与归档里**每条可检验的承诺**抽成一句「看到 X 就应该 Y」，逐条在实现里找**承接点**（文件:行 / 函数 / 路由 / 动作 / 断言）——probe 全部命中 ⇒ `承接`；任一未命中 ⇒ `缺口`（不写成已实现）；承接了但与文档不一致 ⇒ `漂移`（带证据行，并标已改/待改）。

**结论**：158 条承诺 = 承接 **153** + 缺口 **0** + 漂移 **5**（已改 5 / 待改 0；另 2 项登记待定见 §5）。

逐条清单表（158 行：id / § / 状态 / 承接点 / 承诺 / 备注）= [`EV-193-claim-matrix.tsv`](EV-193-claim-matrix.tsv)；机读真源 = [`EV-193-claims.json`](EV-193-claims.json)（承诺 + probe + 判定）。**P46 起消费脚本在仓内** `src/system/repo-gate/tools/claim-impl-audit.py`（不再依赖 `tmp/`）。

## 1 统计（按 §）

| § | 条数 | 承接 | 缺口 | 漂移 |
|---|---|---|---|---|
| §0 | 2 | 2 | 0 | 0 |
| §1 | 3 | 3 | 0 | 0 |
| §2 | 4 | 4 | 0 | 0 |
| §3 | 5 | 5 | 0 | 0 |
| §4 | 11 | 11 | 0 | 0 |
| §7 | 9 | 9 | 0 | 0 |
| §8 | 8 | 8 | 0 | 0 |
| §9 | 4 | 4 | 0 | 0 |
| §10 | 11 | 11 | 0 | 0 |
| §11 | 8 | 8 | 0 | 0 |
| §12 | 8 | 6 | 0 | 2 |
| §13 | 7 | 7 | 0 | 0 |
| §14 | 5 | 5 | 0 | 0 |
| §15 | 5 | 4 | 0 | 1 |
| §16 | 7 | 7 | 0 | 0 |
| §17 | 8 | 8 | 0 | 0 |
| §18 | 9 | 9 | 0 | 0 |
| §19 | 9 | 9 | 0 | 0 |
| §20 | 10 | 9 | 0 | 1 |
| §21 | 6 | 5 | 0 | 1 |
| §22 | 8 | 8 | 0 | 0 |
| §23 | 10 | 10 | 0 | 0 |
| §24 | 1 | 1 | 0 | 0 |
| **合计** | **158** | **153** | **0** | **5** |

## 2 漂移 5 条：证据 + 处理

### C63（§12）§12.5 对比度 ≥ WCAG AA、实测零不达标（**漂移**：原始读数里 PO 对象页有 2 处不达标）

- 现状承接点：`src/system/webui/code/assets/app.css:16`
- 证据与处理：原始读数 `tmp/p7-a11y-out.txt` 的 `[390-PO对象页]` 段：228 处可见文字里 **2 处 AA-FAIL**（面包屑分隔符「›」1.51 on rgb(16,21,28)）；同文件工作台 390/1440 两宽度 858 处 0 不达标。已把主文件/归档的「零不达标」改成「工作台两宽度零不达标 + PO 对象页 1 处登记例外」。 处理：**已改**（29 主文件 §12 改「1 处例外已登记」+ 归档 §12.5 记例外与读数；CSS 属「不要改」面）。

### C81（§15）§15 「49 条断言」（原写 48 —— 漂移，已改）

- 现状承接点：`docs/design/29-webui-gui-app.md:125；tmp/verify-identity/verify.out:315`
- 证据与处理：原文档写「48 条断言」，实测 **49**：`tmp/verify-identity/verify-result.json` 的 `checks` 长 49（`failures` 0）、`tmp/verify-identity/verify.out` 末行「结果：断言 49 条，失败 0 条」。处理：**29 主文件已改为 49**（本条 probe 即修后真值）；插件 doc `src/system/webui/docs/identity-and-selfservice.md:15` 同句**登记待定**（本轮允许面外）。

### C114（§20）§20.5 反证读数：去闸门 ⇒ 重复 seq 309 / ledger-frozen（**漂移**：归档指向的读数文件不存在）

- 现状承接点：`tmp/p21-scale-run/webui/jobs.json:262`
- 证据与处理：归档 §20 写的路径 `tmp/p21-shots/concurrent-broken-chain.json` **不在盘上**（P36 tmp 清理后消失）；同一读数的现存原件是 `tmp/p21-scale-run/webui/jobs.json`（含 `"code": "ledger-frozen"` + 「哈希链校验失败: seq 309」）。已把归档指针改成现存路径。 处理：**已改**（归档 §20 指针换成在盘原件，并写明命中内容 `ledger-frozen` / `seq 309`）。

### C119（§21）§21.4 产品面 0 命中「回终端」文案（原 rfq 动作载荷里给了 `python3` 命令 —— 漂移，已改）

- 现状承接点：`—`
- 证据与处理：`src/domain/rfq/code/ui.mjs` 的**动作载荷**（不是注释）里有两处教用户回终端：周报降级分支的 `next_action`（`python3 …weekly-report.py …`）与 `report-render-missing` 分支的 CLI 复跑命令；这正是 §21.4 禁止的形态（其余命中都在源码注释里，不是产品面）。 处理：**已改**（两处都换成界内可点的下一步：换一周 / 换格式 / 看通知中心 / 转运维）；清单表保留 probe = 「插件 `code/ui.mjs` 里 0 处 `python3` 载荷」，注释命中仍会让它报红，供后续回归用。

### C136（§12）§12 复跑指针指向**在盘**的读数（**漂移**：归档指向的 tmp/p7-report.md 不存在）

- 现状承接点：`tmp/p7-a11y-out.txt:13`
- 证据与处理：归档 §12 末行「测量与复跑：`tmp/p7-a11y-out.txt` 与 `tmp/p7-report.md`」—— `tmp/p7-report.md` **不在盘上**（P36 tmp 清理后消失）。已把该行改指现存读数文件 + 本证据页。 处理：**已改**（归档 §12 末行改指在盘读数 + `tmp/p7-start.sh`）。

## 3 缺口 0 条（含审计过程的诚实披露）

probe 初跑报过 9 条「缺口」，逐条核实后**全部**是「实现里真有承接点、只是第一版 probe 写得不准」：`gate.grant`/`gate.deny` 经 `decideAction(...)` 参数注册（字面 `id: 'gate.grant'` 不存在）；`tools/verify.sh` 的分支带缩进（`^advice)` 匹配不到）；`signer-mismatch` 在 `identity-sign.py` 而非 `quote-sign.py`。改正 probe 后复跑 ⇒ 缺口 0；清单表每条都带 `file:line`，没有一条是「找不到承接却写成已实现」。

边界：判定口径 = probe 命中（可重跑、可复核），**不是**运行时行为断言；真 HTTP / 真浏览器读数由各节原验证脚本负责，清单表逐条留了路径。

## 4 当场改了什么（4 项，均在允许面内）

| # | 文件 | 改动 | 为什么 |
|---|---|---|---|
| 1 | `src/domain/rfq/code/ui.mjs`（周报降级分支 `next_action`） | `python3 …weekly-report.py --ledger …` 换成界内下一步（换一周再看 / 看通知中心 / 转运维） | 29 §21.4 禁止产品面教用户回终端；这是**动作载荷**，原样会进界面 |
| 2 | `src/domain/rfq/code/ui.mjs`（`report-render-missing` 分支） | CLI 复跑命令换成「换格式 / 换一周 / 转运维」 | 同上（同插件第二处） |
| 3 | `docs/design/29-webui-gui-app.md` | §12 对比度改「算过；1 处例外已登记」；删 §12 重复的「禁止」句；§15 断言数 48→49 | 漂移 C63/C81 + 腾预算（28 KB 硬上限） |
| 4 | `docs/design/29-webui-gui-app-archive.md` | §12.5 记「858 处、例外 1 处」；复跑指针 `tmp/p7-report.md`→在盘读数；§20 反证读数指针改到在盘原件 | 漂移 C63/C136/C114 |

## 5 登记待定（允许面外）

- `src/system/webui/docs/identity-and-selfservice.md:15`「21 条身份路由、**48 条断言**」——实测 49（`tmp/verify-identity/verify-result.json` 的 `checks` 长 49、`failures` 0）。29 主文件已改 49；插件 doc 同句待改。
- `src/system/webui/code/assets/app.css`：PO 对象页面包屑分隔符 `›` 对比度 1.51（不达 WCAG AA）。修法在外壳 CSS，属「不要改」面；已按缺口登记在归档 §12，判据未放松。

## 6 复跑（可重跑）

```bash
# 判 + 写回同一份 TSV 与 .resolved.json（**任意 cwd**；rc=0 = 无缺口/无待改漂移）
python3 src/system/repo-gate/tools/claim-impl-audit.py
python3 src/system/repo-gate/tools/claim-impl-audit.py --no-write   # 只判、不写文件
tools/run.sh tools/check-docs.py    # 预算/ID/引用（改了 29 与归档，必须绿）
```

**P46 复跑（cwd=`/tmp`）**：158 条 = 承接 153 / 缺口 0 / 漂移 5、`rc=0`；脚本进仓后 `tmp/` 被清也能复跑（另一把尺子见 29 §24）。

## 7 未覆盖 / 风险

- 静态承接点口径：probe 命中的是「承诺对应的实现位置」；本页不起服务、不开浏览器。
- 清单表里的 `tmp` 路径按「当时在盘」读（`tmp/**` 会被清理轮次删）。
- 锚点是**扫描时刻**的快照：工作树里有并发/遗留的未提交改动（本批未提交），行号会随之移动。
