/** Telegram Bot API transport. Token-bearing URLs never enter persisted records or errors. */
export function createTransport({apiBase='https://api.telegram.org',fetchImpl=fetch}={}) {
  const controllers=new Set()
  let disposed=false
  const request=async(token,method,payload={},timeoutMs=35000)=>{
    if(disposed)throw new Error('The Telegram plugin was unloaded.')
    const controller=new AbortController();controllers.add(controller)
    const timeout=setTimeout(()=>controller.abort(),timeoutMs);timeout.unref?.()
    try {
      const response=await fetchImpl(`${apiBase}/bot${token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:controller.signal})
      const body=await response.json()
      if(!response.ok || !body.ok)throw Object.assign(new Error(body.description || `Telegram returned HTTP ${response.status}.`),{retryAfter:Number(body.parameters?.retry_after)||0,status:response.status})
      return body.result
    } catch(error) {
      if(error.name==='AbortError')throw new Error(disposed?'Telegram connection closed.':'Telegram request timed out. Check the connection before retrying an outgoing message.')
      const message=String(error.message||'Telegram request failed.').replaceAll(token,'[credential]')
      throw Object.assign(new Error(message),{retryAfter:error.retryAfter || 0})
    } finally {clearTimeout(timeout);controllers.delete(controller)}
  }
  return {
    getMe:token=>request(token,'getMe'),
    updates:(token,offset,timeout=0)=>request(token,'getUpdates',{offset,limit:100,timeout,allowed_updates:['message','edited_message']},(timeout+10)*1000),
    send:(token,{chatId,text,replyToMessageId})=>request(token,'sendMessage',{chat_id:String(chatId),text,...(replyToMessageId?{reply_parameters:{message_id:Number(replyToMessageId)}}:{})}),
    async download(token,fileId) {
      const info=await request(token,'getFile',{file_id:fileId})
      if(!info.file_path)throw new Error('Telegram did not return a downloadable file.')
      if(info.file_size>20*1024*1024)throw new Error('Telegram cloud downloads are limited to 20 MB.')
      const controller=new AbortController();controllers.add(controller)
      const timeout=setTimeout(()=>controller.abort(),30000);timeout.unref?.()
      try {
        const response=await fetchImpl(`${apiBase}/file/bot${token}/${info.file_path}`,{signal:controller.signal})
        if(!response.ok)throw new Error(`Telegram file download returned HTTP ${response.status}.`)
        const parts=[];let size=0
        for await(const part of response.body){size+=part.length;if(size>20*1024*1024){controller.abort();throw new Error('Telegram file exceeds the 20 MB download limit.')}parts.push(Buffer.from(part))}
        return Buffer.concat(parts)
      }catch(error){throw new Error(String(error.message||'Telegram download failed.').replaceAll(token,'[credential]'))}
      finally{clearTimeout(timeout);controllers.delete(controller)}
    },
    dispose(){disposed=true;for(const controller of controllers)controller.abort();controllers.clear()},
  }
}
