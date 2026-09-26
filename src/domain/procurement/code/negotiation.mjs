import {createHash} from 'node:crypto'
const copy=value=>structuredClone(value)
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value
const digest=value=>createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex')
const now=()=>new Date().toISOString()
export function createNegotiation(h){
 const {store,get,save,fail,required,text,newId,cents,costBasis,proposeReview,getReview,applyQuote,sendMessage}=h
 const ref=(user,collection,id)=>{const event=store.events(user.id).findLast(event=>event.body?.collection===collection&&event.body.record?.id===id);if(!event)fail('The negotiation source has no ledger reference.');return{realm:user.id,seq:event.seq,hash:event.entry_hash}}
 const number=(value,label,min,max,integer=false)=>{if(value===undefined||value===null||value===''||!Number.isFinite(Number(value))||Number(value)<min||Number(value)>max||integer&&!Number.isInteger(Number(value)))fail(`${label} must be explicitly set between ${min} and ${max}.`);return Number(value)}
 const policyFields=input=>{const minUnitPrice=cents(required(input.minUnitPrice,'Minimum authorized unit price')),maxUnitPrice=cents(required(input.maxUnitPrice,'Maximum authorized unit price'));if(minUnitPrice<0||maxUnitPrice<minUnitPrice)fail('Declare a non-negative ordered price band.');return{maxRounds:number(input.maxRounds,'Maximum rounds',1,100,true),maxConcessionPercent:number(input.maxConcessionPercent,'Maximum concession per attempt (%)',0,100),minimumCostUpliftPercent:number(input.minimumCostUpliftPercent,'Minimum private cost uplift (%)',0,1000),minUnitPrice:minUnitPrice/100,maxUnitPrice:maxUnitPrice/100,costSource:input.costSource}}
 const counted=(user,thread)=>({...thread,attempts:Math.max(thread.attempts||0,...store.list(user.id,'negotiation-rounds').filter(row=>row.threadId===thread.id).map(row=>row.attemptNo))})
 const owned=(user,id)=>{const thread=counted(user,get(user,'negotiation-threads',id));if(thread.ownerId!==user.id)fail('This private negotiation belongs to another party.',403);return thread}
 const basis=(user,thread)=>{
  const quote=get(user,'quotes',thread.currentQuoteId),rfq=get(user,'rfqs',quote.rfqId),item=quote.items.find(row=>row.id===thread.itemId)
  if(!item||rfq.status!=='published'||quote.rfqRevision!==(rfq.publishedRevision||1))fail('Use a current open request and current-scope quotation for negotiation.',409)
  if(user.role==='supplier'?quote.supplierId!==user.id:rfq.ownerId!==user.id)fail('This quote is outside your party.',403)
  const costs=user.role==='supplier'?costBasis(user,quote,item,thread.policy.costSource):null
  if(user.role==='supplier'&&(!costs||costs.unitCost===undefined||!costs.sourceRef))fail('Record the chosen private cost basis before negotiating; no floor will be guessed.')
  const cost=cents(costs?.unitCost??0),percent=Math.round(thread.policy.minimumCostUpliftPercent*10000),uplift=Number((BigInt(cost)*BigInt(1000000+percent)+999999n)/1000000n)
  return{quote,rfq,item,costs,floorCents:Math.max(cents(thread.policy.minUnitPrice),user.role==='supplier'?uplift:0),ceilingCents:cents(thread.policy.maxUnitPrice),quoteRef:ref(user,'quotes',quote.id),policyRevision:thread.policyRevision}
 }
 const actions=new Set(['open-negotiation','revise-negotiation-policy','request-negotiation','review-negotiation','close-negotiation','apply-negotiation'])
 async function review(user,thread,round,context={}){
  if(round.status!=='pending')fail('Only a pending permitted attempt can be reviewed.')
  const proposal=await proposeReview(user,{kind:'procurement.concession',title:`Review price negotiation: ${thread.title}`,summary:`Attempt ${round.attemptNo} · ${round.fromUnitPrice} → ${round.toUnitPrice} ${thread.currency} per ${thread.unit}. ${user.role==='supplier'?'Prepare private quote revision.':'Send nonbinding price request.'}`,input:{workspaceId:user.id,threadId:thread.id,roundId:round.id,basisDigest:round.basisDigest,preview:{title:thread.title,item:thread.itemDescription,unit:thread.unit,currency:thread.currency,fromUnitPrice:round.fromUnitPrice,toUnitPrice:round.toUnitPrice,concessionPercent:round.concessionPercent,privateFloor:round.floor,privateCeiling:round.ceiling,reason:round.reason,message:round.message||'',effect:user.role==='supplier'?'Applies an editable private quotation revision. It does not submit or promise this price.':'Sends this exact nonbinding negotiation request to the named supplier.',sources:[{label:'Quotation basis',collection:'quotes',recordId:round.basis.quote.id,ref:round.basis.quoteRef,link:{view:'quotes',quoteId:round.basis.quote.id,rfqId:thread.rfqId,workspaceId:user.id}}],risks:['A negotiation proposal does not confirm accepted scope, an award, or an order.']}},source:{kind:context.agent?'assistant':'human',plugin:'procurement'},runId:context.runId||null,idempotencyKey:`negotiation:${round.id}`})
  await save(user,'negotiation-rounds',{...round,reviewActionId:proposal.id},'procurement/negotiation-review-requested')
  return{ok:true,round:{...round,reviewActionId:proposal.id},proposal,action:{type:'navigate',label:'Review price proposal',input:{view:'approvals',actionId:proposal.id}},message:'Exact price proposal saved for human review. No price has been sent or changed.'}
 }
 async function execute(user,action,input,context={}){
  if(action==='open-negotiation'){
   const quote=get(user,'quotes',input.quoteId),item=quote.items.find(row=>row.id===input.itemId);if(!item)fail('Choose a quoted item to negotiate.')
   if(store.list(user.id,'negotiation-threads').some(row=>row.ownerId===user.id&&row.status==='open'&&row.currentQuoteId===quote.id&&row.itemId===item.id))fail('Continue or close the existing private negotiation for this quoted item.');
   const policy=policyFields(input.policy||{});if(user.role==='supplier'&&!['quote','commercial'].includes(policy.costSource))fail('Choose the private quoted cost or the sourced commercial cost model.');if(user.role==='contractor')policy.costSource='not-applicable'
   const record={id:newId('negotiation'),ownerId:user.id,role:user.role,rfqId:quote.rfqId,originalQuoteId:quote.id,currentQuoteId:quote.id,itemId:item.id,itemDescription:item.description,title:get(user,'rfqs',quote.rfqId).title,unit:item.unit,currency:quote.currency,policy,policyRevision:1,status:'open',attempts:0,currentUnitPrice:item.unitPrice,openedBy:user.actorId||user.id}
   const source=basis(user,record);if(source.floorCents>source.ceilingCents)fail('The sourced private floor exceeds your authorized ceiling. Review your declared bounds before opening.')
   return{ok:true,thread:await save(user,'negotiation-threads',{...record,openingBasis:source},'procurement/negotiation-opened'),message:'Private negotiation opened with explicit limits and source facts.'}
  }
  const thread=owned(user,input.threadId||input.id)
  if(action==='close-negotiation'){if(thread.status==='closed')return{ok:true,thread,duplicate:true};const outcome=required(input.outcome,'Outcome');if(!['accepted','rejected','withdrawn','limit-reached'].includes(outcome))fail('Choose the recorded outcome.');return{ok:true,thread:await save(user,'negotiation-threads',{...thread,status:'closed',outcome,closeReason:required(input.reason,'Closure reason'),closedAt:now()},'procurement/negotiation-closed')}}
  if(thread.status!=='open')fail('This negotiation is closed. Its attempt history is retained.',409)
  if(action==='revise-negotiation-policy'){if(input.expectedPolicyRevision!==undefined&&Number(input.expectedPolicyRevision)!==thread.policyRevision)fail('The policy was revised in another window. Reload before editing.',409);const policy=policyFields(input.policy||{});if(user.role==='contractor')policy.costSource='not-applicable';else if(!['quote','commercial'].includes(policy.costSource))fail('Choose a sourced private cost basis.');const updated={...thread,policy,policyRevision:thread.policyRevision+1,policyReason:required(input.reason,'Policy revision reason')};basis(user,updated);return{ok:true,thread:await save(user,'negotiation-threads',updated,'procurement/negotiation-policy-revised'),message:'Policy revision recorded. Existing attempts still count and pending proposals need fresh review.'}}
  if(action==='review-negotiation'){const round=get(user,'negotiation-rounds',input.roundId);if(round.threadId!==thread.id)fail('Choose an attempt from this thread.');return review(user,thread,round,context)}
  if(action==='request-negotiation'){
   const attemptNo=thread.attempts+1,current=basis(user,thread),from=cents(thread.currentUnitPrice),to=cents(input.toUnitPrice),delta=Math.max(0,user.role==='supplier'?from-to:to-from),maxScaled=Math.round(thread.policy.maxConcessionPercent*10000),concessionPercent=from?delta/from*100:delta?100:0
   let rejection=null
   if(attemptNo>thread.policy.maxRounds)rejection={code:'ROUND_LIMIT',reason:'The declared round limit is exhausted.'}
   else if(to<0||to===from)rejection={code:'PRICE_MOVE',reason:'Propose a different non-negative unit price.'}
   else if(BigInt(delta)*1000000n>BigInt(from)*BigInt(maxScaled))rejection={code:'CONCESSION_LIMIT',reason:'The proposed concession exceeds this attempt’s declared percentage limit.'}
   else if(to<current.floorCents)rejection={code:'PRIVATE_FLOOR',reason:'The proposed unit price is below the sourced private floor.'}
   else if(to>current.ceilingCents)rejection={code:'PRICE_BAND',reason:'The proposed unit price exceeds the declared authorized ceiling.'}
   const source={quote:current.quote,quoteRef:current.quoteRef,rfqRevision:current.rfq.publishedRevision,itemId:thread.itemId,policy:thread.policy,policyRevision:thread.policyRevision,costs:current.costs,currentUnitPrice:thread.currentUnitPrice},basisDigest=digest(source)
   const round={id:`${thread.id}:a${attemptNo}`,threadId:thread.id,ownerId:user.id,attemptNo,status:rejection?'rejected':'pending',fromUnitPrice:from/100,toUnitPrice:to/100,concessionPercent,reason:required(input.reason,'Negotiation reason'),basis:source,basisDigest,floor:current.floorCents/100,ceiling:current.ceilingCents/100,...(rejection?{rejection}:{})}
   if(user.role==='contractor')round.message=`Nonbinding price request for ${thread.title}: ${thread.itemDescription}, ${thread.unit}. Would you consider ${round.toUnitPrice} ${thread.currency} per ${thread.unit}? ${round.reason} This is a negotiation request, not an award or order.`
   // The attempt itself is authoritative. A crash before the summary update cannot reuse its number.
   await save(user,'negotiation-rounds',round,rejection?'procurement/negotiation-refused':'procurement/negotiation-proposed',`${context.agent?'agent':'human'}:${user.actorId||user.id}`)
   await save(user,'negotiation-threads',{...thread,attempts:attemptNo},'procurement/negotiation-attempt-counted')
   if(rejection)throw Object.assign(new Error(`${rejection.reason} Attempt ${attemptNo} is recorded; no price was changed or sent.`),{status:409,code:rejection.code})
   return review(user,thread,round,context)
  }
  if(action==='apply-negotiation'){
   const round=get(user,'negotiation-rounds',input.roundId),approval=context.reviewedConcession
   if(!approval||approval.kind!=='procurement.concession'||approval.status!=='executing'||approval.id!==input.reviewActionId||approval.input.workspaceId!==user.id||approval.input.roundId!==round.id||round.threadId!==thread.id||approval.input.basisDigest!==round.basisDigest)fail('Apply this concession only through its exact active human review.',403)
   if(round.status==='applied')return{ok:true,quoteId:round.appliedQuoteId,duplicate:true}
   if(round.status!=='pending')fail('This attempt cannot be applied.')
   const current=basis(user,thread),source={quote:current.quote,quoteRef:current.quoteRef,rfqRevision:current.rfq.publishedRevision,itemId:thread.itemId,policy:thread.policy,policyRevision:thread.policyRevision,costs:current.costs,currentUnitPrice:thread.currentUnitPrice}
   if(digest(source)!==round.basisDigest)fail('The quote, sourced cost or private policy changed. Request a fresh negotiation attempt.',409)
   let result
   if(user.role==='supplier')result=await applyQuote(user,{...current.quote,id:undefined,expectedRevision:null,items:current.quote.items.map(item=>item.id===thread.itemId?{...item,unitPrice:round.toUnitPrice,normalization:undefined,offered:undefined}:item)})
   else result=await sendMessage(user,{rfqId:thread.rfqId,toId:current.quote.supplierId,text:round.message,kind:'negotiation'})
   const quoteId=result.quote?.id||thread.currentQuoteId
   await save(user,'negotiation-rounds',{...round,status:'applied',appliedBy:user.actorId||user.id,appliedAt:now(),appliedQuoteId:result.quote?.id||null,messageId:result.message?.id||null,reviewActionId:approval.id},'procurement/negotiation-approved')
   await save(user,'negotiation-threads',{...thread,currentQuoteId:quoteId,currentUnitPrice:round.toUnitPrice},'procurement/negotiation-position-updated')
   return{...result,action:{type:'navigate',label:user.role==='supplier'?'Review private quote revision':'Open project conversation',input:{view:user.role==='supplier'?'quotes':'messages',quoteId:user.role==='supplier'?quoteId:undefined,rfqId:thread.rfqId}},message:user.role==='supplier'?'Reviewed concession prepared as a private quote revision. Submit separately to share it.':'Reviewed nonbinding price request sent. No award or order was created.'}
  }
 }
 const state=user=>({negotiationThreads:store.list(user.id,'negotiation-threads').filter(row=>row.ownerId===user.id).map(row=>counted(user,row)),negotiationRounds:store.list(user.id,'negotiation-rounds').filter(row=>row.ownerId===user.id).map(row=>({...row,...(row.reviewActionId?{reviewStatus:getReview(user,row.reviewActionId)?.status||'unavailable'}:{})}))})
 return{actions,execute,state}
}
