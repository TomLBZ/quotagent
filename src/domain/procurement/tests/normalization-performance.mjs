import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {Context} from '../../../../host/node_modules/cordis/lib/index.js'
import * as storePlugin from '../../../system/workspace-store/code/index.mjs'
import * as procurementPlugin from '../code/index.mjs'
mkdirSync('tmp',{recursive:true});const root=mkdtempSync(resolve('tmp/procurement-normalization-perf-')),ctx=new Context(),fibers=[]
const buyer={id:'buyer',role:'contractor',name:'Buyer'},suppliers=Array.from({length:5},(_,i)=>({id:'supplier-'+i,role:'supplier',name:'Supplier '+i})),users=[buyer,...suppliers]
fibers.push(await ctx.plugin({name:'normalization-perf-fixture',apply(inner){inner.provide('accounts',{list:()=>structuredClone(users),get:id=>structuredClone(users.find(row=>row.id===id)),can:()=>true});inner.provide('web',{route:()=>()=>{},contribute:()=>()=>{}})}}));for(const plugin of[storePlugin,procurementPlugin])fibers.push(await ctx.plugin(plugin,plugin===storePlugin?{root}:{}))
try{
 const run=(user,action,input)=>ctx.procurement.execute(user,action,input)
 const items=Array.from({length:200},(_,i)=>({id:'line-'+i,description:'Measured cable '+i,quantity:10+i,unit:'m',measurementRuleId:'length',interfaceId:'supply'})),scope={measurementRules:[{id:'length',name:'Cable measurement',dimension:'length',units:[{unit:'m',factor:1},{unit:'cm',factor:0.01}]}],interfaces:[{id:'supply',name:'Supply and termination',responsibilityOwner:'Supplier'}],deliverables:'Measured and terminated cable',exclusions:'Civil works'}
 const rfq=(await run(buyer,'create-rfq',{title:'Measured200×5 normalization',items,scope,supplierIds:suppliers.map(row=>row.id)})).rfq;await run(buyer,'publish-rfq',{id:rfq.id,confirmed:true})
 const inputs=suppliers.map((_,supplier)=>items.map(item=>({id:item.id,unitPrice:0,offered:{quantity:item.quantity*100,unit:'cm',unitPrice:(supplier+1)/100}})))
 for(let i=0;i<suppliers.length;i++){const quote=(await run(suppliers[i],'save-quote',{rfqId:rfq.id,items:inputs[i]})).quote;await run(suppliers[i],'submit-quote',{id:quote.id,confirmed:true})}
 const before=users.map(user=>ctx.store.events(user.id).length),start=performance.now(),normalized=inputs.map(input=>ctx.procurement.normalizeQuoteItems(input,rfq)),comparison=ctx.procurement.snapshot(buyer).comparison,elapsedMs=performance.now()-start
 assert.equal(comparison.length,5);assert.equal(normalized.length,5);assert(normalized.every(rows=>rows.length===200));assert(elapsedMs<30000,`Measured ${elapsedMs}ms exceeds30s requirement`)
 assert.deepEqual(inputs.map(input=>ctx.procurement.normalizeQuoteItems(input,rfq)),normalized);assert.deepEqual(ctx.procurement.snapshot(buyer).comparison,comparison);assert.deepEqual(users.map(user=>ctx.store.events(user.id).length),before)
 const report={ok:true,root,dimensions:{items:200,quotes:5},elapsedMs,thresholdMs:30000,measurement:'Five complete exact-unit normalization calls plus authorized buyer comparison snapshot; fixture authorship/QEP transfer excluded. One local Node process, no network model call.',checks:['Actual200-item RFQ and five human-submitted QEP quotations available in buyer realm','Exact normalization and comparison remain deterministic and append no events on replay','Measured200×5 normalization+comparison below30s on this host'],at:new Date().toISOString()};writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
}finally{for(const fiber of fibers.reverse())await fiber.dispose()}
