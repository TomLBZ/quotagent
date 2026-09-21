# ADR-0017 canary 分流与自动回滚的方向性

- 状态：accepted（2026-09-21）
- 依据：`ADR-0016 §3` 留的余项（"canary 的真实路由与自动晋升/自动回滚阈值"）；用户 2026-09-21 指令"用自进化的方式制作插件…使每一个功能模块都可分别独立演进"。
- 关联任务：`T-229`；机检 `tools/verify.sh canary`（11 条断言）+ `tools/verify.sh evolution`（31 条，含 canary 全链）；证据 `docs/work/evidence/EV-064-*.txt`。

## 1. 决定：**扩大上线面要人批准，缩小上线面不用**

| 动作 | 影响 | 是否要人工 `approval_ref` |
|---|---|---|
| 进入 canary（产物开始吃真实流量） | 扩大暴露面 | **要**（与晋升同一门槛） |
| 退出 canary / 回滚（产物停止吃流量） | 缩小暴露面 | **不要**（安全动作，越自动越好） |
| 从 canary 升为全量 | 扩大暴露面 | **要**（`approval_required=true`，`automatic=false`） |

理由：自动化系统的危险性来自"自己给自己扩权"。把**授权**与**安全**分开——机器可以自动踩刹车，不能自动踩油门。

## 2. 分流与判定的具体口径

- **分流**：`bucket({realm, key})` 用 `sha256("<realm>:<key>")` 前 8 位十六进制对 10000 取模，落 `canary` 当且仅当 `< weight_bps`。同键永远同道（可复现、可解释、无墙钟无随机）。
- **realm 白名单**：`realms` 非空时，名单外的 realm **永远** base（不得越界分流）。
- **边界**：`weight_bps = 0` → 全 base；`= 10000` → 全 canary（精确边界，不是"差不多"）。
- **判定**（三条 AND，任一条退化即建议回滚）：错误率高出 base 超过 `error_rate_bps_up`；延迟 p95 高出超过 `latency_p95_up_bps`；成本均值高出超过 `cost_up_bps`。
- **样本不足不下结论**：任一侧样本 < `min_samples` → `insufficient`（薄证据不得触发回滚）。
- **不得把 base 的问题算到 canary 头上**：只有 base 退化时 recommendation 不是 rollback。

## 3. 与其它 ADR 的关系

- `ADR-0016`：产物可写面（只有 `host/modules/`）与晋升门槛不变；本 ADR 只补"晋升之后"的一段。
- `ADR-0002` / `INV-010`：canary 只影响**流量分流与产物启停**，不改内核、不写账本；账本写入仍在 Python 侧（canary 事件由 `tools/evolve-record.py` append）。
- 人工门（`P8`）：canary 的"进/升"复用同一个人工门概念（`approval_ref` 形如 `ap-NNNN`）。

## 4. 后果与已知限制

- 进树模块 `host/modules/canary.mjs` 提供 `bucket/enterCanary/exitCanary/record/stats/verdict/decide`；`decide()` 直接给出 `{action, automatic, approval_required}`，调用方不需要自己解释方向性。
- 事件 `evolve/canary-entered` / `evolve/canary-exited` 已两侧登记（`kernel/events.py` 与 `docs/design/05-events.md`），由 `tools/verify.sh events` 双向机检。
- **已知限制**：真实网络分流（HTTP/消息层）尚未接线——本 ADR 固定的是**路由与判定语义**；把它接到真实入口属后续任务（宿主视图/中间件批次）。
