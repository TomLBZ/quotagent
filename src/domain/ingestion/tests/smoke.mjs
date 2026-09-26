/** Real Cordis + Python Ledger, no AI provider needed for upload/table/private-draft flow. */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdirSync,mkdtempSync} from 'node:fs'
import {resolve} from 'node:path'
import * as store from '../../../system/workspace-store/code/index.mjs'
import * as files from '../../../system/file-store/code/index.mjs'
import * as settings from '../../../system/settings/code/index.mjs'
import * as procurement from '../../procurement/code/index.mjs'
import * as ingestion from '../code/index.mjs'
import * as spreadsheet from '../../ingestion-engines/code/spreadsheet.mjs'
import * as tabular from '../../ingestion-engines/code/tabular.mjs'
import * as email from '../../ingestion-engines/code/email.mjs'
import * as documents from '../../ingestion-engines/code/documents.mjs'
import {fixtures} from '../../ingestion-engines/tests/fixtures.mjs'
const require=createRequire(new URL('../../../../host/package.json',import.meta.url))
const {Context}=require('cordis'),ctx=new Context(),routes=[],navigation=[],tools=[]
const fibers=[]
const mount=async(...args)=>{const fiber=await ctx.plugin(...args);fibers.push(fiber);return fiber}
const users=[{id:'ingestion-buyer',role:'contractor',name:'Buyer',company:'Builder'}, {id:'ingestion-supplier',role:'supplier',name:'Supplier',company:'Vendor'}]
const [buyer,supplier]=users
const add=(list,value)=>{list.push(value);return()=>list.splice(list.indexOf(value),1)}
mkdirSync(resolve('tmp'),{recursive:true});const root=mkdtempSync(resolve('tmp/ingestion-smoke-'))
await mount({name:'fixture-services',apply(ctx){
  ctx.provide('accounts',{list:()=>structuredClone(users),get:id=>users.find(user=>user.id===id),can:()=>true})
  ctx.provide('web',{route:(...args)=>add(routes,args),contribute:value=>add(navigation,value)})
  ctx.provide('assistant',{tool:value=>add(tools,value)})
}})
await mount(store,{root});await mount(settings);await mount(files);await mount(procurement)
const ingestFiber=await mount(ingestion)
await mount(spreadsheet);const csvFiber=await mount(tabular);await mount(email);await mount(documents)
const source=await fixtures()
const parse=async(user,filename,buffer=source[filename])=>{const file=await ctx.files.put(user,{filename,buffer});return ctx.ingestion.parse(user,file.id)}
try {
  assert.equal(ctx.ingestion.catalog(buyer).length,4,'Traditional engine catalog works without AI')
  const record=await parse(buyer,'cabling-offer.eml')
  assert.equal(record.items.length,2);assert.equal(record.attachments.length,1)
  assert.ok(ctx.files.read(buyer,record.fileId).equals(source['cabling-offer.eml']))
  assert.throws(()=>ctx.files.read(supplier,record.fileId),/not available/)
  assert.throws(()=>ctx.ingestion.get(supplier,record.id),/not in your account/)
  const mixed=await parse(buyer,'mixed-headings.xlsx')
  assert.equal(mixed.rows.length,2);assert.equal(mixed.items.length,2,'Both sheets survive heterogeneous heading aliases')
  assert.equal(mixed.items[1].description,'Dual data outlet with faceplate');assert.equal(mixed.items[1].quantity,48)
  const {rfq}=await ctx.ingestion.importDraft(buyer,record.id,{title:'Email-based private RFQ',supplierIds:[supplier.id]})
  assert.equal(rfq.status,'draft');assert.equal(ctx.procurement.snapshot(supplier).rfqs.length,0)
  await ctx.procurement.execute(buyer,'publish-rfq',{id:rfq.id,confirmed:true})
  const offer=await parse(supplier,'cabling-offer.xlsx')
  const {quote}=await ctx.ingestion.importDraft(supplier,offer.id,{rfqId:rfq.id,paymentTerms:'Net 30',leadDays:12})
  assert.equal(quote.total,3156);assert.equal(quote.status,'draft');assert.equal(ctx.procurement.snapshot(buyer).quotes.length,0)
  await ctx.ingestion.update(supplier,offer.id,{currency:'EUR'})
  await assert.rejects(ctx.ingestion.importDraft(supplier,offer.id,{rfqId:rfq.id}),/priced in EUR.*uses USD/)
  await ctx.ingestion.update(supplier,offer.id,{currency:'USD',items:offer.items.map((item,i)=>({...item,unit:i?'each':'box'}))})
  await assert.rejects(ctx.ingestion.importDraft(supplier,offer.id,{rfqId:rfq.id}),/priced per box.*requests m/)
  const euro=await parse(supplier,'euro-offer.csv',Buffer.from('Description,Quantity,Unit,Unit Price EUR\nCable,10,box,EUR 100'))
  assert.equal(euro.currency,'EUR');assert.equal(euro.items[0].unitPrice,100)
  const emptyAttachment=await parse(buyer,'empty-attachment.eml',Buffer.from('Subject: Valve request\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="parts"\r\n\r\n--parts\r\nContent-Type: text/plain\r\n\r\n10 each Useful valve\r\n--parts\r\nContent-Type: text/csv\r\nContent-Disposition: attachment; filename="empty.csv"\r\n\r\n\r\n--parts--\r\n'))
  assert.equal(emptyAttachment.items.length,1);assert.match(emptyAttachment.warnings.join(' '),/empty.csv.*empty/)
  assert.ok(ctx.store.events(buyer.id).some(row=>row.type==='ingestion/document-parsed'))
  assert.ok(ctx.store.events(buyer.id).some(row=>row.type==='ingestion/imported-to-private-draft'))
  await assert.rejects(ctx.ingestion.extract(buyer,record.id),/not connected/)
  const assumed=await parse(buyer,'incomplete.csv',Buffer.from('Description,Quantity,Unit\nUnknown valve,,\n'))
  assert.deepEqual(assumed.questions.map(row=>row.field),['quantity','unit'])
  const unsupported={id:'unreferenced',description:'Operator added valve',quantity:2,unit:'each',unitPrice:null,cost:null,source:{quote:'This exact excerpt does not exist'}}
  let review=await ctx.ingestion.update(buyer,assumed.id,{items:[unsupported]})
  assert.equal(review.itemReviews[0].kind,'assumption');assert.equal(review.itemReviews[0].confirmed,false)
  const before=ctx.procurement.snapshot(buyer).rfqs.length
  await assert.rejects(ctx.ingestion.importDraft(buyer,assumed.id,{}),/Confirm the labelled assumptions/)
  assert.equal(ctx.procurement.snapshot(buyer).rfqs.length,before)
  review=await ctx.ingestion.update(buyer,assumed.id,{confirmAssumptions:[unsupported.id]})
  assert.equal(review.itemReviews[0].confirmed,true);assert.equal(review.itemReviews[0].confirmation.by,buyer.id)
  assert.equal(review.questions.length,0)
  const privateAssumption=await ctx.ingestion.importDraft(buyer,assumed.id,{})
  assert.equal(privateAssumption.rfq.status,'draft')
  review=await ctx.ingestion.update(buyer,assumed.id,{items:[{...unsupported,quantity:3}]})
  assert.equal(review.itemReviews[0].confirmed,false,'Exact-item confirmation cannot apply to edited values')
  assert.equal(ctx.store.events(buyer.id).filter(row=>row.type==='ingestion/assumptions-reviewed').length,1)
  assert.equal(ctx.store.events(buyer.id).findLast(row=>row.body?.record?.id===assumed.id).body.record.questions[0].field,'source','Model-visible questions reconstruct from ledger')
  await csvFiber.dispose();assert.ok(!ctx.ingestion.catalog(buyer).some(engine=>engine.id==='tabular'))
  const csv=await ctx.files.put(buyer,{filename:'cabling-offer.csv',buffer:source['cabling-offer.csv']})
  await assert.rejects(ctx.ingestion.parse(buyer,csv.id),/No engine supports/)
  await ingestFiber.dispose();assert.ok(!routes.some(([method,path])=>path.startsWith('/ingestion')))
  assert.ok(!tools.some(tool=>tool.name.startsWith('ingestion_')))
  console.log(JSON.stringify({ok:true,root,checks:['real-format email attachment parsing','account-owned original and extraction','heterogeneous Excel sheet headings','private contractor RFQ and supplier $3156 quote','currency/unit mismatch rejected; EUR source detected','complete parsed sources in ledger','missing-field questions; exact-source assumptions; human confirmation; edited-value invalidation; no external effects','AI optional; engine unload removes registration; route/tool disposal']}))
} finally {for(const fiber of fibers.reverse())await fiber.dispose()}
