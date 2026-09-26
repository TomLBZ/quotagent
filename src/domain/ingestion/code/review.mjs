import {createHash} from 'node:crypto'

const digest=item=>createHash('sha256').update(JSON.stringify(item)).digest('hex')
export function itemReview(record,item) {
 const row=Number(item.source?.row),quote=String(item.source?.quote||'').trim()
 const text=String(record.text||'').replace(/\s+/g,' ')
 const referenced=Number.isInteger(row)&&row>0&&row<=(record.rows?.length||0)||quote.length>0&&text.includes(quote.replace(/\s+/g,' '))
 const fingerprint=digest(item),confirmation=record.assumptionReviews?.[item.id]
 return {itemId:item.id,kind:referenced?'referenced':'assumption',fingerprint,
  basis:referenced?(row>0?`Source row ${row}`:'Exact source excerpt'):'No matching source row or excerpt',
  confirmed:!referenced&&confirmation?.fingerprint===fingerprint,
  ...(confirmation?.fingerprint===fingerprint?{confirmation}:{}),source:{documentId:record.id,fileId:record.fileId,sha256:record.sourceHash,...item.source}}
}
export function reviewDocument(record,role) {
 const itemReviews=(record.items||[]).map(item=>itemReview(record,item)),questions=[]
 for(const [index,item] of (record.items||[]).entries()) {
  const fields=[...(!item.description?.trim()?['description']:[]),...(!(Number(item.quantity)>0)?['quantity']:[]),...(!item.unit?.trim()?['unit']:[]),...(role==='supplier'&&item.unitPrice===null?['unit price']:[])]
  for(const field of fields)questions.push({id:`${item.id}:${field}`,itemId:item.id,field,text:`What is the ${field} for ${item.description||`item ${index+1}`}?`,source:itemReviews[index].source})
  if(itemReviews[index].kind==='assumption'&&!itemReviews[index].confirmed)questions.push({id:`${item.id}:source`,itemId:item.id,field:'source',text:`Which source supports ${item.description||`item ${index+1}`}? Confirm this assumption explicitly if it is your own addition.`,source:itemReviews[index].source})
 }
 return {...record,itemReviews,questions,questionNotice:'Private review questions. Nothing has been sent to a counterparty.'}
}
