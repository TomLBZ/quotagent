/** Composition only: every product behavior is supplied by a Cordis plugin. */
import { Context } from 'cordis'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as web from '../src/system/webui/code/product-server.mjs'
import * as store from '../src/system/workspace-store/code/index.mjs'
import * as accounts from '../src/system/accounts/code/product.mjs'
import * as agent from '../src/system/agent-runtime/code/product.mjs'
import * as procurement from '../src/domain/procurement/code/index.mjs'
import * as studio from '../src/system/plugin-studio/code/product.mjs'
const root = fileURLToPath(new URL('../',import.meta.url))
const ctx = new Context()
const fibers=[]
const mount = async(plugin,config={})=>{ const fiber=await ctx.plugin(plugin,config); fibers.push(fiber); if(fiber.state!==2) throw new Error(`Plugin ${plugin.name} did not activate (${fiber.state})`); return fiber }
await mount(web,{port:Number(process.env.QUOTAGENT_WEBUI_PORT || 8093),host:process.env.QUOTAGENT_WEBUI_HOST || '127.0.0.1',prefix:process.env.QUOTAGENT_WEBUI_PREFIX || '/quotagent',assets:resolve(root,'src/system/webui/client/dist')})
await mount(store,{root:process.env.QUOTAGENT_PRODUCT_DATA || resolve(root,'tmp/product-data')})
await mount(accounts)
await mount(agent)
await mount(procurement)
await mount(studio)
const address=await ctx.web.listen()
console.log(JSON.stringify({ready:true,port:address.port,url:`http://127.0.0.1:${address.port}${ctx.web.prefix}/`,plugins:fibers.map(f=>({name:f.name,state:f.state,uid:f.uid}))}))
let closing=false
const stop=async()=>{if(closing)return;closing=true;for(const fiber of fibers.reverse()) await fiber.dispose();process.exit(0)}
process.once('SIGTERM',stop);process.once('SIGINT',stop)
