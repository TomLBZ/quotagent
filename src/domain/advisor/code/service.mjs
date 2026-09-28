import {randomUUID} from 'node:crypto'
import {staleQuote} from '../../procurement/code/rfq-lifecycle.mjs'
import {modes,publicRequest,publicQuotation,questionsFor,uncertaintiesFor} from './rubrics.mjs'
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})}
const now=()=>new Date().toISOString(),collection='advisor-assessments'
const text=(value,label,max=16000)=>{if(value!==undefined&&typeof value!=='string')fail(`${label} must be text.`);const result=(value||'').trim();if(result.length>max)fail(`${label} exceeds ${max} characters. Narrow it explicitly; text is never silently cut.`);return result}
export function createAdvisor(ctx){
 const store=ctx.store,accounts=ctx.accounts,procurement=ctx.procurement,jev=ctx.get('jev')
 const pending=new Map();let disposed=false
 const client=user=>{if(!user?.id||!['contractor','supplier'].includes(user.role))fail('Open a supplier or contractor workspace to assess quotations.',403);if(!accounts.can(user,'assistant:use'))fail('AI assessment access is disabled for this account.',403);return user}
 const snapshot=user=>procurement.snapshot(client(user))
 const source=(data,kind,record)=>{const event=store.events(data.realmId).findLast(row=>row.body?.collection===kind&&row.body.record?.id===record.id);if(!event)fail('The selected source has no reconstructable ledger record.',409);return{realm:data.realmId,collection:kind,id:record.id,title:record.title||record.supplierName,revision:record.revision,seq:event.seq,hash:event.entry_hash,...(kind==='quotes'?{statusHash:store.events(data.realmId).findLast(row=>row.body?.collection==='quote-status'&&row.body.record?.id===record.id)?.entry_hash||null}:{})}}
 const stale=row=>{
  if(row.sources.some(ref=>{const events=store.events(ref.realm),latest=events.findLast(event=>event.body?.collection===ref.collection&&event.body.record?.id===ref.id);return !latest||latest.entry_hash!==ref.hash||ref.collection==='quotes'&&(events.findLast(event=>event.body?.collection==='quote-status'&&event.body.record?.id===ref.id)?.entry_hash||null)!==ref.statusHash}))return true
  if(row.mode==='shortlist'){const rfq=store.get(row.realmId,'rfqs',row.rfqId),current=store.list(row.realmId,'quotes').map(quote=>({...quote,...(store.get(row.realmId,'quote-status',quote.id)||{})})).filter(quote=>quote.rfqId===row.rfqId&&!staleQuote(quote,rfq)&&['submitted','awarded'].includes(quote.status)).map(quote=>quote.id).sort();return JSON.stringify(current)!==JSON.stringify(row.candidateIds)}
  return false
 }
 const decorate=row=>({...row,stale:stale(row),advisoryOnly:true,action:{action:'navigate',label:'Review Jev assessment',input:{view:'advisor',assessmentId:row.id,rfqId:row.rfqId,workspaceId:row.realmId}}})
 const get=(user,id)=>{const data=snapshot(user),row=store.get(user.id,collection,id);if(!row||row.realmId!==data.realmId||row.role!==user.role)fail('This assessment is not available in the selected workspace.',404);return decorate(row)}
 const state=user=>{const data=snapshot(user);return{status:jev.status(user),settings:jev.settings(user),rfqs:data.rfqs.map(row=>({id:row.id,title:row.title,revision:row.revision})),quotes:data.quotes.map(row=>({id:row.id,rfqId:row.rfqId,supplierName:row.supplierName,revision:row.revision,status:row.status,stale:row.stale})),modes:modes.filter(row=>!row.roles||row.roles.includes(user.role)),assessments:store.list(user.id,collection).filter(row=>row.realmId===data.realmId&&row.role===user.role).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(decorate)}}
 const prepare=(user,input)=>{
  const data=snapshot(user),mode=modes.find(row=>row.id===input.mode&&(!row.roles||row.roles.includes(user.role)));if(!mode)fail('Choose an assessment available for your role.')
  const rfq=data.rfqs.find(row=>row.id===input.rfqId);if(!rfq)fail('Choose a request available in this workspace.',404)
  const message=text(input.text,'Source or question'),sources=[source(data,'rfqs',rfq)],request=publicRequest(rfq),state={request},claims=input.claims||[]
  let quotes=[]
  if(mode.id==='quote-review'){
   const quote=data.quotes.find(row=>row.id===input.quoteId&&row.rfqId===rfq.id);if(!quote)fail('Choose a quotation for this request.',404)
   if(quote.stale||['withdrawn','superseded'].includes(quote.status))fail('This quotation is stale or withdrawn. Select a current quotation.',409)
   sources.push(source(data,'quotes',quote));state.quote=publicQuotation(quote);if(message)state.text=message
  }else if(mode.id==='shortlist'){
   if(!message)fail('State your priorities for the shortlist; they will not be guessed.')
   quotes=data.quotes.filter(row=>row.rfqId===rfq.id&&!row.stale&&['submitted','awarded'].includes(row.status));if(!quotes.length)fail('Receive a current quotation before asking for a shortlist.')
   if(quotes.length>30)fail('This request has more than30 current offers. Use an explicit smaller package; offers are never silently omitted.')
   for(const quote of quotes)sources.push(source(data,'quotes',quote));state.quotes=quotes.map(publicQuotation);state.text=message
  }else{
   if(!message)fail(mode.id==='clarification'?'Enter the clarification question.':'Paste the source text to check.');state.text=message
   if(mode.id==='field-check'){
    if(!Array.isArray(claims)||!claims.length||claims.length>12)fail('Provide between one and12 explicit claims.')
    state.claims=claims.map(value=>{const claim=text(value,'Claim',1200);if(!claim)fail('Claims cannot be blank.');return claim})
   }
  }
  return{realmId:data.realmId,mode:mode.id,title:`${mode.label} · ${rfq.title}`,rfqId:rfq.id,quoteId:state.quote?.id||null,sources,state,...(mode.id==='shortlist'?{candidateIds:quotes.map(row=>row.id).sort()}:{}),questions:questionsFor(mode.id,{quotes,claims:state.claims})}
 }
 const assess=async(user,input={},context={})=>{
  if(disposed)fail('The quotation advisor is reloading.',409)
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['mode','rfqId','quoteId','text','claims','clientRequestId'].includes(key)))fail('Use mode, request, quotation and explicit source text/claims only.')
  if(input.clientRequestId!==undefined&&(typeof input.clientRequestId!=='string'||!/^[-a-zA-Z0-9]{16,80}$/.test(input.clientRequestId)))fail('Invalid client request correlation identifier.')
  const prepared=prepare(user,input),id=randomUUID(),controller=new AbortController(),abort=()=>controller.abort(context.signal?.reason),threshold=jev.settings(user).confidenceThreshold
  if(context.signal?.aborted)abort();else context.signal?.addEventListener('abort',abort,{once:true})
  const initial={id,...prepared,role:user.role,...(input.clientRequestId?{clientRequestId:input.clientRequestId}:{}),status:'pending',createdAt:now(),threshold,answers:{},requiresReview:true,uncertainties:[],review:null,reviews:[]}
  const work=(async()=>{
   await store.put(user.id,collection,initial,{event:'advisor/assessment-created',actor:context.runId?`agent:${user.id}`:`human:${user.id}`})
   let result
   try{
    result=await jev.evaluate(user,{state:prepared.state,questions:prepared.questions,purpose:`advisor:${prepared.mode}`,signal:controller.signal,runId:context.runId||null,requestKey:id,sources:prepared.sources})
   }catch(error){
    const row={...initial,status:controller.signal.aborted?'interrupted':'unavailable',finishedAt:now(),error:error.message,code:error.code||'provider-unavailable',callId:error.callId||null,uncertainties:['No usable provider assessment is available. Continue the ordinary quotation workflow and review the sources manually.']}
    await store.put(user.id,collection,row,{event:row.status==='interrupted'?'advisor/assessment-interrupted':'advisor/assessment-unavailable',actor:`agent:${user.id}`})
    if(context.signal?.aborted)throw error
    return decorate(row)
   }
   const uncertainties=uncertaintiesFor(result.answers,threshold),row={...initial,status:'completed',finishedAt:now(),model:result.model,callId:result.callId,requestSha256:result.requestSha256,answers:result.answers,usage:result.usage,tokens:result.tokens,requiresReview:uncertainties.length>0,uncertainties,summary:'Jev supplied typed suggestions for private human review. No quotation terms, ranking, recipient or commitment changed.'}
   await store.put(user.id,collection,row,{event:'advisor/assessment-completed',actor:`agent:${user.id}`});return decorate(row)
  })()
  pending.set(id,{promise:work,controller});try{return await work}finally{pending.delete(id);context.signal?.removeEventListener('abort',abort)}
 }
 const cancel=async(user,id)=>{
  const row=get(user,id);if(row.status!=='pending')return row
  const job=pending.get(id);if(!job)fail('The assessment is recovering. Refresh its saved status before retrying.',409)
  job.controller.abort(new Error('Stopped by the account owner.'));await job.promise.catch(()=>{});return get(user,id)
 }
 const review=async(user,input={})=>{
  const row=get(user,input.id);if(row.status!=='completed')fail('Only a completed assessment can be reviewed.',409)
  if(!['accepted','dismissed'].includes(input.decision))fail('Accept or dismiss this advisory result.')
  if(input.decision==='accepted'&&row.stale)fail('A source changed since this assessment. Assess the current sources before accepting.',409)
  if(!accounts.can(user,'workspace:write'))fail('Review annotations are disabled for this account.',403)
  const review={decision:input.decision,note:text(input.note,'Review note',2000),at:now(),by:user.id},saved={...row,review,reviews:[...(row.reviews||[]),review]};delete saved.action;delete saved.stale
  await store.put(user.id,collection,saved,{event:'advisor/assessment-reviewed',actor:`human:${user.id}`});return decorate(saved)
 }
 const recover=async()=>{for(const user of accounts.list().filter(row=>['contractor','supplier'].includes(row.role)))for(const row of store.list(user.id,collection).filter(row=>row.status==='pending'))await store.put(user.id,collection,{...row,status:'interrupted',finishedAt:now(),error:'The advisor restarted before recording a confirmed result. Inspect the retained request and retry explicitly.',uncertainties:['Interrupted provider request; no automatic replay.']},{event:'advisor/assessment-interrupted',actor:'system:advisor'})}
 return{state,get,assess,cancel,review,recover,async dispose(){disposed=true;for(const row of pending.values())row.controller.abort();await Promise.allSettled([...pending.values()].map(row=>row.promise))}}
}
