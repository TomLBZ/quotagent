import {createHash} from 'node:crypto'
const hash=value=>createHash('sha256').update(value).digest('hex')
export const reusableFaqKeys=['unit','measurement_note','deadline_note','scope_note','delivery_note','warranty_note','payment_note','exclusion_note','safety_note']
const questionHash=value=>hash(String(value??'').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' '))
const blocked=/reserve[_ -]?price|cost[_ -]?model|\bsignature\b|private\s*:/i
export function createFaq(h){
 const {store,get,save,fail,required,newId,approval}=h
 const sourceRef=(user,collection,id)=>{const event=store.events(user.id).findLast(row=>row.body?.collection===collection&&row.body.record?.id===id);if(!event)fail('The FAQ source has no ledger reference.');return{realm:user.id,seq:event.seq,hash:event.entry_hash}}
 const fields=value=>{if(!Array.isArray(value)||!value.length)fail('Select at least one explicit reusable field.');const keys=new Set();return value.map(row=>{if(!reusableFaqKeys.includes(row.key)||keys.has(row.key))fail('Choose unique supported reusable field keys; private or credential fields are not allowed.');keys.add(row.key);const text=required(row.value,'Reusable field value');if(blocked.test(text))fail('Private-price, cost-model or signature markers cannot be published as reusable FAQ fields.');return{key:row.key,value:text}})}
 const source=(user,id)=>{const ticket=get(user,'clarifications',id),rfq=get(user,'rfqs',ticket.rfqId);if(ticket.status!=='closed'||!ticket.answer||!ticket.published)fail('Use a fully broadcast clarification answer as the source.');if(ticket.rfqRevision!==(rfq.publishedRevision||1))fail('The answer belongs to an older request revision. Resolve the current clarification before publishing reusable facts.',409);return{ticket,rfq}}
 const snapshot=user=>store.list(user.id,'faqs').filter(row=>row.ownerId===user.id)
 const lookup=(user,input)=>{
  const rfq=store.get(user.id,'rfqs',input.rfqId),revision=Number(input.rfqRevision),none=(reason,nextAction)=>({hit:false,entry:null,reason,nextAction,rfqId:input.rfqId,rfqRevision:revision})
  if(!Number.isInteger(revision)||revision<1||!String(input.question||'').trim())fail('Provide an explicit positive source revision and question for exact lookup.')
  if(!rfq)return none('faq-unknown-request','Open a request available in your current workspace.')
  const candidates=snapshot(user).filter(row=>row.schema==='quotagent/faq/v1'&&row.status==='published'&&row.questionHash===questionHash(input.question))
  const entry=candidates.find(row=>row.source.rfqId===rfq.id&&row.source.rfqRevision===revision)
  if(entry)return{hit:true,entry:{id:entry.id,question:entry.question,fields:entry.fields,source:entry.source,publishedBy:entry.publishedBy,publishedAt:entry.publishedAt},reason:'faq-hit',nextAction:'Review these exact source fields before using them in a new private answer draft.',rfqId:rfq.id,rfqRevision:revision}
  if(candidates.length)return none('faq-version-mismatch','No content returned. Choose the exact source request/revision, or explicitly adapt a historical source into a new private answer for human review.')
  return none('faq-not-published','No published structured entry matches this question. Review a source clarification and publish selected reusable fields first.')
 }
 const actions=new Set(['prepare-faq','publish-faq','deprecate-faq','adapt-faq'])
 async function execute(user,action,input,{agent=false}={}){
  if(action==='prepare-faq'){
   const {ticket,rfq}=source(user,input.clarificationId),prior=input.id?get(user,'faqs',input.id):null
   if(prior&&(prior.ownerId!==user.id||prior.status!=='draft'))fail('Only your own unpublished FAQ candidate can be edited.',403)
   const values=fields(input.fields),question=required(input.question??ticket.question,'Reusable question');if(blocked.test(question))fail('Remove private markers from the reusable question.')
   const record={...prior,id:prior?.id||newId('faq'),schema:'quotagent/faq/v1',ownerId:user.id,status:'draft',revision:(prior?.revision||0)+1,question,questionHash:questionHash(question),fields:values,source:{ticketId:ticket.id,rfqId:rfq.id,rfqRevision:ticket.rfqRevision,questionHash:questionHash(ticket.question),answerHash:hash(ticket.answer),ticketRef:sourceRef(user,'clarifications',ticket.id),rfqRef:sourceRef(user,'rfqs',rfq.id)},authoredBy:user.actorId||user.id}
   return{ok:true,faq:await save(user,'faqs',record,'procurement/faq-candidate-prepared',`${agent?'agent':'human'}:${user.actorId||user.id}`,input.expectedRevision!==undefined?{expectedRevision:input.expectedRevision}:{}),message:'Reusable fields saved as a private candidate. Human publication is still required.'}
  }
  const entry=get(user,'faqs',input.id);if(entry.ownerId!==user.id)fail('This FAQ belongs to another workspace.',403)
  if(action==='publish-faq'){
   if(entry.schema!=='quotagent/faq/v1')fail('Prepare explicit reusable fields from the original clarification first.')
   if(entry.status==='published')return{ok:true,faq:entry,duplicate:true};if(entry.status!=='draft')fail('Only a private FAQ candidate can be published.')
   const {ticket}=source(user,entry.source.ticketId)
   if(ticket.rfqRevision!==entry.source.rfqRevision||hash(ticket.answer)!==entry.source.answerHash)fail('The source answer changed. Prepare a fresh candidate.',409)
   fields(entry.fields);await approval(user,action,entry.id,input,entry)
   const published=await save(user,'faqs',{...entry,status:'published',publishedBy:user.actorId||user.id,publishedAt:new Date().toISOString()},'procurement/faq-published')
   return{ok:true,faq:published,message:'Selected reusable fields published in your own workspace with exact source references.'}
  }
  if(action==='deprecate-faq'){
   if(entry.status==='deprecated')return{ok:true,faq:entry,duplicate:true}
   return{ok:true,faq:await save(user,'faqs',{...entry,status:'deprecated',deprecationReason:required(input.reason,'Deprecation reason'),deprecatedBy:user.actorId||user.id,deprecatedAt:new Date().toISOString()},'procurement/faq-deprecated'),message:'Entry deprecated. Its source and publication history remain readable; exact lookup no longer returns it.'}
  }
  if(action==='adapt-faq'){
   if(entry.schema!=='quotagent/faq/v1'||entry.status!=='published')fail('Choose a currently published structured source to adapt.')
   const ticket=get(user,'clarifications',input.clarificationId),rfq=get(user,'rfqs',ticket.rfqId)
   if(rfq.ownerId!==user.id||rfq.status!=='published'||!['open','answered'].includes(ticket.status))fail('Adapt only into your own open current clarification.',403)
   if(ticket.rfqRevision!==(rfq.publishedRevision||1))fail('Reload the current clarification revision.',409)
   const answer=required(input.answer,'Adapted answer'),reason=required(input.reason,'Adaptation reason')
   return{ok:true,clarification:await save(user,'clarifications',{...ticket,revision:(ticket.revision||0)+1,status:'answered',draftAnswer:answer,answerSource:{kind:'structured-faq-adaptation',faqId:entry.id,source:entry.source,sourceRef:sourceRef(user,'faqs',entry.id),targetRfqId:rfq.id,targetRevision:ticket.rfqRevision,reason,exactVersion:entry.source.rfqId===rfq.id&&entry.source.rfqRevision===ticket.rfqRevision}},'procurement/faq-adaptation-drafted',`${agent?'agent':'human'}:${user.actorId||user.id}`,input.expectedRevision!==undefined?{expectedRevision:input.expectedRevision}:{}),message:'Adaptation is a new private answer draft. Review and broadcast separately; this is not an exact FAQ lookup hit.'}
  }
 }
 return{actions,execute,lookup,state:user=>({structuredFaqKeys:reusableFaqKeys,faqs:snapshot(user)})}
}
