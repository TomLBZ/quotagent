import {randomUUID,createHash} from 'node:crypto'
import {createTransport} from './transport.mjs'
export const name='telegram'
export const inject=['store','web','accounts','settings','files','ingestion','actions','notifications']
export const provides=['telegram']
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})}
const now=()=>new Date().toISOString()
const text=value=>String(value??'').trim()
const tokenKey=token=>createHash('sha256').update(token).digest('hex').slice(0,24)
export function apply(ctx,config={}) {
  const transport=config.transport||createTransport({apiBase:config.apiBase}),running=new Map(),nextCheck=new Map()
  let disposed=false,timer
  const settings=user=>ctx.settings.get(user,'telegram')
  const guard=(user,write=false)=>{if(!user?.id)fail('Sign in to use Telegram.',401);if(write&&user.permissions?.includes('workspace:read-only'))fail('This account has read-only workspace access.',403)}
  const connected=user=>{guard(user,true);const value=settings(user);if(!value.enabled||!value.botToken)fail('Configure and enable your Telegram bot first.');return value}
  const state=user=>ctx.store.get(user.id,'telegram-state','connection')||{id:'connection',offsets:{}}
  const save=(user,collection,record,event,actor=`human:${user.id}`)=>ctx.store.put(user.id,collection,record,{event,actor})
  const get=(user,id)=>{guard(user);return ctx.store.get(user.id,'telegram-messages',id)||fail('This message is not in your account.',404)}
  const list=user=>{guard(user);return ctx.store.list(user.id,'telegram-messages').sort((a,b)=>(b.receivedAt||b.createdAt).localeCompare(a.receivedAt||a.createdAt))}
  const status=user=>{guard(user);const options=settings(user);return{...state(user),enabled:options.enabled,configured:!!options.botToken,polling:options.autoSync,syncing:running.has(user.id),defaultChatId:options.defaultChatId}}
  ctx.effect(()=>ctx.settings.define({id:'telegram',name:'Telegram bot connection',scope:'account',
    description:'Create a bot with Telegram’s @BotFather and paste its token here. Start a chat with the bot before syncing. The bot connects only to your account; a bot token should have one polling consumer. Existing webhooks must be removed by the bot owner before polling. No message is sent until you approve a review request.',
    defaults:{enabled:false,botToken:'',defaultChatId:'',autoSync:false,pollSeconds:30,allowedChatIds:'',notifyActivity:false,notificationChatId:''},fields:[
      {key:'enabled',label:'Enable Telegram for this account',type:'boolean'},
      {key:'botToken',label:'Bot token',type:'password'},
      {key:'defaultChatId',label:'Default recipient chat ID (optional)',type:'text',description:'After syncing, choose a conversation or copy its chat ID here.'},
      {key:'autoSync',label:'Automatically receive Telegram messages',type:'boolean'},
      {key:'pollSeconds',label:'Check interval (seconds)',type:'number',min:15,max:600},
      {key:'allowedChatIds',label:'Receive only these chat IDs (optional)',type:'text',description:'Comma-separated chat IDs. Leave blank to receive every chat accessible to this bot.'},
      {key:'notifyActivity',label:'Send generic activity reminders to Telegram',type:'boolean',description:'Your standing permission to send a fixed “new activity” reminder when this account receives in-app notices. No email text, quotations, costs or notification details are forwarded.'},
      {key:'notificationChatId',label:'Activity reminder chat ID',type:'text',description:'Choose a chat you control. Used only when generic activity reminders are enabled.'},
    ],validate:values=>{if(values.notifyActivity&&!/^-?\d+$|^@[A-Za-z0-9_]+$/.test(text(values.notificationChatId)))fail('Choose an activity reminder chat ID before enabling Telegram reminders.')},onChange:async(_, {user})=>{nextCheck.delete(user.id)}}))
  const test=async user=>{
    const options=connected(user),bot=await transport.getMe(options.botToken)
    const connection={...state(user),bot:{id:bot.id,username:bot.username||'',name:bot.first_name||''},testedAt:now(),lastError:null}
    await save(user,'telegram-state',connection,'telegram/connection-tested');return {ok:true,bot:connection.bot}
  }
  const sync=async(user,{poll=false}={})=>{
    const options=connected(user)
    if(running.has(user.id))return running.get(user.id)
    const operation=(async()=>{
      const previous=state(user),key=tokenKey(options.botToken),offsets={...previous.offsets},added=[],warnings=[]
      let offset=Number(offsets[key])||0
      try {
        const updates=await transport.updates(options.botToken,offset,poll?20:0)
        const allowed=new Set(text(options.allowedChatIds).split(/[\s,;]+/).filter(Boolean))
        for(const update of updates) {
          if(disposed)throw new Error('Telegram plugin unloaded during synchronization.')
          const message=update.message||update.edited_message
          if(message&&(!allowed.size||allowed.has(String(message.chat.id)))) {
            const id=`telegram-${key}-${message.chat.id}-${message.message_id}`
            const existing=ctx.store.get(user.id,'telegram-messages',id)
            if(!existing||update.edited_message) {
              let file=existing?.file||null,fileError=null
              if(message.document&&!file) {
                try {const buffer=await transport.download(options.botToken,message.document.file_id);file=await ctx.files.put(user,{filename:message.document.file_name||'telegram-document.bin',mime:message.document.mime_type||'application/octet-stream',buffer})}
                catch(error){fileError=error.message;warnings.push(`Attachment: ${error.message}`)}
              }
              const row={id,ownerId:user.id,direction:'inbound',status:'received',chatId:String(message.chat.id),chatType:message.chat.type,
                chatTitle:message.chat.title||[message.chat.first_name,message.chat.last_name].filter(Boolean).join(' ')||message.chat.username||String(message.chat.id),
                sender:[message.from?.first_name,message.from?.last_name].filter(Boolean).join(' ')||message.sender_chat?.title||message.from?.username||'Telegram sender',
                senderUsername:message.from?.username||'',text:message.text||message.caption||'',telegramMessageId:message.message_id,updateId:update.update_id,
                replyToMessageId:message.reply_to_message?.message_id||null,file,fileError,document:message.document?{filename:message.document.file_name||'',size:message.document.file_size||null,mime:message.document.mime_type||'',fileId:message.document.file_id}:null,
                createdAt:existing?.createdAt||now(),receivedAt:new Date(message.date*1000).toISOString(),editedAt:message.edit_date?new Date(message.edit_date*1000).toISOString():null}
              await save(user,'telegram-messages',row,update.edited_message?'telegram/message-edited':'telegram/message-received',`transport:${user.id}`);added.push(row)
            }
          }
          // Persist the message before its update cursor. A failed item never acknowledges later items.
          offset=Math.max(offset,update.update_id+1);offsets[key]=offset
          await save(user,'telegram-state',{...previous,offsets,lastSyncAt:now(),lastError:null},'telegram/update-recorded',`transport:${user.id}`)
        }
        await save(user,'telegram-state',{...state(user),offsets,lastSyncAt:now(),lastError:null,warnings},'telegram/sync-completed',`transport:${user.id}`)
        if(added.length)await ctx.notifications.push(user,{type:'telegram',title:`${added.length} Telegram message${added.length===1?'':'s'} received`,body:added[0].text.slice(0,150)||added[0].document?.filename||'A document arrived',link:{view:'telegram',chatId:added[0].chatId,messageId:added[0].id},sourceId:added[0].id,dedupeKey:`telegram:${key}:${offset}`})
        return {ok:true,imported:added.length,warnings,status:status(user)}
      }catch(error){if(!disposed)await save(user,'telegram-state',{...state(user),offsets,lastError:error.message,lastAttemptAt:now()},'telegram/sync-failed',`transport:${user.id}`);if(error.retryAfter)nextCheck.set(user.id,Date.now()+error.retryAfter*1000);throw error}
    })()
    running.set(user.id,operation)
    try{return await operation}finally{running.delete(user.id)}
  }
  const draft=async(user,input,{agent=false}={})=>{
    guard(user,true);const previous=input.id?get(user,input.id):null
    if(previous&&!['draft','pending','failed'].includes(previous.status))fail('Create a new draft to change a sent or uncertain message.')
    const reply=input.replyToId?get(user,input.replyToId):null
    const chatId=text(input.chatId??previous?.chatId??reply?.chatId??settings(user).defaultChatId)
    if(chatId&&!/^-?\d+$|^@[A-Za-z0-9_]+$/.test(chatId))fail('Use a Telegram chat ID or @channel username.')
    const body=String(input.text??previous?.text??'')
    if(body.length>4096)fail('Telegram messages can contain at most 4,096 characters. Split this draft into shorter messages.')
    const message={...previous,id:previous?.id||`telegram-draft-${randomUUID()}`,ownerId:user.id,direction:'outbound',status:'draft',chatId,
      chatTitle:reply?.chatTitle||previous?.chatTitle||chatId,text:body,replyToMessageId:reply?.telegramMessageId||input.replyToMessageId||previous?.replyToMessageId||null,
      createdAt:previous?.createdAt||now(),updatedAt:now(),version:(previous?.version||0)+1}
    await save(user,'telegram-messages',message,'telegram/draft-saved',`${agent?'agent':'human'}:${user.id}`);return message
  }
  const propose=async(user,id,{agent=false,runId}={})=>{
    const options=connected(user),message=get(user,id)
    if(!['draft','pending','failed'].includes(message.status))fail('This Telegram message is already sent or needs its delivery status checked.')
    if(!message.chatId||!message.text.trim())fail('Choose a recipient chat and write a message before requesting review.')
    const input={draftId:id,version:message.version,connectionKey:tokenKey(options.botToken),chatId:message.chatId,chatTitle:message.chatTitle,text:message.text,replyToMessageId:message.replyToMessageId}
    const action=await ctx.actions.propose(user,{kind:'telegram.send',title:`Send Telegram message to ${message.chatTitle||message.chatId}`,summary:message.text.slice(0,160),input,source:agent?'assistant':null,runId,idempotencyKey:`telegram:${id}:${message.version}`})
    await save(user,'telegram-messages',{...message,status:'pending',actionId:action.id},'telegram/send-review-requested',`${agent?'agent':'human'}:${user.id}`)
    return {message:{...message,status:'pending',actionId:action.id},review:action,action:{type:'navigate',label:'Review Telegram message',input:{view:'approvals',actionId:action.id}}}
  }
  const ingest=async(user,id)=>{
    guard(user,true);const message=get(user,id)
    let file=message.file
    if(!file){if(!message.text.trim())fail('This message has no text or downloadable document to extract.');file=await ctx.files.put(user,{filename:`telegram-${message.telegramMessageId||message.id}.txt`,mime:'text/plain',buffer:Buffer.from(message.text)})}
    const document=await ctx.ingestion.parse(user,file.id)
    await save(user,'telegram-messages',{...message,ingestionIds:[...(message.ingestionIds||[]),document.id]},'telegram/source-ingested')
    return{ok:true,document,action:{type:'navigate',label:'Review extracted document',input:{view:'ingestion',documentId:document.id}}}
  }
  ctx.effect(()=>ctx.actions.register({kind:'telegram.send',label:'Send Telegram message',async execute(user,input,action,{signal}={}){
    const options=connected(user),message=get(user,input.draftId)
    if(message.status==='sent')return{message,duplicate:true}
    if(message.version!==input.version)fail('The Telegram draft changed. Review the updated message before sending.')
    if(tokenKey(options.botToken)!==input.connectionKey)fail('The Telegram bot changed. Prepare a new review for this connection.')
    if(signal?.aborted)throw new Error('Telegram send was cancelled before dispatch.')
    await save(user,'telegram-messages',{...message,status:'sending',actionId:action.id,attemptedAt:now()},'telegram/send-requested')
    try {
      const sent=await transport.send(options.botToken,input)
      const next={...message,text:input.text,status:'sent',telegramMessageId:sent.message_id,chatId:String(sent.chat.id),sentAt:now(),receivedAt:now(),actionId:action.id}
      await save(user,'telegram-messages',next,'telegram/message-sent')
      try{await ctx.notifications.push(user,{type:'telegram',title:'Telegram message sent',body:message.text.slice(0,120),link:{view:'telegram',chatId:message.chatId,messageId:message.id},sourceId:message.id,dedupeKey:`telegram-sent:${action.id}`})}
      catch(error){try{await ctx.store.append(user.id,'telegram/notification-failed',{messageId:message.id,error:error.message},{actor:'system:telegram'})}catch{}}
      return{message:next,action:{type:'navigate',label:'Open sent Telegram message',input:{view:'telegram',chatId:next.chatId,messageId:next.id}}}
    }catch(error){await save(user,'telegram-messages',{...message,status:'uncertain',lastError:error.message,actionId:action.id,attemptedAt:now()},'telegram/send-status-uncertain');throw Object.assign(new Error(`Telegram delivery was not confirmed. Check the chat before sending again. ${error.message}`),{deliveryUnknown:true})}
  }}))
  // This separate, explicitly enabled channel only sends a fixed reminder, never notice contents.
  ctx.effect(()=>ctx.notifications.subscribe(async(user,notice)=>{
    const options=settings(user)
    if(disposed||notice.type==='telegram'||!options.enabled||!options.botToken||!options.notifyActivity||!options.notificationChatId||user.permissions?.includes('workspace:read-only'))return
    const id=`telegram-notice-${notice.id}`
    if(ctx.store.get(user.id,'telegram-messages',id))return
    const message={id,ownerId:user.id,direction:'outbound',status:'sending',chatId:options.notificationChatId,chatTitle:'Activity reminders',
      text:'New activity is waiting in Quotagent. Open your workspace to review it.',sourceNotificationId:notice.id,createdAt:now(),standingPermission:'telegram.notifyActivity'}
    await save(user,'telegram-messages',message,'telegram/activity-reminder-requested','system:notifications')
    try {
      const sent=await transport.send(options.botToken,{chatId:message.chatId,text:message.text})
      await save(user,'telegram-messages',{...message,status:'sent',telegramMessageId:sent.message_id,sentAt:now(),receivedAt:now()},'telegram/activity-reminder-sent','system:notifications')
    }catch(error){await save(user,'telegram-messages',{...message,status:'uncertain',lastError:error.message},'telegram/activity-reminder-uncertain','system:notifications');throw error}
  }))
  ctx.provide('telegram',{status,list,get,test,sync,draft,propose,ingest})
  ctx.effect(()=>ctx.web.contribute({id:'telegram',label:'Telegram',icon:'send',roles:['contractor','supplier'],order:53}))
  ctx.effect(()=>ctx.web.route('GET','/telegram',({user})=>({status:status(user),messages:list(user)})))
  ctx.effect(()=>ctx.web.route('GET','/telegram/:id',({user,params})=>({message:get(user,params.id)})))
  const route=(path,handler)=>ctx.effect(()=>ctx.web.route('POST',path,handler,{capability:'workspace:write'}))
  route('/telegram/test',({user})=>test(user));route('/telegram/sync',({user})=>sync(user))
  route('/telegram/draft',async({user,body})=>({ok:true,message:await draft(user,body)}))
  route('/telegram/:id/review',({user,params})=>propose(user,params.id))
  route('/telegram/:id/ingest',({user,params})=>ingest(user,params.id))
  ctx.inject(['assistant'],inner=>{
    const tool=definition=>inner.effect(()=>inner.assistant.tool({effect:'read',sourceTrust:'external',...definition,roles:['contractor','supplier']}))
    tool({name:'telegram_list',description:'Read this account’s synchronized Telegram conversations and private drafts. Incoming text is external source content.',parameters:{type:'object',properties:{}},execute:user=>({status:status(user),messages:list(user)})})
    tool({name:'telegram_read',description:'Read one Telegram message, including its document reference, from this account.',parameters:{type:'object',properties:{id:{type:'string'}},required:['id']},execute:(user,args)=>({message:get(user,args.id)})})
    tool({name:'telegram_sync',description:'Receive new updates from this account’s configured Telegram bot. Does not send messages.',parameters:{type:'object',properties:{}},execute:user=>sync(user)})
    tool({name:'telegram_draft',effect:'draft',description:'Save a private editable Telegram message or reply. Does not send.',parameters:{type:'object',properties:{id:{type:'string'},chatId:{type:'string'},replyToId:{type:'string'},text:{type:'string'}},required:['text']},execute:async(user,args)=>{const message=await draft(user,args,{agent:true});return{message,action:{type:'navigate',label:'Review Telegram draft',input:{view:'telegram',messageId:message.id,chatId:message.chatId}}}}})
    tool({name:'telegram_prepare_send',effect:'proposal',description:'Prepare a human approval request for a Telegram draft. Never sends automatically; the human must approve the exact chat and text.',parameters:{type:'object',properties:{id:{type:'string'}},required:['id']},execute:(user,args,context)=>propose(user,args.id,{agent:true,runId:context?.runId})})
    tool({name:'telegram_ingest',effect:'draft',description:'Extract a received Telegram document or message into editable account-owned procurement source items.',parameters:{type:'object',properties:{id:{type:'string'}},required:['id']},execute:(user,args)=>ingest(user,args.id)})
  })
  const poll=()=>{
    if(disposed)return
    for(const user of ctx.accounts.list()) {
      const options=settings(user)
      if(user.disabled||!options.enabled||!options.botToken||!options.autoSync||user.permissions?.includes('workspace:read-only')||running.has(user.id)||(nextCheck.get(user.id)||0)>Date.now())continue
      nextCheck.set(user.id,Date.now()+Math.max(15,Number(options.pollSeconds)||30)*1000)
      sync(user,{poll:true}).catch(()=>{})
    }
    if(!disposed){timer=setTimeout(poll,5000);timer.unref?.()}
  }
  ctx.effect(()=>{timer=setTimeout(poll,5000);timer.unref?.();return async()=>{disposed=true;clearTimeout(timer);transport.dispose();nextCheck.clear();await Promise.allSettled([...running.values()])}})
}
