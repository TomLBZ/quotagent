import {createServer as netServer} from 'node:net'
import {createServer as httpServer} from 'node:http'
import {createRequire} from 'node:module'
import {once} from 'node:events'
const require=createRequire(new URL('../../../../host/package.json',import.meta.url))
const {SMTPServer}=require('smtp-server')
export async function localServices({source,attachment=Buffer.from('Description,Quantity,Unit,Unit Price\nValve,4,each,12.50')}={}) {
  const sockets=new Set(),smtpMessages=[],telegramSent=[],requests=[]
  const raw=source||Buffer.from('From: Vendor <vendor@fixture.invalid>\r\nTo: buyer@fixture.invalid\r\nSubject: Fixture quotation\r\nMessage-ID: <fixture-inquiry@fixture.invalid>\r\nDate: Fri, 25 Sep 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n4 each Valve @ 12.50\r\n')
  const imap=netServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.setEncoding('utf8');socket.write('* OK Fixture IMAP ready\r\n')
    let buffer='',authTag=null,folder='INBOX'
    socket.on('data',data=>{buffer+=data;let end;while((end=buffer.indexOf('\r\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+2)
      if(authTag){socket.write(`${authTag} OK Authenticated\r\n`);authTag=null;continue}
      const parts=line.split(' '),tag=parts.shift(),command=parts.shift()?.toUpperCase(),args=parts.join(' ');requests.push({protocol:'imap',command,args:command==='AUTHENTICATE'||command==='LOGIN'?'[credentials]':args})
      const ok=()=>socket.write(`${tag} OK ${command} completed\r\n`)
      if(command==='CAPABILITY')socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR\r\n${tag} OK CAPABILITY completed\r\n`)
      else if(command==='AUTHENTICATE'){if(parts.length>1)ok();else{authTag=tag;socket.write('+ \r\n')}}
      else if(command==='LOGIN')ok()
      else if(command==='LIST'||command==='LSUB')socket.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasNoChildren \\Sent) "/" "Sent"\r\n${tag} OK LIST completed\r\n`)
      else if(command==='EXAMINE'||command==='SELECT'){folder=args.replace(/^"|"$/g,'');socket.write(`* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1234] UIDs valid\r\n* OK [UIDNEXT 2] Next UID\r\n${tag} OK [READ-ONLY] ${folder} selected\r\n`)}
      else if(command==='UID'&&parts[0]?.toUpperCase()==='SEARCH')socket.write(`* SEARCH 1\r\n${tag} OK SEARCH complete\r\n`)
      else if(command==='UID'&&parts[0]?.toUpperCase()==='FETCH'){
        if(/BODY(?:\.PEEK)?\[/i.test(args)){socket.write(`* 1 FETCH (UID 1 BODY[] {${raw.length}}\r\n`);socket.write(raw);socket.write(`)\r\n${tag} OK FETCH completed\r\n`)}
        else socket.write(`* 1 FETCH (UID 1 FLAGS () INTERNALDATE "25-Sep-2026 10:00:00 +0000" RFC822.SIZE ${raw.length})\r\n${tag} OK FETCH completed\r\n`)
      }
      else if(command==='LOGOUT'){socket.write(`* BYE Closing\r\n${tag} OK LOGOUT completed\r\n`);socket.end()}
      else ok()
    }})
  })
  imap.listen(0,'127.0.0.1');await once(imap,'listening')
  const smtp=new SMTPServer({secure:false,logger:false,authOptional:true,disabledCommands:['STARTTLS'],
    onAuth(auth,session,callback){callback(null,{user:auth.username})},
    onData(stream,session,callback){const parts=[];stream.on('data',chunk=>parts.push(chunk));stream.on('end',()=>{smtpMessages.push({envelope:session.envelope,source:Buffer.concat(parts)});callback(null,'Fixture accepted')})}})
  await new Promise(resolve=>smtp.listen(0,'127.0.0.1',resolve))
  const updates=[{update_id:1,message:{message_id:10,date:1790330400,chat:{id:4242,type:'private',first_name:'Fixture supplier'},from:{id:4242,first_name:'Fixture',last_name:'Supplier'},text:'Please quote 4 each Valve.'}},
    {update_id:2,message:{message_id:11,date:1790330401,chat:{id:4242,type:'private',first_name:'Fixture supplier'},from:{id:4242,first_name:'Fixture',last_name:'Supplier'},caption:'Offer attached',document:{file_id:'fixture-file',file_unique_id:'fixture-unique',file_name:'telegram-offer.csv',mime_type:'text/csv',file_size:attachment.length}}}]
  const telegram=httpServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk)
    const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{},method=req.url.split('/').at(-1)
    if(req.url==='/fixture/status'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({smtpSent:smtpMessages.length,telegramSent:telegramSent.length,smtpMessages:smtpMessages.map(message=>({to:message.envelope.rcptTo.map(row=>row.address),source:message.source.toString()})),telegramMessages:telegramSent}));return}
    requests.push({protocol:'telegram',method,body})
    if(req.url.startsWith('/file/')){res.writeHead(200,{'content-type':'text/csv'});res.end(attachment);return}
    let result
    if(method==='getMe')result={id:8000,is_bot:true,first_name:'Fixture Bot',username:'quotagent_fixture_bot'}
    else if(method==='getUpdates')result=updates.filter(update=>update.update_id>=Number(body.offset||0))
    else if(method==='getFile')result={file_id:'fixture-file',file_path:'documents/offer.csv',file_size:attachment.length}
    else if(method==='sendMessage'){telegramSent.push(body);result={message_id:100+telegramSent.length,date:1790330600,chat:{id:Number(body.chat_id),type:'private'},text:body.text}}
    else{res.writeHead(404);res.end(JSON.stringify({ok:false,description:'Unknown fixture method'}));return}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,result}))
  })
  telegram.listen(0,'127.0.0.1');await once(telegram,'listening')
  return {imapPort:imap.address().port,smtpPort:smtp.server.address().port,telegramBase:`http://127.0.0.1:${telegram.address().port}`,smtpMessages,telegramSent,requests,updates,
    async close(){for(const socket of sockets)socket.destroy();await Promise.all([new Promise(resolve=>imap.close(resolve)),new Promise(resolve=>smtp.close(resolve)),new Promise(resolve=>telegram.close(resolve))])}}
}
