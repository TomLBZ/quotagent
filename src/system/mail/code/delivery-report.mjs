// Structured MIME DSN only. Never infer delivery failure from subject/body prose.
const fields=value=>Object.fromEntries(String(value).replace(/\r\n/g,'\n').replace(/\n[ \t]+/g,' ').split('\n').filter(line=>/^[A-Za-z][A-Za-z0-9-]*:/.test(line)).map(line=>{const at=line.indexOf(':');return[line.slice(0,at).toLowerCase(),line.slice(at+1).trim().slice(0,2048)]}))
const messageId=value=>{const match=String(value||'').match(/^<[^<>\s]+>$/);return match?match[0]:null}
export function deliveryReport(parsed,sourceFileId=null){
 const parts=(parsed.attachments||[]).filter(part=>part.contentType==='message/delivery-status')
 if(!parts.length)return null
 const blocks=parts.flatMap(part=>part.content.toString('utf8').slice(0,262144).replace(/\r\n/g,'\n').split(/\n\s*\n/).map(fields)),reports=[]
 for(const block of blocks)if(block.action&&block['final-recipient'])reports.push({recipient:block['final-recipient'],action:block.action.toLowerCase(),status:block.status||'',diagnostic:block['diagnostic-code']||'',remoteMta:block['remote-mta']||''})
 const returned=(parsed.attachments||[]).filter(part=>['message/rfc822','text/rfc822-headers'].includes(part.contentType)).map(part=>fields(part.content.toString('utf8').slice(0,65536).split(/\r?\n\r?\n/)[0])['message-id'])
 const candidates=[...new Set([...blocks.map(block=>block['original-message-id']),...returned].map(messageId).filter(Boolean))]
 return {format:'message/delivery-status',sourceFileId,originalMessageId:candidates.length===1?candidates[0]:null,matchState:candidates.length===1?'exact-message-id':candidates.length?'ambiguous-original-id':'original-id-not-supplied',reportingMta:blocks.find(block=>block['reporting-mta'])?.['reporting-mta']||'',reports:reports.slice(0,100),omittedReports:Math.max(0,reports.length-100),truncated:parts.some(part=>part.content.length>262144)||reports.length>100,sourceTrust:'external'}
}
