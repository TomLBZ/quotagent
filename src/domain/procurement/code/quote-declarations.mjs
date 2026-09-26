const copy=value=>structuredClone(value)
const fail=message=>{throw Object.assign(new Error(message),{status:400,code:'QUOTE_DECLARATIONS'})}
const text=value=>String(value??'').trim()
const unique=(values,label)=>{if(new Set(values).size!==values.length)fail(`${label} must be unique.`)}
const exactDate=value=>{const input=text(value);if(!/^\d{4}-\d\d-\d\d$/.test(input)||!Number.isFinite(Date.parse(input))||new Date(input).toISOString().slice(0,10)!==input)fail('Every schedule milestone needs a valid ISO date.');return input}
export function quoteDeclarations(prior={},input={},itemIds=[]){
 prior=prior||{}
 const result={}
 for(const key of ['assumptions','exclusions']){
  const values=input[key]===undefined?prior[key]:input[key]
  if(values===undefined)continue
  if(!Array.isArray(values)||values.length>100)fail(`Provide at most 100 declared ${key}.`)
  result[key]=values.map(value=>{const declaration=text(value);if(!declaration)fail(`Each ${key==='assumptions'?'assumption':'exclusion'} needs explicit text.`);return declaration})
  unique(result[key],key)
 }
 const schedule=input.schedule===undefined?prior.schedule:input.schedule
 if(schedule!==undefined){
  if(!Array.isArray(schedule)||schedule.length>100)fail('Provide at most 100 named schedule milestones.')
  result.schedule=schedule.map(row=>{
   const id=text(row.id),label=text(row.label);if(!id||!label)fail('Every schedule milestone needs an ID and label.')
   if(!['firm','indicative'].includes(row.binding))fail('Declare each milestone as firm or indicative.')
   if(!Array.isArray(row.itemIds??[]))fail('Milestone item references must be a list.')
   const references=[...new Set((row.itemIds||[]).map(String))];if(references.some(id=>!itemIds.includes(id)))fail('Milestone references must identify quoted items.')
   return{id,label,date:exactDate(row.date),binding:row.binding,itemIds:references,description:text(row.description)}
  });unique(result.schedule.map(row=>row.id),'Schedule milestone IDs')
 }
 return copy(result)
}
export function protectFirmSchedule({agent,prior,next,asOf}){
 if(!agent||!prior?.commercial?.validityUntil||prior.commercial.validityUntil<asOf)return
 const firm=(prior.schedule||[]).filter(row=>row.binding==='firm')
 if(firm.some(row=>JSON.stringify((next.schedule||[]).find(item=>item.id===row.id)||null)!==JSON.stringify(row)))throw Object.assign(new Error('The submitted offer still has valid firm milestones. A human must prepare changes to these promises; keep their exact dates and scope in an agent draft.'),{status:409,code:'FIRM_SCHEDULE_HUMAN_REQUIRED'})
}
