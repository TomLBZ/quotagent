# ADR-0020 一切皆插件：三层分类、目录规范与注入式 UI

Status: accepted

## Problem

目录与归属是"事实上的架构"，但本仓的架构只存在于散落的实现里：`src/quotagent/**`（双包名）、`host/**`（cordis 宿主 + 模块 + 门）、`tools/**`（70 个脚本）、`user-space/**`（gitignored 的运行时目录），
加上 `src/quotagent/qa/checks_*.py`（47 个分散检查）。后果是**三件事同时发生**：

1. 没有任何一条规则说"一个功能由哪个插件提供、它的代码/测试/需求/文档各放在哪"，因此新功能落到哪里只能靠模仿上一批；
2. `webui` 事实上耦合了每个业务插件的载荷装配与页面（新增一个插件要改 `webui.mjs` 两处以上），违反"插件可分别独立演进"；
3. 需求以"产品整体"口径写在 `docs/work/functional-requirements.md`，看不出它由谁提供，`docs/design/15-requirements-coverage.md` §4 只能事后补 12 件"无归属插件"。

用户 2026-09-22 指令（逐字）：
- "一切皆插件，所以 src 中本质是大量的插件。src 下面有 system、domain 和 userspace 等主要的分类 …（**如果 cordis 已经提供相应系统级功能，则直接使用 cordis 功能！**）"
- "每个插件应该有自己的子目录，包含自己的代码、自己的测试文件、自己的需求、自己的文档/使用规范等，使得单个插件都可以被 agent 独立开发、演进，也可以被 agent 轻易动态读取、重载、使用、卸载等。"
- "目前 projects/quotagent 文件夹下文件位置混乱、架构不清晰 … host、tools、user-space 等文件夹也不知道为何不在 src 内。"
- "**不需要让 webui 耦合展示其他插件的 UI 或者耦合某种具体的业务逻辑。**"

## Decision

1. **三层插件分类**（`src/system/`、`src/domain/`、`src/userspace/`），判定规则、层间信任级别与写面见 `docs/design/27-plugin-architecture.md` §1（本 ADR 不重复清单，一处一事实）。当前落点：**34 个 system、25 个 domain、2 个 userspace 命名空间**（逐文件映射见 `docs/work/plans/plugin-file-map.md`）。
2. **单插件标准目录布局**：`code/ tests/ requirements/ docs/ tools/ plugin.json`，插件自述清单字段与最小契约见 27 §3；清单**复用** `user-space` 既有 `plugin.json` 约定（`host/lib/user-space.mjs` 的字段与 `NAME_RE`），不新增第二套。
3. **生命周期接口唯一**：`list / enumerate / status / load / reload / unload` 六个动词，由 `tools/plugin.sh <verb> <plugin-id>` 一行命令暴露（27 §4）。system/domain 今日由 `host/profiles.mjs` 静态装配，userspace 今日已可动态装卸（`host/modules/user-plugin-manager.mjs`）；本 ADR 要求三条路走**同一个接口与同一张清单**。
4. **依赖规则**：插件可依赖其它插件（`inject` / `depends_on`）与第三方（`external_deps` + 锁文件），但第三方依赖的默认值是**零**（承接 ADR-0007：现场机器无法保证安装与网络）；新增第三方依赖需 ADR + 锁文件 + "一键运行仍成立"的证据。
5. **注入式 UI 契约**：`webui` 只提供注册面（路由前缀、区块槽位、静态资源目录、只读投影接口），**不知道业务语义**；业务插件通过注册声明自己的区块/路由/资源。禁止 `webui` 里出现任何插件名、业务名词或字段绑定。
6. **修法路径**：迁移分阶段、每阶段独立可提交可验证，见 `docs/work/plans/plugin-migration-plan.md`；门名（`tools/verify.sh <门>`）是**稳定接口**，实现路径可以搬。

## Consequences

- 新功能 = 新增一个插件目录（代码 + 测试 + 需求 + 文档 + 清单），不必改中心清单（延续 `host/modules/index.mjs` 的"目录即清单"）；`webui` 不再改。
- `docs/design/12-documentation-standard.md` §1 的预算表是文档门的真源，目录搬迁必须同步改该表的路径（否则新位置的文档逃出预算 = 门变松），本批已预置 `docs/work/plans/*.md` 与 `src/system|domain/*/docs/*.md` 两行。
- 代价：迁移期存在双份路径（旧路径引用、门脚本与 `verify.sh` 里的硬编码路径），必须靠"门名不变 + 每阶段全门回读"来兜底；`host/package.json`、`node_modules`、`host/*.md` 的预算行与 `tools/cordis.sh` 的 `$ROOT/host` 是已知硬编码点。
- `checks_*.py`（47 个）与 `host/t*-gate.mjs` / `host/<plugin>.mjs` 门随插件搬家 ⇒ 每个插件的测试与它自己的代码同目录，独立演进不再需要跨目录改别人。

## How to verify

- `tools/verify.sh docs`（预算/ID/覆盖）：预算表的路径与真实目录一致，无新增未受预算约束的文档子目录。
- `tools/verify.sh coverage`：矩阵双向全覆盖 + 每个插件至少归属 1 条 FR/AC（A5）在本 ADR 之后扩展为按"插件 id"而不是"文件路径"对齐（见 ADR-0021）。
- `tools/verify.sh plugins`（`tools/check-plugin-inventory.py`）：清单与 `host/modules/*.mjs` 双向一致。
- 门名稳定性：`tools/verify.sh help` 自报的门名集合（本批实测 **66** 个）在迁移前后**逐字不变**（脚本化对比，见 `docs/work/plans/plugin-migration-plan.md` §5 风险 R-2）。
- 本 ADR 的规则文本落在 27 §1/§2/§3/§5/§6/§7，每条都带机检要点；"是否跑偏"由这些要点回答。

## Revisit conditions

1. 若 `src/system|domain` 的 Python 包名（`system`/`domain`）与运行时环境里的同名包冲突（已在 Python 3.13 实测无冲突，`importlib.util.find_spec` 均返回 `None`），需要改包名或加隔离层。
2. 若 cordis 上游提供 `@cordisjs/plugin-loader` / `plugin-hmr` 的稳定版并愿承担 Node 依赖，则自研的 `host/lib/user-space.mjs` 装载器按 27 §7.2 替换（先写 ADR）。
3. 若"每个插件自带第三方依赖"在实践中导致一键运行不可复现，则该条收紧为"依赖上收到 `src/system/runtime/` 统一锁定"。
