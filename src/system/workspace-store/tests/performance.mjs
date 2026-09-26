// Filesystem-specific baseline, not a universal latency guarantee.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtempSync,mkdirSync,writeFileSync,statfsSync,statSync} from 'node:fs'
import {resolve} from 'node:path'
import {cpus,platform,release} from 'node:os'
import {performance} from 'node:perf_hooks'
import * as store from '../code/index.mjs'
const require=createRequire(new URL('../../../../host/package.json',import.meta.url)),{Context}=require('cordis')
mkdirSync('tmp',{recursive:true});const root=mkdtempSync(resolve('tmp/store-performance-')),ctx=new Context(),latencies=[]
let fiber=await ctx.plugin(store,{root})
const count=10000,realm='performance-fixture',started=performance.now()
try{
 for(let index=0;index<count;index++){
  const before=performance.now();await ctx.store.put(realm,'baseline',{id:`row-${index}`,revision:1,quantity:index,description:`Durable test item ${index}`,unit:'each'},{event:'workspace/record-saved',actor:'human:performance-fixture'})
  latencies.push(performance.now()-before)
 }
 const appendTotalMs=performance.now()-started,expected=ctx.store.list(realm,'baseline'),head=ctx.store.events(realm).at(-1).entry_hash
 assert.equal(expected.length,count);await fiber.dispose()
 const reopen=performance.now();fiber=await ctx.plugin(store,{root});const rebuildMs=performance.now()-reopen
 assert.deepEqual(ctx.store.list(realm,'baseline'),expected);assert.equal(ctx.store.events(realm).at(-1).entry_hash,head)
 const historyStart=performance.now(),historic=ctx.store.projection(realm,{seq:5000}),historyMs=performance.now()-historyStart
 assert.equal(historic.baseline.length,5000)
 latencies.sort((a,b)=>a-b);const percentile=n=>latencies[Math.ceil(count*n)-1]
 const report={ok:true,at:new Date().toISOString(),root,count,recordShape:'One version per distinct item; integer quantity, unit, description. Existing Python Ledger with default fsync=true; serial native NDJSON adapter calls.',environment:{node:process.version,os:platform(),release:release(),cpu:cpus()[0]?.model,filesystemType:statfsSync(root).type,ledgerBytes:statSync(`${root}/ledgers/${realm}.jsonl`).size},append:{totalMs:appendTotalMs,meanMs:appendTotalMs/count,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),maxMs:latencies.at(-1)},rebuild:{events:count,milliseconds:rebuildMs,exactRecordsAndHead:true},historical:{seq:5000,records:5000,milliseconds:historyMs},historicalTargets:{appendEveryEvent5ms:latencies.at(-1)<=5,rebuild10000Within10s:rebuildMs<=10000},limits:'Single measured container/filesystem and synthetic record size. Append includes IPC, durable append, chain verification and response/projection update. Rebuild includes process startup, ledger validation and all native projections. No public load, remote disk, concurrency or provider inference claimed.'}
 writeFileSync(`${root}/report.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
}finally{await fiber.dispose()}
