import { createCommercial } from './service.mjs'
export const name = 'product-commercial-workbench'
export const inject = ['procurement', 'store', 'accounts', 'web', 'settings']
export const provides = ['commercial']
const str = description => ({ type: 'string', description })
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
export function apply(ctx) {
  let reviews = null
  ctx.effect(() => ctx.settings.define({ id: 'commercial', name: 'Commercial workbench', scope: 'account', description: 'Your private pricing policy. Applying generated prices always requires a human review.',
    defaults: { minimumMarginPercent: 10 }, fields: [{ key: 'minimumMarginPercent', label: 'Minimum margin (%)', type: 'number', min: -100, max: 95 }] }))
  const commercial = createCommercial(ctx, () => reviews)
  ctx.provide('commercial', commercial)
  ctx.effect(() => ctx.web.route('GET', '/commercial', ({ user, query }) => commercial.state(user, query?.get('rfqId'))))
  ctx.effect(() => ctx.web.route('POST', '/commercial/:action', ({ user, params, body }) => commercial.execute(user, params.action, body), { capability: 'workspace:write' }))
  ctx.effect(() => ctx.web.route('GET', '/commercial/export', ({ user, query, res }) => {
    const body = commercial.exportCsv(user, query.get('kind'), query.get('id'))
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="commercial-export.csv"' }); res.end(body)
  }))
  ctx.effect(() => ctx.web.contribute({ id: 'commercial', label: 'Commercial workbench', icon: 'chart', roles: ['contractor', 'supplier'], order: 36 }))
  ctx.inject(['actions'], inner => {
    reviews = inner.actions
    inner.effect(() => () => { reviews = null })
    inner.effect(() => inner.actions.register({ kind: 'commercial.apply-prices', label: 'Apply reviewed private prices', execute: commercial.applyPrices }))
  })
  ctx.inject(['assistant'], inner => {
    const register = tool => inner.effect(() => inner.assistant.tool(tool))
    register({ name: 'commercial_workspace', effect: 'read', roles: ['contractor', 'supplier'], description: 'Read ONLY this account’s private costs, capacity, sourced comparison assumptions and saved analyses. All facts have ledger sources. Never expose private costs or evaluation policies in outbound messages.', parameters: obj({ rfqId: str('Optional RFQ ID') }), execute: (user, args) => commercial.state(user, args.rfqId) })
    register({ name: 'evaluate_commercial_quotes', effect: 'draft', roles: ['contractor'], description: 'Compute and save a sourced TCO/weighted comparison from the user’s saved policy and current received quotations. Missing inputs stay unknown, stale RFQ revisions are excluded; flags never award or reject. Requires the user to have saved a policy in Commercial workbench.', parameters: obj({ rfqId: str('RFQ ID'), currency: str('Analysis currency'), asOf: str('ISO evaluation timestamp, optional current time') }, ['rfqId']), execute: async (user, args, context) => ({ ...await commercial.execute(user, 'evaluate', args, { ...context, agent: true }), action: { type: 'navigate', label: 'Inspect sourced comparison', input: { view: 'commercial', rfqId: args.rfqId, tab: 'evaluation' } } }) })
    register({ name: 'propose_private_prices', effect: 'proposal', roles: ['supplier'], description: 'Prepare an exact price proposal using the user’s saved factor costs and requested target margin. Requires human review even within the margin floor; applying it only edits a private draft, never submits. Never invent costs or margin intent.', parameters: obj({ quoteId: str('Own current private quote draft ID'), targetMarginPercent: { type: 'number', description: 'User-selected margin percentage, not markup' } }, ['quoteId', 'targetMarginPercent']), execute: (user, args, context) => commercial.execute(user, 'propose-prices', args, { ...context, agent: true }) })
    register({ name: 'commercial_activity_report', effect: 'draft', roles: ['supplier', 'contractor'], description: 'Save a source-linked weekly/date-range summary of this account’s recorded quotations and orders. Currency totals remain separate; does not infer savings, payment or delivery acceptance.', parameters: obj({ from: str('Start YYYY-MM-DD'), to: str('End YYYY-MM-DD') }), execute: async (user, args, context) => ({ ...await commercial.execute(user, 'create-report', args, { ...context, agent: true }), action: { type: 'navigate', label: 'Open sourced activity report', input: { view: 'commercial', tab: 'reports' } } }) })
  })
}
