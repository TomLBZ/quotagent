import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync} from 'node:fs'
import {Context} from '../../../../host/node_modules/cordis/lib/index.js'
import * as web from '../code/product-server.mjs'
const ctx=new Context(),fiber=await ctx.plugin(web,{port:0,prefix:'/example'}),checks=[]
try{const {port}=await ctx.web.listen(),base=`http://127.0.0.1:${port}`,response=await fetch(base+'/example/api/routes'),value=await response.json();assert.equal(response.status,200);assert.deepEqual(value.routes,[{method:'GET',path:'/example/',auth:'none',title:'Quotagent workspace'}]);assert.equal((await fetch(base+'/example/api/health')).status,200);checks.push('Unrelated configured prefix self-describes exactly one public entry without login; native health responds')
const path=await fetch(base+'/example',{redirect:'manual'});assert.equal(path.status,302);assert.equal(path.headers.get('location'),'/example/');await fiber.dispose();await assert.rejects(fetch(base+'/example/api/routes'));checks.push('Entry normalizes to trailing slash; disposing web fiber closes its actual HTTP listener')
const directory=process.env.EVIDENCE_DIR||'tmp/agent-experience/catalog-ui-runtime/discovery';mkdirSync(directory,{recursive:true});const report={ok:true,at:new Date().toISOString(),checks};writeFileSync(directory+'/report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
}finally{await fiber.dispose()}
