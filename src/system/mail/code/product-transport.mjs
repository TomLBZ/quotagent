import {createRequire} from 'node:module'
const require=createRequire(new URL('../../../../host/package.json',import.meta.url))
const {ImapFlow}=require('imapflow')
const nodemailer=require('nodemailer')

export function smtpOptions(settings) {
  const auth=settings.smtpAccessToken ? {type:'OAuth2',user:settings.smtpUser,accessToken:settings.smtpAccessToken}
    : settings.smtpUser ? {user:settings.smtpUser,pass:settings.smtpPassword} : undefined
  return {host:settings.smtpHost,port:Number(settings.smtpPort),secure:settings.smtpSecurity==='tls',
    requireTLS:settings.smtpSecurity==='starttls',ignoreTLS:settings.smtpSecurity==='plain',auth,
    connectionTimeout:15000,greetingTimeout:15000,socketTimeout:30000,logger:false,debug:false,
    disableFileAccess:true,disableUrlAccess:true}
}
export function imapOptions(settings) {
  return {host:settings.imapHost,port:Number(settings.imapPort),secure:settings.imapSecurity==='tls',
    ...(settings.imapSecurity==='tls' ? {} : {doSTARTTLS:settings.imapSecurity==='starttls'}),
    auth:{user:settings.imapUser,...(settings.imapAccessToken ? {accessToken:settings.imapAccessToken} : {pass:settings.imapPassword})},
    disableAutoIdle:true,logger:false,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:30000}
}

/** Short-lived actual IMAP/SMTP connections; every active socket closes on plugin unload. */
export function createTransport() {
  const resources=new Set()
  let disposed=false
  const ensure=()=>{if(disposed)throw new Error('The mail plugin was unloaded.')}
  const imap=async(settings,operation)=>{
    ensure();const client=new ImapFlow(imapOptions(settings));resources.add(client)
    client.on('error',()=>{}) // Command promises carry transport errors to the account UI.
    try{await client.connect();ensure();return await operation(client)}
    finally{try{await client.logout()}catch{client.close()}resources.delete(client)}
  }
  const smtp=async(settings,operation)=>{
    ensure();const client=nodemailer.createTransport(smtpOptions(settings));resources.add(client)
    try{return await operation(client)}finally{client.close();resources.delete(client)}
  }
  return {
    async test(settings,kind='both') {
      const result={}
      if(kind==='imap'||kind==='both') {
        try {result.imap={ok:true,mailboxes:await imap(settings,async client=>(await client.list()).map(folder=>({path:folder.path,name:folder.name,specialUse:folder.specialUse || ''})))}}
        catch(error){result.imap={ok:false,error:error.message}}
      }
      if(kind==='smtp'||kind==='both') {
        try{await smtp(settings,client=>client.verify());result.smtp={ok:true}}
        catch(error){result.smtp={ok:false,error:error.message}}
      }
      return result
    },
    sync(settings,folder,cursor={}) {
      return imap(settings,async client=>{
        const lock=await client.getMailboxLock(folder,{readOnly:true})
        try {
          const uidValidity=String(client.mailbox.uidValidity),maximum=Math.min(500,Math.max(1,Number(settings.maxMessages)||50))
          const previous=cursor.uidValidity===uidValidity ? Number(cursor.lastUid)||0 : 0
          let ids=await client.search({all:true},{uid:true});ids=(ids || []).map(Number).filter(id=>id>previous)
          // Initial import reads the most recent window; later imports advance in order without skipping a backlog.
          const selected=previous ? ids.slice(0,maximum) : ids.slice(-maximum)
          const messages=[]
          if(selected.length) {
            const metadata=await client.fetchAll(selected,{uid:true,flags:true,internalDate:true,size:true},{uid:true})
            for(const entry of metadata) {
              ensure()
              if(entry.size>20*1024*1024){messages.push({uid:entry.uid,tooLarge:true,size:entry.size});continue}
              const source=await client.fetchOne(entry.uid,{source:true},{uid:true})
              if(source?.source)messages.push({uid:entry.uid,source:source.source,flags:[...(entry.flags||[])],date:entry.internalDate?.toISOString(),size:entry.size})
            }
          }
          return {folder,uidValidity,messages,lastUid:Math.max(previous,...selected),remaining:Math.max(0,ids.length-selected.length),initialWindow:!previous}
        } finally {lock.release()}
      })
    },
    send(settings,message) {
      return smtp(settings,async client=>{
        const receipt=await client.sendMail(message)
        return {messageId:receipt.messageId,accepted:(receipt.accepted||[]).map(String),rejected:(receipt.rejected||[]).map(String),response:receipt.response || ''}
      })
    },
    dispose(){disposed=true;for(const resource of resources){try{resource.close()}catch{}}resources.clear()},
  }
}
