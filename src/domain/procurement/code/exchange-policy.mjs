import {quoteDeclarations} from './quote-declarations.mjs'
import {validatePublishedScope} from './structured-scope.mjs'
const copy = value => structuredClone(value)
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key,ordered(value[key])])) : value
const equal = (a,b) => JSON.stringify(ordered(a ?? null)) === JSON.stringify(ordered(b ?? null))
const semantic = value => Array.isArray(value) ? value.map(semantic) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key])=>!['createdAt','updatedAt','publishedAt','submittedAt','confirmedAt','signedAt','approvedAt','appliedAt','answeredAt','broadcastAt','withdrawnAt','closedAt'].includes(key) && !['createdAt','updatedAt','status','stale','staleReason','cost','costTotal','privateNotes','margin','costComplete','marginBasis'].includes(key)).map(([key,row])=>[key,semantic(row)])) : value
const select = (record,keys) => Object.fromEntries(keys.map(key=>[key,record?.[key] ?? null]))
const financial = record => semantic(select(record,['quoteId','currency','items','total','subtotal','priceBreakdown','commercial','leadDays','paymentTerms','assumptions','exclusions','schedule','terms','requiredTerms','termExceptions']))
const quoteFields = 'id rfqId supplierId supplierName ownerId leadDays paymentTerms notes terms assumptions exclusions schedule status total currency revision rfqRevision commercial subtotal priceBreakdown createdAt updatedAt submittedAt supersededBy withdrawnReason withdrawnAt demo items'.split(' ')
const rfqFields = 'id title description deadline clarifyDeadline currency items scope scopePolicy terms status ownerId ownerName revision publishedRevision initialRevision projectId projectName sectionId sectionName amendmentReason requirements createdAt updatedAt publishedAt closedReason closedAt demo supplierIds'.split(' ')
const fields = {
 rfqs:rfqFields,quotes:quoteFields,'quote-status':['id','status','orderId'],
 orders:'id rfqId quoteId awardId rfqRevision title ownerId ownerName supplierId supplierName originalTotal currency status orderRevision commercial assumptions exclusions schedule terms requiredTerms termExceptions items originalItems leadDays paymentTerms supplierConfirmedBy supplierConfirmedAt signedBy signedAt reviewActionId subtotal total priceBreakdown createdAt updatedAt acknowledgedAt acknowledgedBy awardedBy lastChangeId'.split(' '),
 changes:'id orderId rfqId title description ownerId supplierId proposedBy proposedByActor status baseOrderRevision lines proposedItems proposedAmounts amount currency settledBy createdAt updatedAt counterpartyConfirmedBy decisionReason confirmedAt approvedBy approvedAt reviewActionId appliedOrderRevision appliedAt'.split(' '),
 messages:'id rfqId fromId fromName toId text kind binding createdAt updatedAt'.split(' '),
 'rfq-versions':['id','rfqId','publishedRevision','snapshot','createdAt','updatedAt'],
 clarifications:'id rfqId ownerId askerId rfqRevision question itemIds status published askedByYou answer answeredAt broadcastAt previousAnswers reopenedReason createdAt updatedAt'.split(' '),
 'rebid-requests':'id rfqId supplierId fromRevision rfqRevision reason status ownerId quoteId createdAt updatedAt'.split(' '),
 'award-intents':'id rfqId quoteId ownerId ownerName supplierId supplierName title status binding quote quoteDigest rfqRevision total currency reason terms requiredTerms termExceptions proposedBy createdAt updatedAt decisionReason decidedBy confirmedBy confirmedAt orderId signedBy reviewActionId'.split(' '),
 acceptances:'id orderId rfqId ownerId supplierId reference acceptedAt lines deficiencies orderRevision recordedBy createdAt updatedAt'.split(' '),
 invoices:'id orderId rfqId ownerId supplierId invoiceNumber invoiceDate currency lines taxAmount freightAmount total computedTotal status recordedBy recordedByParty createdAt updatedAt lastMatchId'.split(' '),
 'invoice-matches':'id orderId orderRevision invoiceId acceptanceIds previousInvoiceIds ownerId supplierId status differences invoiceTotal currency checkedBy checkedAt createdAt updatedAt'.split(' '),
}
const actions = {
 rfqs:['publish-rfq','publish-amendment','close-rfq','sign-order','award'],quotes:['submit-quote','withdraw-quote'],
 'quote-status':['sign-order','award'],orders:['sign-order','award','acknowledge-order','approve-change'],
 changes:['propose-change','confirm-change','reject-change','approve-change','settle-change'],
 'award-intents':['propose-award','confirm-award','decline-award','withdraw-award','sign-order','award'],
 acceptances:['record-acceptance'],invoices:['record-invoice','reconcile-invoice'],'invoice-matches':['reconcile-invoice'],
 'rfq-versions':['publish-rfq','publish-amendment'],'rebid-requests':['publish-amendment','submit-quote'],
 clarifications:['ask-clarification','broadcast-clarification','publish-amendment'],messages:[],
}
const reject = message => { throw Object.assign(new Error(message),{status:409,code:'PROCUREMENT_EXCHANGE_POLICY'}) }
function publicShape(collection,record,to) {
 if (!fields[collection] || Object.keys(record).some(key=>!fields[collection].includes(key))) reject('The outgoing procurement record includes unsupported or private fields.')
 const check = value => { if(Array.isArray(value))value.forEach(check);else if(value&&typeof value==='object'){if(Object.keys(value).some(key=>['cost','costTotal','privateNotes','margin','internalScore','benchmark','draftAnswer','answerSource','deliveredIds'].includes(key)))reject('Private prices, evaluations or answer drafts cannot be exchanged.');Object.values(value).forEach(check)} };check(record)
 if(collection==='rfqs' && (!equal(record.supplierIds,[to]) || record.status==='draft'))reject('A public request exposes only its recipient invitation and published scope.')
 if(collection==='quotes' && record.status==='draft')reject('Quotation drafts cannot be exchanged.')
 if(collection==='rfq-versions')publicShape('rfqs',record.snapshot,to)
 if(collection==='award-intents')publicShape('quotes',record.quote,to)
 if(collection==='clarifications' && record.ownerId!==to && record.askerId)reject('Another bidder identity cannot be included in shared clarification.')
}
function sourceMatches(collection,record,event) {
 const body=event.body||{},scope=body.scope||{},action=body.action
 if(!actions[collection]?.includes(action))return false
 if(collection==='orders'){
  if(['sign-order','award'].includes(action))return scope.id===record.awardId && !!body.authority?.grantId && equal(financial({...scope.quote,quoteId:scope.quoteId,terms:scope.terms,requiredTerms:scope.requiredTerms,termExceptions:scope.termExceptions}),financial(record))
  if(action==='approve-change')return scope.orderId===record.id && !!body.authority?.grantId && equal(semantic({items:scope.proposedItems,...scope.proposedAmounts}),semantic(select(record,['items','subtotal','total','priceBreakdown'])))
  return scope.id===record.id&&equal(financial(scope),financial(record))
 }
 if(collection==='quotes'){const keys=quoteFields.filter(key=>!['supersededBy','withdrawnReason','withdrawnAt'].includes(key));return scope.id===record.id&&equal(semantic(select(scope,keys)),semantic(select(record,keys))) || record.status==='superseded'&&scope.id===record.supersededBy&&scope.rfqId===record.rfqId}
 if(collection==='award-intents')return scope.id===record.id&&equal(semantic(select(scope,['quote','terms','requiredTerms','termExceptions'])),semantic(select(record,['quote','terms','requiredTerms','termExceptions'])))
 if(collection==='quote-status')return scope.quoteId===record.id&&!!body.authority?.grantId
 if(collection==='changes')return scope.id===record.id&&equal(semantic(select(scope,['lines','proposedItems','proposedAmounts','amount','currency','orderId','baseOrderRevision'])),semantic(select(record,['lines','proposedItems','proposedAmounts','amount','currency','orderId','baseOrderRevision'])))&&(!['applied','approved'].includes(record.status)||!!body.authority?.grantId)
 if(collection==='acceptances')return scope.id===record.id&&equal(semantic(scope),semantic(record))
 if(collection==='invoices')return action==='record-invoice'?scope.id===record.id&&equal(semantic(scope),semantic(record)):scope.invoice?.id===record.id&&equal(semantic(select(scope.invoice,['lines','taxAmount','freightAmount','total','computedTotal','currency'])),semantic(select(record,['lines','taxAmount','freightAmount','total','computedTotal','currency'])))
 if(collection==='invoice-matches')return scope.invoice?.id===record.invoiceId&&equal(scope.sources,select(record,['orderId','orderRevision','invoiceId','acceptanceIds','previousInvoiceIds']))&&equal(scope.differences,record.differences)
 if(collection==='rfqs'){
  if(['sign-order','award'].includes(action))return scope.rfqId===record.id&&scope.rfqRevision===(record.publishedRevision||record.revision)&&!!body.authority?.grantId
  const source=action==='publish-amendment'?scope.fields:scope
  const keys=['title','description','deadline','clarifyDeadline','currency','items','scope','terms','requirements','projectId','sectionId']
  return (scope.id===record.id||scope.rfqId===record.id)&&equal(semantic(select(source,keys)),semantic(select(record,keys)))
 }
 if(collection==='rfq-versions')return sourceMatches('rfqs',record.snapshot,event)
 if(collection==='rebid-requests')return scope.rfqId===record.rfqId&&(scope.baseRevision+1===record.rfqRevision||scope.rfqRevision===record.rfqRevision)
 if(collection==='clarifications')return action==='ask-clarification'?body.recordId===record.rfqId&&scope.question===record.question&&scope.rfqRevision===record.rfqRevision:action==='broadcast-clarification'?body.recordId===record.id&&scope.question===record.question&&scope.answer===record.answer&&scope.rfqRevision===record.rfqRevision:scope.rfqId===record.rfqId&&scope.baseRevision+1===record.rfqRevision
 return false
}
export function procurementExchangePolicy({store,accounts,procurement}) {
 const commitment = (collection,record) => !record.demo && (collection==='quotes'&&record.status==='submitted'||collection==='orders'||collection==='quote-status'||collection==='changes'&&['approved','applied','settled'].includes(record.status)||collection==='award-intents'&&record.status==='committed')
 const reference = (realm,event) => ({realm,seq:event.seq,hash:event.entry_hash})
 return {
  id:'procurement',collections:Object.keys(fields),
  async prepare({from,to,collection,record}){
   publicShape(collection,record,to)
   const events=store.events(from),source=[...events].reverse().find(event=>event.type==='procurement/human-approved'&&sourceMatches(collection,record,event))
   const fact=[...events].reverse().find(event=>event.body?.collection===collection&&event.body.record?.id===record.id)
   const demoSource=collection==='rfq-versions'&&record.snapshot?.demo ? [...events].reverse().find(event=>event.type?.startsWith('procurement/demo-')&&event.body?.collection==='rfqs'&&event.body.record?.id===record.rfqId) : fact
   const demo=!!(record.demo||record.snapshot?.demo)&&demoSource?.type?.startsWith('procurement/demo-')
   if(!source&&!demo&&collection!=='messages')reject(`No recorded human decision authorizes this ${collection} transfer.`)
   if(collection==='messages'&&(!fact||!fact.actor?.startsWith('human:')||record.binding!==false))reject('A message needs its signed-in human source and must remain nonbinding.')
   const eventClass=demo?'fact':commitment(collection,record)?'commitment':['award-intents','changes','rebid-requests'].includes(collection)?'intent':'fact'
   return {type:`procurement/${collection}`,eventClass,refs:{source:reference(from,source||(demo?demoSource:fact)),object_id:record.id,rfq_id:record.rfqId||record.snapshot?.rfqId||null},approvals:source?[{by:`human:${source.body.humanId}`,at:source.body.approvedAt,scope:{action:source.body.action,objectId:source.body.recordId,revision:record.orderRevision||record.rfqRevision||record.publishedRevision||record.revision||1,semantic:semantic(copy(record)),...(source.body.authority?{authority:copy(source.body.authority)}:{})},sourceRef:reference(from,source)}]:[]}
  },
  async validate({from,to,collection,record,local,metadata,peer}){
   try{
    publicShape(collection,record,to)
    if(collection==='rfqs'||collection==='rfq-versions')validatePublishedScope(collection==='rfqs'?record:record.snapshot)
    const sender=accounts.get(from)||(peer?.realm===from?peer:null),recipient=accounts.get(to)
    if(!sender||!recipient)reject('The sender or recipient business account is unavailable.')
    const rfq=collection==='rfqs'?record:collection==='rfq-versions'?record.snapshot:store.get(to,'rfqs',record.rfqId||local?.rfqId)
    const order=record.orderId?store.get(to,'orders',record.orderId):collection==='orders'?record:null
    const ownerId=record.ownerId||rfq?.ownerId||order?.ownerId,supplierId=record.supplierId||order?.supplierId
    if(collection==='messages'){if(record.fromId!==from||record.toId!==to||!rfq||![rfq.ownerId,...rfq.supplierIds].includes(from))reject('The message participants do not match the request.')}
    else if(collection==='quotes'){if(from!==record.supplierId||to!==record.ownerId)reject('Only the named supplier can publish its quote to the request owner.')}
    else if(['rfqs','rfq-versions','acceptances','invoice-matches','quote-status'].includes(collection)){
     const quote=collection==='quote-status'?store.get(to,'quotes',record.id):null
     if(from!==(ownerId||quote?.ownerId)||sender.role!=='contractor')reject('Only the contractor controls this record.')
    }else if(![ownerId,supplierId,record.askerId].includes(from)&&!(collection==='clarifications'&&from===rfq?.ownerId))reject('This sender is not a party to the record.')
    if(collection==='quotes'&&!record.demo){
     const declared=quoteDeclarations({},record,record.items.map(item=>item.id));if(!equal(declared,Object.fromEntries(['assumptions','exclusions','schedule'].filter(key=>record[key]!==undefined).map(key=>[key,record[key]]))))reject('Quotation schedule and qualifications must retain valid exact declarations.')
     const source=record.rfqRevision ? store.get(to,'rfq-versions',`${record.rfqId}:v${record.rfqRevision}`)?.snapshot||rfq : rfq
     if(!source||!equal(procurement.normalizeQuoteItems(record.items,source),record.items))reject('Quotation lines must retain their requested source or explicit additional/alternative classification and exact normalization basis.')
     if(record.items.some(item=>procurement.normalizeQuotePrice([item],{}).subtotal!==item.total))reject('Quotation line totals do not match their unit rates and quantities.')
     const amounts=procurement.normalizeQuotePrice(record.items,record.commercial||{})
     if(amounts.total!==record.total||record.subtotal!==undefined&&amounts.subtotal!==record.subtotal||record.priceBreakdown&&!equal(amounts.priceBreakdown,record.priceBreakdown))reject('Quotation totals do not match the declared source rates, tax and freight.')
    }
    if(collection==='changes'){
     if(!order||record.ownerId!==order.ownerId||record.supplierId!==order.supplierId)reject('This change does not belong to an existing agreement between these parties.')
     const basis=['lines','proposedItems','proposedAmounts','amount','currency','orderId','baseOrderRevision','proposedBy']
     if(local&&!equal(select(local,basis),select(record,basis)))reject('Confirmation or approval cannot alter the previously proposed change terms.')
     if(!local){
      if(record.status!=='proposed'||from!==record.proposedBy||(order.orderRevision||1)!==record.baseOrderRevision)reject('A new change must be a proposal against the current approved order revision.')
      const plan=procurement.previewChange({...recipient,workspaceOwnerId:to},order.id,record.lines)
      if(!equal(plan.lines,record.lines)||!equal(plan.items,record.proposedItems)||!equal(plan.amounts,record.proposedAmounts)||plan.amount!==record.amount)reject('The declared change amount and scope do not match its original quoted-line calculations.')
     }
     if(['confirmed','rejected'].includes(record.status)&&from===record.proposedBy)reject('The proposing party cannot supply its own counterparty confirmation.')
    }
    if(collection==='orders'&&from===record.ownerId){
     if(!local){
      const intent=store.get(to,'award-intents',record.awardId)
      if(!intent||intent.status!=='confirmed'||!intent.confirmedBy||!equal(financial({...intent.quote,quoteId:intent.quoteId,terms:intent.terms,requiredTerms:intent.requiredTerms,termExceptions:intent.termExceptions}),financial(record)))reject('A new purchase order must match this supplier’s confirmed award intent exactly.')
     }else if(!equal(financial(local),financial(record))){
      const change=store.get(to,'changes',record.lastChangeId)
      if(!change||!['confirmed','approved','applied'].includes(change.status)||!change.counterpartyConfirmedBy||change.baseOrderRevision!==(local.orderRevision||1)||record.orderRevision!==change.baseOrderRevision+1||!equal(record.items,change.proposedItems)||!equal(select(record,['subtotal','total','priceBreakdown']),change.proposedAmounts)||!equal(select(record,['quoteId','currency','commercial','leadDays','paymentTerms','assumptions','exclusions','schedule','terms','requiredTerms','termExceptions']),select(local,['quoteId','currency','commercial','leadDays','paymentTerms','assumptions','exclusions','schedule','terms','requiredTerms','termExceptions'])))reject('Revised order money or scope must match the locally confirmed sourced change.')
     }
    }
    if(collection==='orders'&&from!==record.ownerId){if(from!==record.supplierId||record.status!=='acknowledged'||!local||!equal(semantic(select(record,Object.keys(record).filter(key=>!['status','acknowledgedAt','acknowledgedBy','updatedAt'].includes(key)))),semantic(select(local,Object.keys(record).filter(key=>!['status','acknowledgedAt','acknowledgedBy','updatedAt'].includes(key))))))reject('Supplier acknowledgment cannot alter approved order scope or money.')}
    if(collection==='award-intents'&&from!==record.ownerId&&(!['confirmed','declined'].includes(record.status)||!local||!equal(semantic(local.quote),semantic(record.quote))))reject('Supplier confirmation must preserve the proposed offer.')
    if(collection==='changes'&&['approved','applied'].includes(record.status)&&from!==record.ownerId)reject('Only the contractor can authorize and apply a financial change.')
    if(collection==='quotes'&&record.status==='submitted'&&record.rfqRevision!==undefined&&rfq&&record.rfqRevision!==(rfq.publishedRevision||rfq.revision||1))reject('Quotation refers to a different published request revision; request a rebid.')
    if(collection==='rfqs'&&local&&(record.publishedRevision||1)<(local.publishedRevision||1))reject('An older request version cannot replace current scope.')
    const approvals=metadata.approvals||[]
    if(commitment(collection,record)&&metadata.eventClass!=='commitment')reject('This public financial commitment needs the commitment class.')
    if(approvals.some(proof=>!equal(proof.scope?.semantic,semantic(record))))reject('The human decision does not bind these exact public business fields.')
    if(commitment(collection,record)&&!approvals.length)reject('A human decision is required for this commitment.')
    if((collection==='orders'&&from===record.ownerId||collection==='quote-status'||collection==='changes'&&['approved','applied'].includes(record.status)||collection==='award-intents'&&record.status==='committed')&&!approvals.some(proof=>proof.scope?.authority?.grantId))reject('The monetary commitment is missing its independent review grant.')
    return {ok:true}
   }catch(error){return {ok:false,code:error.code||'PROCUREMENT_EXCHANGE_POLICY',message:error.message,nextAction:'Review the current source, participants and human decision; prepare a corrected reviewed transfer.'}}
  },
  authority({collection,path,record,from}){
   const key=Array.isArray(path)?path[0]:String(path||'').replace(/^\//,'').split(/[/.]/)[0]
   let owner='sender'
   if(collection==='quotes')owner=record.supplierId
   else if(collection==='rfqs'||collection==='rfq-versions')owner=record.ownerId||record.snapshot?.ownerId
   else if(collection==='orders'&&!['status','acknowledgedAt','acknowledgedBy','updatedAt'].includes(key))owner=record.ownerId
   else if(collection==='changes'&&['lines','proposedItems','proposedAmounts','amount','currency','orderId','baseOrderRevision','title','description','proposedBy','proposedByActor'].includes(key))owner=record.proposedBy
   else if(['acceptances','invoice-matches','quote-status'].includes(collection))owner=record.ownerId||'sender'
   return {owner:owner||from,commitment:!['createdAt','updatedAt','submittedAt','signedAt','approvedAt','confirmedAt','appliedAt','acknowledgedAt'].includes(key)&&commitment(collection,record)}
  },
 }
}
