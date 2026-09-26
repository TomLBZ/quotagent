/** Native lifecycle acceptance with actual store/accounts/settings and installed artifacts. */
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {Context} from '../../../../host/node_modules/cordis/lib/index.js'
import * as web from '../../webui/code/product-server.mjs'
import * as store from '../../workspace-store/code/index.mjs'
import * as accounts from '../../accounts/code/product.mjs'
import * as settings from '../../settings/code/index.mjs'
import * as manager from '../code/index.mjs'
import * as agent from '../../agent-runtime/code/product.mjs'
import * as installed from '../../installed-plugins/code/index.mjs'
import * as studio from '../../plugin-studio/code/product.mjs'
const root=mkdtempSync(resolve('tmp/plugin-manager-native-')),ctx=new Context(),fibers=[],checks=[],mount=async(module,config)=>{const fiber=await ctx.plugin(module,config);assert.equal(fiber.state,2);fibers.push(fiber);return fiber}
try{
 await mount(web);await mount(store,{root});await mount(accounts);await mount(settings,{initFile:false});let managerFiber=await mount(manager)
 const config={inheritDefaults:false},agentFiber=await mount(agent,config),installedFiber=await mount(installed),studioFiber=await mount(studio),admin=ctx.accounts.get('admin-demo'),owner=ctx.accounts.get('contractor-demo')
 const definitions=[{id:'agent-runtime',module:agent,fiber:agentFiber,config,repoId:'system/agent-runtime',configurationId:'ai'},{id:'installed-plugins',module:installed,fiber:installedFiber,repoId:'system/installed-plugins'},{id:'plugin-studio',module:studio,fiber:studioFiber,repoId:'system/plugin-studio'}]
 for(const definition of definitions)ctx.plugins.register(definition)
 let rows=ctx.plugins.list(admin)
 assert(rows.some(row=>row.parentId==='agent-runtime'&&row.provides.includes('ai')))
 assert(rows.some(row=>row.parentId==='agent-runtime'&&row.provides.includes('assistant')))
 assert(rows.some(row=>row.id==='installed-plugins'&&row.provides.includes('installedPlugins')))
 assert(!rows.some(row=>row.parentId==='plugin-studio'&&row.provides.includes('studioRuntime')))
 assert.equal(rows.find(row=>row.id==='agent-runtime').configurable,true)
 assert(rows.some(row=>row.repoId==='system/mail'&&row.status==='available'&&!row.lifecycleAllowed))
 checks.push('Actual native Cordis inventory reports provider/assistant children, independent installed owner, schema association and repository-only availability')
 const created=await ctx.installedPlugins.create(owner,{name:'Lifecycle fixture',description:'Explicit local pure utility',kind:'calculator',spec:{title:'Double quantity',fields:[{name:'quantity',label:'Quantity',type:'number',default:2}],code:'function(input) { return {total: input.quantity * 2} }'}}),id=created.plugin.id
 assert.equal((await ctx.installedPlugins.run(owner,id,{input:{quantity:3}})).result.total,6)
 await assert.rejects(ctx.plugins.setEnabled('agent-runtime',false),/dependent plugins first/)
 await assert.rejects(ctx.plugins.setEnabled('installed-plugins',false),/dependent plugins first/)
 await ctx.plugins.setEnabled('plugin-studio',false)
 assert.equal(ctx.get('studio'),undefined);assert(ctx.get('studioRuntime'));assert(!ctx.web.routes().some(row=>row.path.startsWith('/studio')))
 assert.equal((await ctx.installedPlugins.run(owner,id,{input:{quantity:3}})).result.total,6)
 assert(ctx.web.extensions(owner).some(row=>row.installedId===id))
 checks.push('Dependency refusal protects active Studio; disabling management removes its routes while the actual installed utility still executes6 and keeps its GUI contribution')
 await ctx.plugins.setEnabled('agent-runtime',false);assert.equal(ctx.get('ai'),undefined);assert.equal(ctx.get('assistant'),undefined)
 assert.equal((await ctx.installedPlugins.run(owner,id,{input:{quantity:4}})).result.total,8)
 await assert.rejects(ctx.plugins.setEnabled('plugin-studio',true),/required services first/)
 await ctx.plugins.setEnabled('installed-plugins',false);assert.equal(ctx.get('installedPlugins'),undefined);assert(!ctx.web.extensions(owner).length)
 await managerFiber.dispose();managerFiber=await mount(manager)
 for(const definition of definitions)ctx.plugins.register({...definition,fiber:null})
 for(const definition of definitions)assert.equal(ctx.plugins.enabled(definition.id),false)
 await ctx.plugins.setEnabled('agent-runtime',true);await ctx.plugins.setEnabled('installed-plugins',true);await ctx.plugins.setEnabled('plugin-studio',true)
 assert(ctx.get('studio'));assert.equal((await ctx.installedPlugins.run(owner,id,{input:{quantity:5}})).result.total,10)
 assert.equal(ctx.installedPlugins.history(owner,id).revisions.length,1)
 checks.push('Disablement survives manager restart; actual remount reconstructs unchanged artifact history and utility output10 from the native ledger')
 await managerFiber.dispose();assert.equal(ctx.get('ai'),undefined);assert.equal(ctx.get('installedPlugins'),undefined);assert.equal(ctx.get('studio'),undefined);assert(!ctx.web.extensions(owner).length)
 checks.push('Manager disposal removes its managed fibers, provider/Studio/installed services and generated UI contributions')
 const report={ok:true,root,checks};writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
}finally{for(const fiber of fibers.reverse())await fiber.dispose()}
