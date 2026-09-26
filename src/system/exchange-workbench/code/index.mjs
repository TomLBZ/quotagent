import { randomUUID } from 'node:crypto'
export const name='exchange-workbench'
export const inject=['store','accounts','settings','web']
export const provides=['exchange']
const now=()=>new Date().toISOString(),copy=value=>structuredClone(value)
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})}
export async function apply(ctx,config={}){
 const schemas=new Map(),peers=new Map(),controllers=new Set(),running=new Set();let disposed=false,timer
 const realm=user=>ctx.get('procurement')?.realm(user)||ctx.get('teams')?.resolveUser(user,'snapshot').id||user.id
 const owner=id=>ctx.accounts.get(id)
 const ownPeers=user=>ctx.store.list(realm(user),'exchange-peers').filter(row=>!row.deleted&&row.sourceRealm===realm(user))
 const write=(user,row,event)=>ctx.store.put(user.id,'exchange-peers',{...row,updatedAt:now(),revision:(row.revision||0)+1},{event:`exchange/${event}`,actor:`human:${user.id}`})
 const configure=async row=>{
  if(row.mode==='local'||row.deleted)return
  const user=owner(row.ownerId),values=ctx.settings.get(user,row.configurationId)
  await ctx.store.configurePeer(row.sourceRealm,row.peerRealm,row.channel,values.pairingSecret)
 }
 const register=row=>{
  peers.set(row.id,row)
  if(schemas.has(row.id))return
  schemas.set(row.id,ctx.settings.define({id:row.configurationId,name:`${row.name} QEP pairing`,scope:'account',ownerId:row.ownerId,description:'Both parties configure the same channel and private pairing secret. HMAC pairing is symmetric trust; this is not an independent digital identity certificate.',fields:[{key:'pairingSecret',label:'Shared pairing secret',type:'password',description:'At least 16 characters; stored outside the ledger.'}],defaults:{pairingSecret:''},validate:values=>{if(values.pairingSecret&&values.pairingSecret.length<16)fail('The pairing secret needs at least 16 characters.')},onChange:()=>configure(peers.get(row.id))}))
 }
 for(const user of ctx.accounts.list().filter(account=>ctx.store.health()[account.id]?.healthy!==false))for(const row of ctx.store.list(user.id,'exchange-peers')){
  register(row)
  if(row.deleted){if(ctx.settings.view(user,row.configurationId).hasOverrides)await ctx.settings.save(user,row.configurationId,{reset:true});schemas.get(row.id)();schemas.delete(row.id);peers.delete(row.id)}else await configure(row)
 }
 const configured=(from,to,channel)=>[...peers.values()].find(row=>!row.deleted&&row.enabled&&row.sourceRealm===from&&row.peerRealm===to&&(!channel||row.channel===channel))
 const savePeer=async(user,input={})=>{
  if(user.id!==realm(user))fail('Only the party workspace owner can configure its shared delivery routes. All members can inspect route metadata.',403)
  const previous=input.id?ctx.store.get(user.id,'exchange-peers',input.id):null
  if(input.id&&(!previous||previous.deleted))fail('Peer not found.',404)
  const sourceRealm=realm(user),peerRealm=String(input.peerRealm??previous?.peerRealm??'').trim(),name=String(input.name??previous?.name??'').trim(),mode=input.mode||previous?.mode||'manual'
  if(!name||!peerRealm||peerRealm===sourceRealm)fail('Give the peer a name and a different recipient realm.')
  if(!['local','manual','http'].includes(mode))fail('Choose local, portable file or HTTP delivery.')
  if(!/^[A-Za-z0-9_.-]{1,100}$/.test(peerRealm))fail('Use the exact account or party realm ID.')
  const channel=mode==='local'?'local':String(input.channel??previous?.channel??'portable').trim()
  if(!/^[A-Za-z0-9_.-]{1,100}$/.test(channel)||mode!=='local'&&channel==='local')fail('Use a nonlocal channel ID for paired services.')
  let endpoint=String(input.endpoint??previous?.endpoint??'').trim()
  if(mode==='http'){let parsed;try{parsed=new URL(endpoint)}catch{fail('Enter the complete peer HTTP receive URL.')}if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)fail('Use an HTTP(S) receiver URL without embedded credentials.');endpoint=parsed.href}
  if(mode==='local'&&!owner(peerRealm))fail('A local peer must be an existing account. Use a paired channel for an independent service.')
  if(ownPeers(user).some(row=>row.id!==previous?.id&&row.peerRealm===peerRealm&&row.enabled&&(input.enabled??true)))fail('Disable the existing active delivery route for this recipient first.')
  if(previous&&(previous.peerRealm!==peerRealm||previous.channel!==channel||previous.sourceRealm!==sourceRealm))fail('Create a new peer to change its realm or stream channel; existing signed history keeps its original pairing.')
  const id=previous?.id||randomUUID(),row={...previous,id,ownerId:user.id,sourceRealm,peerRealm,name,role:input.role||previous?.role||owner(peerRealm)?.role||'supplier',mode,channel,endpoint:mode==='http'?endpoint:'',enabled:input.enabled??previous?.enabled??true,configurationId:previous?.configurationId||`qep-peer-${id}`,createdAt:previous?.createdAt||now()}
  if(!['supplier','contractor'].includes(row.role))fail('Choose the peer business role.')
  await write(user,row,previous?'peer-updated':'peer-created');const stored=ctx.store.get(user.id,'exchange-peers',id);register(stored)
  if(input.pairingSecret)await ctx.settings.save(user,row.configurationId,{values:{pairingSecret:input.pairingSecret}})
  await configure(stored);return {ok:true,peer:stored}
 }
 const removePeer=async(user,id)=>{if(user.id!==realm(user))fail('Only the party workspace owner can remove its shared delivery routes.',403);const row=ctx.store.get(user.id,'exchange-peers',id);if(!row||row.deleted)fail('Peer not found.',404);await ctx.settings.save(user,row.configurationId,{reset:true});await write(user,{...row,deleted:true,enabled:false},'peer-removed');schemas.get(id)?.();schemas.delete(id);peers.delete(id);return{ok:true}}
 const requirePair=async(target,packageValue)=>{
  const source=packageValue?.envelope?.sender?.realm,channel=packageValue?.channel
  const peer=configured(target,source,channel)
  if(!peer)fail('This recipient has no enabled pairing for the signed sender and channel.',403)
  await configure(peer);return peer
 }
 const receive=async(target,packageValue,{user}={})=>{
  if(Array.isArray(packageValue)){if(!packageValue.length||packageValue.length>128)fail('Use a delivery batch of 1 to 128 signed packages.');let result;const released=[],replays=[];for(const item of packageValue){result=await receive(target,item,{user});released.push(...(result.released||[]));replays.push(...(result.replays||[]))}return {...result,released,replays:[...new Map(replays.map(item=>[item.envelope.msg_id,item])).values()].slice(0,64)}}
  if(user&&realm(user)!==target)fail('Choose your own current workspace.',403)
  const peer=packageValue?.channel==='local'&&user?null:await requirePair(target,packageValue)
  const result=await ctx.store.receivePackage(target,packageValue,{peer:peer?{realm:peer.peerRealm,role:peer.role,name:peer.name}:undefined});
  const receipts=ctx.store.deliveryState(target).outbox.filter(row=>row.control&&row.to===packageValue.envelope.sender.realm&&row.channel===packageValue.channel).sort((a,b)=>a.seq-b.seq).slice(-64).map(row=>({schema:'quotagent/qep-package/v1',channel:row.channel,envelope:row.envelope}));
  const replays=[];for(const id of [...new Set([result,...(result.released||[])].flatMap(item=>item.resendIds||[]))].slice(0,64))replays.push((await ctx.store.package(target,id)).package)
  return {...result,receipts,replays}
 }
 const transport={id:'exchange-workbench',select:async({from,to})=>{const peer=configured(from,to)||[...peers.values()].find(row=>!row.deleted&&row.sourceRealm===from&&row.peerRealm===to);if(!peer){if(!owner(to))fail('Pair this external recipient before preparing a delivery.');return null}await configure(peer);return{channel:peer.channel,mode:peer.enabled?peer.mode:'manual'}},handles:row=>!!configured(row.ownerId,row.to,row.channel),
  async deliver({from,to,delivery,package:packageValue,packages,signal}){
   const peer=configured(from,to,delivery.channel);if(!peer||peer.mode!=='http')return{status:'queued'}
   const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);controllers.add(controller);signal?.addEventListener('abort',abort,{once:true});const timeout=setTimeout(()=>controller.abort(new Error('Peer response timed out. The exact signed package remains available for retry.')),config.timeoutMs||12000)
   const predecessors=[];for(const prior of ctx.store.deliveryState(from).outbox.filter(row=>row.to===to&&row.channel===delivery.channel&&row.seq<delivery.seq&&row.status!=='delivered').sort((a,b)=>a.seq-b.seq).slice(0,64))predecessors.push((await ctx.store.package(from,prior.id)).package);
   const batch=[...new Map([...predecessors,...(packages||[packageValue])].map(item=>[item.envelope.msg_id,item])).values()].sort((a,b)=>a.envelope.seq-b.envelope.seq)
   try{const response=await fetch(peer.endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({packages:batch}),signal:controller.signal});let result;try{result=await response.json()}catch{fail('The peer returned an unreadable delivery response.',502)}if(!response.ok)fail(result.error||`Peer returned HTTP ${response.status}`,response.status);return result}
   finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort);controllers.delete(controller)}
  }}
 ctx.effect(()=>ctx.store.exchangeTransport(transport))
 const list=user=>{
  const target=realm(user),state=ctx.store.deliveryState(target)
  const thin=row=>{const {envelope,package:packageValue,receipt,...rest}=row;return{...rest,hasReceipt:!!receipt,receiptSummary:receipt?{outcome:receipt.envelope.body.outcome,at:receipt.envelope.body.at,msgId:receipt.envelope.msg_id}:null}}
  return{realm:target,canManageRoutes:user.id===target,outbox:state.outbox.filter(row=>!row.control).map(thin).reverse(),inbox:state.inbox.filter(row=>!row.control||row.status==='held').map(thin).reverse(),recovery:[...state.outbox.filter(row=>row.controlKind==='resend-request').map(row=>({...thin(row),direction:'outbox'})),...state.inbox.filter(row=>row.controlKind==='resend-request').map(row=>({...thin(row),direction:'inbox'}))].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),peers:ownPeers(user).map(row=>({...row,paired:row.mode==='local'||ctx.settings.view(owner(row.ownerId),row.configurationId).configuredSecrets.includes('pairingSecret')})),localAccounts:ctx.accounts.list().filter(row=>row.role!=='admin'&&row.id!==target).map(({id,name,role})=>({id,name,role})),capabilities:ctx.store.capabilities,health:ctx.store.health()[target]||{healthy:true,eventCount:0},receiverPath:`${ctx.web.prefix||'/quotagent'}/api/exchange/receive/${encodeURIComponent(target)}`}
 }
 const detail=(user,id,direction='outbox')=>{const row=ctx.store.get(realm(user),direction==='inbox'?'exchange-inbox':'exchange-outbox',id);if(!row)fail('Delivery not found.',404);return row}
 const retry=async(user,id)=>{detail(user,id);const result=await ctx.store.retryDelivery(realm(user),id);return{ok:true,...result}}
 const resolveConflict=async(user,id,input)=>{if(input.confirmed!==true)fail('Confirm that you accept the exact sender-approved public record.');return{ok:true,inbox:await ctx.store.resolveConflict(realm(user),id,{actor:user.id,acceptIncoming:true})}}
 const exportPackage=async(user,id,{receipt=false}={})=>{const target=realm(user),row=detail(user,id,receipt?'inbox':'outbox');if(receipt){if(!row.receipt)fail('This package has no receipt yet.',409);return{package:row.receipt,filename:`receipt-${id}.qep.json`}}return ctx.store.package(target,id)}
 const recheck=async(user,id)=>{const row=detail(user,id,'inbox');return{ok:true,...await receive(realm(user),row.package,{user})}}
 async function tick(){if(disposed)return;for(const peer of peers.values()){
  if(!peer.enabled||peer.deleted||peer.mode!=='http')continue
  const user=owner(peer.ownerId);if(!user||user.disabled)continue
  for(const row of ctx.store.deliveryState(peer.sourceRealm).outbox){if(row.control&&row.controlKind!=='resend-request'||row.to!==peer.peerRealm||row.channel!==peer.channel||!['queued','requested','failed','held'].includes(row.status)||running.has(row.id)||(row.attempts||0)>=5||Date.parse(row.nextAttemptAt||row.lastAttemptAt||row.createdAt)+(!row.nextAttemptAt?Math.min(60000,2000*2**(row.attempts||0)):0)>Date.now())continue
   running.add(row.id)
   try{const result=await ctx.store.retryDelivery(peer.sourceRealm,row.id);if(!['delivered','fulfilled'].includes(result.status)){const latest=ctx.store.get(peer.sourceRealm,'exchange-outbox',row.id);await ctx.store.markDelivery(peer.sourceRealm,row.id,{status:latest.status,error:latest.error,nextAction:latest.nextAction,nextAttemptAt:new Date(Date.now()+Math.min(60000,2000*2**latest.attempts)).toISOString()});if(latest.attempts>=5)await ctx.get('notifications')?.push(user,{type:'warning',title:'Delivery needs attention',body:`${row.title}: ${latest.error||'No signed receipt after repeated attempts.'}`,link:{view:'exchange',deliveryId:row.id},sourceId:row.id,dedupeKey:`exchange-retry:${row.id}`})}}
   catch{}finally{running.delete(row.id)}
  }
 }}
 timer=setInterval(()=>void tick(),config.retryIntervalMs||5000);timer.unref?.()
 ctx.effect(()=>()=>{disposed=true;clearInterval(timer);for(const controller of controllers)controller.abort();for(const dispose of schemas.values())dispose();schemas.clear();peers.clear()})
 ctx.provide('exchange',{list,savePeer,removePeer,receive,retry,detail,exportPackage,recheck,resolveConflict})
 const route=(method,path,handler,options={})=>ctx.effect(()=>ctx.web.route(method,path,handler,options))
 route('GET','/exchange',({user})=>list(user))
 route('POST','/exchange/peers',({user,body})=>savePeer(user,body),{capability:'plugins:manage'})
 route('POST','/exchange/peers/:id/remove',({user,params})=>removePeer(user,params.id),{capability:'plugins:manage'})
 route('POST','/exchange/import',async({user,body})=>({ok:true,...await receive(realm(user),body.packages||body.package||body,{user})}),{capability:'workspace:write'})
 route('POST','/exchange/receive/:realm',({params,body})=>receive(params.realm,body.packages||body.package||body),{public:true})
 route('POST','/exchange/:id/retry',({user,params})=>retry(user,params.id),{capability:'workspace:write'})
 route('POST','/exchange/:id/recheck',({user,params})=>recheck(user,params.id),{capability:'workspace:write'})
 route('POST','/exchange/:id/resolve',({user,params,body})=>resolveConflict(user,params.id,body),{capability:'workspace:write'})
 route('GET','/exchange/:id/detail',({user,params,query})=>detail(user,params.id,query.get('direction')))
 route('GET','/exchange/:id/package',async({user,params,query,res})=>{const result=await exportPackage(user,params.id,{receipt:query.get('receipt')==='true'});res.setHeader('content-type','application/json');res.setHeader('content-disposition',`attachment; filename="${result.filename}"`);res.end(JSON.stringify(result.package,null,2)+'\n')})
 route('GET','/exchange/history',({user,query})=>{const target=realm(user);return{realm:target,seq:query.get('seq'),records:ctx.store.projection(target,{...(query.has('seq')?{seq:query.get('seq')}:{}),...(query.get('time')?{time:query.get('time')}:{}),...(query.get('collection')?{collection:query.get('collection')}:{})})}})
 route('GET','/exchange/storage',({user})=>{if(user.role!=='admin')fail('Administrator access is required.',403);return{health:ctx.store.health(),capabilities:ctx.store.capabilities}},{admin:true})
 ctx.effect(()=>ctx.web.contribute({id:'exchange',label:'Deliveries & exchange',icon:'send',roles:['contractor','supplier','admin'],order:44}))
 ctx.inject(['assistant'],inner=>{inner.effect(()=>inner.assistant.tool({name:'delivery_status',description:'Inspect current account delivery receipts, gaps and conflicts. A delivery receipt is not an award or signature.',parameters:{type:'object',properties:{}},roles:['contractor','supplier'],effect:'read',execute:user=>({ok:true,...list(user),action:{type:'navigate',input:{view:'exchange'},label:'Open deliveries'}})}))})
}
