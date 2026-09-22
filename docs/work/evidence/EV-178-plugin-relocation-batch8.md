# EV-178 收尾搬迁（五件）：`host/lib` 剩 2 + `host/modules` 剩 16 + `tools/**` 17 + 24 个插件补承载 + 收口自证（`T-328`）

> 逐项清单与逐门原始输出另存 `EV-178-batch8-raw.json`（同目录、非 `.md`，不受 8 KB 预算约束）。规则照前七批（先改读方、两半边、对拍）。

## 一、五件清单

| # | 事项 | 清单 | 落地 |
|---|---|---|---|
| ① | `host/lib` 剩 **2** | `evolution.mjs`→`system/evolution/code/`；`user-space.mjs`→`system/user-plugin-manager/code/` | 旧路径**薄重导**；裸 `cordis` 改**模块内显式解析** |
| ② | `host/modules` 剩 **16** 实体 | `advice-panel`→`domain/advice`、`authority-band`→`domain/authority-band`、`compare`→`domain/compare`、`gate-timeline`→`domain/gate-timeline`、`quote-prepare`→`domain/quote-prepare`、`rfq-deadline`→`domain/rfq-deadline`、`audit-hook`→`system/audit-hook`、`bridge-canary`→`system/canary`、`index`→`system/runtime`（`code/plugin-index.mjs`）、`kernel-bridge`→`system/kernel-bridge`、`mail-view`→`system/mail`、`observability`→`system/observability`、`projection`→`system/projection`、`timeline`→`system/timeline`、`ui-feedback`→`system/ui-feedback`、`webui`→`system/webui`（全落 `code/`） | 旧路径**薄重导**（经 `host/lib/entity-<stem>.mjs` 一跳）；15 个插件新建 `lib -> ../../../host/lib` 过渡软链 |
| ③ | `tools/**` 非薄入口再搬 **17**（要求 ≥12） | `audit-verify`·`export-events`·`refresh-admin-snapshot`·`admin-apply`·`refresh-agent-memory`·`refresh-retention-plan`·`gate-nudge`·`rfq-promise`·`userplugin-record`·`userplugin-elevate`·`ui-feedback-apply`·`ui-feedback-monitor`·`ui-feedback-tick`·`ws-integrate`·`evolve-record`·`evolve-module`·`storage` | 旧位置**薄转发**（`runpy`/`exec bash`/副作用 import）；`BASELINE_NONTHIN` 30→**13** |
| ④ | 补承载 **24**（要求 ≥10，含 Python） | **Python 19**：`domain/{faq,pricing,quotes,rfq,intake,negotiation,capacity,change,clarify,commitments,costmodel,deviation,export,guard,sync,terms}` + `system/{measures,relay,realm}` 的 `code/__init__.py`（`entry=code/__init__.py`）；**ESM 5**：`system/{audit-hook,observability,timeline,ui-feedback}` + `domain/rfq-deadline` 的 `code/index.mjs` | **不新造功能**；承载 **28→53/63**；仍无入口 **10** |
| ⑤ | 收口自证 | `27 §10` 例外登记（**空表**）+ `plugin-assets` 新增 **PA8** + 变异 F7；`27`/`14`/映射表按**事实**改 | 见 §六 |

## 二、cordis 解析的实测行（①的先决）

**不把 `cordis` 拷进仓库**、不放宽解析：实体按**显式候选链**解析（与
`src/system/runtime/code/plugin-registry.mjs` 的 `loadCordis` **同一套**：`$QUOTAGENT_CORDIS` →
`host/node_modules/cordis/lib/index.js` → 裸 `cordis`），两个插件的 `plugin.json` 加
`dependencies: {"cordis": "4.0.0-rc.10"}`。裸名从 `src/**` 上溯解析不到（实测 `ERR_MODULE_NOT_FOUND`）。

```
OK  src/system/evolution/code/evolution.mjs -> ARTIFACT_SURFACE,DIRECTIONS,EvolutionError,METRIC_SOURCES,PatchJournal,SAME_KIND_FAILURE_LIMIT,gate,gateModule,makeModuleProposal,makeProposal,promote,promoteModule,recordEvent,rollback,rollbackModule,shadowArtifact,shadowMount
OK  src/system/user-plugin-manager/code/user-space.mjs -> APPROVAL_RE,DEGRADED_REASONS,ELEVATION_CODE,ENTRY,ENTRY_REASONS,HOST_SERVICES,MANIFEST,MAX_MANIFEST_BYTES,MAX_PLUGINS,NAME_RE,REFUSAL_CODES,REQUIRED_FIELDS,RESERVED_PREFIXES,RESERVED_SERVICES,SERVICE_RE,assertWriteSurface,credentialScope,isReserved,loadPlugin,namespaceKey,reload,resolveCredential,scan,userSpaceRootOf
```

旧路径同一次运行也 `OK`，导出集合**逐名一致**（17/17、23/23）⇒ 两半边都活。

## 三、`host/modules` 16 个：导出面与搬前逐名一致

在 `tmp/ev178-before/`（`git worktree` 的 **HEAD 整树**）与产品树各 import 一次，比 `Object.keys(m).sort()`：
**16/16 `SAME`**（before == after == entity 三方相等；逐行原文在 raw.json §三）。例：

```
SAME advice-panel n=20 COMMIT_SCOPES,Config,DEGRADED_REASONS,ENGINE,ENGINE_NOTE,GATE_COMMANDS,GATE_COMMAND_FALLBACK,RULES,SECTIONS,SEVERITIES,adviseOf,apply,builtin,disposer,fixture,inject,isoMs,name,provides,usedServices
SAME webui n=9 Config,SUBVIEWS,apply,builtin,inject,name,provides,sendGovernorError,usedServices
```

**先改读方再搬**（否则静默判绿，本批实测 4 类读点）：① `t280..t287` 八个围栏门的 `TARGET`/`WEBUI` 改指实体；
② `host/check-modules.mjs` 的 `manifestSource` 与 A4 的 `emit` 扫描改走 `moduleSource(file)`（此前该函数**定义了却没人调用** ⇒ A1「源码引用事件 ⟺ builtin 声明 events」在 25 个薄重导上**恒真**）；
③ 9 处按源码文本读的 AC 检查常量（`checks_adv`/`checks_gate`/`checks_qprep`/`checks_uxweb`/`checks_uifb`/`checks_admin`/`check-mail-transport`/`check-plugin-lifecycle`）改指实体；④ `tools/mutate-ui-views.py` 的 M4 路径改指 `src/system/webui/code/webui.mjs`。另 5 个 `code/index.mjs` 包装的 `../../../../host/modules/<stem>.mjs` 改指同目录 `./<stem>.mjs`。
**追链检查**：`docs/work/evolution-log.json` 的 12 条 `artifact_path` 与本批 16 个 stem **无交集**（无哈希/日志钉住项）⇒ 无需追链。

## 四、`tools/**` 17 项：两半边

- **旧半边**：只剩薄转发，全部满足 PA1/PA2（标记 + ≤20 行 + ≤1200 B + ≤ 目标 1/4）。
- **新半边**：实体在 `src/<层>/<插件>/tools/`，仓库根推导 `parents[1]`/`parent.parent` → `parents[4]`（`evolve-module.mjs` 另把 `../host/lib/evolution.mjs` 改指同插件 `../code/evolution.mjs`）。
- **先改读方**：3 处按**源码文本读**的读方先改指实体 —— `checks_uifb.py` 的 `APPLY`、`checks_admin.py` 的 `WRITER`、`checks_usreq.py` 的 `MONITOR`/`TICK`。
- **`manual-check.py` 不搬**：PA6 断言「已搬资产仍被**契约面**引用」，它在 `verify.sh`/`qa`/`tests`/`tools` 里都没有调用者 ⇒ 搬了就是孤儿；保留 `插件·待搬`。
- PA6 的**参考面**跟到搬完的家（`verify.sh` + `qa/*.py` + `src/*/*/tests/*.*` + `src/*/*/tools/*.*`）—— 判据未松，另加「非空转探针」。

## 五、承载计数

**已接承载 53 / 仍待实现 10**（`plugin.json` 共 63：`src/system` 34 + `src/domain` 26 + `src/userspace` 3）。
本批新接 **24**（19 Python + 5 ESM），全部只重导出既有实体：`node tmp/ev178-carriers.mjs` 5/5 `OK`；
`python3 tmp/ev178-pycarriers.py` 19/19 `OK`（`__all__` 非空、只含本模块定义的名字与数据常量）。
仍无入口 10 = 多实体 8（`system/{admin,agent-runtime,canary,eval,kernel-bridge,mail,webui}`、`domain/compare`）
+ 平台运行器 2（`system/{repo-gate,qa-runner}`，实现在插件根 ⇒ `code: 待实现`）。

## 六、PA8 与反向验证（原始行）

`27-plugin-architecture.md` §10 新增机检真源（锚点 `<!-- exceptions: host-layer-nonthin -->`，表**空**）；
门 `plugin-assets` 新增 **PA8**：**`host/modules`+`host/lib` 的非薄入口实体集合 == 文档登记的例外集合**（双向）。
反向验证（产品树真放一个实体、不登记）：

```
[FAIL] PA8 宿主层非薄入口 == 27 §10 登记的例外集合（默认空；双向）
        `host/modules/zz-reverse-probe.mjs` 是**非薄入口实体**，但 27 §10 例外表里没有登记（搬漏，或放回 host/modules 没登记）
```

删掉后立刻 `RESULT: PASS（plugin-assets 门 16/16）`（+PA8 +F7）。第 5 处变异 **F7**（实体放回 `host/modules/` 不登记）实测 `命中指定断言=True；红项=['PA6','PA8']`。

## 七、门结果（提交前）

19 道门全绿；与搬前**逐项对拍**的原始行在 raw.json §七（rc 与 passed/total 逐项不变；两处**按设计**变化：
`plugin-assets` 14/14→**16/16**（+PA8 +F7）、`modules` 内两条按源码文本判的读点改走 `moduleSource`（断言数不变仍 **521/521**，判据变**更强**））。
`run-clone`/`clean-copy` 校验 HEAD ⇒ 原始行见同目录 `EV-178-post-commit.txt`。
