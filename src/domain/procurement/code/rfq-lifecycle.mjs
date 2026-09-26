import { requirementFields } from './commercial-fields.mjs'
// Business records only. Ledger and transport semantics belong to workspace-store.
export const rfqRevision = rfq => Number(rfq.publishedRevision || rfq.revision || 1)
export const quoteRevision = (quote, rfq) => Number(quote.rfqRevision || rfq.initialRevision || rfqRevision(rfq))
export const staleQuote = (quote, rfq) => quoteRevision(quote, rfq) !== rfqRevision(rfq)

const copy = value => structuredClone(value)
const now = () => new Date().toISOString()
const editable = ['title', 'description', 'deadline', 'currency', 'items', 'supplierIds', 'projectId', 'projectName', 'sectionId', 'sectionName', 'requirements']
const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

export function createRfqLifecycle(helpers) {
  const { store, accounts, get, save, exchange, approval, fail, required, text, role, newId, rfqItems, suppliers, currencyOf, publicRfq } = helpers
  const contextFields = (user, input) => {
    if (!input.projectId) {
      if (input.sectionId) fail('Choose a project before choosing a section.')
      return { projectId: '', projectName: '', sectionId: '', sectionName: '' }
    }
    const project = get(user, 'projects', input.projectId)
    if (project.ownerId !== user.id) fail('That project belongs to another account.', 403)
    const section = input.sectionId ? get(user, 'sections', input.sectionId) : null
    if (section && (section.ownerId !== user.id || section.projectId !== project.id)) fail('Choose a section of the selected project.')
    return { projectId: project.id, projectName: project.name, sectionId: section?.id || '', sectionName: section?.name || '' }
  }
  const version = async (user, rfq) => {
    const id = `${rfq.id}:v${rfqRevision(rfq)}`
    if (store.get(user.id, 'rfq-versions', id)) return
    await save(user, 'rfq-versions', { ...copy(rfq), id, rfqId: rfq.id, publishedRevision: rfqRevision(rfq), snapshot: copy(rfq) }, 'procurement/rfq-version-recorded')
  }
  const publicVersion = (record, recipient) => ({ id: record.id, rfqId: record.rfqId, publishedRevision: record.publishedRevision,
    snapshot: publicRfq(record.snapshot, recipient), createdAt: record.createdAt, updatedAt: record.updatedAt })
  const ticketPublic = (ticket, recipient, status = ticket.status) => ({ id: ticket.id, rfqId: ticket.rfqId,
    ownerId: ticket.ownerId, rfqRevision: ticket.rfqRevision, question: ticket.question, itemIds: ticket.itemIds,
    status, published: !!ticket.published, ...(recipient === ticket.askerId ? { askedByYou: true } : {}),
    ...(ticket.published && ['broadcasting', 'closed'].includes(status) ? { answer: ticket.answer, answeredAt: ticket.answeredAt, broadcastAt: ticket.broadcastAt } : {}),
    previousAnswers: copy(ticket.previousAnswers || []), reopenedReason: ticket.reopenedReason || '',
    createdAt: ticket.createdAt, updatedAt: ticket.updatedAt })
  const checkRfq = (user, id, owner = false) => {
    const rfq = get(user, 'rfqs', id)
    if (owner ? rfq.ownerId !== user.id : rfq.ownerId !== user.id && !rfq.supplierIds.includes(user.id)) fail('This request is not available to you.', 403)
    if (rfq.status !== 'published') fail('This request is not open for changes or questions.')
    return rfq
  }
  const checkExpected = (rfq, expected) => {
    if (expected !== undefined && Number(expected) !== rfqRevision(rfq)) fail(`The request changed to revision ${rfqRevision(rfq)}. Reload and review that scope first.`, 409)
  }
  const amendmentFields = (user, rfq, input) => {
    const next = { ...rfq, ...Object.fromEntries(editable.filter(key => input[key] !== undefined).map(key => [key, input[key]])) }
    const deadline = text(next.deadline)
    if (deadline && !Number.isFinite(Date.parse(deadline))) fail('Choose a valid deadline.')
    const invited = suppliers(next.supplierIds)
    if (rfq.supplierIds.some(id => !invited.includes(id))) fail('An amendment must keep all previously invited suppliers informed. Add suppliers if needed; existing invitations cannot be removed.')
    return { title: required(next.title, 'RFQ title'), description: text(next.description), deadline, currency: currencyOf(next.currency),
      requirements: requirementFields(rfq.requirements, input.requirements), items: rfqItems(next.items), supplierIds: invited, ...contextFields(user, next) }
  }
  const fieldDelta = (rfq, fields) => editable.filter(key => !same(rfq[key] ?? (typeof fields[key] === 'string' ? '' : key === 'requirements' ? {} : null), fields[key])).map(field => ({ field, before: copy(rfq[field] ?? null), after: copy(fields[field] ?? null) }))

  async function reopen(user, rfq) {
    for (const current of store.list(user.id, 'clarifications').filter(row => row.rfqId === rfq.id && (row.rfqRevision !== rfqRevision(rfq) || row.reopenRevision === rfqRevision(rfq)))) {
      const previousAnswers = [...(current.previousAnswers || [])]
      if (current.published && current.answer && !previousAnswers.some(row => row.revision === current.rfqRevision && row.answer === current.answer)) {
        previousAnswers.push({ revision: current.rfqRevision, answer: current.answer, broadcastAt: current.broadcastAt || current.answeredAt })
      }
      let updated = current.rfqRevision === rfqRevision(rfq) ? current : await save(user, 'clarifications', { ...current, revision: (current.revision || 0) + 1, reopenRevision: rfqRevision(rfq), reopenedRecipients: [], rfqRevision: rfqRevision(rfq), status: 'open',
        answer: '', draftAnswer: '', answerSource: null, answeredAt: null, broadcastAt: null, deliveredIds: [], previousAnswers,
        reopenedReason: `Request amended to revision ${rfqRevision(rfq)}. Review this question against the new scope.` }, 'procurement/clarification-reopened')
      const recipients = current.published ? rfq.supplierIds : current.askerId === user.id ? [] : [current.askerId]
      for (const id of recipients) {
        if (updated.reopenedRecipients?.includes(id)) continue
        const delivered = await exchange(user, id, 'clarifications', ticketPublic(updated, id), 'procurement/clarification-reopened')
        if (delivered?.received === false) continue
        updated = await save(user, 'clarifications', { ...updated, reopenedRecipients: [...(updated.reopenedRecipients || []), id] }, 'procurement/clarification-reopened')
      }
    }
  }
  const ownsTicket = (user, id) => {
    role(user, 'contractor')
    const ticket = get(user, 'clarifications', id), rfq = checkRfq(user, ticket.rfqId, true)
    if (ticket.ownerId !== user.id) fail('Only the request owner can answer this clarification.', 403)
    if (ticket.rfqRevision !== rfqRevision(rfq)) fail('The question references an older request revision. Reload the current question.', 409)
    return { ticket, rfq }
  }
  const actions = new Set(['save-project', 'save-section', 'save-amendment', 'publish-amendment', 'ask-clarification',
    'save-clarification-answer', 'broadcast-clarification', 'save-faq', 'archive-faq'])
  async function execute(user, action, input, actor) {
    if (action === 'save-project') {
      role(user, 'contractor')
      const existing = input.id ? get(user, 'projects', input.id) : null
      if (existing && existing.ownerId !== user.id) fail('Only the project owner can edit it.', 403)
      const project = await save(user, 'projects', { ...existing, id: existing?.id || newId('project'), ownerId: user.id,
        revision: (existing?.revision || 0) + 1, name: required(input.name, 'Project name'), currency: currencyOf(input.currency), calendar: text(input.calendar) }, 'procurement/project-saved', actor, input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {})
      return { ok: true, project }
    }
    if (action === 'save-section') {
      role(user, 'contractor')
      const project = get(user, 'projects', input.projectId)
      if (project.ownerId !== user.id) fail('Only your own project can contain this section.', 403)
      const existing = input.id ? get(user, 'sections', input.id) : null
      if (existing && (existing.ownerId !== user.id || existing.projectId !== project.id)) fail('This section belongs to another project.', 403)
      const section = await save(user, 'sections', { ...existing, id: existing?.id || newId('section'), ownerId: user.id,
        revision: (existing?.revision || 0) + 1, projectId: project.id, name: required(input.name, 'Section name'), description: text(input.description) }, 'procurement/section-saved', actor, input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {})
      return { ok: true, section }
    }
    if (action === 'save-amendment') {
      role(user, 'contractor')
      const rfq = checkRfq(user, input.rfqId, true)
      checkExpected(rfq, input.expectedRevision)
      if (store.list(user.id, 'rfq-amendments').some(row => row.rfqId === rfq.id && row.status === 'publishing')) fail('Finish delivery of the current amendment before drafting another.')
      const existing = input.id ? get(user, 'rfq-amendments', input.id) : null
      if (existing && (existing.rfqId !== rfq.id || existing.ownerId !== user.id || existing.status !== 'draft')) fail('Only your own draft amendment can be edited.')
      if (existing && existing.baseRevision !== rfqRevision(rfq)) fail('This amendment was prepared against an older scope. Start a new amendment.', 409)
      const fields = amendmentFields(user, rfq, { ...existing?.fields, ...input })
      const delta = fieldDelta(rfq, fields)
      if (!delta.length) fail('Change at least one scope field before saving an amendment.')
      const amendment = await save(user, 'rfq-amendments', { ...existing, id: existing?.id || newId('amendment'), ownerId: user.id,
        rfqId: rfq.id, revision: (existing?.revision || 0) + 1, baseRevision: rfqRevision(rfq), status: 'draft', reason: required(input.reason || existing?.reason, 'Reason for amendment'),
        fields, delta, deliveredIds: [] }, 'procurement/amendment-drafted', actor, input.expectedDraftRevision !== undefined ? { expectedRevision: input.expectedDraftRevision } : {})
      return { ok: true, amendment, message: 'Private amendment saved. The published request has not changed.' }
    }
    if (action === 'publish-amendment') {
      role(user, 'contractor')
      let amendment = get(user, 'rfq-amendments', input.id), rfq = checkRfq(user, amendment.rfqId, true)
      if (amendment.ownerId !== user.id) fail('This amendment belongs to another account.', 403)
      if (amendment.status === 'published') return { ok: true, amendment, rfq, duplicate: true }
      const nextRevision = amendment.baseRevision + 1
      if (amendment.status === 'draft' && amendment.baseRevision !== rfqRevision(rfq)) fail('The published request changed after this amendment was drafted. Prepare a new amendment.', 409)
      if (amendment.status === 'publishing' && rfqRevision(rfq) !== amendment.baseRevision && !(rfqRevision(rfq) === nextRevision && rfq.lastAmendmentId === amendment.id)) fail('A newer amendment exists. Review its delivery state before retrying.', 409)
      await approval(user, action, amendment.id, input, amendment)
      if (amendment.status === 'draft') amendment = await save(user, 'rfq-amendments', { ...amendment, status: 'publishing' }, 'procurement/amendment-delivery-started')
      if (rfqRevision(rfq) === amendment.baseRevision) {
        await version(user, rfq)
        rfq = await save(user, 'rfqs', { ...rfq, ...amendment.fields, initialRevision: rfq.initialRevision || rfqRevision(rfq),
          publishedRevision: nextRevision, revision: nextRevision, lastAmendmentId: amendment.id,
          amendmentReason: amendment.reason, amendmentDelta: amendment.delta, publishedAt: now() }, 'procurement/rfq-amended')
        await version(user, rfq)
      }
      for (const recipient of rfq.supplierIds) {
        if (amendment.deliveredIds.includes(recipient)) continue
        const deliveries = [await exchange(user, recipient, 'rfqs', publicRfq(rfq, recipient), 'procurement/rfq-amended')]
        for (const record of store.list(user.id, 'rfq-versions').filter(row => row.rfqId === rfq.id)) deliveries.push(await exchange(user, recipient, 'rfq-versions', publicVersion(record, recipient), 'procurement/rfq-version-recorded'))
        const rebid = store.get(user.id, 'rebid-requests', `${amendment.id}:${recipient}`) || { id: `${amendment.id}:${recipient}`, rfqId: rfq.id, supplierId: recipient, fromRevision: amendment.baseRevision,
          rfqRevision: nextRevision, reason: amendment.reason, status: 'requested', ownerId: user.id }
        if (!store.get(user.id, 'rebid-requests', rebid.id)) await save(user, 'rebid-requests', rebid, 'procurement/rebid-requested')
        deliveries.push(await exchange(user, recipient, 'rebid-requests', rebid, 'procurement/rebid-delivered'))
        if (deliveries.some(result => result?.received === false)) continue
        amendment = await save(user, 'rfq-amendments', { ...amendment, deliveredIds: [...amendment.deliveredIds, recipient] }, 'procurement/amendment-delivery-progress')
      }
      await reopen(user, rfq)
      if (amendment.deliveredIds.length < rfq.supplierIds.length) return { ok: true, rfq, amendment, deliveryPending: true, message: 'The amendment is recorded, but some suppliers have not acknowledged its delivery. Review Deliveries and retry publication after delivery is resolved.' }
      amendment = await save(user, 'rfq-amendments', { ...amendment, status: 'published', publishedAt: now() }, 'procurement/amendment-published')
      return { ok: true, rfq, amendment, message: `Revision ${nextRevision} delivered to every invited supplier. Previous quotations need rebidding.` }
    }
    if (action === 'ask-clarification') {
      const rfq = checkRfq(user, input.rfqId)
      checkExpected(rfq, input.rfqRevision)
      const itemIds = [...new Set((input.itemIds || []).map(String))]
      if (itemIds.some(id => !rfq.items.some(item => item.id === id))) fail('Choose item references from the current request.')
      const question = required(input.question, 'Question')
      await approval(user, action, rfq.id, input, { question, itemIds, rfqRevision: rfqRevision(rfq) })
      const ticket = await save(user, 'clarifications', { id: newId('clarification'), rfqId: rfq.id, ownerId: rfq.ownerId,
        askerId: user.id, question, itemIds, rfqRevision: rfqRevision(rfq), status: 'open', published: false, previousAnswers: [] }, 'procurement/clarification-asked')
      if (user.id !== rfq.ownerId) await exchange(user, rfq.ownerId, 'clarifications', ticket, 'procurement/clarification-received')
      return { ok: true, clarification: ticket, message: user.id === rfq.ownerId ? 'Question recorded. Prepare and broadcast a shared answer.' : 'Question sent to the contractor. An official answer will be shared with all invited suppliers.' }
    }
    if (action === 'save-clarification-answer') {
      const { ticket, rfq } = ownsTicket(user, input.id)
      if (ticket.status === 'closed' || ticket.status === 'broadcasting') fail('This answer is already shared or being delivered. Wait for an RFQ amendment to reopen it.')
      checkExpected(rfq, input.rfqRevision)
      const source = input.faqId ? get(user, 'faqs', input.faqId) : null
      if (source && source.status !== 'active') fail('That FAQ entry is archived.')
      const answer = required(input.answer ?? source?.answer, 'Answer')
      const updated = await save(user, 'clarifications', { ...ticket, revision: (ticket.revision || 0) + 1, status: 'answered', draftAnswer: answer,
        answerSource: source ? { kind: 'faq', id: source.id, source: source.source } : { kind: actor.startsWith('agent:') ? 'agent-draft' : 'human', accountId: user.id } }, 'procurement/clarification-answer-drafted', actor, input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {})
      return { ok: true, clarification: updated, message: 'Answer saved privately. Review and broadcast it to make it shared guidance.' }
    }
    if (action === 'broadcast-clarification') {
      let { ticket, rfq } = ownsTicket(user, input.id)
      if (ticket.status === 'closed') return { ok: true, clarification: ticket, duplicate: true }
      if (!['answered', 'broadcasting'].includes(ticket.status)) fail('Save an answer before broadcasting it.')
      const answer = required(ticket.draftAnswer || ticket.answer, 'Answer')
      await approval(user, action, ticket.id, input, { question: ticket.question, answer, rfqRevision: ticket.rfqRevision, supplierIds: rfq.supplierIds })
      ticket = await save(user, 'clarifications', { ...ticket, status: 'broadcasting', published: true, answer,
        answeredAt: ticket.answeredAt || now(), broadcastAt: ticket.broadcastAt || now(), deliveredIds: ticket.deliveredIds || [] }, 'procurement/clarification-broadcast-started')
      for (const recipient of rfq.supplierIds) {
        if (ticket.deliveredIds.includes(recipient)) continue
        const delivery = await exchange(user, recipient, 'clarifications', ticketPublic(ticket, recipient), 'procurement/clarification-delivered')
        if (delivery?.received === false) continue
        ticket = await save(user, 'clarifications', { ...ticket, deliveredIds: [...ticket.deliveredIds, recipient] }, 'procurement/clarification-delivery-progress')
      }
      if (ticket.deliveredIds.length < rfq.supplierIds.length) return { ok: true, clarification: ticket, deliveryPending: true, message: 'The answer is recorded, but some suppliers have not acknowledged receipt. Review Deliveries before retrying the broadcast.' }
      const completed = { ...ticket, status: 'closed', broadcastAt: ticket.broadcastAt || now() }
      const deliveries = []
      for (const recipient of rfq.supplierIds) deliveries.push(await exchange(user, recipient, 'clarifications', ticketPublic(completed, recipient), 'procurement/clarification-delivered'))
      if (deliveries.some(result => result?.received === false)) return { ok: true, clarification: ticket, deliveryPending: true, message: 'The answer reached suppliers; some final shared-answer receipts are pending. Review Deliveries and retry the broadcast to complete it.' }
      ticket = await save(user, 'clarifications', completed, 'procurement/clarification-broadcast')
      return { ok: true, clarification: ticket, message: `Answer delivered to all ${rfq.supplierIds.length} invited suppliers.` }
    }
    if (action === 'save-faq') {
      const ticket = get(user, 'clarifications', input.clarificationId)
      if (ticket.status !== 'closed' || !ticket.answer) fail('Only a fully broadcast answer can become a reusable FAQ.')
      const prior = store.list(user.id, 'faqs').find(row => row.source?.ticketId === ticket.id && row.source?.rfqRevision === ticket.rfqRevision)
      if (prior) return { ok: true, faq: prior, duplicate: true }
      const faq = await save(user, 'faqs', { id: newId('faq'), ownerId: user.id, question: ticket.question, answer: ticket.answer,
        status: 'active', source: { ticketId: ticket.id, rfqId: ticket.rfqId, rfqRevision: ticket.rfqRevision, broadcastAt: ticket.broadcastAt } }, 'procurement/faq-saved')
      return { ok: true, faq, message: 'FAQ saved in your account with its source. Reusing it creates a new draft answer.' }
    }
    if (action === 'archive-faq') {
      const faq = get(user, 'faqs', input.id)
      if (faq.ownerId !== user.id) fail('This FAQ belongs to another account.', 403)
      return { ok: true, faq: await save(user, 'faqs', { ...faq, status: 'archived', archivedAt: now() }, 'procurement/faq-archived') }
    }
  }
  function snapshot(user, rfqs) {
    const visible = new Set(rfqs.map(row => row.id))
    return { projects: store.list(user.id, 'projects').filter(row => row.ownerId === user.id),
      sections: store.list(user.id, 'sections').filter(row => row.ownerId === user.id),
      amendments: store.list(user.id, 'rfq-amendments').filter(row => row.ownerId === user.id && visible.has(row.rfqId)),
      rfqVersions: store.list(user.id, 'rfq-versions').filter(row => visible.has(row.rfqId)),
      clarifications: store.list(user.id, 'clarifications').filter(row => visible.has(row.rfqId)).map(row => user.role === 'supplier' ? ticketPublic(row, user.id) : row),
      faqs: store.list(user.id, 'faqs').filter(row => row.ownerId === user.id),
      rebidRequests: store.list(user.id, 'rebid-requests').filter(row => visible.has(row.rfqId) && (row.ownerId === user.id || row.supplierId === user.id)) }
  }
  return { contextFields, version, publicVersion, actions, execute, snapshot, checkExpected }
}
