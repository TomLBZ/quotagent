import * as provider from './product-ai.mjs'
import * as assistant from './product-assistant.mjs'
import * as policy from './product-policy.mjs'
import * as usage from './product-usage.mjs'
import * as evaluation from './product-evaluation.mjs'
export const name = 'agent-runtime'
export const inject = ['web','store','accounts','settings']
export async function apply(ctx, config) {
  await ctx.plugin(usage)
  await ctx.plugin(provider,config)
  await ctx.plugin(policy)
  await ctx.plugin(assistant)
  await ctx.plugin(evaluation)
}
