import {createSubmissionBatches} from './submission-batches.mjs'
import {installDraftContext,pairedParties} from './draft-context.mjs'
import {requestCollection} from './request-collection.mjs'
import {publicQuoteLine} from './structured-scope.mjs'
import { createProcurement } from './service.mjs'
import { procurementExchangePolicy } from './exchange-policy.mjs'
import { fulfillmentReview, fulfillmentLabels } from './fulfillment-review.mjs'
import { createHash } from 'node:crypto'

export const name = 'procurement'
export const inject = ['store', 'accounts', 'web']
export const provides = ['procurement']

const string = (description) => ({ type: 'string', description })
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const item = object({ id: string('RFQ item ID, e.g. item-1'), description: string('Exact item specification'),
  measurementRuleId:string('Explicit measurement rule in structured request scope'),interfaceId:string('Exactly one responsibility interface'),
  classification:{type:'string',enum:['base','additional','alternative']},sourceItemId:string('Original RFQ item replaced by an alternative'),scopeReason:string('Explicit additional or alternative scope explanation'),
  offered:object({quantity:{type:'number'},unit:string('Original offered unit admitted by the declared measurement rule'),unitPrice:{type:'number'}},['quantity','unit','unitPrice']),
  quantity: { type: 'number', description: 'Positive required quantity' }, unit: string('Unit of measure'),
  unitPrice: { type: 'number', description: 'Quoted unit price, up to two decimal places' },
  cost: { type: 'number', description: 'Optional PRIVATE supplier unit cost; never sent to buyer' } }, ['description', 'quantity', 'unit'])
const termsSchema={type:'array',items:object({key:string('Shared required/offered term key'),family:{type:'string',enum:['payment','warranty','penalty','acceptance','delivery','scope','other']},label:string('Term label'),text:string('Exact authored declaration')},['key','family','label','text'])}
const scopeSchema=object({measurementRules:{type:'array',items:object({id:string('Rule ID'),name:string('Authored rule name'),dimension:string('Explicit physical dimension'),units:{type:'array',items:object({unit:string('Admitted unit'),factor:{type:'number',description:'Exact declared multiplier to common base unit'}},['unit','factor'])}},['id','name','dimension','units'])},interfaces:{type:'array',items:object({id:string('Interface ID'),name:string('Boundary or interface description'),responsibilityOwner:string('One explicitly named responsible party; never guess')},['id','name','responsibilityOwner'])},deliverables:string('Agreed outputs'),exclusions:string('Explicit exclusions; None only if user states none')},['measurementRules','interfaces','deliverables','exclusions'])

export async function apply(ctx) {
  const scoped = (user, operation = 'snapshot', input = {}) => ctx.get('teams')?.resolveUser(user, operation, input) || user
  let draftContext=null
  const procurement = createProcurement({ proposeNegotiation:(user,input)=>{if(!reviews)throw new Error('Enable Review actions before proposing concessions.');return reviews.propose(user,input)},negotiationReview:(user,id)=>{try{return reviews?.get(user,id)}catch{return null}},commercialCostBasis:(user,quote,item)=>{const actor=ctx.accounts.get(user.actorId||user.id)||user,state=ctx.get('commercial')?.state({...actor,workspaceOwnerId:user.id}),costs=state?.costs.find(row=>row.quoteId===quote.id&&row.quoteRevision===quote.revision),line=costs?.items.find(row=>row.itemId===item.id);return line?{unitCost:line.unitCost,kind:'fully-burdened-commercial-model',sourceRef:costs.sourceRef}:null}, parties:(user,options)=>pairedParties(ctx,user,options), draftDefaults:(user,context)=>draftContext?.view(user,context)||{values:{},provenance:{},context:{}}, store: ctx.store, accounts: ctx.accounts, resolveUser: scoped, authorizeCommitment: async (user, request) => {
    if (!['award', 'sign-order', 'approve-change'].includes(request.action)) return null
    const actions = ctx.get('actions')
    if (!actions?.authorizeCommitment) throw new Error('Enable independent Review actions before signing a purchase order or approving a monetary change.')
    return actions.authorizeCommitment(user, request)
  } })
  if (ctx.web.collection) ctx.effect(() => ctx.web.collection(requestCollection(procurement)))
  if (ctx.store.exchangePolicy) ctx.effect(() => ctx.store.exchangePolicy(procurementExchangePolicy({ store: ctx.store, accounts: ctx.accounts, procurement })))
  let reviews = null
  const labels = { ...fulfillmentLabels, 'send-message': 'Send project message', 'publish-rfq': 'Publish request', 'submit-quote': 'Submit quotation', 'acknowledge-order': 'Acknowledge order', 'approve-change': 'Approve order change', 'publish-amendment': 'Publish request amendment', 'ask-clarification': 'Send clarification question', 'broadcast-clarification': 'Broadcast shared answer' }
  const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value
  const semantic = value => Array.isArray(value) ? value.map(semantic) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !['status','stale','staleReason','currentRfqRevision','cost','costTotal','privateNotes','margin','costComplete','marginBasis'].includes(key) && !['createdAt','updatedAt','publishedAt','submittedAt','confirmedAt','signedAt','approvedAt','appliedAt','answeredAt','broadcastAt','withdrawnAt','closedAt'].includes(key)).map(([key,item]) => [key,semantic(item)])) : value
  const fingerprint = value => createHash('sha256').update(JSON.stringify(ordered(semantic(value)))).digest('hex')
  const rawReviewInput = (user, action, input) => {
    const data = procurement.snapshot(user)
    const fulfillment = fulfillmentReview(user, action, input, data)
    if (fulfillment) return fulfillment
    if (['publish-amendment', 'ask-clarification', 'broadcast-clarification'].includes(action)) {
      if (action !== 'ask-clarification' && user.role !== 'contractor') throw new Error('Only the request owner may publish or answer shared scope.')
      const record = action === 'publish-amendment' ? data.amendments.find(row => row.id === input.id) : action === 'broadcast-clarification' ? data.clarifications.find(row => row.id === input.id) : data.rfqs.find(row => row.id === input.rfqId)
      if (!record) throw new Error('That request, amendment or question is not available in this account.')
      const rfq = data.rfqs.find(row => row.id === (record.rfqId || record.id))
      if (!rfq || rfq.status !== 'published') throw new Error('This request is no longer open.')
      if (action === 'publish-amendment' && !['draft', 'publishing'].includes(record.status)) throw new Error('This amendment is already published.')
      if (action === 'publish-amendment' && record.status === 'draft' && record.baseRevision !== rfq.publishedRevision) throw new Error('This amendment was prepared against an older request. Prepare a new draft.')
      if (action === 'broadcast-clarification' && !['answered', 'broadcasting'].includes(record.status)) throw new Error('Save a private answer before preparing the broadcast.')
      const recipientIds = action === 'ask-clarification' ? [rfq.ownerId] : action === 'publish-amendment' ? record.fields.supplierIds : rfq.supplierIds
      const recipients = recipientIds.map(id => procurement.parties(user).find(person=>person.id===id)).map(person => person && ({ id: person.id, name: person.company || person.name, email: person.email }))
      if (recipients.some(person => !person)) throw new Error('A recipient account is no longer available.')
      const payload = action === 'ask-clarification' ? { rfqId: rfq.id, rfqRevision: rfq.publishedRevision, question: String(input.question || '').trim(), itemIds: input.itemIds || [] } : { id: record.id }
      if (action === 'ask-clarification' && !payload.question) throw new Error('Write the clarification question first.')
      const targets = { record, rfq, recipients }
      const preview = { title: rfq.title, label: labels[action], recipients, currency: record.fields?.currency || rfq.currency,
        text: action === 'broadcast-clarification' ? `Question: ${record.question}\n\nShared answer: ${record.draftAnswer || record.answer}` : action === 'ask-clarification' ? payload.question : `Revision ${record.baseRevision} → ${record.baseRevision + 1}. ${record.reason}\nChanged fields: ${record.delta.map(row => row.field).join(', ')}`,
        description: action === 'publish-amendment' ? record.fields.description : `Request revision ${rfq.publishedRevision}. ${action === 'broadcast-clarification' ? 'This answer goes to every invited supplier; bidder identity is omitted.' : 'This question goes to the request owner.'}`,
        ...(action === 'publish-amendment' ? { items: record.fields.items, deadline: record.fields.deadline, clarifyDeadline:record.fields.clarifyDeadline, scope:record.fields.scope, terms:record.fields.terms } : {}) }
      return { action, payload, reviewed: targets, preview, fingerprint: fingerprint(targets) }
    }
    const allowed = user.role === 'contractor' ? ['send-message', 'publish-rfq', 'award', 'approve-change'] : ['send-message', 'submit-quote', 'acknowledge-order']
    if (!allowed.includes(action)) throw new Error('This action belongs to the other party.')
    const id = action === 'award' ? input.quoteId || input.id : action === 'send-message' ? input.rfqId : input.id
    const collection = { 'send-message': data.rfqs, 'publish-rfq': data.rfqs, 'submit-quote': data.quotes, award: data.quotes, 'acknowledge-order': data.orders, 'approve-change': data.changes }[action]
    const record = collection?.find(row => row.id === id)
    if (!record) throw new Error('That record is not available in this account.')
    if (['submit-quote', 'award'].includes(action) && record.stale) throw new Error('This quotation uses an older request revision. Prepare a rebid first.')
    const wantedStatus = { 'publish-rfq': 'draft', 'submit-quote': 'draft', award: 'submitted', 'acknowledge-order': 'issued', 'approve-change': 'proposed' }[action]
    if (wantedStatus && record.status !== wantedStatus) throw new Error(`This ${action === 'approve-change' ? 'change' : 'record'} is no longer ${wantedStatus}. Review its current state.`)
    const order = record.orderId ? data.orders.find(row => row.id === record.orderId) : action === 'acknowledge-order' ? record : null
    const rfq = data.rfqs.find(row => row.id === (record.rfqId || order?.rfqId || record.id))
    const recipientIds = action === 'publish-rfq' ? record.supplierIds : [action === 'send-message' ? input.toId : user.role === 'supplier' ? rfq?.ownerId || record.ownerId : record.supplierId || order?.supplierId]
    if (action === 'submit-quote' && rfq?.status !== 'published') throw new Error('This request is no longer open for quotations.')
    const recipients = recipientIds.map(recipientId => data.contacts.find(row => row.id === recipientId))
    if (!recipients.length || recipients.some(person => !person)) throw new Error('Choose active counterparties from this project before preparing the action.')
    let payload = action === 'award' ? { quoteId: id } : { id }
    if (action === 'send-message') {
      if (user.role === 'supplier' ? input.toId !== rfq.ownerId : rfq.ownerId !== user.id || !rfq.supplierIds.includes(input.toId)) throw new Error('Choose a counterparty invited to this request.')
      const text = String(input.text || '').trim()
      if (!text) throw new Error('Write the message to review.')
      payload = { rfqId: id, toId: input.toId, text, kind: ['message', 'clarification', 'negotiation'].includes(input.kind) ? input.kind : 'message' }
    }
    const targets = { record, rfq: rfq || null, order, recipients }
    const amount = action === 'approve-change' ? record.amount : record.total
    const preview = { title: record.title || rfq?.title || order?.title || 'Project commitment', label: labels[action], recipients: recipients.map(person => ({ id: person.id, name: person.company || person.name, email: person.email })),
      ...(typeof amount === 'number' ? { amount } : {}), ...(record.priceBreakdown ? { priceBreakdown: record.priceBreakdown } : {}), currency: record.currency || rfq?.currency || order?.currency || 'USD',
      ...(action === 'send-message' ? { text: payload.text, kind: payload.kind } : { items: (record.items || []).map(publicQuoteLine),
        description: record.description || '', notes: record.notes || '', assumptions:record.assumptions,exclusions:record.exclusions,schedule:record.schedule, commercial:record.commercial, paymentTerms: record.paymentTerms || '', leadDays: record.leadDays, deadline: action === 'publish-rfq' ? record.deadline : undefined, clarifyDeadline:record.clarifyDeadline, scope:record.scope, terms:record.terms }) }
    return { action, payload, reviewed: targets, preview, fingerprint: fingerprint(targets) }
  }
  const reviewInput = (user, action, input) => {
    const owner = scoped(user, 'snapshot', input), frozen = rawReviewInput(owner, action, input)
    const data=procurement.snapshot(owner),events=ctx.store.events(owner.id),sources=[],seen=new Set()
    const candidates=[frozen.reviewed.record,frozen.reviewed.rfq,frozen.reviewed.quote,frozen.reviewed.order].filter(Boolean)
    for(const record of candidates){
      const collection=['rfqs','quotes','orders','changes','award-intents','rfq-amendments','clarifications','invoices','acceptances'].find(name=>ctx.store.get(owner.id,name,record.id))
      if(!collection||seen.has(collection+':'+record.id))continue
      const source=events.findLast(event=>event.body?.collection===collection&&event.body.record?.id===record.id)
      if(!source)continue
      seen.add(collection+':'+record.id)
      const link=collection==='quotes'?{view:'quotes',quoteId:record.id,rfqId:record.rfqId}:collection==='orders'?{view:'orders',orderId:record.id}:collection==='award-intents'?{view:'orders',rfqId:record.rfqId,awardId:record.id}:record.orderId?{view:'orders',orderId:record.orderId,tab:collection==='changes'?'changes':'invoices'}:{view:'rfqs',rfqId:record.rfqId||record.id,...(collection==='rfq-amendments'?{tab:'versions'}:collection==='clarifications'?{tab:'clarifications'}:{})}
      sources.push({label:record.title||record.invoiceNumber||record.supplierName||({rfqs:'Request',quotes:'Quotation',orders:'Order',changes:'Scope change','award-intents':'Confirmed selection','rfq-amendments':'Request amendment',clarifications:'Shared clarification'}[collection])||'Project source',collection,recordId:record.id,ref:{realm:owner.id,seq:source.seq,hash:source.entry_hash},link:{...link,workspaceId:owner.id}})
    }
    const quoteId=frozen.reviewed.quote?.id||frozen.reviewed.record?.quoteId||(sources.some(row=>row.collection==='quotes'&&row.recordId===frozen.reviewed.record?.id)?frozen.reviewed.record.id:null)
    const risks=[...(data.comparison.find(row=>row.quoteId===quoteId)?.risks||[]),...(data.termConflicts||[]).filter(row=>row.quoteId===quoteId&&row.decision?.resolution!=='accept-offer').map(row=>`${row.label}: required/offered difference still needs a human term decision.`)]
    return { ...frozen, preview:{...frozen.preview,sources,risks}, workspaceId: owner.id, fingerprint: fingerprint({ workspaceId: owner.id, targets: frozen.reviewed, payload: frozen.payload }) }
  }
  const propose = async (user, action, input, context = {}) => {
    if (!reviews) throw new Error('Enable Review actions to prepare this commitment.')
    const frozen = reviewInput(user, action, input)
    const amount = typeof frozen.preview.amount === 'number' ? ` · ${new Intl.NumberFormat('en-US', { style: 'currency', currency: frozen.preview.currency }).format(frozen.preview.amount)}` : ''
    const proposal = await reviews.propose(user, { kind: 'procurement.commit', title: `${labels[action]}: ${frozen.preview.title}`, summary: `${frozen.preview.recipients.map(person => person.name).join(', ')}${amount}`, input: frozen,
      idempotencyKey:context.idempotencyKey||null, source: { kind: context.source || 'assistant', plugin: 'procurement', ...(context.stepId ? { stepId: context.stepId } : {}) }, runId: context.runId || null })
    return { ok: true, reviewRequired: true, proposal, action: { type: 'navigate', label: 'Review procurement action', input: { view: 'approvals', actionId: proposal.id } }, message: 'Saved for human review. Nothing has been sent or committed.' }
  }
  const submissions=createSubmissionBatches({store:ctx.store,scoped,accounts:ctx.accounts,actions:user=>reviews?.list(user)||[],prepareOne:async(user,id,context)=>{
    const current=reviewInput(user,'submit-quote',{id}),pending=reviews?.list(user).find(row=>row.kind==='procurement.commit'&&row.status==='pending'&&row.input.action==='submit-quote'&&row.input.workspaceId===current.workspaceId&&row.input.fingerprint===current.fingerprint)
    if(pending)return {proposal:pending,reused:true}
    return propose(user,'submit-quote',{id},context)
  }})
  ctx.effect(()=>()=>submissions.dispose())
  procurement.prepareSubmissions=submissions.prepare
  procurement.submissionBatches=submissions.list
  ctx.inject(['actions'], inner => {
    reviews = inner.actions
    inner.effect(() => () => { reviews = null })
    inner.effect(()=>inner.actions.register({kind:'procurement.concession',label:'Review bounded price concession',execute:(user,input,action)=>procurement.execute({...user,workspaceOwnerId:input.workspaceId},'apply-negotiation',{threadId:input.threadId,roundId:input.roundId,reviewActionId:action.id},{reviewedConcession:action})}))
    inner.effect(() => inner.actions.register({ kind: 'procurement.commit', label: 'Procurement commitment', review: (user, input) => ['sign-order','award','approve-change'].includes(input.action) ? { workspaceId: input.workspaceId, side: user.role, independent: true, amount: Math.abs(Math.round(input.preview.amount * 100)), currency: input.preview.currency, object: { kind: input.action === 'approve-change' ? 'change' : 'award-intent', id: input.reviewed.record.id }, action: input.action, fingerprint: input.fingerprint } : null, execute: async (user, input, action, { signal } = {}) => {
      if (signal?.aborted) throw new Error('This action was canceled before execution.')
      const current = reviewInput(user, input.action, input.payload)
      if (current.workspaceId !== input.workspaceId || current.fingerprint !== input.fingerprint) throw new Error('This project, quotation, recipient or order changed after the proposal. Prepare a new review of its current details.')
      const result = await procurement.execute(user, input.action, { ...input.payload, confirmed: true, reviewActionId: action.id })
      const target = result.awardIntent ? { view: 'orders', rfqId: result.awardIntent.rfqId, awardId: result.awardIntent.id } : result.change ? { view: 'orders', orderId: result.change.orderId } : result.order ? { view: 'orders', orderId: result.order.id, rfqId: result.order.rfqId } : input.action === 'send-message' ? { view: 'messages', rfqId: input.payload.rfqId } : result.quote ? { view: 'quotes', quoteId: result.quote.id, rfqId: result.quote.rfqId } : { view: 'rfqs', rfqId: result.rfq?.id || input.payload.id }
      return { ...result, approvalId: action.id, action: { type: 'navigate', label: 'Open project result', input: target } }
    } }))
  })
  // The advertised demo opens on useful, labelled data. Seed only the built-in
  // identities; the existing idempotent action preserves their later work.
  const demoAccounts = [
    ['contractor-demo', 'contractor@demo.local', 'contractor'],
    ['supplier-demo', 'supplier@demo.local', 'supplier'],
    ['supplier2-demo', 'supplier2@demo.local', 'supplier'],
  ].map(([id, email, role]) => {
    const account = ctx.accounts.get(id)
    return account?.email === email && account.role === role && !account.disabled ? account : null
  })
  if (demoAccounts.every(Boolean) && demoAccounts.every(account => ctx.store.health?.()[account.id]?.healthy !== false) && !demoAccounts[0].permissions?.includes('workspace:read-only')) {
    await procurement.execute(demoAccounts[0], 'seed-demo')
  }
  ctx.provide('procurement', procurement)
  ctx.inject(['settings'],inner=>{draftContext=installDraftContext(inner);inner.effect(()=>()=>{draftContext?.dispose();draftContext=null})})
  ctx.effect(()=>ctx.web.route('GET','/workspace/draft-defaults',({user,query})=>procurement.defaults(user,Object.fromEntries(['workspaceId','projectId','sectionId'].filter(key=>query.get(key)).map(key=>[key,query.get(key)])))))
  ctx.effect(()=>ctx.web.route('GET','/workspace/faqs/lookup',({user,query})=>procurement.faqLookup(user,Object.fromEntries(['rfqId','rfqRevision','question'].map(key=>[key,query.get(key)])))))
  ctx.effect(() => ctx.web.route('GET', '/workspace', ({ user }) => procurement.snapshot(user)))
  ctx.effect(() => ctx.web.route('GET', '/workspace/export', ({ user, query, res }) => {
    const rfqId = typeof query?.get === 'function' ? query.get('rfqId') : query?.rfqId
    const csv = procurement.exportCsv(user, rfqId)
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="quotation-comparison.csv"' })
    res.end(csv)
  }))
  ctx.effect(()=>ctx.web.route('GET','/workspace/submission-batches',({user})=>({batches:submissions.list(user)})))
  ctx.effect(()=>ctx.web.route('POST','/workspace/review-submissions',({user,body})=>submissions.prepare(user,body,{source:'human'}),{capability:'workspace:write'}))
  ctx.effect(() => ctx.web.route('POST', '/workspace/review/:action', ({ user, params, body }) => propose(user, params.action, body, { source: 'human' }), { capability: 'workspace:write' }))
  ctx.effect(() => ctx.web.route('POST', '/workspace/change-preview', ({ user, body }) => procurement.previewChange(user, body.orderId, body.lines, body.expectedOrderRevision)))
  ctx.effect(() => ctx.web.route('POST', '/workspace/:action', ({ user, params, body }) => procurement.execute(user, params.action, body), { capability: 'workspace:write' }))
  for (const [id, label, icon, roles, order] of [
    ['workspace', 'Overview', 'LayoutDashboard', ['contractor', 'supplier'], 10],
    ['rfqs', 'Requests', 'ClipboardList', ['contractor', 'supplier'], 20],
    ['quotes', 'Quotes', 'FileText', ['contractor', 'supplier'], 30],
    ['orders', 'Orders', 'Package', ['contractor', 'supplier'], 40],
    ['messages', 'Messages', 'MessageSquare', ['contractor', 'supplier'], 50],
  ]) ctx.effect(() => ctx.web.contribute({ id, label, icon, roles, order, linkKeys: ['workspaceId',...(({rfqs:['rfqId','tab'],quotes:['rfqId','quoteId'],orders:['orderId','rfqId','awardId','tab'],messages:['rfqId']})[id] || [])] }))

  // Deferred injection avoids a cycle: the assistant may itself depend on procurement.
  ctx.inject(['assistant'], (inner) => {
    const register = (tool) => inner.effect(() => inner.assistant.tool(tool))
    register({ name: 'procurement_workspace', effect: 'read', description: 'Read the signed-in account\'s RFQs, current quotes, orders, messages and comparison. Supplier private costs are visible only to that supplier. Use this before grounded recommendations.',
      roles: ['contractor', 'supplier'], parameters: object({ rfqId: string('Optional RFQ to focus on') }),
      execute(user, args) {
        const data = procurement.snapshot(user)
        if (!args.rfqId) return data
        return { ...data, rfqs: data.rfqs.filter((row) => row.id === args.rfqId), quotes: data.quotes.filter((row) => row.rfqId === args.rfqId),
          orders: data.orders.filter((row) => row.rfqId === args.rfqId), messages: data.messages.filter((row) => row.rfqId === args.rfqId),
          comparison: data.comparison.filter((row) => row.rfqId === args.rfqId), clarifications: data.clarifications.filter(row => row.rfqId === args.rfqId), amendments: data.amendments.filter(row => row.rfqId === args.rfqId), rfqVersions: data.rfqVersions.filter(row => row.rfqId === args.rfqId), rebidRequests: data.rebidRequests.filter(row => row.rfqId === args.rfqId) }
      } })
    register({ name: 'draft_rfq', effect: 'draft', description: 'Create an editable PRIVATE RFQ draft from extracted requirements. Cite uncertainties in the description; never invent quantities. This does not publish or contact suppliers.',
      roles: ['contractor'], parameters: object({ id: string('Optional existing unpublished RFQ draft ID to edit'), title: string('RFQ title'), description: string('Scope and unresolved assumptions'),
        scope:scopeSchema, terms:termsSchema, projectId: string('Optional own project ID'), sectionId: string('Optional section of that project'), clarifyDeadline: string('Optional explicit clarification deadline in ISO UTC; cannot be later than quote deadline'), deadline: string('Optional ISO date'), currency: string('Three-letter currency code'), items: { type: 'array', items: item },
        supplierIds: { type: 'array', items: string('Supplier account ID from contacts') } }, ['title', 'items']),
      async execute(user, args) {
        const result = await procurement.execute(user, 'create-rfq', args, { agent: true })
        return { ...result, action: { action: 'navigate', label: 'Review RFQ draft', input: { view: 'rfqs', rfqId: result.rfq.id } } }
      } })
    register({ name: 'draft_quote', effect: 'draft', description: 'Prepare an editable PRIVATE supplier quote using actual RFQ item IDs and the user\'s authorized prices/costs. Never send it; human review is required. Missing price guidance should be discussed first.',
      roles: ['supplier'], parameters: object({ id: string('Optional existing draft ID'), rfqId: string('Invited RFQ ID'), rfqRevision: { type: 'integer', description: 'Current published RFQ revision that these prices address' }, items: { type: 'array', items: item },
        assumptions:{type:'array',items:string('Explicit supplied assumption')},exclusions:{type:'array',items:string('Explicit supplied exclusion')},schedule:{type:'array',items:object({id:string('Stable milestone ID'),label:string('Named deliverable milestone'),date:string('Explicit ISO date'),binding:{type:'string',enum:['firm','indicative']},itemIds:{type:'array',items:string('Quoted item ID')},description:string('Authored timing qualification')},['id','label','date','binding'])}, terms:termsSchema, commercial:object({deviations:{type:'array',items:object({category:{type:'string',enum:['technical','commercial','schedule','scope']},itemId:string('Optional actual quoted item reference'),description:string('Explicit deviation from request'),priceImpact:{type:'number',description:'Optional declared amount; omitted means unknown'},timeImpactDays:{type:'integer',description:'Optional declared days; omitted means unknown'}},['description'])}}), leadDays: { type: 'integer' }, paymentTerms: string('Payment terms'), notes: string('Public quote notes'), privateNotes: string('Private supplier notes') }, ['rfqId', 'rfqRevision', 'items']),
      async execute(user, args) {
        const result = await procurement.execute(user, 'save-quote', args, { agent: true })
        return { ...result, action: { action: 'navigate', label: 'Review quote draft', input: { view: 'quotes', quoteId: result.quote.id, rfqId: result.quote.rfqId } } }
      } })
    register({ name: 'compare_quotes', effect: 'read', description: 'Get exact arithmetic and explicit risks for current submitted quotes, with source quote and RFQ references. Does not award or change data.',
      roles: ['contractor'], parameters: object({ rfqId: string('RFQ ID to compare') }, ['rfqId']),
      execute(user, args) {
        const data = procurement.snapshot(user)
        return { rfq: data.rfqs.find((row) => row.id === args.rfqId), quotes: data.comparison.filter((row) => row.rfqId === args.rfqId),
          note: 'Compare complete scope, delivery and payment terms. Cheapest total alone does not establish best value.' }
      } })
    register({ name: 'draft_rfq_amendment', effect: 'draft', description: 'Prepare a PRIVATE amendment to a published request. Provide the current revision and a reason. Changed scope is not sent until a person reviews publication; old quotations will then require rebidding.',
      roles: ['contractor'], parameters: object({ id: string('Optional existing amendment draft ID'), rfqId: string('Published RFQ ID'), expectedRevision: { type: 'integer' }, reason: string('Why scope changes'),
        scope:scopeSchema, terms:termsSchema, title: string('New title if changed'), description: string('New complete scope description'), clarifyDeadline: string('Optional explicit clarification deadline in ISO UTC; cannot be later than quote deadline'), deadline: string('Optional ISO date'), currency: string('Currency'), items: { type: 'array', items: item }, supplierIds: { type: 'array', items: string('Supplier ID; preserve existing invitees') } }, ['rfqId', 'expectedRevision', 'reason']),
      async execute(user, args) { const result = await procurement.execute(user, 'save-amendment', args, { agent: true }); return { ...result, action: { type: 'navigate', label: 'Review amendment draft', input: { view: 'rfqs', rfqId: args.rfqId, tab: 'versions' } } } } })
    register({ name: 'draft_clarification_answer', effect: 'draft', description: 'Save a PRIVATE draft answer to an open clarification. Reused FAQ is source data and must be reviewed against this request revision. This never broadcasts an answer.',
      roles: ['contractor'], parameters: object({ id: string('Clarification ticket ID'), rfqRevision: { type: 'integer' }, answer: string('Exact proposed answer; do not invent missing scope facts'), faqId: string('Optional source FAQ entry in this account') }, ['id', 'answer']),
      async execute(user, args) { const result = await procurement.execute(user, 'save-clarification-answer', args, { agent: true }); return { ...result, action: { type: 'navigate', label: 'Review clarification answer', input: { view: 'rfqs', rfqId: result.clarification.rfqId, tab: 'clarifications' } } } } })
    register({ name: 'prepare_rfq_lifecycle_review', effect: 'proposal', description: 'Prepare a durable human review for an amendment publication, a clarification question, or a saved answer broadcast to EVERY invited supplier. Nothing is sent automatically.',
      roles: ['contractor', 'supplier'], parameters: object({ action: { type: 'string', enum: ['publish-amendment', 'ask-clarification', 'broadcast-clarification'] }, id: string('Amendment or clarification ID'), rfqId: string('RFQ for a new question'), question: string('Exact question for the request owner'), itemIds: { type: 'array', items: string('Referenced current item ID') } }, ['action']),
      execute: (user, args, context) => propose(user, args.action, args, context) })
    register({name:'lookup_faq',effect:'read',roles:['contractor','supplier'],description:'Look up published reusable fields for the exact request revision and normalized question. Wrong version returns no entry; historical adaptation is a separate private draft action.',parameters:object({rfqId:string('Authorized RFQ ID'),rfqRevision:{type:'integer'},question:string('Exact question')},['rfqId','rfqRevision','question']),execute:(user,args)=>procurement.faqLookup(user,args)})
    register({name:'prepare_faq_fields',effect:'draft',roles:['contractor','supplier'],description:'Prepare explicit reusable fields from a fully broadcast clarification as a private candidate. A person must publish them. Never include private price, cost model or signature fields.',parameters:object({clarificationId:string('Fully broadcast source ticket'),question:string('Reusable source-backed question'),fields:{type:'array',items:object({key:{type:'string',enum:['unit','measurement_note','deadline_note','scope_note','delivery_note','warranty_note','payment_note','exclusion_note','safety_note']},value:string('Explicit reusable source fact')},['key','value'])}},['clarificationId','fields']),execute:(user,args,context)=>procurement.execute(user,'prepare-faq',args,{...context,agent:true})})
    register({name:'propose_negotiation_price',effect:'proposal',roles:['supplier','contractor'],description:'Propose a price move within a human-configured private negotiation thread. Each attempt consumes a durable round, including refusals. The actual private cost floor and limits are enforced, and every permitted concession goes to human review. Never disclose private floors, costs or bounds.',parameters:object({threadId:string('Existing own open negotiation thread ID'),toUnitPrice:{type:'number',description:'User-requested new unit price, at most two decimals'},reason:string('Sourced rationale without private costs in any outbound text')},['threadId','toUnitPrice','reason']),execute:(user,args,context)=>procurement.execute(user,'request-negotiation',args,{...context,agent:true})})
    register({ name: 'draft_message', effect: 'proposal', description: 'Save an exact clarification or negotiation message in the durable human review queue. Does NOT send or make a price concession. The user can decline and request a revision before approving.',
      roles: ['contractor', 'supplier'], parameters: object({ rfqId: string('RFQ ID'), toId: string('Recipient account ID'),
        text: string('Draft message text'), kind: { type: 'string', enum: ['message', 'clarification', 'negotiation'] } }, ['rfqId', 'toId', 'text']),
      execute: (user, args, context) => propose(user, 'send-message', args, context) })
    register({name:'prepare_quote_submissions',effect:'proposal',roles:['supplier'],description:'Prepare separately frozen review actions for up to 50 selected own quotation drafts. Returns durable per-item preparation results; nothing is submitted and each exact quotation still needs human review.',parameters:object({quoteIds:{type:'array',items:string('Own quotation draft ID'),minItems:1,maxItems:50}},['quoteIds']),execute:(user,args,context)=>submissions.prepare(user,args,{...context,source:context?.source||'assistant'})})
    register({ name: 'prepare_commitment', effect: 'proposal', description: 'Save an exact durable human review proposal for publishing, quote submission, a nonbinding award intent, supplier confirmation, independently reviewed order signing, order acknowledgment or sourced change approval. Nothing is committed until a person approves; changed target records require a fresh review.',
      roles: ['contractor', 'supplier'], parameters: object({ action: { type: 'string', enum: ['publish-rfq', 'submit-quote', 'propose-award', 'confirm-award', 'decline-award', 'withdraw-award', 'sign-order', 'acknowledge-order', 'confirm-change', 'reject-change', 'approve-change', 'settle-change', 'close-rfq', 'withdraw-quote'] },
        id: string('RFQ, quote, award intent, order or change ID'), quoteId: string('Quote ID for a nonbinding award intent'), reason: string('Explicit selection or decision reason'), note: string('Optional change closure note') }, ['action']),
      execute: (user, args, context) => propose(user, args.action, args, context) })
  })
}
