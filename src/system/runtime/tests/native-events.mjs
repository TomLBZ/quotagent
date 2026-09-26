import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync} from 'node:fs'
import {Context} from '../../../../host/node_modules/cordis/lib/index.js'
const ctx=new Context(),checks=[],fibers=[]
try {
 let seen=[]
 const events=await ctx.plugin({name:'event-semantics-check',apply(child){
  child.on('check/emit',()=>seen.push('first'));child.on('check/emit',()=>seen.push('second'))
  child.on('check/parallel',async()=>{await new Promise(resolve=>setTimeout(resolve,10));seen.push('slow')});child.on('check/parallel',async()=>seen.push('fast'))
  child.on('check/serial',async()=>{seen.push('first');return undefined});child.on('check/serial',async()=>{seen.push('stop');return 'stopped'});child.on('check/serial',()=>seen.push('unreachable'))
  child.on('check/bail',()=>false);child.on('check/bail',()=>42);child.on('check/bail',()=>seen.push('unreachable'))
  child.on('check/waterfall',async(value,next)=>{seen.push(`before:${value}`);const result=await next();seen.push('after');return result})
  child.on('check/short',()=> 'intercepted');child.on('check/short',()=>seen.push('unreachable'))
  child.on('check/twice',async(_,next)=>{await next();await next()})
 }});fibers.push(events)
 ctx.emit('check/emit');assert.deepEqual(seen,['first','second']);seen=[];await ctx.parallel('check/parallel');assert.deepEqual(seen,['fast','slow']);seen=[];assert.equal(await ctx.serial('check/serial'),'stopped');assert.deepEqual(seen,['first','stop']);assert.equal(ctx.bail('check/bail'),42)
 seen=[];assert.equal(await ctx.waterfall('check/waterfall','payload',()=>{seen.push('inner');return 7}),7);assert.deepEqual(seen,['before:payload','inner','after']);assert.equal(await ctx.waterfall('check/short',()=>assert.fail()),'intercepted');await assert.rejects(()=>ctx.waterfall('check/twice',null,()=>{}),/next\(\) called multiple times/)
 checks.push('Actual installed Cordis emit/parallel/serial/bail/waterfall ordering, return values, interception and repeated-next refusal pass')
 let calls=0;const dispose=ctx.on('check/manual',()=>calls++);ctx.emit('check/manual');dispose();ctx.emit('check/manual');assert.equal(calls,1);await events.dispose();seen=[];ctx.emit('check/emit');assert.deepEqual(seen,[]);checks.push('Listener disposer and owning fiber disposal remove actual callbacks')
 let generations=0,ticks=0,notifications=0,stopped=0
 const dependent=await ctx.plugin({name:'consumer-check',inject:['checkDependency'],apply(child){generations++;child.on('check/notice',()=>notifications++);child.effect(()=>{const timer=setInterval(()=>ticks++,5);return()=>{clearInterval(timer);stopped++}})}});fibers.push(dependent)
 assert.equal(generations,0)
 const provider={name:'provider-check',apply(child){child.provide('checkDependency',{value:1})}}
 let service=await ctx.plugin(provider);fibers.push(service);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(generations,1);assert(ticks>0);ctx.emit('check/notice');assert.equal(notifications,1)
 await service.dispose();const baseline=ticks;await new Promise(resolve=>setTimeout(resolve,20));ctx.emit('check/notice');assert.equal(ticks,baseline);assert.equal(notifications,1);assert.equal(stopped,1)
 service=await ctx.plugin(provider);fibers.push(service);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(generations,2);await dependent.dispose();const last=ticks;await new Promise(resolve=>setTimeout(resolve,20));ctx.emit('check/notice');assert.equal(ticks,last);assert.equal(notifications,1);assert.equal(stopped,2)
 checks.push('Missing dependency leaves consumer inactive; provider mount/removal/remount recreates consumer, disposes timers/listeners, and explicit consumer unload leaves no later effects')
 const directory=process.env.EVIDENCE_DIR||'tmp/agent-experience/catalog-ui-runtime/native';mkdirSync(directory,{recursive:true});const report={ok:true,at:new Date().toISOString(),runtime:'cordis 4.0.0-rc.10',checks};writeFileSync(`${directory}/report.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
} finally {for(const fiber of fibers.reverse())await fiber.dispose()}
