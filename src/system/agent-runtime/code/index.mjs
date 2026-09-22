/**
 * 进树插件入口：`src/system/agent-runtime/`（本批接上 `entry`，`D-080`）。
 *
 * 本目录里有**三个各自独立的 cordis 插件实体**：`agent-context.mjs`（`agentContext`）、
 * `agent-memory.mjs`（`agentMemory`）、`agent-harness.mjs`（`agentHarness`）——它们本来就是宿主里
 * 三个平级模块（`host/modules/agent-{context,memory,harness}.mjs`），`inject` 都是空数组
 * （彼此不依赖，**各自独立装卸**这条性质由 `AC-AGENTRT-007` 单独围栏，不因为本入口而改变）。
 * 所以本入口是**机制组合**：按 name 字典序把三个成员交给宿主，`provides` 是三者 provides 的并集。
 * **零业务语义、零写面**：本文件不做判断、不装配上下文、不碰记忆、不写任何东西。
 *
 * 与被否决的选项：①只挑一个当入口（否决：另外两个的服务键在服务索引里永远 `unresolved`）
 * ②拆成三个插件目录（否决：63 个插件数量与需求归属是冻结事实，见 `D-079` 的同一条理由）
 * ③不接（否决：`provides` 长期是占位键 `['agent-runtime']`）。
 *
 * 配置面：组合入口**不替成员解析配置**，每个成员按自己的 `Config` 取默认值装载
 * （与 `agent-runtime` profile 里三个模块各自装载时的形态一致）。
 */
import * as context from './agent-context.mjs'
import * as harness from './agent-harness.mjs'
import * as memory from './agent-memory.mjs'

/** 成员插件（按 name 字典序：context / harness / memory；顺序只影响装载次序）。 */
export const MEMBERS = [context, harness, memory]

export const name = 'agent-runtime'
export const inject = []
export const provides = ['agentContext', 'agentMemory', 'agentHarness']
export const usedServices = []

/** 装载：把三个成员插件原样交给宿主（本包装不加任何东西）。 */
export function apply(ctx) {
  for (const member of MEMBERS) {
    ctx.plugin({ name: member.name, inject: member.inject ?? [], provides: member.provides ?? [],
      Config: member.Config, apply: member.apply }, {})
  }
}
