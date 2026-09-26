import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync,mkdtempSync } from 'node:fs'
import { resolve } from 'node:path'
import * as storePlugin from '../../workspace-store/code/index.mjs'
import * as teamsPlugin from '../code/index.mjs'
import * as actionPlugin from '../../action-center/code/index.mjs'
import * as procurementPlugin from '../../../domain/procurement/code/index.mjs'
const require=createRequire(new URL('../../../../host/package.json',import.meta.url)),{Context}=require('cordis')
const users=[
 {id:'team-owner',name:'Owner',email:'owner@local.test',company:'Team Buyer',role:'contractor',permissions:[]},
 {id:'team-reviewer',name:'Reviewer',email:'reviewer@local.test',company:'Colleague',role:'contractor',permissions:[]},
 {id:'team-outsider',name:'Outsider',email:'outsider@local.test',company:'Other Buyer',role:'contractor',permissions:[]},
 {id:'team-supplier',name:'Supplier',email:'supplier@local.test',company:'Vendor',role:'supplier',permissions:[]},
 {id:'team-observer',name:'Observer',email:'observer@local.test',company:'Colleague',role:'contractor',permissions:[]},
]
const [owner,reviewer,outsider,supplier,observer]=users,ctx=new Context(),fibers=[],notices=[],routes=[],nav=[]
mkdirSync('tmp',{recursive:true});const root=mkdtempSync(resolve('tmp/teams-state-'))
const add=(items,item)=>{items.push(item);return()=>items.splice(items.indexOf(item),1)}
const mount=async(module,config)=>{const fiber=await ctx.plugin(module,config);assert.equal(fiber.state,2);fibers.push(fiber);return fiber}
const checks=[]
try{
 await mount({name:'team-test-services',apply(child){child.provide('accounts',{get:id=>structuredClone(users.find(user=>user.id===id)),list:()=>structuredClone(users),can:user=>!user.permissions?.includes('workspace:read-only')});child.provide('web',{route:(...args)=>add(routes,args),contribute:item=>add(nav,item)});child.provide('notifications',{push:async(user,input)=>{notices.push({user:user.id,...input});return input}})}})
 await mount(storePlugin,{root});let teamFiber=await mount(teamsPlugin);const procurementFiber=await mount(procurementPlugin);await mount(actionPlugin)
 assert.equal(ctx.teams.state(owner).workspaces.length,1)
 assert.throws(()=>ctx.teams.scope(outsider,owner.id),/not an active member/)
 await assert.rejects(async()=>ctx.teams.invite(owner,{email:supplier.email,roleId:'lead'}),/same contractor or supplier/)
 const invitation=await ctx.teams.invite(owner,{email:reviewer.email,roleId:'lead'})
 assert.equal(ctx.teams.state(reviewer).invitations.length,1);assert.equal(ctx.teams.list(reviewer).length,1)
 assert.throws(()=>ctx.teams.scope(reviewer,owner.id),/not an active member/)
 await ctx.teams.answerInvite(reviewer,invitation.id,true);await ctx.teams.select(reviewer,owner.id)
 assert.equal(ctx.teams.scope(reviewer).team.id,owner.id);assert.equal(ctx.teams.list(reviewer).length,2)
 checks.push('Explicit accepted same-party membership; unrelated and opposite-side accounts remain outside the workspace')
 const drafted=await ctx.procurement.execute(owner,'create-rfq',{title:'Team scoped draft',description:'Shared only with accepted colleagues',deadline:'2026-10-15',items:[{id:'lamp',description:'Lamp',quantity:2,unit:'each'}],supplierIds:[supplier.id],currency:'USD'})
 assert.equal(ctx.procurement.snapshot(reviewer).rfqs[0].id,drafted.rfq.id);assert.equal(ctx.procurement.snapshot(outsider).rfqs.length,0)
 await ctx.procurement.execute(reviewer,'publish-rfq',{id:drafted.rfq.id,confirmed:true})
 const approved=ctx.store.events(owner.id).findLast(event=>event.type==='procurement/human-approved')
 assert.equal(approved.body.humanId,reviewer.id);assert.equal(approved.actor,'human:'+reviewer.id)
 assert.equal(ctx.procurement.snapshot(supplier).rfqs[0].ownerId,owner.id)
 checks.push('Shared business ownership and real human actor remain distinct through actual Ledger/QEP publication')
 const obsInvite=await ctx.teams.invite(owner,{email:observer.email,roleId:'observer'});await ctx.teams.answerInvite(observer,obsInvite.id,true);await ctx.teams.select(observer,owner.id)
 assert.equal(ctx.procurement.snapshot(observer).rfqs.length,1)
 await assert.rejects(async()=>ctx.procurement.execute(observer,'create-rfq',{title:'Denied',items:[{description:'X',quantity:1,unit:'each'}]}),/read-only/)
 const before=ctx.teams.authority(reviewer,100,'USD');assert.equal(before.unconfigured,true);assert.equal(before.within,false)
 const policy=ctx.teams.state(owner).workspace.policy
 policy.roles=policy.roles.map(role=>({...role,limit:role.id==='director'?'unlimited':role.id==='lead'?20000:0}))
 const proposed=await ctx.teams.proposePolicy(owner,{policy,reviewerId:reviewer.id,reason:'Separate roles for quotations'})
 assert.equal(ctx.teams.authority(reviewer,100,'USD').unconfigured,true)
 await assert.rejects(async()=>ctx.teams.decidePolicy(owner,proposed.id,{approved:true}),/independent reviewer/)
 await ctx.teams.decidePolicy(reviewer,proposed.id,{approved:true});assert.equal(ctx.teams.authority(reviewer,100,'USD').unconfigured,true)
 await ctx.teams.applyPolicy(owner,proposed.id)
 assert.equal(ctx.teams.authority(reviewer,20000,'USD').within,true);assert.equal(ctx.teams.authority(reviewer,20001,'USD').within,false)
 assert.equal(ctx.teams.authority(reviewer,20001,'USD').nextRole,'director');assert.equal(ctx.teams.authority(reviewer,100,'EUR').within,false)
 assert.equal(ctx.teams.authority(observer,1,'USD').within,false)
 checks.push('Policy requires independent grant then proposer application; unknown, zero, exact limit, explicit unlimited and currency mismatch retain distinct meanings')
 const reference={kind:'rfq',id:drafted.rfq.id}
 await ctx.teams.assign(owner,{object:reference,accountId:reviewer.id,reason:'Review delivery scope'})
 await ctx.teams.follow(reviewer,{object:reference})
 const comment=await ctx.teams.comment(owner,{object:reference,text:'Please review @reviewer@local.test and check @missing@local.test.'})
 assert.deepEqual(comment.mentions,[reviewer.id]);assert.deepEqual(comment.unresolved,['missing@local.test'])
 assert.equal(ctx.teams.state(owner).today.assignedByMe[0].assigneeId,reviewer.id);assert.equal(ctx.teams.state(reviewer).today.following[0].object.id,drafted.rfq.id);assert.equal(ctx.teams.state(owner).today.deadlines[0].deadline,'2026-10-15')
 ctx.actions.register({kind:'fixture.personal-review',execute:async()=>({ok:true})});const personal=await ctx.actions.propose(owner,{kind:'fixture.personal-review',input:{note:'Private account decision'}});assert.equal(ctx.teams.state(owner).today.decisions[0].id,personal.id);assert.equal(ctx.teams.state(reviewer).today.decisions.length,0)
 assert.equal(ctx.teams.state(reviewer).today.assignments.length,1);assert.equal(ctx.teams.state(reviewer).today.mentions.length,1)
 assert.equal(notices.filter(notice=>notice.sourceId===comment.id).length,1)
 await assert.rejects(async()=>ctx.teams.assign(observer,{object:reference,accountId:owner.id}),/cannot assign/)
 await ctx.teams.completeAssignment(reviewer,'rfq:'+drafted.rfq.id);assert.equal(ctx.teams.state(reviewer).today.assignments.length,0)
 checks.push('Actual object assignments, completion, following, known mentions and unresolved names drive personal activity without duplicate notices')
 await ctx.teams.updateMember(owner,{accountId:reviewer.id,active:false})
 assert.throws(()=>ctx.teams.scope(reviewer,owner.id),/not an active member/)
 assert.equal(ctx.teams.state(owner).comments[0].authorId,owner.id)
 await ctx.teams.select(reviewer,reviewer.id)
 await procurementFiber.dispose();await teamFiber.dispose()
 assert.equal(ctx.get('teams'),undefined);assert.ok(!nav.some(item=>item.id==='team'));assert.ok(!routes.some(([,path])=>path.startsWith('/teams')))
 teamFiber=await mount(teamsPlugin)
 assert.equal(ctx.teams.state(owner).policyProposals[0].status,'applied');assert.equal(ctx.teams.state(owner).comments.length,1)
 const originalRole=owner.role;users[0].role='supplier'
 assert.equal(ctx.teams.state({...owner,role:'supplier'}).workspace.members.length,1);assert.equal(ctx.teams.state({...owner,role:'supplier'}).comments.length,0)
 users[0].role=originalRole;assert.equal(ctx.teams.state(owner).comments.length,1)
 checks.push('Removal blocks access while preserving history; native disposal/reload and single-perspective role changes retain correct isolation')
 console.log(JSON.stringify({ok:true,root,checks},null,2))
}finally{for(const fiber of fibers.reverse())await fiber.dispose()}
