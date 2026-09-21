# 模型 “Jev” 调研报告：强项、使用方式、对 quotagent 的适用性

- 调研日期：2026-09-21（UTC）。对象：TypeSafe AI 的 `Jev`（System One 模型）。
- 方法：先由独立 subagent 做首轮检索（原始检索记录见提交信息与 `EV-060`），**再由本 agent 用一手页面逐条复核**：凡本文“一手核实”栏内的事实，均由本 agent 直接抓取下列页面确认，不是转述。
- 结论类型：**模型确实存在**；对本项目而言它是**决策判定层**（不是文本生成模型），适配点在“建议”而非“决策”。

## 1. 结论

Jev 是 TypeSafe AI 发布的 “System One” 评估模型：输入一个 `state` 与若干**类型化问题**，返回**类型化答案 + 校准置信度**（`noul`/`boolean`、`choice`、`score`），**不生成文本**（Vercel 页面标 `maximum output tokens: 0`）。

对 quotagent 的定位：**适合做“建议层”，不适合做“判定层”**——凡是本项目已有确定性判定者（比价、账本、评审门、演化门），Jev 只能作为**输入**（如分流、打标、分级建议），其输出不得成为事实来源。

## 2. 一手核实（本 agent 亲自抓取）

| 事实 | 值 | 来源（一手） |
|---|---|---|
| 模型 id（Cloudflare Workers AI） | `typesafe/jev` | `developers.cloudflare.com/ai/models/typesafe/jev/` |
| 模型 id（Vercel AI Gateway） | `typesafe-ai/jev` | `vercel.com/ai-gateway/models/jev` |
| 输入形状 | `{ state, questions }`，每题带 `type` + `instructions` + `criteria` | 同上（两处示例一致） |
| 输出形状 | `{ model, answers: { <问题>: { type, choice/score/noul, confidence, probabilities, legend } } }` | Cloudflare 页面示例（示例回包 `model: "jev-1.13.0"`） |
| 问题类型 | `noul`（布尔概率）、`choice`（多选一 + 概率分布）、`score`（有序打分 + legend） | Cloudflare 页面 |
| 统一端点 | `POST /v1/systemone`（`model` 字段选模型；另有 `GET /v1/models` 列出账号可用名） | `docs.typesafe.ai/models`（一手，本 agent 抓取） |
| token 预算（**修正**） | **64k** 覆盖 `state` ＋ 全部问题；**32k** 覆盖 `state` ＋ **最长的那一道题** —— 不是笼统的「32k 上下文」 | `docs.typesafe.ai/models` |
| 速率限制 | 250,000 tokens/s、1,200 req/min（厂商公布） | `docs.typesafe.ai/models` |
| 输入模态 | **仅文本**（字符串 / JSON 对象 / 文本数组），无图像、音频、视频 | `docs.typesafe.ai/models` |
| 定制方式 | 不用客户数据做微调/LoRA，同一套权重服务全部账号；领域适配靠请求里的 `state` 与每题的 `instructions`/`criteria` | `docs.typesafe.ai/models` |
| 输出长度 | 0（不生成文本） | Vercel 页面 |
| 定价（输入） | $0.042 / 1M input tokens；输出免费 | Vercel 页面 |
| 一次请求可并行多题 | 是 | Vercel 页面描述 |

两处网关对布尔类型命名不一致：Cloudflare 示例用 `type: "noul"`，Vercel 示例用 `type: "boolean"`。**接入时以各自网关文档为准**（本文不做统一）。

厂商宣称（非一手核实的独立结论）：最高 200× 更快、400× 更低成本（`[二手]`，来自媒体报道与厂商公告，未独立复现）。

厂商**自己公布**的失败模式（`docs.typesafe.ai/model-jaggedness/jev-1.13`，本 agent 已抓取，属一手）：不要用 `score` 输出反算精确数值（其数值校准弱，只能拿期望值判阈值）；数值换算放到代码里做；答案空间有界时把抽取改成对候选集的 `choice`，而不是问它要具体值；要生成文本就用别的模型。这三条恰好正面支持本报告的定位：**判定/建议可以交给它，精确数值与文本必须留在内核侧**。

## 3. 强项 / 使用方式 / 局限

强项（本项目视角可用的三条）：

1. **类型化输出**：返回值天然是 `choice` / `score` / 布尔概率，无需解析自由文本，也不用正则从散文里抠字段。
2. **校准置信度**：`confidence` 与 `probabilities` 可直接用于“置信度低就转人工”的策略，与本项目的人工门（`AC-APPROVE-003`）天然契合。
3. **单次判定成本极低**：$0.042/1M 输入 token、输出免费，适合放进 agent 循环里当**廉价路由器**。

使用方式（两条一手示例，缩略）：

```jsonc
// Cloudflare Workers AI：POST https://api.cloudflare.com/client/v4/accounts/<id>/ai/run
{ "model": "typesafe/jev",
  "input": { "state": "Help! My payouts have been failing for 3 days.",
             "questions": {
               "is_urgent": { "type": "noul", "instructions": "Does this convey urgency?",
                              "criteria": { "true": "Explicitly time-sensitive", "false": "No urgency expressed" } },
               "department": { "type": "choice", "instructions": "Which team should handle this?",
                               "criteria": { "billing": "…", "technical": "…", "sales": "…" } },
               "frustration": { "type": "score", "instructions": "How frustrated?",
                                "criteria": ["Calm", "Frustrated", "Very angry"] } } } }
```
```ts
// Vercel AI Gateway（ai SDK）
const result = await evaluate({ model: 'typesafe-ai/jev', state: '…',
  questions: { refunded: { type: 'boolean', instructions: 'Was a refund issued?' } } })
```

局限（有源或有明确边界）：

| 局限 | 影响 |
|---|---|
| 不生成文本、不解释理由 | 不能当“写建议”的模型；只能给判定与置信度 |
| 无算术/日期/多步规划能力（不在其设计范围内） | 金额、期限、成本核算仍必须在 Python 内核里算 |
| 32k `state` 上限 | 整包 RFQ + 历史上下文可能超限，需要摘要（摘要属新的事实来源，须留痕） |
| 闭源、无自托管、无权重 | 供应链上多一个外部依赖，须有降级路径 |
| 英文最优（中文质量未核实） | 本项目文档与条款以中文为主，须先实测 |

## 4. 对本项目（quotagent）的适用性判定

| 候选用途 | 判定 | 理由 |
|---|---|---|
| 澄清工单分流（`choice`：价格/交期/条款/质量） | **适合** | 单次判定 + 类型化；结果可作 `clarification/*` 事件的**建议字段**，人工门仍在前 |
| 报价异常打标（`noul` + `score`） | **适合** | 与 `guard` 的确定性阈值**并行**：护栏仍按数值判定，Jev 只提供“可疑”提示与理由来源 |
| 偏离度分级（`score`） | **适合** | 分级只是标签，不改账本数值 |
| 供应商/包路由建议（`choice`） | **适合** | 建议写进账本，授标仍由人工门决定 |
| 票据/字段核对（`boolean`） | **适合（需人复核）** | 可作为预筛，**不得**作为“已核对”的证据 |
| 演化门（`evolve/*` 的门判定） | **不适合（禁止）** | 门必须由确定性指标判定；本仓已有负控“指标来源=模型自评 → 红”（`host/lib/evolution.mjs`、`verify.sh evolution`） |
| 账本写入 / 事实生成 | **禁止** | 账本唯一写入者是 Python 内核（`INV-010` 面与 `ADR-0007`），模型不得写事实 |
| 替代人工门（`P8`） | **禁止** | 人工门前置是既有设计；高置信度也不构成批准 |
| 算术/期限/成本核算 | **禁止** | 内核确定性计算，`ADR-0011` 已定 |

接入若要做，必须同时满足三条纪律：**模型可见 ⟺ 账本可见**（模型 id/版本、`state` 摘要哈希、题目、答案、置信度全进账本）、**建议不等于决定**（只写 `advisory/*` 类事件）、**有降级路径**（外部不可达时主流程照常，建议字段留空并显式标注）。

## 5. 建议的插件形态与下一步

若未来开发（用户 2026-09-21 明示“如果适合，可以未来开发相应插件”），建议形态：

- 一个 cordis 插件 `advisor`（`host/modules/advisor.mjs`：开关、超时、降级、路由前缀），配一个 Python 侧服务 `services/advisory.py`（零第三方依赖，`urllib` 直调 HTTP），只做两件事：构造 `state`+`questions`、把答案与置信度写成 `advisory/*` 事件。
- 人工门策略：`confidence < 阈值` → 直接进人工门并标注“低置信”；`Jev 不可达` → `advisory/unavailable` 事件 + 主流程继续。
- 验收要点（未来任务 `T-224`）：建议不改变任何既有判定（同输入下有/无建议的账本事实条目逐字段一致）、置信度阈值以下必转人工、外部失败不影响主流程、账本留痕完整。

低成本验证顺序（建议）：① 用真实中文澄清工单做一次 `choice` 分流，测中文质量与延迟；② 用一份完整 RFQ 包测 32k 上限是否够用；③ 只在这两项通过后才做插件。

## 6. 未核实清单（不得当作结论）

- 中文（CJK）语义判定的质量与稳定性 —— **未实测**。
- 延迟数字：厂商与媒体称“亚秒级 / 最高 200× 更快”，但公开页面上另有一处写作 “3 to 329”（疑为毫秒笔误） —— **两个来源不一致，未实测**。
- 参数规模、内部架构、训练数据 —— 厂商未公布。
- 许可与商用条款原文、数据留存政策 —— 未逐条核实（`docs.typesafe.ai/legal` 未抓取）。
- 独立复现的 benchmark —— 未检索到可信第三方复现。

## 7. 参考链接

一手（本 agent 抓取）：`https://developers.cloudflare.com/ai/models/typesafe/jev/`、`https://vercel.com/ai-gateway/models/jev`、`https://docs.typesafe.ai/models`（端点/预算/速率/模态/定制方式）、`https://docs.typesafe.ai/model-jaggedness/jev-1.13`（厂商公开失败模式）。发布公告 `https://typesafe.ai/blog/introducing-system-one-models-and-jev` 抓取失败，仅据检索摘要引用（`[二手]`）。
二手（媒体/第三方）：LangChain《Building a Harness with Jev》、DataCamp《System One Models vs Jev》、Flavio Copes《A deep dive into Jev》、The Register 2026-09-16、ETV Bharat 2026-09-21。
证据：`docs/work/evidence/EV-060-jev-primary-sources.txt`（本 agent 抓取的一手页面原文节选）。
