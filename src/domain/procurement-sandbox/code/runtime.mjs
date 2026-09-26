import {Context} from '../../../../host/node_modules/cordis/lib/index.js'
import {Readable} from 'node:stream'
import * as web from '../../../system/webui/code/product-server.mjs'
import * as store from '../../../system/workspace-store/code/index.mjs'
import * as settings from '../../../system/settings/code/index.mjs'
import * as notifications from '../../../system/notifications/code/index.mjs'
import * as teams from '../../../system/teams/code/index.mjs'
import * as actions from '../../../system/action-center/code/index.mjs'
import * as agent from '../../../system/agent-runtime/code/product.mjs'
import * as procurement from '../../procurement/code/index.mjs'
import * as commercial from '../../commercial-workbench/code/index.mjs'
import * as files from '../../../system/file-store/code/index.mjs'
import * as ingestion from '../../ingestion/code/index.mjs'
import * as engines from '../../ingestion-engines/code/index.mjs'
import * as workflows from '../../../system/agent-workflows/code/index.mjs'
import * as styles from '../../../system/workspace-styles/code/index.mjs'
import * as guide from '../../../system/user-guide/code/index.mjs'
import {runScenario} from './scenario.mjs'
const sourceActor=Symbol('sandbox-native-scenario-actor'),clone=value=>structuredClone(value)
export const actors=[
 {id:'sandbox-buyer',role:'contractor',name:'Simulated buyer',company:'Demo Northstar Construction',email:'buyer@sandbox.invalid'},
 {id:'sandbox-reviewer',role:'contractor',name:'Simulated independent reviewer',company:'Demo Northstar Construction',email:'reviewer@sandbox.invalid'},
 {id:'sandbox-supplier',role:'supplier',name:'Simulated supplier',company:'Demo Summit Supply',email:'supplier@sandbox.invalid'},
 {id:'sandbox-supplier2',role:'supplier',name:'Simulated competing supplier',company:'Demo Atlas Materials',email:'supplier2@sandbox.invalid'},
].map(user=>({...user,permissions:[],preferences:{},sandbox:true}))
export async function createRuntime({root,role,prefix='/quotagent',descriptor}){
 const ctx=new Context(),fibers=[],current=actors.find(user=>user.role===role&&user.id!=='sandbox-reviewer');let disposed=false
 const profile=id=>{const actor=actors.find(user=>user.id===id);return actor?{...clone(actor),preferences:ctx.get('store')?.get(id,'sandbox-accounts',id)?.preferences||{}}:null}
 const mount=async(module,config)=>{const fiber=await ctx.plugin(module,config);fibers.push(fiber);if(fiber.state!==2)throw new Error('Demo plugin failed to activate: '+module.name)}
 const dispose=async()=>{if(disposed)return;disposed=true;for(const fiber of fibers.reverse())await fiber.dispose()}
 try{
  await mount(web,{prefix});await mount(store,{root})
  await mount({name:'sandbox-accounts',inject:['store','web'],apply(inner){const update=async(id,patch)=>{if(id!==current.id)throw new Error('Edit only your own demonstration preferences.');if(Object.keys(patch).some(key=>key!=='preferences'))throw new Error('The demo identity and perspective are fixed. Exit demo mode to edit your real account.');await inner.store.put(id,'sandbox-accounts',{id,preferences:{...profile(id).preferences,...clone(patch.preferences||{})}},{actor:id,event:'sandbox/preferences-updated'});return profile(id)};inner.provide('accounts',{get:profile,list:()=>actors.map(user=>profile(user.id)),can:(user)=>!!profile(user?.id),resolve:req=>profile(req[sourceActor]||current.id),update});inner.effect(()=>inner.web.route('PATCH','/account',async({user,body})=>({user:await update(user.id,body)})));inner.effect(()=>inner.web.contribute(descriptor))}})
  await mount(settings,{initFile:false});await mount(notifications);await mount(teams);await mount(actions);await mount(agent,{inheritDefaults:false});await mount(procurement);await mount(commercial);await mount(files);await mount(ingestion);await mount(engines);await mount(workflows);await mount(styles);await mount(guide)
  const invoke=async(actor,path,body={})=>{if(disposed)throw new Error('Demo runtime disposed.');const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method='POST';req.url=prefix+'/api'+path;req.headers={};req[sourceActor]=actor.id;let status=200,data='';const res={writableEnded:false,writeHead(code){status=code},setHeader(){},end(value=''){data+=value;this.writableEnded=true}};await ctx.web.handle(req,res);const result=data?JSON.parse(data):{};if(status>=400||result.ok===false)throw new Error(result.error||'The demo step did not complete.');return result}
  return{ctx,actor:profile(current.id),handle:(req,res)=>ctx.web.handle(req,res),dispose,seed:progress=>runScenario({ctx,actors,invoke,progress})}
 }catch(error){await dispose();throw error}
}
