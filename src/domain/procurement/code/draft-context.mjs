const fail=(message,status=403)=>{throw Object.assign(new Error(message),{status})}
const copy=value=>structuredClone(value)
export const draftFields={currency:'currency',description:'requestBrief',leadDays:'quoteLeadDays',paymentTerms:'quotePaymentTerms',notes:'quoteNotes'}

export function installDraftContext(ctx){
 const disposers=[]
 const party=(user,context={},write=false)=>{
  if(!['contractor','supplier'].includes(user?.role))fail('Open a contractor or supplier workspace to use project defaults.')
  const selected={...user,...(context.workspaceId?{workspaceOwnerId:context.workspaceId}:{})}
  const scoped=ctx.get('teams')?.resolveUser(selected,write?'settings-update':'snapshot')||selected
  if(!ctx.get('teams')&&context.workspaceId&&context.workspaceId!==user.id)fail('These defaults belong to another party workspace.')
  if(write&&!ctx.accounts.can(ctx.accounts.get(scoped.actorId||scoped.id)||user,'workspace:write'))fail('Your account has read-only business access.')
  if(ctx.store.health?.()[scoped.id]?.healthy===false)fail('This workspace needs ledger recovery before its defaults can be used.',503)
  return scoped
 }
 const project=(user,context,write)=>{const scoped=party(user,context,write),record=ctx.store.get(scoped.id,'projects',context.projectId);if(!record||record.ownerId!==scoped.id)fail('Choose a project in this party workspace.');return {scoped,record}}
 const section=(user,context,write)=>{const {scoped,record:parent}=project(user,context,write),record=ctx.store.get(scoped.id,'sections',context.sectionId);if(!record||record.ownerId!==scoped.id||record.projectId!==parent.id)fail('Choose a section of this project.');return {scoped,record,parent}}
 const safeList=(user,fn)=>['contractor','supplier'].includes(user?.role)?fn():[]
 disposers.push(ctx.settings.registerScope({id:'workspace',label:'Party workspace',list:(user,context={})=>safeList(user,()=>{const scoped=party(user,context);return[{id:scoped.id,label:scoped.company||scoped.name,context:{workspaceId:scoped.id}}]}),resolve:(user,context,{write})=>{const scoped=party(user,context,write);return{realmId:scoped.id,key:scoped.id,label:scoped.company||scoped.name}}}))
 disposers.push(ctx.settings.registerScope({id:'project',label:'Project',list:(user,context={})=>safeList(user,()=>{const scoped=party(user,context);return ctx.store.list(scoped.id,'projects').filter(row=>row.ownerId===scoped.id).map(row=>({id:row.id,label:row.name,context:{workspaceId:scoped.id,projectId:row.id}}))}),resolve:(user,context,{write})=>{const {scoped,record}=project(user,context,write);return{realmId:scoped.id,key:record.id,label:record.name}}}))
 disposers.push(ctx.settings.registerScope({id:'section',label:'Section',list:(user,context={})=>safeList(user,()=>{const scoped=party(user,context),projects=ctx.store.list(scoped.id,'projects').filter(row=>row.ownerId===scoped.id);return ctx.store.list(scoped.id,'sections').filter(row=>row.ownerId===scoped.id&&projects.some(project=>project.id===row.projectId)&&(!context.projectId||row.projectId===context.projectId)).map(row=>({id:row.id,label:`${projects.find(project=>project.id===row.projectId).name} / ${row.name}`,context:{workspaceId:scoped.id,projectId:row.projectId,sectionId:row.id}}))}),resolve:(user,context,{write})=>{const {scoped,record,parent}=section(user,context,write);return{realmId:scoped.id,key:record.id,label:`${parent.name} / ${record.name}`}}}))
 disposers.push(ctx.settings.define({id:'procurement',name:'Procurement draft defaults',scope:'user',scopes:['workspace','project','section'],description:'Starting values for new private requests and quotations. Explicit edits and existing records take precedence; nothing is published or submitted automatically.',fields:[{key:'currency',label:'Default currency',type:'select',options:['USD','GBP','EUR','AUD','SGD','HKD','CNY']},{key:'requestBrief',label:'Default request brief',type:'textarea'},{key:'quoteLeadDays',label:'Default quote lead time (days)',type:'number',min:0,max:3650},{key:'quotePaymentTerms',label:'Default quote payment terms',type:'textarea'},{key:'quoteNotes',label:'Default quote notes',type:'textarea'}],defaults:{currency:'USD',requestBrief:'',quoteLeadDays:14,quotePaymentTerms:'',quoteNotes:''},validate:values=>{if(!Number.isInteger(Number(values.quoteLeadDays)))fail('Default lead time must be a whole number of days.',400)}}))
 return{
  view(user,context={}){
   const scoped=party(user,context),actor=ctx.accounts.get(scoped.actorId||user.actorId||user.id)||user,selected={workspaceId:scoped.id}
   // A received buyer project never grants a supplier access to buyer settings.
   if(scoped.role==='contractor'&&context.projectId){project(actor,{...selected,projectId:context.projectId});selected.projectId=context.projectId;if(context.sectionId){section(actor,{...selected,sectionId:context.sectionId});selected.sectionId=context.sectionId}}
   else if(context.sectionId||context.projectId)fail('Only your own contractor project can provide project defaults.')
   const result=ctx.settings.view(actor,'procurement',selected)
   if(selected.projectId&&result.provenance.currency?.layer==='schema'){
    const record=ctx.store.get(scoped.id,'projects',selected.projectId),event=ctx.store.events(scoped.id).findLast(row=>row.body?.collection==='projects'&&row.body.record?.id===record.id)
    result.values.currency=record.currency;result.provenance.currency={source:'project-record',layer:'project',scopeLabel:record.name,reference:event?{realm:scoped.id,seq:event.seq,hash:event.entry_hash}:record.id}
   }
   return{values:copy(result.values),provenance:copy(result.provenance),context:selected}
  },dispose(){for(const dispose of disposers.reverse())dispose()}
 }
}

/** Resolve only explicitly paired metadata; never manufacture a local account. */
export function pairedParties(ctx,user,{includeDisabled=false}={}){
 const exchange=ctx.get('exchange');if(!exchange)return[]
 const result=exchange.list(user)
 return result.peers.filter(row=>(row.enabled||includeDisabled)&&row.paired&&['contractor','supplier'].includes(row.role)).map(row=>{
  const event=ctx.store.events(result.realm).findLast(event=>event.body?.collection==='exchange-peers'&&event.body.record?.id===row.id)
  return{id:row.peerRealm,name:row.name,company:row.name,role:row.role,external:true,enabled:row.enabled,peerId:row.id,sourceRealm:row.sourceRealm,sourceRef:event?{realm:result.realm,seq:event.seq,hash:event.entry_hash}:null}
 })
}
