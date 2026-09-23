# 事实源落点表（tmp/ 与 docs/work/plans/ 里的需求与规格 → 正式文档）

<!-- budget: 32 KB（docs/work/plans/*.md 行，本批新增）。本页不复制事实源正文，只给"哪一条落到哪里"。 -->

用户 2026-09-22 指令（逐字）：
> "你目前 tmp 中也混杂大量的项目要求和任务规范等，**必须落实持久化到项目主体的文档中去**。"

**纪律**：本页是**指针表**，不是搬家；事实源文件**一个字都不删**（`tmp/` 是 gitignored 的草稿区，`docs/work/plans/*.txt` 与 `*.json` 是入版本控制的事实源）。
落点只写正式文档的位置（FR/AC 的 ID、设计文档的 §、计划文档的 §）；已落地的 ID 全部可在定义集合里解析（复核命令见 §4）。

## 1. 落点表（逐文件 × 逐主题）

| # | 事实源（保留原样） | 主题 / 章节 | 已落地的正式位置 | 状态 | 复核 |
|---|---|---|---|---|---|
| 1 | `docs/work/plans/ux-双方痛点与交互需求.md.txt`（63936 B，29 节；`tmp/` 的逐字节副本已按 P36 清理，见 §2 G-5） | §0 证据基线 / §2 痛点清单（22 条痛点，含 9 条 human problem） / §2.1 追溯 | `docs/work/functional-requirements.md` §6.1（`FR-USREQ-001..012`：原话短引 + 可验收含义 + 验收方式）+ `docs/work/requirements-traceability.md`（状态 done/partial/missing + 证据列，本批新增"插件归属"列） | 已持久化（12 条） | `tools/verify.sh docs`（ID 解析）+ `tools/verify.sh coverage` |
| 2 | 同上 | §3 交互需求（FR 草案 20 条 / AC 草案） | 已落地的部分：`FR-UX-001..005`、`FR-UXWEB-001..002`、`FR-UIFB-001`、`FR-GATE-001..002`、`FR-AUTH-001`、`FR-RFQ-006`、`FR-ADV-001`、`FR-VIZ-001`、`FR-QUOTE-001`（各自的 AC 见定义集合） | 部分（§3 的其余草案仍在事实源里，见 §2 缺口表 G-1） | 家族逐条见 `docs/design/28-plugin-requirements-and-run.md` §2.2 |
| 3 | 同上 | §4 GUI 可行动作清单（四道视角）、§5.1 明确不做（6 条）、§5.2 未决（5 条） | 四道视角与动作：`FR-UX-004/005`、`FR-ADMIN-001..010`、`docs/design/21-admin-console-contract.md`、`docs/work/plans/ui-workflow-rework.md`；"明确不做"与"未决"由事实源保留（它们不是需求） | 部分 | 同上 + `docs/design/15-requirements-coverage.md` §3 |
| 4 | `docs/work/plans/gui-交互规格.md.txt`（50676 B，30 节；`tmp/` 的副本已按 P36 清理） | §2 每个视图第一屏、§3 交互实现方案（选定 SSR + `<form>`，否决内联 script；动作 → 路由/方法/请求体/响应形状总表）、§4 路由与视图拆分 | `docs/design/21-admin-console-contract.md`（管理道契约）、`FR-UXWEB-001..002`、`FR-ADMIN-001..010`、`FR-UIFB-001`；"0 内联脚本 + `<form method=get>`"的结构断言落在 `tools/verify.sh webui` | 已持久化（结构与路由） | `tools/verify.sh webui`、`admin-route`、`config-route` |
| 5 | 同上 | §5 可验收（每交互一条可机检断言 + 建议门名）、§6 分步实施顺序 | 建议门名已收敛为既有门名（`tools/verify.sh help` 的 66 个名字集合是接口）；实施顺序由 `docs/work/plans/plugin-migration-plan.md` §2 的阶段接管 | 已持久化（映射到既有门） | `tools/verify.sh help`（门名快照对比，见迁移计划 §3） |
| 6 | `docs/work/plans/config-凭据UX规格.md.txt`（43746 B，28 节；`tmp/` 的副本已按 P36 清理） | §2 配置分层（项目/插件/凭据）、§3 UI 化方案（含干跑预览、0600 待办件、原子写、回滚）、§4 凭据安全（只存指针与指纹，永不回显）、§5 初始化体验 | `FR-CONFIG-001..002`（配置面）、`FR-ADMIN-006..010`（管理道）、`FR-MAIL-001..002`（凭据项之一）、`AC-CONFIG-001`；设计落点 `docs/design/21-admin-console-contract.md` + `docs/work/deployment-manual.md` | 已持久化 | `tools/verify.sh config-route`（11 条路径未提权 401 同形 / 干跑零落盘 / 保存只落 0600 / `--init` 生成 YAML / 真 config.yaml 指纹前后不变） |
| 7 | 同上 | §6 可验收（每条一条机器判定断言）、§7 未决、§8 落地顺序 | 断言 → 既有门（`config-route`/`mail-transport`）；未决保留在事实源；落地顺序 → 迁移计划阶段 1.2 与 5.4 | 已持久化 | 同上 |
| 8 | `docs/work/plans/ui-workflow-rework.md`（27821 B）· `-part2.md`（25671 B）· `-part3.md`（21274 B） | §0 结论（11 步 0 步能推进） / §1 实测证据 / §2 缺口清单（按角色按步骤） | `FR-USREQ-001..003` 的缺口判据 + `docs/work/requirements-traceability.md` §2（缺什么才能机检）+ `docs/design/15-requirements-coverage.md` §3 的三条缺口登记 + 证据 `docs/work/evidence/EV-158-ui-workflow-rework.txt` | 已持久化（缺口形态） | `tools/verify.sh coverage`（缺口必须逐条登记） |
| 9 | `docs/work/plans/ui-workflow-rework-part2.md` · `-part3.md` | §3 目标交互规格（每步页面/控件/校验/提交后可验证结果）；§4 视觉规格（设计 token + 40 条 `VIS-nn` 规则） | §3 的部分落点：既有写操作四类（`gates`/`rfq-deadline`/`ui-feedback`/`quote-draft` 门）；**§4 视觉规格尚未有 FR/AC**（缺口 G-2） | 部分（§3 部分、§4 无） | §2 缺口表 |
| 10 | `docs/work/plans/p3-spec.json`（44400 B：41 条需求 + 42 条验收，逐条含建议验证命令与证据文件） | `requirements[]` / `acceptance[]` | 已在 FR 定义集合：**34/41**；已在 AC 定义集合：**34/42**（另 7 条 FR、8 条 AC 未在册，见缺口 G-3）；ID 与全文以本表 §4 的复核命令为准 | 部分（按实测，不按本文件自带的 `landed` 标记） | `tmp/arch-batch/fr_families.py` 的实测输出（EV-162 §2） |
| 11 | `docs/work/plans/ux2-index.json`（1538 B） | `sources[]` 三份规格的索引、"landed"（P0a 已落地）、`naming`（草稿编号必须转纯字母家族）、`discipline`（没实现的不得标 done） | 索引与纪律本身已是正式口径：家族命名规则进 ADR-0021 §3 与 28 §2.1；"已落地 P0a"= `FR-UXWEB-001..002`/`AC-UXWEB-001` | 已持久化 | `docs` 门（ID 解析）+ `webui` 门 |
| 12 | `tmp/jev-research.md`（23756 B，模型 "Jev" 调研）· `tmp/jev-research.json` | §① 结论 / §③ 适用性 / §④ 建议与插件接口草案 | 需求面：`FR-ADV-001`（决策建议层，已实现为 `domain/advice`）；凭据面：`docs/work/progress-checklist.md` 的 T-224（把 Jev key 放进 `/workspace/config.yaml`）+ `.agents/state.json` 的 `human_required`；未核实的结论保留在事实源（`[二手]`/`[假设]` 不得当成已验证） | 部分（接口草案未落设计文档，见缺口 G-4） | `tools/verify.sh advice` |
| 13 | ~~`tmp/config-凭据UX规格.md.txt` · `tmp/gui-交互规格.md.txt` · `tmp/ux-双方痛点与交互需求.md.txt`~~ | 三份规格的 `tmp/` 副本（与 `docs/work/plans/` 同名文件**逐字节相同**：43746 / 50676 / 63936） | **已删（P36 / `EV-192`）**：逐字节相同即纯副本，按用户要求「不得保留副本」删除；事实源 = `docs/work/plans/` 里的那个（#1/#4/#6），本页不再有 `tmp/` 指针 | 已持久化（副本已删） | `cmp`（删前实测 `IDENTICAL`，`EV-192` §5） |

## 2. 缺口表（未落地的部分必须显式登记，不得静默）

| # | 缺口 | 内容 | 登记位置 | 计划 |
|---|---|---|---|---|
| G-1 | `ux-双方痛点与交互需求.md.txt` §3 的其余 FR/AC 草案 | 未入定义集合的草案条目（例如第三/四条视角的部分交互） | 本表 + `docs/design/15-requirements-coverage.md` §3 | 按插件归属逐条评估后落表（不能先落表后实现：门要求 AC 有真命令与证据） |
| G-2 | `ui-workflow-rework-part3.md` §4 视觉规格（40 条 `VIS-nn`） | 无 FR、无 AC、无门（`webui` 门只有结构断言） | `docs/work/requirements-traceability.md` §2（`FR-USREQ-002` 的缺口行）+ 本表 | 需要"可机检视觉基线"（design token + `data-*` 断言）或人工评审记录；两选一后落 FR/AC |
| G-3 | `p3-spec.json` 未在册的 7 条 FR / 8 条 AC | 实测缺失（按家族 + 编号写，避免写出未定义的 ID）：FR 侧 = AGENTRT 家族 001/003/004/005 + STORAGE 家族 002/003/005；AC 侧 = AGENTRT 家族 001/003/004/005 + STORAGE 家族 002/003/005 + ADMIN 家族 011 | 本表 | 落表时按 `docs/design/28-plugin-requirements-and-run.md` §2.1 的命名方案；实现先于落表（既有纪律：无真命令与证据不进定义集合） |
| G-4 | `jev-research.md` §4.2 的宿主插件接口草案 | 未进设计文档（`docs/design/24-agent-runtime-plugins.md` 未含 Jev 适配节） | 本表 + T-224 | 凭据就位后按 27 §2 的插件布局落 `src/system/<plugin>/docs/` |
| G-5 | `tmp/` 与 `docs/work/plans/` 里**其余**散件（脚本、`.out`、探针） | 它们是过程产物不是规范 | 本表 + `docs/work/evidence/EV-192` | **P36 已清（用户 2026-09-23 指令）**：删「派生整树 / 变异树 / 旧夹具树 / 0 消费者的一次性产物」（`tmp/` 4.4 G → 183 M）；**留**「活文档（`src/**`、`docs/design`、`docs/work` 非 evidence、`.agents`、`tools`）引用到的可重跑脚本 + 当前批次证据 + `tmp/README.md`」。逐条删/留清单与理由见 `EV-192` §3 |

## 3. `tmp/` 指针（草稿区不留"必须记住"的东西）

`tmp/` 是 gitignored 的草稿区，**fresh clone 里不存在**，因此指针的持久化位置是本页 + `tmp/README.md`（草稿区内的便利副本）。
`tmp/README.md` 的内容：逐文件一行"→ 落点在哪"，并链回本页 §1 的同一行号；**不复制任何正文**。

## 4. 复核命令（本页每一行的"已落地"都必须能被重算）

```bash
# ① 落点里引用的每个 FR/AC ID 是否都在定义集合里（0 个未解析 = 通过）
python3 - <<'PY'
import re, pathlib
root = pathlib.Path('.')
ROW = re.compile(r'^\|\s*(FR|AC)-[A-Z0-9-]*\d\s*\|', re.M)
def ids(prefix):
    main = root / ('docs/work/functional-requirements.md' if prefix == 'FR' else 'docs/work/acceptance-criteria.md')
    out = set()
    for f in [main, *sorted(main.parent.glob(main.stem + '-archive*.md'))]:
        out |= {m.group(0).strip('| ').strip() for m in ROW.finditer(f.read_text(encoding='utf-8'))}
    return out
fr, ac = ids('FR'), ids('AC')
text = (root / 'docs/work/plans/spec-persistence.md').read_text(encoding='utf-8')
refs = set(re.findall(r'\b(?:FR|AC)-[A-Z0-9]+(?:-[A-Z0-9]+)*\d\b', text))
missing = sorted(r for r in refs if r not in fr | ac)
print('refs:', len(refs), 'unresolved:', missing)
PY

# ② p3-spec.json 的实际在册率（不取该文件自带的 landed 标记）
python3 tmp/arch-batch/fr_families.py

# ③ 三份大规格的 fact source（P36 起 `tmp/` 不再保留副本；删前实测逐字节相同）
ls -l docs/work/plans/ux-双方痛点与交互需求.md.txt docs/work/plans/gui-交互规格.md.txt docs/work/plans/config-凭据UX规格.md.txt
```

## 5. 与迁移计划的关系

本页只回答"规格落到哪"；"代码落到哪"在 `docs/work/plans/plugin-migration-plan.md`（阶段与风险）与 `plugin-file-map.md`（逐文件映射）。
两者共用同一套归属真源：`docs/design/28-plugin-requirements-and-run.md` §2。
