import * as provider from './product-ai.mjs'
import * as assistant from './product-assistant.mjs'
export const name = 'agent-runtime'
export const inject = ['web','store','accounts']
export async function apply(ctx, config) {
  await ctx.plugin(provider,config)
  await ctx.plugin(assistant)
}
