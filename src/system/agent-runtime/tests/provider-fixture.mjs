// Loopback-only protocol service for GUI evidence. These responses are not model-quality evidence.
import {createServer} from 'node:http'
const port=Number(process.env.FIXTURE_PORT||8653);let calls=0
const server=createServer(async(request,response)=>{
 if(request.method==='GET'&&request.url==='/stats'){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({calls,kind:'explicit-loopback-protocol-fixture'}));return}
 let raw='';for await(const part of request)raw+=part
 try{const body=JSON.parse(raw),text=body.messages?.at(-1)?.content||'';calls++
 if(text.includes('G6 PROVIDER FAIL')){response.writeHead(503,{'content-type':'application/json','retry-after':'2'});response.end(JSON.stringify({error:{message:'Explicit local fixture temporary failure'}}));return}
 if(text.includes('G6 DELAY'))await new Promise(resolve=>setTimeout(resolve,10000))
 response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({model:'g6-protocol-fixture',choices:[{message:{role:'assistant',content:'This is a local protocol fixture response. No procurement action was taken. Review the source before deciding.'}}],usage:{prompt_tokens:120,completion_tokens:30,total_tokens:150}}))
 }catch(error){response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:error.message}}))}
})
await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));console.log(JSON.stringify({ready:true,url:`http://127.0.0.1:${port}/v1`,provider:'g6-loopback',model:'g6-protocol-fixture',key:'fixture-only',limitation:'Synthetic transport responses; no real model or external business action.'}))
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.closeAllConnections();server.close(()=>process.exit(0))})
