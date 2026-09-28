import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {Context} from '../../../../host/node_modules/cordis/lib/index.js'
import * as store from '../../../system/workspace-store/code/index.mjs'
import * as procurement from '../../procurement/code/index.mjs'
import * as teams from '../../../system/teams/code/index.mjs'
import {authoredFixtureInput} from '../../procurement/tests/declared-scope-fixture.mjs'
import {createAdvisor} from '../code/service.mjs'
const buyer={id:'buyer',name:'Buyer',role:'contractor',email:'buyer@advisor.test'},supplier={id:'supplier',name:'Supplier',role:'supplier',email:'supplier@advisor.test'},rival={id:'rival',name:'Rival',role:'supplier',email:'rival@advisor.test'},member={id:'member',name:'Member',role:'supplier',email:'member@advisor.test'},admin={id:'admin',role:'admin'},users=[buyer,supplier,rival,member,admin]
mkdirSync('tmp',{recursive:true});const root=mkdtempSync(resolve('tmp/advisor-business-')),checks=[],requests=[],ctx=new Context(),fibers=[];let providerBehavior='normal',low=false,allow=true
fibers.push(await ctx.plugin({name:'advisor-fixture',apply(ctx){
 ctx.provide('accounts',{list:()=>structuredClone(users),get:id=>structuredClone(users.find(row=>row.id===id)),can:()=>allow})
 ctx.provide('web',{route:()=>()=>{},contribute:()=>()=>{}})
 ctx.provide('jev',{status:()=>({available:true,model:'typed-fixture',provider:'typesafe'}),settings:()=>({confidenceThreshold:.65,maxContextBytes:100000}),async evaluate(user,input){requests.push(structuredClone({...input,signal:undefined}));if(providerBehavior==='fail')throw Object.assign(new Error('TypeSafe fixture unavailable'),{code:'http-529'});if(providerBehavior==='wait')await new Promise((_,reject)=>{if(input.signal.aborted)reject(new Error('Cancelled'));else input.signal.addEventListener('abort',()=>reject(new Error('Cancelled')),{once:true})});const answers=Object.fromEntries(Object.entries(input.questions).map(([id,q])=>[id,q.type==='noul'?{type:'noul',noul:low?.5:.95}:q.type==='score'?{type:'score',score:1,confidence:low?.1:.9,probabilities:{0:0,1:1,2:0,3:0},legend:Object.fromEntries(q.criteria.map((x,i)=>[i,x]))}:{type:'choice',choice:Object.keys(q.criteria)[0],confidence:low?.1:.9,probabilities:Object.fromEntries(Object.keys(q.criteria).map((key,i)=>[key,i===0?1:0]))}]));return{callId:'fixture-'+requests.length,model:'typed-fixture',answers,usage:{input_tokens:100,output_tokens:20},tokens:{input:100,output:20,total:120},requestSha256:'fixture'}}})
}}))
for(const plugin of [store,teams,procurement])fibers.push(await ctx.plugin(plugin,plugin===store?{root}:{}))
let service=createAdvisor(ctx)
const run=(user,action,input)=>ctx.procurement.execute(user,action,authoredFixtureInput(action,input))
const business=()=>users.filter(u=>u.role!=='admin').map(user=>({id:user.id,rfqs:ctx.store.list(user.id,'rfqs'),quotes:ctx.store.list(user.id,'quotes'),orders:ctx.store.list(user.id,'orders'),approvals:ctx.store.events(user.id).filter(row=>row.type.includes('approval'))}))
try{
 const rfq=(await run(buyer,'create-rfq',{title:'Complete source lighting scope',currency:'USD',items:[{id:'lamp',description:'IP65 lamp',unit:'each',quantity:12}],requirements:{warrantyMonths:36},supplierIds:[supplier.id,rival.id]})).rfq
 await run(buyer,'publish-rfq',{id:rfq.id,confirmed:true})
 const quote=(await run(supplier,'save-quote',{rfqId:rfq.id,items:[{id:'lamp',unitPrice:250,cost:187}],leadDays:21,paymentTerms:'Net30',privateNotes:'SECRET-SUPPLIER-COST-NOTES',notes:'Installation excluded'})).quote
 await assert.rejects(service.assess(buyer,{mode:'quote-review',rfqId:rfq.id,quoteId:quote.id}),/Choose a quotation/)
 await run(supplier,'submit-quote',{id:quote.id,confirmed:true})
 const before=business(),comparison=ctx.procurement.snapshot(buyer).comparison
 const a=await service.assess(buyer,{mode:'quote-review',rfqId:rfq.id,quoteId:quote.id}),b=await service.assess(supplier,{mode:'quote-review',rfqId:rfq.id,quoteId:quote.id})
 assert.equal(a.status,'completed');assert.equal(a.sources.length,2);assert.equal(a.state.quote.total,3000)
 for(const req of requests){assert(!JSON.stringify(req).includes('SECRET-SUPPLIER'));assert(!JSON.stringify(req.state).includes('"cost"'));assert(!JSON.stringify(req.state).includes('privateNotes'))}
 for(const ref of a.sources){const event=ctx.store.events(ref.realm).find(e=>e.seq===ref.seq);assert.equal(event.entry_hash,ref.hash);assert.equal(event.body.record.id,ref.id)}
 assert.throws(()=>service.get(rival,a.id),/not available/);assert.throws(()=>service.get({...buyer,role:'supplier'},a.id),/not available/);assert.equal(service.state({...buyer,role:'supplier'}).assessments.length,0);assert.throws(()=>service.state(admin),/supplier or contractor/)
 assert.deepEqual(business(),before);assert.deepEqual(ctx.procurement.snapshot(buyer).comparison,comparison)
 checks.push('Both native QEP party perspectives use received or own sources with exact ledger refs; no cost/private-note leak, no rival/admin access, deterministic business records and comparison unchanged')
 const c=await service.assess(buyer,{mode:'clarification',rfqId:rfq.id,text:'请确认交货时间'}),d=await service.assess(buyer,{mode:'shortlist',rfqId:rfq.id,text:'Explicit scope fit; compare recorded totals only within same currency'}),e=await service.assess(supplier,{mode:'field-check',rfqId:rfq.id,text:'Quoted installation is excluded.',claims:['Installation is included.','Twelve lamps are required.']})
 assert.equal(c.questions.topic.type,'choice');assert.equal(c.questions.urgent.type,'noul');assert(Object.hasOwn(d.questions.candidate.criteria,'none'));assert.equal(Object.keys(e.answers).length,2)
 await assert.rejects(service.assess(supplier,{mode:'shortlist',rfqId:rfq.id,text:'Choose me'}),/available for your role/)
 await assert.rejects(service.assess(buyer,{mode:'shortlist',rfqId:rfq.id}),/priorities/)
 await assert.rejects(service.assess(buyer,{mode:'field-check',rfqId:rfq.id,text:'Test',claims:[]}),/explicit claims/)
 await assert.rejects(service.assess(buyer,{mode:'clarification',rfqId:rfq.id,text:'x'.repeat(16001)}),/never silently cut/)
 checks.push('Four source-bound modes retain complete typed rubrics and explicit user text; shortlist has no-match escape, supplier competitive shortlist refused, required priorities/claims and untruncated source limits enforced')
 const alternate=(await run(buyer,'create-rfq',{title:'Alternate request with a five-year warranty requirement',currency:'USD',items:[{id:'lamp',description:'Different associated scope, never claim evidence',unit:'each',quantity:99}],requirements:{warrantyMonths:60},supplierIds:[supplier.id]})).rfq
 assert.equal(rfq.requirements.warrantyMonths,36);assert.equal(alternate.requirements.warrantyMonths,60)
 const pasted='The supplier offer includes packaging. Installation is excluded.',claims=['Packaging is included.','Installation is included.','The offer includes a five-year warranty.'],priorClaimsBusiness=business()
 const fieldA=await service.assess(supplier,{mode:'field-check',rfqId:rfq.id,text:pasted,claims}),wireA=requests.at(-1)
 const fieldB=await service.assess(buyer,{mode:'field-check',rfqId:alternate.id,text:pasted,claims}),wireB=requests.at(-1)
 assert.deepEqual(wireA.state,{text:pasted,claims});assert.deepEqual(wireB.state,wireA.state);assert.deepEqual(wireB.questions,wireA.questions)
 assert(!Object.hasOwn(wireA.state,'request'));assert(!JSON.stringify(wireB.state).includes('warrantyMonths'));assert(!JSON.stringify(wireB.state).includes(alternate.title))
 for(const question of Object.values(wireA.questions)){
  assert.match(question.instructions,/Use only state.text as evidence/);assert.match(question.instructions,/absent from state.text are unknown/);assert.match(question.instructions,/buyer requirements are never supplier statements/)
  assert.match(question.criteria.contradicted,/statement in the pasted source text/);assert.match(question.criteria.unknown,/Absent from the pasted source text/)
 }
 for(const row of [fieldA,fieldB]){assert.equal(row.sources.length,1);assert.equal(row.sources[0].id,row.rfqId);const event=ctx.store.events(row.sources[0].realm).find(value=>value.seq===row.sources[0].seq);assert.equal(event.entry_hash,row.sources[0].hash);assert.deepEqual(ctx.store.get(row.sources[0].realm===supplier.id?supplier.id:buyer.id,'advisor-assessments',row.id).state,{text:pasted,claims})}
 const beforeUnauthorized=requests.length;await assert.rejects(service.assess(supplier,{mode:'field-check',rfqId:alternate.id,text:pasted,claims}),/request available/);assert.equal(requests.length,beforeUnauthorized)
 assert.deepEqual(business(),priorClaimsBusiness)
 checks.push('Field-check sends only explicit pasted text and claims: changing the associated RFQ from36-month warranty/12lamps to60-month warranty/99lamps leaves the typed evidence and rubric identical. Missing warranty is instructed unknown, not contradiction; authorized RFQ refs remain pinned organizational metadata, inaccessible RFQ refuses before provider dispatch, and all business records stay unchanged. Controlled provider proves input isolation, not semantic accuracy.')
 const rivalQuote=(await run(rival,'save-quote',{rfqId:rfq.id,items:[{id:'lamp',unitPrice:240,cost:180}],leadDays:18,paymentTerms:'Net30'})).quote
 await run(rival,'submit-quote',{id:rivalQuote.id,confirmed:true});assert.equal(service.get(buyer,d.id).stale,true)
 await assert.rejects(service.review(buyer,{id:d.id,decision:'accepted'}),/source changed/)
 const freshShortlist=await service.assess(buyer,{mode:'shortlist',rfqId:rfq.id,text:'Fit the explicit RFQ scope'});assert.deepEqual(freshShortlist.candidateIds.sort(),[quote.id,rivalQuote.id].sort());assert.equal(freshShortlist.stale,false)
 await run(rival,'withdraw-quote',{id:rivalQuote.id,reason:'Supplier withdrawal for source freshness test',confirmed:true});assert.equal(service.get(buyer,freshShortlist.id).stale,true)
 checks.push('A newly received current competitor changes the assessed candidate set and makes an older shortlist stale; accepting it is refused; later source withdrawal invalidates fresh shortlist too')
 low=true;const uncertain=await service.assess(buyer,{mode:'clarification',rfqId:rfq.id,text:'Mixed unclear clarification'});assert.equal(uncertain.requiresReview,true);assert.equal(uncertain.uncertainties.length,2)
 const prior=business();const accepted=await service.review(buyer,{id:uncertain.id,decision:'accepted',note:'I reviewed source manually.'});assert.equal(accepted.review.decision,'accepted');assert.deepEqual(business(),prior);assert.equal(accepted.requiresReview,true)
 const event=ctx.store.events(buyer.id).findLast(row=>row.type==='advisor/assessment-created');assert.equal(event.body.record.state.text,'Mixed unclear clarification')
 checks.push('Low model confidence and ambiguous Noul probability require manual review; human acceptance is only a private annotation and preserves uncertainty plus all business approvals/records')
 low=false;await run(supplier,'save-quote',{id:quote.id,rfqId:rfq.id,expectedRevision:quote.revision,items:[{id:'lamp',unitPrice:251,cost:186}],leadDays:22})
 assert.equal(service.get(supplier,b.id).stale,true);assert.equal(service.get(buyer,a.id).stale,false)
 await assert.rejects(service.review(supplier,{id:b.id,decision:'accepted'}),/source changed/)
 await service.review(supplier,{id:b.id,decision:'dismissed'})
 const invite=await ctx.teams.invite(supplier,{email:member.email,roleId:'lead'});await ctx.teams.answerInvite(member,invite.id,true);await ctx.teams.select(member,supplier.id)
 const team=await service.assess(member,{mode:'clarification',rfqId:rfq.id,text:'When can we deliver?'});assert.equal(team.realmId,supplier.id);assert.equal(team.sources[0].realm,supplier.id);assert(ctx.store.get(member.id,'advisor-assessments',team.id));assert(!ctx.store.get(supplier.id,'advisor-assessments',team.id))
 await ctx.teams.select(member,member.id);assert.throws(()=>service.get(member,team.id),/selected workspace/)
 checks.push('Source edits mark own assessment stale without inventing receipt updates for buyer; stale acceptance refused; team source realm pinned while private assessment belongs only to requester')
 const beforeFailure=ctx.procurement.snapshot(buyer).comparison;providerBehavior='fail';const failed=await service.assess(buyer,{mode:'quote-review',rfqId:rfq.id,quoteId:quote.id});assert.equal(failed.status,'unavailable');assert.deepEqual(failed.answers,{});assert.equal(failed.code,'http-529');assert.deepEqual(ctx.procurement.snapshot(buyer).comparison,beforeFailure)
 providerBehavior='wait';const stopped=service.assess(buyer,{mode:'clarification',rfqId:rfq.id,text:'Stop this pending assessment'});await new Promise(resolve=>setTimeout(resolve,30));const pendingRow=service.state(buyer).assessments.find(row=>row.status==='pending');assert(pendingRow)
 await assert.rejects(service.cancel(rival,pendingRow.id),/not available/);assert.equal((await service.cancel(buyer,pendingRow.id)).status,'interrupted');assert.equal((await stopped).status,'interrupted')
 const pending=service.assess(buyer,{mode:'clarification',rfqId:rfq.id,text:'Cancel this request'});await new Promise(resolve=>setTimeout(resolve,30));await service.dispose();assert.equal((await pending).status,'interrupted')
 service=createAdvisor(ctx);const orphan={...a,id:'orphan',status:'pending'};await ctx.store.put(buyer.id,'advisor-assessments',orphan,{event:'advisor/assessment-created'});await service.recover();assert.equal(service.get(buyer,'orphan').status,'interrupted');assert.equal(service.get(buyer,a.id).status,'completed')
 allow=false;assert.throws(()=>service.state(buyer),/disabled/);allow=true
 checks.push('Provider failure leaves explicit unavailable record and normal comparison usable; only requester can stop saved pending work, disposal cancels pending work, remount marks orphan interrupted without replay and preserves completed history; capability refusal enforced')
 const out={ok:true,command:'node src/domain/advisor/tests/business.mjs',checks,groups:checks.length,scope:'Actual native Cordis/Python ledger/QEP and domain service with a controlled typed provider; not live Jev quality',dataRoot:root};const directory=resolve(process.env.EVIDENCE_DIR||'tmp/jev-2026-09-28');mkdirSync(directory,{recursive:true});writeFileSync(directory+'/business.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2))
}finally{await service.dispose();for(const fiber of fibers.reverse())await fiber.dispose()}
