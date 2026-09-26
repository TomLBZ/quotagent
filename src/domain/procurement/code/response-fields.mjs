/** Public response deadlines belong to the RFQ revision, not a separate UI clock. */
export function clarificationDeadline(value,quoteDeadline){
 const text=String(value??'').trim();if(!text)return ''
 const normalized=/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(text)?text+'Z':text
 const date=new Date(normalized)
 if(!Number.isFinite(date.getTime()))throw Object.assign(new Error('Choose a valid clarification deadline in UTC.'),{status:400})
 if(quoteDeadline&&date.getTime()>Date.parse(quoteDeadline))throw Object.assign(new Error('The clarification deadline cannot be later than the quotation deadline.'),{status:400})
 return date.toISOString()
}
