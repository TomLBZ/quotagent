import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdirSync,mkdtempSync} from 'node:fs'
import {resolve} from 'node:path'
import * as store from '../../workspace-store/code/index.mjs'
import * as settings from '../../settings/code/index.mjs'
import * as files from '../../file-store/code/index.mjs'
import * as procurement from '../../../domain/procurement/code/index.mjs'
import * as ingestion from '../../../domain/ingestion/code/index.mjs'
import * as engines from '../../../domain/ingestion-engines/code/index.mjs'
import * as actions from '../../action-center/code/index.mjs'
import * as notifications from '../../notifications/code/index.mjs'
import * as mail from '../code/product.mjs'
import * as telegram from '../../telegram/code/product.mjs'
import {localServices} from './product-fixtures.mjs'
import {fixtures} from '../../../domain/ingestion-engines/tests/fixtures.mjs'
const require=createRequire(new URL('../../../../host/package.json',import.meta.url)),{Context}=require('cordis')
const source=await fixtures(),servers=await localServices({source:source['cabling-offer.eml']}),ctx=new Context(),fibers=[],routes=[],tools=[]
const users=[{id:'mail-fixture-buyer',role:'contractor',name:'Buyer',email:'buyer@fixture.invalid'},{id:'mail-fixture-other',role:'supplier',name:'Other',email:'other@fixture.invalid'},{id:'mail-fixture-admin',role:'admin',name:'Admin',email:'admin@fixture.invalid'}],buyer=users[0]
const add=(list,item)=>{list.push(item);return()=>list.splice(list.indexOf(item),1)}
const mount=async(plugin,config)=>{const fiber=await ctx.plugin(plugin,config);fibers.push(fiber);return fiber}
mkdirSync(resolve('tmp'),{recursive:true});const root=mkdtempSync(resolve('tmp/external-connections-smoke-'))
try{
  await mount({name:'fixture-base',apply(ctx){ctx.provide('accounts',{list:()=>users,get:id=>users.find(user=>user.id===id),can:()=>true});ctx.provide('web',{route:(...args)=>add(routes,args),contribute:()=>()=>{}});ctx.provide('assistant',{tool:definition=>add(tools,definition)})}})
  await mount(store,{root});await mount(settings);await mount(files);await mount(procurement);await mount(ingestion);await mount(engines);await mount(notifications);await mount(actions)
  const mailFiber=await mount(mail),telegramFiber=await mount(telegram,{apiBase:servers.telegramBase})
  await ctx.settings.save(buyer,'mail',{values:{enabled:true,fromName:'Fixture buyer',fromAddress:'buyer@fixture.invalid',imapHost:'127.0.0.1',imapPort:servers.imapPort,imapSecurity:'plain',imapUser:'fixture',imapPassword:'fixture-password',smtpHost:'127.0.0.1',smtpPort:servers.smtpPort,smtpSecurity:'plain',smtpUser:'fixture',smtpPassword:'fixture-password',sentMailbox:'Sent'}})
  await ctx.settings.save(buyer,'telegram',{values:{enabled:true,botToken:'fixture-token',defaultChatId:'4242'}})
  await ctx.settings.save(users[2],'mail',{values:{imapPassword:'admin-only-password'}})
  assert.equal(ctx.settings.get(users[1],'mail').imapPassword,'','Admin credentials are not inherited by other accounts')
  assert.equal(ctx.settings.view(buyer,'mail').values.imapPassword,'','Credentials are masked')
  const tested=await ctx.mail.test(buyer)
  assert.ok(tested.result.imap.ok,JSON.stringify(tested));assert.ok(tested.result.smtp.ok,JSON.stringify(tested));assert.equal(servers.smtpMessages.length,0)
  const synced=await ctx.mail.sync(buyer)
  assert.equal(synced.imported,2,'Inbox and Sent folder each imported through IMAP')
  assert.equal((await ctx.mail.sync(buyer)).imported,0,'UID cursor prevents duplicates')
  const received=ctx.mail.list(buyer).find(message=>message.direction==='inbound')
  assert.match(received.body,/attached detailed cabling offer/);assert.equal(received.attachments.length,1)
  assert.equal(ctx.mail.list(users[1]).length,0)
  const extracted=await ctx.mail.ingest(buyer,received.id,received.attachments[0].id)
  assert.equal(extracted.document.items.length,2)
  const draft=await ctx.mail.draft(buyer,{replyToId:received.id,body:'Thanks. Please confirm installation is included.'})
  const proposal=await ctx.mail.propose(buyer,draft.id,{agent:true,runId:'fixture-run'})
  assert.equal(servers.smtpMessages.length,0,'Neither drafting nor proposing sends')
  assert.equal(proposal.review.runId,'fixture-run')
  const sent=await ctx.actions.approve(buyer,proposal.review.id,{confirmed:true})
  assert.equal(sent.status,'succeeded',sent.error);assert.equal(servers.smtpMessages.length,1)
  assert.match(servers.smtpMessages[0].source.toString(),/Please confirm installation/)
  await ctx.actions.approve(buyer,proposal.review.id,{confirmed:true});assert.equal(servers.smtpMessages.length,1,'Duplicate approval does not resend')
  const edit=await ctx.mail.draft(buyer,{to:['vendor@fixture.invalid'],subject:'Original',body:'Original body'})
  const old=await ctx.mail.propose(buyer,edit.id);await ctx.mail.draft(buyer,{id:edit.id,body:'Changed body'})
  const stale=await ctx.actions.approve(buyer,old.review.id,{confirmed:true});assert.equal(stale.status,'failed');assert.equal(servers.smtpMessages.length,1)
  assert.equal((await ctx.telegram.test(buyer)).bot.username,'quotagent_fixture_bot')
  assert.equal((await ctx.telegram.sync(buyer)).imported,2);assert.equal((await ctx.telegram.sync(buyer)).imported,0)
  const incoming=ctx.telegram.list(buyer).find(message=>message.file)
  assert.equal(ctx.files.read(buyer,incoming.file.id).includes(Buffer.from('Valve')),true)
  assert.equal((await ctx.telegram.ingest(buyer,incoming.id)).document.items.length,1)
  const chatDraft=await ctx.telegram.draft(buyer,{replyToId:incoming.id,text:'Thanks. We are reviewing your offer.'})
  const chatProposal=await ctx.telegram.propose(buyer,chatDraft.id,{agent:true})
  assert.equal(servers.telegramSent.length,0)
  const chatSent=await ctx.actions.approve(buyer,chatProposal.review.id,{confirmed:true})
  assert.equal(chatSent.status,'succeeded',chatSent.error);assert.equal(servers.telegramSent.length,1);assert.equal(servers.telegramSent[0].chat_id,'4242')
  assert.equal(ctx.telegram.list(users[1]).length,0)
  assert.ok(ctx.notifications.list(buyer).some(notice=>notice.type==='mail'));assert.ok(ctx.notifications.list(buyer).some(notice=>notice.type==='telegram'))
  const recorded=JSON.stringify(ctx.store.events(buyer.id));assert.ok(recorded.includes('mail/message-received'));assert.ok(recorded.includes('telegram/message-received'));assert.ok(!recorded.includes('fixture-password'));assert.ok(!recorded.includes('fixture-token'))
  await ctx.settings.save(buyer,'telegram',{values:{notifyActivity:true,notificationChatId:'4242'}})
  await ctx.notifications.push(buyer,{type:'mail',title:'PRIVATE quotation pricing',body:'Private unit cost is 1234.56',dedupeKey:'fixture-private-notice'})
  assert.equal(servers.telegramSent.length,2);assert.equal(servers.telegramSent[1].text,'New activity is waiting in Quotagent. Open your workspace to review it.');assert.ok(!JSON.stringify(servers.telegramSent).includes('1234.56'))
  await ctx.settings.save(buyer,'telegram',{values:{notifyActivity:false}})
  await ctx.notifications.push(buyer,{type:'mail',title:'A later private notice',dedupeKey:'fixture-disabled-notice'});assert.equal(servers.telegramSent.length,2)
  const noticeDraft=await ctx.mail.draft(buyer,{to:['vendor@fixture.invalid'],subject:'Receipt survives notification failure',body:'Fictitious local test.'})
  const noticeReview=await ctx.mail.propose(buyer,noticeDraft.id)
  const push=ctx.notifications.push;ctx.notifications.push=async()=>{throw new Error('Fixture notification unavailable')}
  try{const completed=await ctx.actions.approve(buyer,noticeReview.review.id,{confirmed:true});assert.equal(completed.status,'succeeded',completed.error);assert.equal(ctx.mail.get(buyer,noticeDraft.id).status,'sent');assert.ok(ctx.mail.get(buyer,noticeDraft.id).receipt.accepted.length);await ctx.actions.approve(buyer,noticeReview.review.id,{confirmed:true});assert.equal(servers.smtpMessages.length,2)}finally{ctx.notifications.push=push}
  await mailFiber.dispose();await telegramFiber.dispose();assert.ok(!tools.some(tool=>/^(mail|telegram)_/.test(tool.name)));assert.ok(!routes.some(([,path])=>/^\/(mail|telegram)(\/|$)/.test(path)))
  console.log(JSON.stringify({ok:true,root,checks:['real loopback IMAP inbox/sent sync','real loopback SMTP auth/test/send and MIME reply','UID deduplication','account credentials isolated and masked','actual Telegram HTTP API updates/download/send','attachments→files→ingestion','proposals send nothing; human review sends once','stale draft refused','source/receipt ledger and in-app notifications','native routes/tools/socket disposal'],smtpSent:servers.smtpMessages.length,telegramSent:servers.telegramSent.length}))
}finally{for(const fiber of fibers.reverse())await fiber.dispose();await servers.close()}
