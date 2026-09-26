import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {Context} from '../../../../host/node_modules/cordis/lib/index.js'
import * as storePlugin from '../../../system/workspace-store/code/index.mjs'
import * as procurementPlugin from '../code/index.mjs'
import * as actionsPlugin from '../../../system/action-center/code/index.mjs'
import * as teamsPlugin from '../../../system/teams/code/index.mjs'
import {configureReviewer,grantAndSign} from './review-fixture.mjs'
import {declaredScope} from './declared-scope-fixture.mjs'
mkdirSync('tmp',{recursive:true});const root=mkdtempSync(resolve('tmp/public-declarations-')),checks=[],routes=[]
const buyer={id:'buyer',role:'contractor',name:'Buyer',email:'buyer@declarations.local'},supplier={id:'supplier',role:'supplier',name:'Supplier',email:'supplier@declarations.local'},reviewer={id:'reviewer',role:'contractor',name:'Reviewer',email:'reviewer@declarations.local'},users=[buyer,supplier,reviewer]
async function mount(){const ctx=new Context(),fibers=[];fibers.push(await ctx.plugin({name:'declarations-fixture',apply(inner){inner.provide('accounts',{list:()=>structuredClone(users),get:id=>structuredClone(users.find(row=>row.id===id)),can:()=>true});inner.provide('web',{route:(...args)=>{routes.push(args);return()=>routes.splice(routes.indexOf(args),1)},contribute:()=>()=>{}})}}));for(const plugin of[storePlugin,teamsPlugin,actionsPlugin,procurementPlugin])fibers.push(await ctx.plugin(plugin,plugin===storePlugin?{root}:{}));return{ctx,dispose:async()=>{for(const fiber of fibers.reverse())await fiber.dispose()}}}
let mounted=await mount(),ctx=mounted.ctx
try{
 const run=(user,action,input,options)=>ctx.procurement.execute(user,action,input,options);await configureReviewer(ctx,buyer,reviewer)
 const items=[{id:'panel',description:'Panel',quantity:2,unit:'each'}],draft=(await run(buyer,'create-rfq',{title:'Explicit scope and public promises',items,supplierIds:[supplier.id]})).rfq
 const before=ctx.store.events(buyer.id).length;await assert.rejects(run(buyer,'publish-rfq',{id:draft.id,confirmed:true}),/Declare measurement/);assert.equal(ctx.store.events(buyer.id).length,before)
 let rfq=(await run(buyer,'create-rfq',{id:draft.id,...declaredScope(items),expectedRevision:draft.revision})).rfq;rfq=(await run(buyer,'publish-rfq',{id:rfq.id,confirmed:true})).rfq;assert.equal(rfq.scopePolicy,'declared/v1');assert.equal(ctx.store.get(supplier.id,'rfqs',rfq.id).scope.interfaces[0].responsibilityOwner,'Supplier')
 checks.push('New unstructured publication refuses before any approval/fact; explicit fixture-authored rules and owner publish through real QEP with declared policy marker')

 const schedule=[{id:'delivery',label:'Site delivery',date:'2099-01-15',binding:'firm',itemIds:['alternative'],description:'Delivered to the agreed loading bay'}],declarations={assumptions:['Buyer provides safe unloading access.'],exclusions:['Civil works.'],schedule}
 let quote=(await run(supplier,'save-quote',{rfqId:rfq.id,items:[{id:'alternative',classification:'alternative',sourceItemId:'panel',description:'Prefabricated panel pair',quantity:1,unit:'pair',unitPrice:40,scopeReason:'A matched pair replaces two individual panels'},{id:'spare',classification:'additional',description:'Spare fixing pack',quantity:1,unit:'pack',unitPrice:5,scopeReason:'Included spare fixings'}],commercial:{validityUntil:'2099-12-31'},...declarations})).quote
 await run(supplier,'submit-quote',{id:quote.id,confirmed:true});assert.deepEqual(ctx.store.get(buyer.id,'quotes',quote.id).schedule,schedule)
 await assert.rejects(run(supplier,'save-quote',{...quote,id:undefined,schedule:[{...schedule[0],date:'2099-01-16'}]},{agent:true}),error=>error.code==='FIRM_SCHEDULE_HUMAN_REQUIRED')
 const candidate=(await run(supplier,'save-quote',{...quote,id:undefined},{agent:true})).quote;assert.deepEqual(candidate.schedule,schedule);assert.equal(ctx.store.get(buyer.id,'quotes',candidate.id),undefined)
 const intent=(await run(buyer,'propose-award',{quoteId:quote.id,reason:'Reviewed alternative pair and extra fixing pack meet the complete source scope',confirmed:true})).awardIntent;await run(supplier,'confirm-award',{id:intent.id,confirmed:true});const proposal=await routes.find(row=>row[0]==='POST'&&row[1]==='/workspace/review/:action')[2]({user:buyer,params:{action:'sign-order'},body:{id:intent.id}}),signed=await grantAndSign(ctx,buyer,reviewer,proposal),order=signed.order
 assert.deepEqual(order.schedule,schedule);assert.deepEqual(order.assumptions,declarations.assumptions);assert.equal(order.items[0].classification,'alternative');assert.equal(order.items[1].classification,'additional');assert.deepEqual(ctx.store.get(supplier.id,'orders',order.id).exclusions,['Civil works.'])
 await assert.rejects(ctx.store.exchange(buyer.id,supplier.id,'orders',{...order,schedule:[{...schedule[0],date:'2099-01-20'}]},{event:'test/tampered-schedule'}),/human decision|match/)
 checks.push('Human selection adopts complete explicit alternative+additional scope; firm milestones and qualifications survive signed QEP intent→supplier confirmation→independent grant→PO; model cannot change valid firm promise and tampered order cannot reuse approval')

 const FAQrfq=(await run(buyer,'create-rfq',{title:'FAQ exact source',...declaredScope(items),supplierIds:[supplier.id]})).rfq;await run(buyer,'publish-rfq',{id:FAQrfq.id,confirmed:true})
 const ticket=(await run(supplier,'ask-clarification',{rfqId:FAQrfq.id,question:'Does delivery include labels?',itemIds:['panel'],confirmed:true})).clarification;await run(buyer,'save-clarification-answer',{id:ticket.id,answer:'Delivery includes durable equipment labels.'});await run(buyer,'broadcast-clarification',{id:ticket.id,confirmed:true})
 await assert.rejects(run(buyer,'prepare-faq',{clarificationId:ticket.id,fields:[{key:'cost_model',value:'PRIVATE'}]}),/supported reusable/)
 const faq=(await run(buyer,'prepare-faq',{clarificationId:ticket.id,fields:[{key:'scope_note',value:'Delivery includes durable equipment labels.'}]},{agent:true})).faq
 await assert.rejects(run(buyer,'publish-faq',{id:faq.id,confirmed:true},{agent:true}),/cannot commit/)
 assert.equal(ctx.procurement.faqLookup(buyer,{rfqId:FAQrfq.id,rfqRevision:1,question:ticket.question}).hit,false);await run(buyer,'publish-faq',{id:faq.id,confirmed:true})
 const lookup={rfqId:FAQrfq.id,rfqRevision:1,question:'  DOES delivery include LABELS? '},events=ctx.store.events(buyer.id).length,hit=ctx.procurement.faqLookup(buyer,lookup);assert.equal(hit.hit,true);assert.deepEqual(ctx.procurement.faqLookup(buyer,lookup),hit);assert.equal(ctx.store.events(buyer.id).length,events);assert.equal(ctx.procurement.faqLookup(supplier,lookup).hit,false)
 checks.push('Model may prepare only selected allowed FAQ fields from shared source; private keys rejected, human publication required, source refs and question hash retained; exact lookup deterministic/read-only and realm-isolated')

 const amendment=(await run(buyer,'save-amendment',{rfqId:FAQrfq.id,expectedRevision:1,description:'Revised labels need room reference',reason:'Room layout changed'})).amendment;await run(buyer,'publish-amendment',{id:amendment.id,confirmed:true})
 const miss=ctx.procurement.faqLookup(buyer,{...lookup,rfqRevision:2});assert.equal(miss.hit,false);assert.equal(miss.entry,null);assert.equal(miss.reason,'faq-version-mismatch');assert(!JSON.stringify(miss).includes('durable equipment labels'))
 const adaptation=await run(buyer,'adapt-faq',{id:faq.id,clarificationId:ticket.id,answer:'Delivery includes durable labels with the current room reference.',reason:'Current layout retains labels and adds a reviewed room reference.'},{agent:true});assert.equal(adaptation.clarification.answerSource.exactVersion,false);assert.equal(ctx.store.get(supplier.id,'clarifications',ticket.id).draftAnswer,undefined)
 await run(buyer,'broadcast-clarification',{id:ticket.id,confirmed:true});assert.match(ctx.store.get(supplier.id,'clarifications',ticket.id).answer,/current room/)
 await run(buyer,'deprecate-faq',{id:faq.id,reason:'Use the updated room-labelled source.'});assert.equal(ctx.procurement.faqLookup(buyer,lookup).hit,false)
 await mounted.dispose();mounted=await mount();ctx=mounted.ctx;assert.equal(ctx.procurement.snapshot(buyer).faqs.find(row=>row.id===faq.id).status,'deprecated');assert.deepEqual(ctx.procurement.snapshot(supplier).orders.find(row=>row.id===order.id).schedule,schedule)
 checks.push('Wrong-version FAQ lookup returns no content; explicit historical adaptation retains source+target versions as private draft until full human broadcast; deprecation and signed milestone order survive actual remount')
 const report={ok:true,root,checks,ids:{rfq:rfq.id,quote:quote.id,order:order.id,faq:faq.id,faqRfq:FAQrfq.id,ticket:ticket.id},at:new Date().toISOString()};writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
}finally{await mounted.dispose()}
