# 20 P2 新服务的运维快照契约（谈判 / FAQ / 邮件）

- 目的：`FR-NEGO-*`、`FR-CLARIFY-004`、`FR-INTEG-003` 落地后，**运维侧看不到它们**。
  本契约让三者在**现有 dashboard 的运维道**可见（`/quotagent/ops/` 与 `/quotagent/api/pipeline`）。
- 阶段：P2 · 依据：ADR-0012（判定在事实层，宿主只展示）、D-035（新增依赖四处同步）、
  D-040（门里必须喂真数据）、D-052（**没有发信能力就说没有**）
- 实现：Python 侧 `tools/refresh-ui-snapshots.py`（写 `tmp/ui-shared/pipeline.json`）；
  宿主侧新插件 `pipeline-view`（只读聚合）+ webui 路由

## 1. 分工（不允许越界）

· **Python 侧**（`tools/refresh-ui-snapshots.py`）：从三个服务的账本行**重建**计数与最近事件，
  写 `tmp/ui-shared/pipeline.json`。**只读账本、不写账本**；判定逻辑不在这里新写（复用服务的 `replay()`）。
· **宿主侧**（`pipeline-view` 插件）：吃该 JSON，做**有界的只读聚合**与一行人读摘要。
  **不自己判定**（不许从计数里"推算"额度、不许补默认值）。

## 2. 快照文件形状（键名即契约）

```json
{
  "generated_at": "<ISO8601>",
  "views": {
    "contractor": {
      "negotiate": {"threads": 3, "open": 1, "closed": 2, "rounds": 4, "rejected": 2,
                     "last": {"thread_id": "nt-0001", "kind": "round", "attempt_no": 2}},
      "faq":       {"entries": 2, "revs": [2], "last": {"entry_id": "fq-0001", "rfq_rev": 2}},
      "mail":      {"queued": 1, "refused": 1,
                     "transport": {"available": false, "reason": "mail-transport-unavailable",
                                    "next_action": "配置 SMTP/IMAP 凭据后接入"}}
    },
    "supplier": { … 同形状 … }
  }
}
```

**禁止**：任何正文/主旨/附件内容、任何私域键（`reserve_price`/`cost_model`/`signature`/`private:`）、
任何绝对时刻（除 `generated_at` 这个"这份快照是什么时候生成的"元数据）。

## 3. `pipeline-view` 插件契约

```js
export const name = 'pipeline-view'
export const provides = ['pipelineView']
export const inject = []
export const Config = /* {max_views:int=4, max_recent:int=3, max_bytes:int=512} */
export const apply = (ctx, config) => { /* ctx.provide('pipelineView', api) */ }
// api = {
//   snapshot(payload) -> {
//     views: [{view, negotiate:{threads,open,closed,rounds,rejected}, faq:{entries,revs},
//               mail:{queued,refused,transport_available,transport_reason}}],   // 至多 max_views 个视角
//     totals: {threads, rounds, rejected, entries, queued, refused},
//     transport: {available, reason, next_action},     // 三档一致才 available=true，否则 false + 原因
//     degraded: bool, omitted_views: int, source: 'pipeline-view'
//   },
//   headline(payload) -> string    // 一行摘要，受 max_bytes 限制
// }
```

硬约束：**只组合不自算**（数字直接来自快照）、降级优先（形状不对 → `degraded: true` + 全零，**不给看起来健康的零**）、
确定性（不读墙钟/不随机）、有界（视角数与摘要长度）、零 I/O、零事件、不出正文与私域键。

## 4. 机检

· `AC-PIPELINE-001`（宿主插件围栏门 + 路由端到端）：
  ① 门：契约正控/挂载与 dispose/手算一致/**只组合不自算**（故意让计数与明细不一致，断言不重算）/
  降级（`null`/`{}`/类型错 → `degraded:true` 且全零）/有界（视角夹取 + 摘要字节数）/确定性（两次字节一致）/
  静态零 I/O 与无墙钟/私域与正文一律不出现；附 ≥3 处单点变异自证。
  ② 端到端（`verify.sh pipeline-route`）：真跑刷新脚本 → 启动 webui → `GET /api/pipeline` 200 且
  **含三个域**、`transport.available === false`（本轮没有发信能力，只能这么报）、无 `"body"`/`private:`。
· `AC-UI-002`（Python 侧快照写入器）：文件形状合规、两视角都在、无私域/正文、只读账本（不新增行）、
  同一输入两次写出内容除 `generated_at` 外一致。

## 5. 被否决的选项

· **宿主直连内核桥拿数据**：现有 UI 一律"Python 写文件、宿主只读"（webui 不持有 supervisor），
  为一屏数据引入进程级依赖不划算 → 否决。
· **改 `ops-view` 插件把三域塞进去**：它是**已晋升产物**（哈希受追溯门约束），改它会破坏追溯链 → 否决，改用新插件。
· **快照里带"最近一条正文字段"**：运维看板不需要，且容易把私域带出来 → 否决（只给 id/序号/计数）。

### 口径（T-263 定，别把两个口径混着读）

同一域里有**两个来源**，它们**刻意不同**：

- `counts`（如 `negotiate.threads/rounds/rejected`）：走**服务回放** —— 只统计被服务跟踪的对象（权威口径）。
- `recent`：走**账本原始行**（`negotiate/round`、`faq/entry-published`）—— 回答"最近发生了什么"。

因此 `rounds = 1` 与 `recent` 有 5 条**可以同时成立**（两个口径来自两个来源，见上）。
**读法**：计数看趋势与规模，列表看最近动态；**不要**用列表长度去推计数，也不要用计数去否定列表。
