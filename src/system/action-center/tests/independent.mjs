import assert from 'node:assert/strict'
import {mkdirSync,mkdtempSync} from 'node:fs'
import {resolve} from 'node:path'
import {Context} from '../../../../host/node_modules/cordis/lib/index.js'
import * as storePlugin from '../../workspace-store/code/index.mjs'
import {createTeams} from '../../teams/code/service.mjs'
import {createActions} from '../code/service.mjs'
const users=[
 {id:'owner',email:'owner@local.test',name:'Proposer',company:'Buyer',role:'contractor',permissions:[]},
 {id:'lead',email:'lead@local.test',name:'Reviewer',company:'Colleague',role:'contractor',permissions:[]},
 {id:'director',email:'director@local.test',name:'Higher reviewer',company:'Colleague',role:'contractor',permissions:[]},
 {id:'outsider',email:'outsider@local.test',name:'Another buyer',company:'Another buyer',role:'contractor',permissions:[]},
 {id:'supplier',email:'supplier@local.test',name:'Supplier',company:'Vendor',role:'supplier',permissions:[]},
]
const [owner,lead,director,outsider]=users,accounts={get:id=>structuredClone(users.find(person=>person.id===id)),list:()=>structuredClone(users),can:user=>!users.find(person=>person.id===user.id)?.permissions.includes('workspace:read-only')}
mkdirSync('tmp',{recursive:true});const root=mkdtempSync(resolve('tmp/independent-actions-')),ctx=new Context(),fiber=await ctx.plugin(storePlugin,{root})
let moment=Date.now(),notices=[],deliveries=0,teams,actions
const notification={push:async(user,input)=>notices.push({to:user.id,...input})}
const checks=[]
try{
 teams=createTeams({store:ctx.store,accounts,notifications:()=>notification})
 for(const [person,roleId] of [[lead,'lead'],[director,'director']]){const invitation=await teams.invite(owner,{email:person.email,roleId});await teams.answerInvite(person,invitation.id,true);await teams.select(person,owner.id)}
 const configure=async(timeoutPolicy='remind')=>{const policy=teams.state(owner).workspace.policy;policy.timeoutMinutes=1;policy.timeoutPolicy=timeoutPolicy;policy.roles=policy.roles.map(role=>({...role,limit:role.id==='director'?100000:role.id==='lead'?50000:0}));const proposal=await teams.proposePolicy(owner,{policy,reviewerId:lead.id,reason:'Test exact authority'});await teams.decidePolicy(lead,proposal.id,{approved:true});await teams.applyPolicy(owner,proposal.id)}
 await configure()
 actions=createActions({store:ctx.store,accounts,teams:()=>teams,notifications:()=>notification,clock:()=>moment})
 const definition={kind:'fixture.order',label:'Exact order',review:(user,input)=>({workspaceId:owner.id,independent:true,amount:input.amount,currency:input.currency||'USD',object:{kind:'intent',id:input.id},action:'sign-order',fingerprint:input.version}),execute:async(user,input,action)=>{await actions.authorizeCommitment({...user,id:owner.id,actorId:user.id},{action:'sign-order',id:input.id,record:input,input:{reviewActionId:action.id}});if(input.fail)throw new Error('Destination refused this exact item');deliveries++;return{sent:true,actorId:user.id,ownerId:user.workspaceOwnerId}}}
 const install=()=>actions.register(definition);install()
 const proposal=(patch={})=>actions.propose(owner,{kind:'fixture.order',title:'Review '+(patch.id||'order'),input:{id:'intent-1',amount:15000,version:'scope-v1',...patch},source:{kind:'human'}})
 const action=await proposal()
 assert.equal(actions.list(lead).length,1);assert.equal(actions.list(outsider).length,0);assert.throws(()=>actions.get(outsider,action.id),/not available/)
 await assert.rejects(actions.authorizeCommitment(owner,{action:'sign-order',id:'intent-1',input:{confirmed:true}}),/Prepare this commitment/)
 await assert.rejects(actions.approve(owner,action.id,{confirmed:true}),/different nominated/)
 await assert.rejects(actions.nominate(owner,action.id,{reviewerId:owner.id}),/different active/)
 await assert.rejects(actions.nominate(owner,action.id,{reviewerId:outsider.id}),/not an active/)
 const nominated=await actions.nominate(owner,action.id,{reviewerId:lead.id});assert.equal(nominated.status,'awaiting-review');assert.equal(deliveries,0)
 await assert.rejects(actions.grant(owner,action.id,{confirmed:true}),/nominated different/)
 await actions.grant(lead,action.id,{confirmed:true,reason:'Checked specification and total'});assert.equal(deliveries,0)
 await assert.rejects(actions.approve(lead,action.id,{confirmed:true}),/proposer signs/)
 const results=await Promise.all([1,2,3].map(()=>actions.approve(owner,action.id,{confirmed:true})))
 assert.equal(deliveries,1);assert(results.every(row=>row.status==='succeeded'));assert.equal(results[0].result.actorId,owner.id)
 assert.equal(ctx.store.events(owner.id).filter(event=>event.type==='actions/signed').length,1)
 checks.push('Actual team/ledger proposal -> independent nominated grant -> proposer signature; concurrent signatures execute once; same-role outsiders cannot read or decide')
 const wrongCurrency=await proposal({id:'eur',currency:'EUR'});await assert.rejects(actions.nominate(owner,wrongCurrency.id,{reviewerId:lead.id}),/sufficient authority/)
 const tooLarge=await proposal({id:'large',amount:50001});await assert.rejects(actions.nominate(owner,tooLarge.id,{reviewerId:lead.id}),/sufficient authority/);await actions.nominate(owner,tooLarge.id,{reviewerId:director.id})
 const stale=await proposal({id:'stale'});await actions.nominate(owner,stale.id,{reviewerId:lead.id});await actions.grant(lead,stale.id,{confirmed:true});await configure();await assert.rejects(actions.approve(owner,stale.id,{confirmed:true}),/Authority policy changed/)
 const removed=await proposal({id:'removed'});await actions.nominate(owner,removed.id,{reviewerId:lead.id});await actions.grant(lead,removed.id,{confirmed:true});await teams.updateMember(owner,{accountId:lead.id,active:false});await assert.rejects(actions.approve(owner,removed.id,{confirmed:true}),/not an active/);await teams.updateMember(owner,{accountId:lead.id,active:true})
 checks.push('Exact currency/amount authority, changed policy and removed reviewer invalidate signing without delivery')
 const delegated=await proposal({id:'delegated'});await actions.nominate(owner,delegated.id,{reviewerId:lead.id});await assert.rejects(actions.nominate(lead,delegated.id,{reviewerId:director.id}),/Explain why/);await actions.nominate(lead,delegated.id,{reviewerId:director.id,reason:'Amount needs director context'});assert.equal(actions.get(owner,delegated.id).delegations.length,2);await actions.remind(owner,delegated.id,{reason:'Deadline tomorrow'});assert.equal(actions.get(owner,delegated.id).reminders.length,1)
 moment+=61000;await actions.age();assert.equal(actions.get(owner,delegated.id).status,'awaiting-review');assert.equal(actions.get(owner,delegated.id).ageNotices.at(-1).outcome,'reminded');assert.equal(deliveries,1)
 await configure('escalate');const escalate=await proposal({id:'escalate'});await actions.nominate(owner,escalate.id,{reviewerId:lead.id});moment+=61000;await actions.age();assert.equal(actions.get(owner,escalate.id).reviewerId,director.id);assert.equal(actions.get(owner,escalate.id).ageNotices.at(-1).outcome,'escalated')
 await configure('expire');const expired=await proposal({id:'expired'});await actions.nominate(owner,expired.id,{reviewerId:lead.id});moment+=61000;await assert.rejects(actions.grant(lead,expired.id,{confirmed:true}),/expired/);await actions.age();assert.equal(actions.get(owner,expired.id).status,'expired');assert.equal(deliveries,1)
 checks.push('Reasoned delegation, participant reminders, higher-role escalation and expiry persist distinct receipts; elapsed time never grants or executes')
 await configure();const success=await proposal({id:'batch-good'}),failed=await proposal({id:'batch-fail',fail:true}),unsigned=await proposal({id:'batch-unsigned'})
 for(const item of [success,failed]){await actions.nominate(owner,item.id,{reviewerId:lead.id});await actions.grant(lead,item.id,{confirmed:true})}
 const batch=await actions.batch(owner,{ids:[success.id,failed.id,unsigned.id],operation:'approve',confirmed:true})
 assert.deepEqual(batch.items.map(row=>row.status),['succeeded','failed','blocked']);assert.equal(deliveries,2);assert.equal(actions.batches(owner)[0].items.length,3)
 const retry=await actions.retry(owner,failed.id);assert.equal(retry.status,'pending');assert.equal(retry.grant,null);assert.notEqual(retry.id,failed.id);assert.equal(actions.get(owner,success.id).status,'succeeded')
 checks.push('Mixed batch stores per-item success/failure/blocked receipts; deliberate failed retry is a fresh unsigned proposal and does not repeat successful delivery')
 const interrupted=await proposal({id:'interrupted'});await ctx.store.put(owner.id,'review-actions',{...interrupted,status:'executing'},{event:'fixture/interrupted'})
 await actions.dispose();actions=createActions({store:ctx.store,accounts,teams:()=>teams,notifications:()=>notification,clock:()=>moment});install();await actions.recover()
 assert.equal(actions.get(lead,interrupted.id).status,'uncertain');assert.equal(actions.get(lead,action.id).grant.actorId,lead.id);assert.equal(deliveries,2)
 checks.push('Restart recovery preserves signatures and changes interrupted execution to uncertain without repeating the effect')
 let release,entered=false,slowCalls=0
 actions.register({kind:'fixture.slow',execute:async()=>{slowCalls++;if(slowCalls===1){entered=true;await new Promise(done=>release=done)}return{delivered:true}}})
 const slowItems=await Promise.all([1,2,3].map(index=>actions.propose(owner,{kind:'fixture.slow',input:{index}})))
 const background=await actions.startBatch(owner,{ids:slowItems.map(item=>item.id),operation:'approve',confirmed:true})
 const until=async check=>{for(let index=0;index<300;index++){if(check())return;await new Promise(done=>setTimeout(done,5))}throw new Error('Batch checkpoint not reached')}
 await until(()=>entered);assert.equal(actions.batchGet(owner,background.id).currentId,slowItems[0].id)
 await actions.controlBatch(owner,background.id,{action:'pause'});release();await until(()=>actions.batchGet(owner,background.id).items.length===1)
 assert.equal(actions.batchGet(owner,background.id).status,'paused');assert.equal(slowCalls,1)
 await actions.controlBatch(owner,background.id,{action:'resume',confirmed:true});await until(()=>actions.batchGet(owner,background.id).status==='completed');assert.equal(slowCalls,3)
 const interruptedBatch={...actions.batchGet(owner,background.id),id:'interrupted-batch',status:'running',items:[],currentId:slowItems[0].id}
 await ctx.store.put(owner.id,'action-batches',interruptedBatch,{event:'fixture/interrupted-batch'});await actions.recover()
 const recovered=actions.batchGet(owner,'interrupted-batch');assert.equal(recovered.status,'paused');assert.equal(recovered.items[0].status,'succeeded');assert.equal(recovered.items.length,1);assert.equal(slowCalls,3)
 checks.push('Background batch persists each item, pauses after current effect, resumes only unattempted work, and recovers a completed effect receipt after interruption without automatic replay')
 console.log(JSON.stringify({ok:true,root,checks,deliveries,events:ctx.store.events(owner.id).length},null,2))
}finally{await actions?.dispose();await teams?.dispose();await fiber.dispose()}
