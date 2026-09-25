import * as email from './email.mjs'
import * as spreadsheet from './spreadsheet.mjs'
import * as tabular from './tabular.mjs'
import * as documents from './documents.mjs'
import * as ai from './ai.mjs'
export const name = 'ingestion-engines'
export const inject = ['ingestion']
export function apply(ctx) {
  for (const plugin of [email,spreadsheet,tabular,documents,ai]) ctx.plugin(plugin)
}
