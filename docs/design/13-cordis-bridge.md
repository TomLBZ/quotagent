# 13 桥接：宿主 ↔ Python 内核（NDJSON/stdio v1）

> 决策记录：ADR-0012（宿主直接依赖 cordis）· ADR-0013（桥接协议，本文件是它的**实现级展开**）·
> ADR-0015（宿主 profile 与配置否决）。实现：`src/quotagent/bridge.py`（内核侧）、
> `host/lib/bridge.mjs` + `host/cli.mjs bridge`（宿主侧）。机检：`tools/verify.sh bridge`。

## 1 为什么是进程外，而不是进程内

**cordis 管组合，Python 管事实**（ADR-0012）：账本唯一写者、身份注入、人工门前置这三条不变量
在"宿主能不能自己签名/自己写账本"的问题上只有两种答案。进程内嵌（把 Python 装进 Node 进程）会
让宿主拿到 `commit` 面的可能，直接破坏 INV-005；HTTP/端口式桥引入网络面与鉴权/CSRF 面，P1 无收益
（否决理由见 ADR-0013）。因此：**内核是常驻子进程，协议走 stdio**。

## 2 帧

一行一个 JSON 对象（NDJSON、UTF-8、无缩进、无内嵌换行），**单帧上限 8 MiB**（超限即
`invalid-request` 并断开；分片留待后续 ADR）。统一信封：

```
{"v":1,"n":"<帧名>","p":{...}}
```

| 方向 | 帧名 | 载荷要点 |
|---|---|---|
| 内核→宿主 | `kernel/hello` | `bridge{version,min_supported}`、`kernel{version,profile,operator}`、`qep_versions[]`、`features[]`、`events[]{name,mode,durable}`、`methods[]{m,cls}`、`methods_refused[]`、`ledger{path,head,seq,healthy}`、`realms[]`、`max_frame_bytes`、`credit_window` |
| 宿主→内核 | `bridge.init` | `accept_bridge[]`、`profile`、`want_events[]`、`want_methods[]` |
| 内核→宿主 | `bridge.ready` | `surfaces_open[]`、`ledger_seq`、`degraded`、`non_degradable[]` |
| 宿主→内核 | `method` | `{id,m,params}`——一次方法调用 |
| 内核→宿主 | `result` | `{id,ok:true,m,result,operator}`（`operator` 是**内核注入**的权威身份） |
| 内核→宿主 | `error` | `{id,code,message,next_action,data}` |
| 双向 | `bridge.credit` / `bridge.credit-ack` | 信用窗口（默认 256） |
| 双向 | `bridge.shutdown` / `bridge.bye` | 关闭（不留孤儿） |

**stdout 只承载协议帧**：内核进入桥模式后日志一律走 stderr（本文件第 7 节把这条写成断言）。

## 3 握手与版本协商（不兼容即拒绝）

1. 内核启动后**首帧**推 `kernel/hello`——能力清单的**唯一真源在 Python 侧**
   （事件表来自 `kernel/events.py` 的声明表，与 `05-events.md` §2 对齐）。
2. 宿主回 `bridge.init{accept_bridge}`。
3. **`accept_bridge` 与内核 `bridge.version` 无交集 → 内核写一帧 `version-mismatch` 错误后退
   **退出码 2**，且**账本零新增**（与 ADR-0006 §3 同构：不静默降级）。
4. 兼容但 `want_events` 里有内核未声明的事件 → 落 `kernel/bridge-degraded`（含缺失项）后继续通信；
   `approval-chain` / `version-binding` / `signature-verification` 三项**不可降级**。

## 4 方法面：四级，`commit` 永不暴露

| cls | 含义 | P1 是否开放 |
|---|---|---|
| `read` | 账本读取与投影（`ledger.head/count/read/healthy`、`events.declared`） | ✅ |
| `compute` | 纯计算（`measures.convert/factor` 等，逐步挂到 `norm`/`compare`/`guard`/`tco`） | ✅ |
| `fact` | 追加**已登记**的 fact 事件（`qep.receive`/`qep.send`） | ❌ 默认关闭（`intents_only`，ADR-0013 §3） |
| `commit` | 承诺与人工签署（`approval.decide`/`quote.submit`/`award.commit`/`po.issue`/`change.approve`） | ❌ **永不暴露** |

- `commit` 面登记在 `methods_refused[]` 里（**声明但拒绝**），调用即 `commit-refused` 并落
  `kernel/bridge-rejected`；`next_action` 指"人工签署只走交互式 Python CLI"。
- `fact` 面同样落 `methods_refused[]`；被调用时错误码复用 `commit-refused`（错误码表是固定的，ADR-0013 §4），
  **由 `next_action` 与 `data.cls` 区分**：`fact` → "P1 默认关闭，放宽需另写 ADR"；`commit` → "只走交互式 CLI"。
  这条口径记入 `docs/work/decisions.md`。
- **身份永不自我声明**：宿主在 `params.source`/`params.operator` 里声称的身份只作为 `claimed_source`
  记录；权威身份由内核从启动参数注入（`operator = bridge:<profile>`）。声称 `human:*` 一律拒绝并留痕。

## 5 错误码（固定表 + 必须带 next_action）

| code | 触发 |
|---|---|
| `invalid-request` | 帧非法/超 8 MiB/未知帧名/帧版本不是 1/参数缺失·类型错/**自我声明身份** |
| `unknown-method` | 方法未登记（响应带 `data.exposed[]` 便于自查） |
| `commit-refused` | 承诺面调用；或 `fact` 面未开放 |
| `version-mismatch` | `accept_bridge` 与内核无交集（随后退出码 2） |
| `ledger-unhealthy` | 账本拒绝新增（校验失败/冻结；ADR-0007 §6 的停发语义） |
| `deadline-exceeded` | 宿主侧超时（宿主判定，内核不猜） |
| `backpressure` | 信用窗口耗尽 |
| `kernel-crashed` | 内核未预期异常（也会转成确定性帧，不留半句） |

每个码都带 `next_action`（可行动的下一步），不允许"只说失败"。

## 6 生命周期与背压

- 启动失败**不写账本**、退出码 3；关闭顺序 `bridge.shutdown → SIGTERM → SIGKILL`，不留孤儿。
- 崩溃重启预算 3 次/30s，超预算降只读（拒 `fact`/`commit`，保 `read`/`compute`）；重启后锚点
  （`head/seq`）不一致时先要求 `verify_chain`，失败即只读。
- **在途请求一律记 unknown（不得当成功）**；重发靠 `(correlation_id,type,body_hash)` 去重幂等（ADR-0013 §6）。
- 背压：`hello.credit_window`（默认 256）；durable 通知不可丢（已在账本，退化为"待补齐"），
  live 通知可丢但必须落 `kernel/bridge-backpressure`（含丢弃计数与时间窗）；
  同一连接上**响应优先于通知**（避免事件洪水拖垮一次 `compare.rank`）。

## 7 机检（本批已落地的部分）

`tools/verify.sh bridge` → `qa ac AC-INTEG-004 && qa ac AC-INTEG-005`：

- **AC-INTEG-004**（协议与版本协商，12 断言）：hello 字段齐全；`events[]` 与 Python 声明表一致（含五个
  `kernel/bridge-*` 事件）；只暴露 `read`/`compute`；版本不兼容 → 退出码 2 + 账本 0 字节；
  特性级降级留痕且通信继续；未知方法/非法帧/帧版本错/超限帧都是确定性错误码 + `next_action`；
  stdout 只有协议帧；直跑与经桥 `compute` 结果一致；宿主（cordis）按同一协议握手成功。
- **AC-INTEG-005**（承诺面不可达，对抗性，6 断言）：宿主调 `approval.decide` → `commit-refused` +
  留痕；宿主播报 `human:*` → 拒绝 + 留痕（`claimed_source` 与注入身份分别记录）；
  `fact` 面默认关闭；承诺面关闭不影响 `read`/`compute`。

**故障语义（T-217 已落地，AC-INTEG-006，13 断言）**——宿主侧监督者 `host/lib/supervisor.mjs`
把 ADR-0013 §6 的策略实现出来，内核侧提供锚点/fault/背压/只读：

| 场景 | 断言要点 |
|---|---|
| SIGKILL → 重启 | 哈希链仍真（`verify_report.ok`）；重启前已落账的 durable 条目在重启后**一条不少**；落 `kernel/bridge-restarted`（含重启次数与锚点） |
| 在途请求 | 崩溃时未回帧的请求一律记 **unknown**（`kernel-exited-before-reply`），**不得当成功** |
| 重启预算 | 3 次/30s 内允许；第 4 次起降**只读**（`fact`/`commit` 皆拒且理由标 `read_only`，`read`/`compute` 保留） |
| 背压 | 窗口耗尽时 live 通知丢弃但落 `kernel/bridge-backpressure`（含丢弃计数与**时间窗**）；durable 不丢**数据**，用 `ledger.read{from_seq}` 补齐 |
| 锚点不一致 | 账本落后/历史被替换/锚点不在链中/链校验失败 → `kernel/bridge-fault` + 只读；**账本超前不算 fault**（宿主只是没看到尾巴） |
| 关闭 / 启动 | shutdown → SIGTERM → SIGKILL 且断言**无孤儿**；启动失败退出码 3 且账本零新增 |

**P0 的可复跑性**：`tools/verify.sh p0-no-node` 把 Node 藏起来跑非 P1 阶段的 **34 条 AC**（集合异常即报错，
不给假绿灯）；`AC-RUNTIME-001` 另加静态断言——P0 内核与服务**不得引用** Node/cordis（宿主机能力属 P1 的桥接 AC）。

**仍未落地（后续批次）**：`deadline-exceeded` 的宿主侧判定与超时后的请求处置、事件表"文档↔Python"启动自检、
单帧分片（>8 MiB 包）。不要把"故障语义已证"当成"性能与分片已解决"。

## 8 与 QEP/投递的关系

QEP 报文（`03` §2）与文件投递（`kernel/delivery.py` 的原子写 + `<seq:06d>-<msg_id>.qep.json` 约定）
是**跨参与者**的载体；桥是**同一参与者内**宿主与内核的载体。两者共用同一套 durable/live 与
去重键语义，但**不要混用**：QEP 报文经桥传输时仍是 `fact` 面能力（P1 关闭），
因此 P1 的 QEP 收发仍由 Python 侧承担，宿主只能读投影。
