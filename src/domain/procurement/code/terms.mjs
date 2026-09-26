const copy=value=>structuredClone(value)
const now=()=>new Date().toISOString()
const families=new Set(['payment','warranty','penalty','acceptance','delivery','scope','other'])
export function termFields(value,prior=[],fail=message=>{throw new Error(message)}){
  if(value===undefined)return copy(prior||[])
  if(!Array.isArray(value))fail('Terms must be a list of named declarations.')
  const seen=new Set()
  return value.map(row=>{const key=String(row.key||'').trim(),family=String(row.family||'other'),text=String(row.text??'').trim(),label=String(row.label||key).trim();if(!key||seen.has(key))fail('Every term needs one unique key.');if(!families.has(family))fail('Choose a supported term family.');if(!text)fail(`Write the declared value of ${label}.`);seen.add(key);return{key,family,label,text}})
}
export function createTerms(h){
  const {store,get,save,role,fail,required,text,newId,approval}=h
  const source=(realm,collection,id)=>{const event=store.events(realm).findLast(row=>row.body?.collection===collection&&row.body.record?.id===id);return event?{realm,seq:event.seq,hash:event.entry_hash}:null}
  const state=(user,rfqs=[],quotes=[])=>({termLibrary:store.list(user.id,'term-library').filter(row=>row.ownerId===user.id),termVersions:store.list(user.id,'term-versions').filter(row=>row.ownerId===user.id),termDecisions:store.list(user.id,'term-decisions').filter(row=>row.ownerId===user.id),termConflicts:quotes.flatMap(quote=>{const rfq=rfqs.find(row=>row.id===quote.rfqId);return rfq?conflicts(user,quote,rfq).map(row=>({...row,quoteId:quote.id})):[]})})
  const rawConflicts=(quote,rfq)=>{
    const requiredTerms=termFields(rfq.terms),offered=termFields(quote.terms),keys=[...new Set([...requiredTerms,...offered].map(row=>row.key))],result=[]
    for(const key of keys){const left=requiredTerms.find(row=>row.key===key),right=offered.find(row=>row.key===key);if(left?.text===right?.text)continue;result.push({key:'text:'+key,family:left?.family||right?.family,label:left?.label||right?.label,required:left?.text??null,offered:right?.text??null})}
    for(const [key,label,family]of [['paymentDays','Payment period (days)','payment'],['warrantyMonths','Warranty (months)','warranty'],['penaltyPercent','Penalty (%)','penalty']]){const requiredValue=rfq.requirements?.[key],offeredValue=quote.commercial?.[key];if(requiredValue===undefined)continue;if(offeredValue!==undefined&&Number(offeredValue)===Number(requiredValue))continue;result.push({key:'commercial:'+key,family,label,required:requiredValue,offered:offeredValue??null})}
    return result
  }
  const signature=(quote,rfq)=>({quoteId:quote.id,quoteRevision:quote.revision||1,rfqId:rfq.id,rfqRevision:rfq.publishedRevision||1})
  const decisionFor=(user,quote,rfq)=>store.list(user.id,'term-decisions').find(row=>Object.entries(signature(quote,rfq)).every(([key,value])=>row[key]===value)&&row.ownerId===rfq.ownerId)
  const conflicts=(user,quote,rfq)=>{const decision=decisionFor(user,quote,rfq);return rawConflicts(quote,rfq).map(conflict=>({...conflict,decision:decision?.decisions.find(row=>row.key===conflict.key)||null,decisionId:decision?.id||null,requiresHuman:true}))}
  const accepted=(user,quote,rfq)=>{
    const values=conflicts(user,quote,rfq)
    if(values.some(row=>row.decision?.resolution!=='accept-offer'))fail('Resolve each required/offered term difference with an explicit human decision before proposing or signing an award.',409)
    return {terms:termFields(quote.terms),requiredTerms:termFields(rfq.terms),...(values.length?{termExceptions:values.map(row=>({key:row.key,label:row.label,required:row.required,offered:row.offered,resolution:row.decision.resolution,reason:row.decision.reason,decidedBy:row.decision.decidedBy,decisionId:row.decisionId,...signature(quote,rfq)}))}:{})}
  }
  const applyDefaults=(user,kind,terms)=>{
    const result=termFields(terms,[],fail),applied=[]
    for(const entry of store.list(user.id,'term-library').filter(row=>row.ownerId===user.id&&row.active&&[kind,'both'].includes(row.defaultFor))){if(result.some(row=>row.key===entry.key))continue;result.push({key:entry.key,label:entry.label,family:entry.family,text:entry.text});applied.push({key:entry.key,termId:entry.id,revision:entry.revision,sourceRef:source(user.id,'term-library',entry.id)})}
    return {terms:result,basis:applied.length?{applied,preparedAt:now()}:undefined}
  }
  const actions=new Set(['save-term','archive-term','resolve-terms'])
  async function execute(user,action,input){
    if(action==='save-term'){
      const prior=input.id?get(user,'term-library',input.id):null;if(prior&&prior.ownerId!==user.id)fail('This library entry belongs to another party.',403)
      const fields=termFields([{...prior,...input}],[],fail)[0],defaultFor=input.defaultFor??prior?.defaultFor??'none';if(!['none','request','quote','both'].includes(defaultFor))fail('Choose a term default target.')
      if(store.list(user.id,'term-library').some(row=>row.ownerId===user.id&&row.active&&row.key===fields.key&&row.id!==prior?.id))fail('An active library entry already uses this term key. Revise it or archive it first.')
      const record=await save(user,'term-library',{...prior,id:prior?.id||newId('term'),ownerId:user.id,...fields,defaultFor,active:true,revision:(prior?.revision||0)+1,authoredBy:user.actorId||user.id},'procurement/term-defined',undefined,input.expectedRevision!==undefined?{expectedRevision:input.expectedRevision}:{})
      await save(user,'term-versions',{...record,id:`${record.id}:v${record.revision}`,termId:record.id},'procurement/term-version-recorded')
      return{ok:true,term:record,message:'Private term saved with its version. Existing requests and offers are unchanged.'}
    }
    if(action==='archive-term'){const term=get(user,'term-library',input.id);if(term.ownerId!==user.id)fail('This term belongs to another party.',403);return{ok:true,term:await save(user,'term-library',{...term,active:false,revision:term.revision+1},'procurement/term-archived',undefined,input.expectedRevision!==undefined?{expectedRevision:input.expectedRevision}:{})}}
    if(action==='resolve-terms'){
      role(user,'contractor');const quote=get(user,'quotes',input.quoteId),rfq=get(user,'rfqs',quote.rfqId);if(rfq.ownerId!==user.id)fail('Only the request owner can decide its exceptions.',403)
      const basis=signature(quote,rfq);if(input.quoteRevision!==basis.quoteRevision||input.rfqRevision!==basis.rfqRevision)fail('The request or quotation changed. Review the current differences again.',409)
      const differences=rawConflicts(quote,rfq);if(!differences.length)fail('There are no term differences to resolve.')
      const decisions=differences.map(row=>{const chosen=input.decisions?.find(entry=>entry.key===row.key);if(!chosen||!['accept-offer','require-revision'].includes(chosen.resolution))fail(`Make an explicit decision for ${row.label}.`);return{key:row.key,required:row.required,offered:row.offered,resolution:chosen.resolution,reason:required(chosen.reason,`Reason for ${row.label}`),decidedBy:user.actorId||user.id}})
      const record={id:`terms:${quote.id}:${basis.quoteRevision}:${basis.rfqRevision}`,ownerId:user.id,supplierId:quote.supplierId,...basis,decisions,decidedAt:now()}
      await approval(user,action,quote.id,input,record)
      await save(user,'term-decisions',record,'procurement/term-conflicts-decided')
      return{ok:true,decision:record,message:'Term decisions recorded for these exact revisions. Original declarations are unchanged.'}
    }
  }
  return{actions,execute,state,conflicts,accepted,applyDefaults}
}
