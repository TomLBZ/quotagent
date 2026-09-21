/**
 * 进树模块 1/3：`kernel-bridge`（宿主 ↔ Python 内核的桥接条目）。
 *
 * manifest 形状（评审 C §3）：`{ name, inject, provides, Config, apply, disposer }`。
 * - `inject` 是本模块**允许取用**的宿主侧服务白名单（A1：取未声明的服务必须抛错，不是静默可用）；
 * - `usedServices` 声明"实际用到的服务"，A1 会断言它与 `inject` **相等**（声明即事实）；
 * - `Config` 用 cordis 的 Schema（A3：非法/未知/翻转 const 键必须被拒）；
 * - 事件只允许 emit **已声明**的事件名（A4，真源在 Python 侧的事件表）；
 * - 同输入两次派生输出必须字节一致（A5，不许有墙钟/自增序号）。
 */
import { array, constant, object, string, union } from '../lib/std-schema.mjs'

export const name = 'kernel-bridge'

// `events` 是 cordis 的**内建 mixin**（`ctx.events`），不是可 inject 的服务：
// 把它写进 inject 会让插件永远停在 pending（实测：inject:['events'] → state=0）。
export const inject = ['ledgerView']

export const builtin = ['events']

export const provides = ['bridge']

export const usedServices = ['ledgerView']

export const Config = object({
  accept_bridge: array(string()).default(['1.0']),
  profile: string().default('contractor-ops'),
  credit_window: constant(256),                    // const 键：不得翻转（A3 负控）
  fact_surface: union(['open', 'closed']).default('closed'),
})

export function apply(ctx, config) {
  const facts = { hello_seen: false, rejected: 0 }
  // 订阅（effect）与导出（provides）都挂在 fiber 上 → dispose 后应零残留（A2）
  ctx.effect(() => () => {
    facts.hello_seen = false
  })
  ctx.provide('bridge', {
    /** 桥的能力清单（**不含任何承诺面**；commit 类方法只声明不暴露）。 */
    surface: () => ({ accept_bridge: config.accept_bridge, profile: config.profile,
      exposed: ['ledger.count', 'ledger.head', 'ledger.read'], refused: ['quote.submit', 'award.commit'] }),
    /** 事件必须走声明表（A4）：未声明即拒绝。 */
    emitDeclaration: (declared, event, body) => {
      if (!declared.includes(event)) {
        facts.rejected += 1
        throw new Error(`[unknown-event] ${event} 未在事件表声明（A4）`)
      }
      ctx.events.emit(event, body)
      return true
    },
    facts: () => ({ ...facts, credit_window: config.credit_window }),
  })
}

export function disposer(ctx, config) {
  return () => { ctx.facts = null }
}
