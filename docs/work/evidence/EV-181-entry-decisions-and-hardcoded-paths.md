# EV-181 — ① 干净副本 3 条红 AC 的根因与修法 ② 7 个多实体插件的 `entry` 决定 ③ 硬编码路径扫描 + 新门 PA9


## 一、① 根因：围栏门要的**宿主依赖**在干净副本里不存在（不是"环境敏感"）

`AC-AGENTRT-002/006/007` 的 Node 半边都真跑同一个围栏门 `src/system/agent-runtime/tests/t275-runtime-gate.mjs`（顶层解析宿主内核）：

    const CORDIS_URL = process.env.QUOTAGENT_CORDIS ? pathToFileURL(process.env.QUOTAGENT_CORDIS).href
      : pathToFileURL(join(HERE, 'node_modules', 'cordis', 'lib', 'index.js')).href
    const { Context, EventsService } = await import(CORDIS_URL)

而 `host/node_modules/` 是 **gitignored**（`.gitignore:7`；由 `tools/cordis.sh install` 装）⇒ `git archive HEAD`
的副本里不存在。三条 AC 原先都是裸 `node <实体>`（`subprocess.run(['node', str(GATE.name)], cwd=str(GATE.parent), …)`）
⇒ 副本里 `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<copy>/host/node_modules/cordis/lib/index.js'`，
rc=1、stdout 无 JSON ⇒ 断言 ④/⑥ 判红。

**"单独跑也全绿"的真因**：全量 AC 按 ID 升序跑，`AC-AGENTRT-*` 在最前（第 5–7 行），后面的 `AC-INTEG-004` 等走
`tools/cordis.sh run`（内含**幂等** `install_deps`）⇒ **跑完全量后**依赖才被装上，此后单独重跑自然绿；"顺序污染"只是表象。

### 最小复现

    $ rm -rf /tmp/clean2 && mkdir /tmp/clean2 && git archive HEAD | tar -x -C /tmp/clean2
    $ cd /tmp/clean2 && env -u QUOTAGENT_PLUGIN_CONTROL_TOKEN tools/run.sh -m quotagent.qa all
    [FAIL] AC-AGENTRT-002 — …（9/10 断言）
    [FAIL] AC-AGENTRT-006 — …（11/12 断言）
    [FAIL] AC-AGENTRT-007 — …（4/5 断言）
    [ok] AC-INTEG-004 — 协议与版本协商…（12/12 断言）      ← 它内部 `tools/cordis.sh run` 会 install_deps
    全量 AC：82/85 通过；失败 ['AC-AGENTRT-002', 'AC-AGENTRT-006', 'AC-AGENTRT-007']     RC=1
    $ ls -d /tmp/clean2/host/node_modules ⇒ 存在（**跑之前不存在**）

### 修法（判据一格未改）：走既有依赖自愈约定 `tools/cordis.sh run`

三个检查模块各加 `run_fence_gate()`，把裸 `node <实体>` 换成本仓库既有的同一条约定（`checks_bridge` /
`check-webui.py` / `check-canary.py` / `check-audit-hook.py` 都这么写）：

    return subprocess.run([str(CORDIS), 'run', GATE_REL], cwd=str(GATE.parent),
                          capture_output=True, text=True, timeout=600)   # CORDIS=tools/cordis.sh；GATE_REL='t275-runtime-gate.mjs'

`cordis.sh run` = 幂等 `install_deps` → `exec node host/<薄转发>`；装不上依赖 ⇒ 非 0 退出 + 无 JSON ⇒ **照旧红**；无 Node ⇒ 仍走原"明说降级"分支（ADR-0013 §8）。

### 正向 / 反向验证

     正向（`git ls-files` 复制的副本，**node_modules 不存在**）：/tmp/fix1 ⇒ [PASS]×3（跑完依赖被自动装上）；
      /tmp/fix2 ⇒ 全量 AC **85/85**、RC=0。反向（回退成裸 `node <实体>`，同副本 /tmp/rev1）⇒ [FAIL]×3。

**未改这 3 条 AC 的判据**（断言条件、条数、阈值一字未动；只改"门怎么被跑起来"的环境前置）。

## 二、② 7 个插件的 `entry` 决定（`decisions.md` D-078..D-084，逐条含理由与被否决项）

口径：**有 ESM 服务实体 ⇒ 入口 = 那个实体**（单实体 = 薄重导出；多实体 = **机制组合**：入口只按序 `ctx.plugin()`
成员，零业务语义零写面、不替成员解析配置）；**宿主侧 0 个 ESM 服务实体 ⇒ 入口 = Python 承载入口 `code/__init__.py`**
（与 19 个既有 Python 承载插件同形）。逐插件的"落地状态（`code/`）"写在各自 `requirements/README.md`。

| 插件 | 决定 | `provides`（实体自述真实键） | `load` 实测 |
|---|---|---|---|
| `system/webui` | 单实体（`webui.mjs`） | `['webui','uiSlots']` | `ok:true` `kind=esm`；fiber `PENDING`（25 个 inject 未就绪 ⇒ **非激活不是崩**）；`unload` effects 0 |
| `system/admin` | **机制组合**（guard + view） | `['adminGuard','adminView']` | `ACTIVE`，`effects.count=2`，`unload` `zero_effects` |
| `system/agent-runtime` | **机制组合**（context+harness+memory） | `['agentContext','agentMemory','agentHarness']` | `ACTIVE`，`effects.count=3`，`unload` `zero_effects` |
| `system/canary` | **机制组合**（canary 先、bridge-canary 后） | `['canary','canary-dispatch']` | `ACTIVE`，`effects.count=2`，`unload` `zero_effects` |
| `system/mail` | 单实体（`mail-view.mjs`） | `['mailView']` | `ACTIVE`，`effects.count=2`，`unload` `zero_effects` |
| `system/eval` | **Python 承载入口**（新建 `code/__init__.py` 重导出三个既有实体） | `['eval']`（沿用插件名键） | `kind=python`（宿主不经 cordis 装载） |
| `system/kernel` | 入口 = **内核包自己的** `code/__init__.py`（已存在，非新造） | `['kernel']` | `kind=python` |

结果：`tools/plugin.sh list` ⇒ **63 个插件 valid 63 / invalid 0、degraded 0**（此前 7 条 `artifact-missing`）。

### 连带（否则等于放宽门）：`plugin-lifecycle` 的 A13/A14 改指对照根 + 补正控

原判据锚在"**真根上** `system/webui` 未迁移"（`missing_targets`/`deps_missing == ['system/webui']`、`deps_ready=false`）；
接上入口后该事实消失 ⇒ A13/A14 改指真根**正控**（`closure == ['system/webui']`、`order == ['domain/advice','system/webui']`、
`missing_targets == []`、`deps_ready == true`），**新增 A13b/A14b 负控**：对照根 = 真
`domain/advice` 整块拷贝 + 真 `system/webui` 的**真清单字节**但**不放 `code/index.mjs`** ⇒ `deps` 仍 `ok:true` 且
`missing_targets == ['system/webui']`、`closure == []`；`status` 仍 `deps_ready=false`、`deps_missing == ['system/webui']`。
"目标清单在、入口不在 ⇒ 不算依赖已就绪"**继续被真跑证明**，且是构造出来的（不随仓库演进变绿）。

断言行数 **66/66 → 68/68**（只增不减），读数：`RESULT: PASS（plugin-lifecycle 门 68/68） RC=0`。
变异 6 **不受影响**（已复核）：它的对照根由变异自己 `invalid_dirs=("src/system/webui",)` 造非法清单，与真根无关；
同一运行里 `F0 基线不红` + `F1..F6` 仍逐条命中指定断言。

## 三、③ 硬编码仓库根扫描（可移植性，服务"克隆即跑"）

扫描面 = `src/**`、`host/**`、`tools/**`、任意 `*.sh`；判据 = "以 `quotagent` 为**末段目录**的绝对路径字面量"。
本批命中 4 处（**原始行**）：

    src/system/webui/tools/mutate-ui-views.py:16: ROOT = Path('<仓库根>')
    src/system/ui-feedback/tools/ui-feedback-tick.sh:11: ROOT=<仓库根>
    src/system/ui-feedback/tools/ui-feedback-monitor.sh:10: ROOT="${QUOTAGENT_ROOT:-<仓库根>}"
    tools/manual-check.py:15: ROOT = Path('<仓库根>')

修法（一律由**文件/脚本自身位置**推导，不引入新配置；`QUOTAGENT_ROOT` 覆盖语义保留，AC-USREQ-006 ② 仍成立）：
`.py` 两处改 `ROOT = Path(__file__).resolve().parents[4]` / `parents[1]`；两个 `.sh` 改
`HERE=$(… dirname "$0" …)` + `ROOT="${QUOTAGENT_ROOT:-$(… "$HERE/../../.." …)}"`（脚本都在 `src/*/*/tools/` ⇒ 上溯 3 层）。

### 新增门断言 PA9（`verify.sh plugin-assets`）

- **正向**：`[ok] PA9 仓库内**没有硬编码的仓库根**（…扫 764 个文件：以 `quotagent` 为末段目录的绝对路径字面量 0 处；探针自证非空转）`。
  判据自带**探针**（运行期拼出违例串 ⇒ 必须命中，不许空转）、与"当前仓库在哪"无关 ⇒ **克隆到任何路径**都能抓到它。
- **反向（门内 F8）**：往副本 `tools/manual-check.py` 追加一行硬编码 checkout 路径 ⇒
  `[ok] F8 …必须让 PA9 变红（变异体红 1 项、新增红 1 项、命中指定断言=True；红项=['PA9']）`，且
  `[ok] F0 基线（未变异）在同一套判据上**不红**`。
- 读数：`RESULT: PASS（plugin-assets 门 18/18）`（**16→18**，只增不减），`RC=0`。
