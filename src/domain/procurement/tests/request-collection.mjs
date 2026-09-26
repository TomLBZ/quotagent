import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {Context} from '../../../../host/node_modules/cordis/lib/index.js'
import * as storePlugin from '../../../system/workspace-store/code/index.mjs'
import {createCollections} from '../../../system/webui/code/collections.mjs'
import {createProcurement} from '../code/service.mjs'
import {requestCollection} from '../code/request-collection.mjs'

mkdirSync('tmp',{recursive:true});const root=mkdtempSync(resolve('tmp/request-collection-')),ctx=new Context(),checks=[]
const buyer={id:'buyer',role:'contractor',name:'Buyer'},supplier={id:'supplier',role:'supplier',name:'Supplier'},other={id:'other',role:'contractor',name:'Other'},outsider={id:'outsider',role:'supplier',name:'Uninvited'}
const users=[buyer,supplier,other,outsider],accounts={list:()=>structuredClone(users),get:id=>structuredClone(users.find(row=>row.id===id)),can:()=>true}
let fiber=await ctx.plugin(storePlugin,{root}),procurement=createProcurement({store:ctx.store,accounts}),collections=createCollections({store:ctx.store}),dispose=collections.register(requestCollection(procurement))
try{
  const records=[]
  for(let i=0;i<31;i++)records.push((await procurement.execute(buyer,'create-rfq',{title:`Collection ${String(i).padStart(2,'0')}`,description:i%2?'Steel panels':'Timber panels',currency:i%2?'GBP':'USD',deadline:i%2?'2026-10-30':'',supplierIds:[supplier.id],items:[{id:'panel',description:'Panel',quantity:i+1,unit:'each'}]})).rfq)
  await procurement.execute(other,'create-rfq',{title:'Other party private fixture',items:[{description:'Private scope',quantity:1}],supplierIds:[]})
  const first=await collections.query(buyer,'requests',{sort:'title',size:10}),ids=[]
  assert.equal(first.query.total,31);assert.equal(first.query.pages,4)
  for(let page=1;page<=first.query.pages;page++){const result=await collections.query(buyer,'requests',{sort:'title',size:10,page});assert(result.rows.length<=10);ids.push(...result.rows.map(row=>row.id))}
  assert.deepEqual(ids,records.map(row=>row.id));assert.equal(new Set(ids).size,31)
  assert.equal((await collections.query(other,'requests')).query.total,1);assert.equal((await collections.query(supplier,'requests')).query.total,0)
  const sourceEvents=ctx.store.events(buyer.id).length
  const query={search:'panels',filters:{currency:{equals:'GBP'},lineCount:{min:'1'}},sort:'title',direction:'desc',size:10,exportColumns:['title','currency','lineCount']},filtered=await collections.query(buyer,'requests',query),csv=await collections.export(buyer,'requests',query)
  assert.equal(filtered.query.matched,15);assert.equal(csv.rows,15);assert.deepEqual(csv.columns,['title','currency','lineCount']);assert.equal(ctx.store.events(buyer.id).length,sourceEvents)
  checks.push('31 real request drafts cross four server pages exactly; foreign parties and uninvited suppliers see no other records; whole-source query and selected-column export agree without writes')

  const rfq=records[0];await procurement.execute(buyer,'publish-rfq',{id:rfq.id,confirmed:true})
  const draft=(await procurement.execute(supplier,'save-quote',{rfqId:rfq.id,items:[{id:'panel',unitPrice:10,cost:2}],privateNotes:'Private floor'})).quote
  assert.equal((await collections.query(buyer,'requests',{search:rfq.title})).rows[0].quoteCount,0)
  await procurement.execute(supplier,'submit-quote',{id:draft.id,confirmed:true})
  const revision=(await procurement.execute(supplier,'save-quote',{rfqId:rfq.id,items:[{id:'panel',unitPrice:9,cost:2}]})).quote
  await procurement.execute(supplier,'submit-quote',{id:revision.id,confirmed:true})
  for(const user of [buyer,supplier]){const result=await collections.query(user,'requests',{search:rfq.title});assert.equal(result.rows[0].quoteCount,1);assert.equal(result.rows[0].lineCount,1);for(const key of ['items','supplierIds','draftDefaults','cost','privateNotes'])assert.equal(result.rows[0][key],undefined)}
  assert.equal((await collections.query(outsider,'requests')).query.total,0)
  checks.push('Only current submitted offer counts once after supplier revision; supplier sees its invitation only; compact row whitelist excludes costs, private notes, provenance, recipient lists and item payloads')

  const saved=await collections.save(buyer,'requests',{values:query,expectedRevision:0});assert.equal(saved.revision,1)
  assert.equal(collections.preference(supplier,'requests').revision,0)
  dispose();assert.throws(()=>collections.preference(buyer,'requests'),error=>error.status===404);collections.dispose();await fiber.dispose()
  fiber=await ctx.plugin(storePlugin,{root});procurement=createProcurement({store:ctx.store,accounts});collections=createCollections({store:ctx.store});dispose=collections.register(requestCollection(procurement))
  assert.equal(collections.preference(buyer,'requests').values.filters.currency.equals,'GBP');assert.equal((await collections.query(buyer,'requests',collections.preference(buyer,'requests').values)).query.matched,15)
  checks.push('Explicit personal view persists in the actual ledger and replays after store remount; another account stays default; removing domain registration removes collection access')
  const report={ok:true,root,checks,at:new Date().toISOString()};writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
}finally{dispose();collections.dispose();await fiber.dispose()}
