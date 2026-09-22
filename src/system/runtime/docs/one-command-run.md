# 一键运行契约（`./run`）—— 用法与判据

规范原文：`docs/design/28-plugin-requirements-and-run.md` §3.1（QUOTAGENT-ONE-COMMAND v1，逐字）；
实现：仓库根 `./run`（POSIX sh，薄入口）；门：`tools/verify.sh run-once`。

## 1. 从裸机克隆到服务可访问

```bash
git clone <repo-url> quotagent && cd quotagent && ./run up
```

## 2. 动词（本批起：契约的六个 + 一个附加）

| 动词 | 语义 | 判据 |
|---|---|---|
| `./run up` | 幂等启动：解析解释器 → 准备仓库内 `.venv`（缺失才建）→ 装宿主依赖（缺失才装）→ 起服务 → 健康检查 → 打印 URL 与端口 | 退出码 0 + 健康 200；重复执行 `state=already-up`（**不重建、不覆盖数据**） |
| `./run down` | 停服务并回收**本次启动的**进程（不删数据） | 退出码 0 + 端口真释放；重复执行 `state=not-managed`（幂等） |
| `./run status` | 一行 JSON：`{ok, service, pid, port, url, healthy, ready_ms, managed, degraded[]}` | 健康时退出码 0；`ready_ms` 是**启动时量到的常值**（所以两次 status 逐字节一致） |
| `./run logs [--lines N]` | 最近日志的**路径** + **有界**尾部（缺省 40 行、上限 200 行）；摘要一行 JSON 收尾 | 有日志：退出码 0 + `tail_lines` 与 `max_lines=200`；**没有日志文件时如实失败**（`code=log-missing` + `next_action`，非 0） |
| `./run config init [--config-file P]` | 生成 `config.yaml`（**只含白名单键** = `host/lib/config-keys.mjs` 的 `PROJECT_KEYS` + `plugins:{}`/`credentials:{}` 两个空段；0600；原子写） | 生成：退出码 0 + 逐键默认值 + **指纹前 8 位** + 每键一行 next_action；**已有真配置文件 ⇒ 拒**（`code=config-exists`，一个字节都不动）；**不写账本**（改已有值走 `tools/config-apply.py` 的人工门） |
| `./run doctor` | 只读体检 7 项，逐条 `next_action` | 退出码 0 = 这机器能跑；非 0 = 不能跑（至少一项阻塞） |
| `./run plugin <动词> <插件>` | **运行期装卸**：转发给 `tools/plugin.sh <动词> <插件> --live`，装进**正在服务的那个进程**（`load/reload/unload/status/list/deps`） | 见 `src/system/runtime/docs/lifecycle-contract.md` §5（四道围栅、逐条 `code`+`next_action`、页面区块真出现/真消失） |

旗标：`--port N`（默认 8093）· `--host H`（默认 127.0.0.1）· `--prefix P`（默认 `/quotagent`）·
`--data-dir DIR`（运行期数据根，默认 `tmp/run-shared`；pid/日志落 `tmp/run/`）· `--no-seed`（跳过演示种子）·
`--lines N`（`logs` 的尾部行数，上限 200）· `--config-file P`（`config init` 的目标路径）。

**诚实标注**：契约 §3.1 的动词列表是 `up|down|status|logs|doctor|config init`；`plugin` 是**契约之外的附加
动词**（运行期装卸的用户可见入口），它不改变上面六个动词的语义与判据。契约文本里写的健康路径是
`GET /healthz`，实现与全部门用的是 `<prefix>/api/health`（本批未改这一处偏差，已登记为待收口项）。

## 3. `doctor` 的 7 项（每项都有 `next_action`）

| # | 项 | 阻塞？ | 缺失时 |
|---|---|---|---|
| 1 | interpreter（解释器解析 + 版本，走 `tools/runtime.sh` 的顺序） | 是 | `interpreter-missing`：设 `QUOTAGENT_PY` 或 `tools/bootstrap.sh` |
| 2 | node（路径 + 版本） | 是 | `node-missing`：装 Node 或 `source /workspace/bin/activate.sh` |
| 3 | cordis（`host/node_modules/cordis/package.json` 的版本） | 是 | `tools/cordis.sh install` |
| 4 | port（占用者是谁：本服务 / 别的进程 / 空闲） | 是（被别的进程占） | `./run up --port <另一个端口>` |
| 5 | config（路径 + **指纹前 8 位**，永不回显内容） | 否 | 生成 `config.yaml`（只含白名单键） |
| 6 | credentials（管理员 token 的来源与权限：env / 0600 文件 / 缺失；邮件与模型凭据命中键） | **否** | 放 0600 token 文件 / 补 SMTP-IMAP 键 |
| 7 | gates（`tools/verify.sh` 可执行 + 解释器可解析） | 是 | `chmod +x tools/verify.sh` |

## 4. 外部凭据缺失**不得**阻塞 `up`（契约 §3.1【外部凭据】）

- `up` 不看凭据：缺 SMTP/IMAP 与模型 key 时服务照常起、健康检查照常 200；
- 受影响的插件在 `status` 的 `degraded[]` 里报 `available:false` + **有名 reason** + `next_action`
  （例：`{"plugin":"system/admin","available":false,"reason":"admin-token-absent","next_action":"…"}`）；
- 凭据只存**指针与指纹**：`doctor`/`status` 输出里永不出现值；`./run` 也**不代写** `config.yaml`
  （写入者是 `tools/config-apply.py`，见 ADR-0015 与 `docs/design/21-admin-console-contract.md`）。

## 5. 门怎么验它（`tools/verify.sh run-once`）

真跑：起服务（隔离端口 + 隔离数据根）→ 真 GET `/api/health` 200 → `up` 第二次幂等（pid 不变、
两次 `status` **逐字节一致**）→ `down` 后**端口真释放**（连接被拒）→ 再 `down` 幂等 →
`doctor` 退出码 0 且 7 项齐全 → **凭据缺失下 `up` 仍成功**（临时空配置 + 无 token）且 `status` 报
`available:false` + reason → 占用端口的**外来进程**必须让 `doctor` 非 0（负控）→
`run` 脚本的 **4 处单点变异全红**且产品树字节不变。
