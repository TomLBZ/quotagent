// Independent local QEP fixture. It authors explicitly labelled test quotations;
// it never mutates the running product or represents a real supplier commitment.
import {createRequire} from 'node:module'
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import * as storePlugin from '../../workspace-store/code/index.mjs'
import {procurementExchangePolicy} from '../../../domain/procurement/code/exchange-policy.mjs'
const require=createRequire(new URL('../../../../host/package.json',import.meta.url)),{Context}=require('cordis')
export async function quotationFixture({buyer,supplier,rfq,channel,secret,evidence}){
 mkdirSync('tmp',{recursive:true});const root=mkdtempSync(resolve('tmp/exchange-gui-peer-')),ctx=new Context(),fiber=await ctx.plugin(storePlugin,{root}),accounts={get:id=>[{id:buyer,role:'contractor'},{id:supplier,role:'supplier'}].find(row=>row.id===id)}
 const dispose=ctx.store.exchangePolicy(procurementExchangePolicy({store:ctx.store,accounts}));await ctx.store.configurePeer(supplier,buyer,channel,secret)
 const id=`local-protocol-quote-${Date.now()}`,createdAt=new Date().toISOString()
 return{root,id,async offer(revision,amount,filename){const stamp=new Date().toISOString(),record={id,rfqId:rfq.id,supplierId:supplier,supplierName:'Local protocol fixture supplier',ownerId:buyer,leadDays:7,paymentTerms:'Fixture only; no real order',notes:'Explicit local protocol fixture for concurrent reviewed quotation branches.',status:'submitted',total:amount,currency:rfq.currency,revision,rfqRevision:rfq.publishedRevision||rfq.revision||1,items:rfq.items.map(item=>({...item,unitPrice:amount/item.quantity,total:amount})),createdAt,updatedAt:stamp,submittedAt:stamp};await ctx.store.put(supplier,'quotes',record,{event:'procurement/quote-submitted',actor:`human:${supplier}`});await ctx.store.append(supplier,'procurement/human-approved',{action:'submit-quote',recordId:id,humanId:supplier,scope:record,approvedAt:stamp},{actor:`human:${supplier}`});const queued=await ctx.store.exchange(supplier,buyer,'quotes',record,{channel,manual:true});const exported=await ctx.store.package(supplier,queued.msgId);writeFileSync(`${evidence}/${filename}`,JSON.stringify(exported.package,null,2));return{record,queued,package:exported.package}},async receipt(packageValue){return ctx.store.receivePackage(supplier,packageValue)},async close(){dispose();await fiber.dispose()}}
}
