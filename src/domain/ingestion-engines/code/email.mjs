import { require, register, plainHtml, htmlRows, textItems, decode } from './common.mjs'
const {simpleParser} = require('mailparser')
const MsgReader = require('@kenjiuno/msgreader').default
export const name = 'ingestion-email'
export const inject = ['ingestion']
const attachment = (value,index) => ({filename:value.filename || `attachment-${index + 1}.bin`,mime:value.contentType || 'application/octet-stream',buffer:Buffer.from(value.content)})
export async function parse({buffer,filename}) {
  if (/\.msg$/i.test(filename)) {
    const reader = new MsgReader(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset + buffer.byteLength))
    const data = reader.getFileData()
    if (data.error) throw new Error(`Outlook message could not be read: ${data.error}`)
    const body = data.body || plainHtml(data.bodyHtml || '')
    const attachments = (data.attachments || []).map((entry,index) => {
      const file = reader.getAttachment(entry)
      return {filename:file.fileName || entry.fileName || `attachment-${index + 1}.bin`,mime:entry.attachMimeTag || 'application/octet-stream',buffer:Buffer.from(file.content)}
    })
    const rows = htmlRows(data.bodyHtml || '')
    const parsedText = textItems(body)
    return {text:`Subject: ${data.subject || ''}\nFrom: ${data.senderName || ''} <${data.senderEmail || ''}>\n\n${body}`,
      rows:rows.length ? rows : parsedText.rows,attachments,metadata:{format:'msg',subject:data.subject || '',from:data.senderEmail || data.senderName || '',messages:1},
      warnings:body ? [] : ['This Outlook message has no plain or HTML body. RTF-only messages need export to EML or text.']}
  }
  let messages = [buffer]
  if (/\.mbox$/i.test(filename)) {
    const raw = decode(buffer)
    const chunks = raw.split(/^From \S+[^\r\n]*\r?\n/gm).filter(chunk => chunk.trim())
    messages = (chunks.length ? chunks : [raw]).map(chunk => Buffer.from(chunk.replace(/^>From /gm,'From '),'utf8'))
  }
  const rows = [], attachments = [], texts = [], headers = [], warnings = []
  for (const [index,raw] of messages.slice(0,100).entries()) {
    const mail = await simpleParser(raw,{skipImageLinks:true,skipHtmlToText:false,skipTextToHtml:true})
    const body = mail.text || plainHtml(mail.html || '')
    texts.push(`Message ${index + 1}\nSubject: ${mail.subject || ''}\nFrom: ${mail.from?.text || ''}\nTo: ${mail.to?.text || ''}\nDate: ${mail.date?.toISOString() || ''}\n\n${body}`)
    const tables = htmlRows(mail.html || '')
    rows.push(...(tables.length ? tables : textItems(body).rows).map(row => ({...row,_message:index + 1})))
    attachments.push(...mail.attachments.map(attachment))
    headers.push({subject:mail.subject || '',from:mail.from?.text || '',to:mail.to?.text || '',date:mail.date?.toISOString() || '',messageId:mail.messageId || ''})
  }
  if (messages.length > 100) warnings.push(`Read the first 100 of ${messages.length} messages. Split the mailbox to process the rest.`)
  return {text:texts.join('\n\n---\n\n'),rows,attachments,metadata:{format:/\.mbox$/i.test(filename) ? 'mbox' : 'eml',messages:headers.length,headers},warnings}
}
export function apply(ctx) { register(ctx,{id:'email',name:'Exported email parser',description:'Reads EML/MBOX MIME messages and Outlook MSG, including headers, message text, tables and attached documents.',extensions:['.eml','.mbox','.msg'],parse}) }
