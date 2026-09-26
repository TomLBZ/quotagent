import {randomUUID} from 'node:crypto'
const now=()=>new Date().toISOString(),copy=value=>structuredClone(value)
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})}
// This prepares separate frozen proposals. Execution belongs exclusively to Review actions.
export function createSubmissionBatches({store,scoped,accounts,prepareOne,actions}){
 const jobs=new Map(),active=new Set();let closed=false
 const realm=user=>scoped(user,'snapshot').id
 const list=user=>{
  const proposals=actions(user),byId=new Map(proposals.map(row=>[row.id,row]))
  return store.list(realm(user),'quote-submission-batches').map(row=>({...row,status:row.status==='preparing'&&!active.has(row.id)?'interrupted':row.status,items:row.items.map(item=>({...item,actionStatus:byId.get(item.actionId)?.status||null}))})).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
 }
 async function run(user,input,context={}){
  if(closed)fail('Quotation preparation is unavailable while this plugin unloads.',503)
  if(user.role!=='supplier'||accounts.can&&!accounts.can(user,'workspace:write'))fail('Only an authorized supplier may prepare quotation submissions.',403)
  if(!Array.isArray(input.quoteIds)||!input.quoteIds.length||input.quoteIds.length>50||input.quoteIds.some(id=>typeof id!=='string'||!id))fail('Select between 1 and 50 quotation drafts.')
  const owner=scoped(user,'submit-quote',input),actor=user.actorId||user.id,pinned={...user,workspaceOwnerId:owner.id},ids=[...new Set(input.quoteIds)]
  const prior=jobs.get(owner.id)||Promise.resolve();let activeId
  const job=prior.catch(()=>{}).then(async()=>{
   if(closed)fail('Quotation preparation stopped before this selection started.',503)
   let record={id:randomUUID(),ownerId:owner.id,createdBy:actor,source:context.source||'human',status:'preparing',quoteIds:ids,items:[],createdAt:now(),updatedAt:now()}
   const save=async(type)=>{record=await store.put(owner.id,'quote-submission-batches',copy(record),{event:type,actor:`${context.source&&context.source!=='human'?'agent':'human'}:${actor}`})}
   activeId=record.id;active.add(record.id)
   await save('procurement/submission-selection-started')
   for(const quoteId of ids){
    if(closed){record.status='interrupted';break}
    record.currentQuoteId=quoteId;await save('procurement/submission-item-started')
    let item
    try{const prepared=await prepareOne(pinned,quoteId,{...context,idempotencyKey:`quote-submission:${record.id}:${quoteId}`});item={quoteId,status:'prepared',actionId:prepared.proposal.id,title:prepared.proposal.input.preview.title,amount:prepared.proposal.input.preview.amount,currency:prepared.proposal.input.preview.currency,reused:!!prepared.reused,at:now()}}
    catch(error){item={quoteId,status:'failed',error:error.message,at:now()}}
    record.items.push(item);delete record.currentQuoteId;await save('procurement/submission-item-prepared')
   }
   if(record.status!=='interrupted')record.status=record.items.every(row=>row.status==='prepared')?'prepared':record.items.some(row=>row.status==='prepared')?'partial':'failed'
   record.updatedAt=now();await save('procurement/submission-selection-finished')
   active.delete(record.id)
   return{ok:true,batch:record,reviewRequired:true,action:{type:'navigate',label:'Review prepared quotations',input:{view:'quotes'}},message:`${record.items.filter(row=>row.status==='prepared').length} of ${ids.length} quotations prepared for separate human review. Nothing has been submitted.`}
  });jobs.set(owner.id,job);try{return await job}finally{active.delete(activeId);if(jobs.get(owner.id)===job)jobs.delete(owner.id)}
 }
 return{prepare:run,list,async dispose(){closed=true;await Promise.allSettled([...jobs.values()]);jobs.clear();active.clear()}}
}
