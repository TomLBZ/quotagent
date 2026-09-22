# EV-174 迁移终批：25 个 `qa` 检查 + 阶段 5 第二小片（12 服务）+ 修 `storage` 遗留红

任务 `T-323`；**逐项清单/长表/原始 JSON**在 `EV-174-batch4-raw.json`（同目录）。
铁律：本批只有一个写批次、只 `git add` 本批改的文件、每个搬迁项**两半边**验证、提交后 `git status --porcelain` 为空。
对拍口径：**85 条已注册 AC** 逐条记「断言名 + ok」，搬前 / ①后 / ②后三份快照比对。

## 一、三件

### ① 剩 25 个 `qa/checks_*.py` → 各自插件 `tests/`（旧处 `importlib` 薄转发，导入面不变）

归属 = `plugin-file-map.md` §分类 C 节（25 行已由「待搬」改「已搬」，逐项表见该节）；**25 项都有既有归属插件
⇒ 不新建插件目录**（不造假功能）。改造 recipe 同上一批：`from ..X`→`from quotagent.X`、
`from .registry`→`from quotagent.qa.registry`、`from .checks_y`→`from quotagent.qa.checks_y`、
`parents[3]`→`parents[4]`（本批 4 个文件命中）。旧处逐项 725–773 B（含薄转发标记）；新位置实体
6.5–43.8 KB（逐项字节见 JSON `checks_moved.rows`）。

**对拍原始行**（`tmp/ac-compare.py`：断言名序列 + ok 序列 + 状态分类）：

```
AC 总数 before=85 after=85
names_same/ok_same 完全一致：85 条
有差异：0 条
before 非 pass：['AC-COMPARE-004']      after 非 pass：['AC-COMPARE-004']
```

`AC-COMPARE-004`（phase=P1，不在 `p0-no-node` 集合）**搬前即红**：其末条断言 grep
`docs/work/decisions.md` 的 `D-016`，而 `D-016` 已被更早的归档批次搬进 `decisions-archive-b.md`
（`grep -c D-016 docs/work/decisions.md` = 0）⇒ 与本批无关，**未夹带修**；搬前/搬后状态分类相同。

### ② 阶段 5 第二小片：12 个服务实体 → `src/<层>/<插件>/code/`（旧处薄重导）

**字节守恒逐个证明**（`git show HEAD:<旧>` blob sha256 vs 新位置 sha256）：

```
commitments 9da4dddb7673139d OK   capacity fd1c8ab99918553d OK   change d1742aded5d90a25 OK
clarify     38a8bca5ceacc86f OK   compare  40512e21c11a2e9a OK   costmodel 35f6b4de3fed0077 OK
deviation   1ed2a8b088f8706f OK   export   ffba514283aeb3f2 OK   guard 6ba3750c57c5ea8b OK
intake      aed00fbe323adac5 OK   norm     8d2420079f35272d OK   measures 028794d8674e419a OK
```

**「旧导入路径仍可用」实测行**（`tmp/old-import-proof.py`，`rc=0`，12/12 全绿）：

```
quotagent.services.<name> ×12：dunder=True（__name__ 仍是 quotagent.services.<name>）
  runs_entity=True（类里方法的 __code__.co_filename 全在 src/domain|system/<插件>/code/<name>.py）
  no_co_filename_on_old_path=True（一个都不在旧路径）
```

口径：薄重导在**本模块命名空间**里 `exec` 实体源码 ⇒ 相对导入一字不改（`from .approval import …` 仍解析到
`quotagent.services.approval` 的薄重导）。`inspect.getsourcefile()` 按定义返回**旧路径**（薄重导刻意不改
`__file__`），与 EV-173 内核片同口径；**"跑的是实体"用更硬的 `co_filename` 判**。

**只搬这 12 个的取舍**：`mail`/`mail_transport`/`admin_blocks`/`retention`/`retention_exec`/`faq`/
`negotiation` 仍有读方**按旧路径读源码**（逐条清单见 `plugin-file-map-batches.md` §本批与 JSON）⇒ 先搬会让
那些静态断言在 ~700–950 B 薄重导上**静默判绿** ⇒ 留待"读方一起改"的那批。
**顺带收紧 1 处**：`AC-RUNTIME-001` 扫描面加进实体目录（原只扫旧路径）：`检查 62 个文件（内核 18：实体 9 +
薄重导 9；服务实体 12 + 旧路径 31）；非空转（内核实体 ≥8 且服务实体 ≥8）`。

### ③ 修 `storage` 遗留红（事实区判据对 `user-space` 符号链接失效）

`user-space` 是**指向 `src/userspace/` 的兼容符号链接** ⇒ 事实区必须把词法（`<root>/user-space/…`）与真实
（`<root>/src/userspace/…`）两种形态都算。**改法（收紧而非放宽）**：新增 `_zone_forms()` + `_inside_zone()`，
把「zone 两形态 × 目标两形态」**交叉各判一次**（任一命中即命中 ⇒ 只可能多判成事实区）；`_root_path`/
`_target`/`snapshot` 的 4 处单形态比较全换掉，`snapshot --out` 另加「落点在 `user-space/` ⇒ 拒」。
门侧同批加固：第 8 条内嵌**反向自证** + 新增 `--mutate 5`。

**反向验证原始行（修前 = `git show HEAD:tools/storage.py` 落 tmp 真跑；修后 = 本工作树；同构造同 cwd）**：

```
[1] --root user-space/zz-t277-other list-files --ns acme      修前 rc=0 {"code":"","ok":true,"reason":"namespace-empty"} ← 未拒
[2] --root user-space/acme list-files --ns beta               修前 rc=0 {"code":"","ok":true,"reason":"namespace-empty"} ← 未拒
[3] 写形态：--root user-space/zz-t277-other open-append --ns acme --rel logs/x.log --text S
                                                              修前 rc=0 {"ok":true,"path":"…/user-space/zz-t277-other/acme/logs/x.log","bytes_written":2} ← 真写 2 B 进事实区
三条**修后**一律：rc=1 {"code":"storage-fact-path","reason":"root-in-user-space-other-ns","ok":false,
                "next_action":"事实只进账本（Python 内核独占写入）：把目标改到非事实区…"}
（逐条原始 stdout 见 JSON `storage_fix.fixed_runs`；[1][2] 就是门第 8 条的 f5/f6）
```

越权写入的清理（如实登记）：修前那次写落在 `src/userspace/zz-t277-other/acme/logs/x.log`（2 B，sha256
`7aa397df66304bab…`），**已整目录删除**；复核 `ls src/userspace/` = `README.txt con-a demo-ns` +
`git status --porcelain src/userspace` = 空 + JSON `leak_dir_exists_now=false`（之后每次跑"修前写形态"都即跑即删）。

**反向断言必红（`--mutate 5`：改产品实体 → 子进程跑门 → 还原）**：

```
{"ok":true,"mutation":5,"anchor_hits":1,"child_exit":1,"child_passed":18,"child_total":19,
 "first_fail":"8 拒写事实三类：…","loader_saw_mutated_file":true,"restored_bytes_identical":true,
 "sha256":{"pristine":"5472b5b0fc1829fc…","mutated":"87f29b238a7f5d29…","restored":"5472b5b0fc1829fc…"}}
```

既有 4 处变异复跑仍全红（首个 FAIL = 第 4/5/6/7 条；均 `child_exit=1`、`18/19`、还原逐字节一致）。
**门前后对比**：`{"passed":18,"total":19,"failures":1}` → `{"passed":19,"total":19,"failures":0}`
（七种构造码 `["storage-fact-path"×7]`）。

## 二、两半边验证汇总（TOTAL / PASS / FAIL）

- **旧半边**：25 checks 旧位置只剩薄转发（标记 + ≤1200 B + ≤20 行 + 指向新位置）**25/25**；
  12 服务旧位置是薄重导（`exec` 实体、无实现）**12/12**；`host/*-gate.mjs` 实体 0 / 薄转发 20（本批未动）**20/20**。
- **新半边**：`git cat-file -e HEAD:<新路径>`（25 checks + 12 services）**37/37**；服务字节守恒 == HEAD blob
  **12/12**；旧导入路径可用且 `co_filename` 指向实体 **12/12**。
- **门**：`plugin-assets` PA1/PA2（74 项：目标存在 + 旧位置只剩薄转发 + ≤ 目标 1/4）**74/74**。
- **FAIL = 0**（上述四类），唯一非零项是文档门对尚未落盘 ID 的引用约束（见 §三）。

## 三、门 passed/total（提交前，全带 `env -u QUOTAGENT_PLUGIN_CONTROL_TOKEN`）

```
docs FAIL(1 项：未解析的 ID 引用 EV-174/T-323 —— 当时证据与清单行还没落盘)
coverage 8/8 · ac-registry 通过 · plugins 5/5 · webui 51/51 · modules 521/521 · wiring 5/5 ·
invariants 22/22 · events 一致 · storage 19/19 · plugin-assets 14/14 ·
plugin-requirements 18/18 · plugin-lifecycle 66/66 · run-once 34/34
p0-no-node FAIL(同上：内嵌的文档门 AC 因 EV-174/T-323 未解析而红)
```

> 两道 FAIL 是文档门对 ID 引用的正常约束（被引用定义尚未落盘）；最终 rc 与提交后事实见 §四。

## 四、提交后（原文）

```
git status --porcelain → （空输出）
tools/verify.sh run-clone → PASS（在 HEAD 的 git archive 干净副本上）
docs / p0-no-node → rc=0（§三 两道 FAIL 落盘后转绿）
commit → <SHA7>
```
