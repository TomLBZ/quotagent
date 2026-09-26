const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})}
const copy=value=>structuredClone(value)
const scalar=value=>value==null?'':typeof value==='object'?JSON.stringify(value):String(value)
const text=value=>scalar(value).toLocaleLowerCase('en-US')
const sizes=new Set([0,10,25,50,100])
const empty={search:'',filters:{},sort:'',direction:'asc',size:25,exportColumns:[]}
export function normalizeView(value={},columns=[]){
 const known=new Set(columns.map(column=>column.key)),filters={}
 for(const [key,condition] of Object.entries(value.filters||{}))if(known.has(key)&&condition&&typeof condition==='object'){
  const next={};for(const op of ['contains','equals','min','max'])if(condition[op]!==undefined&&String(condition[op]).length)next[op]=String(condition[op]).slice(0,300)
  if(Object.keys(next).length)filters[key]=next
 }
 return {search:String(value.search||'').slice(0,300),filters,sort:known.has(value.sort)?value.sort:'',direction:value.direction==='desc'?'desc':'asc',size:sizes.has(Number(value.size))?Number(value.size):25,exportColumns:Array.isArray(value.exportColumns)?[...new Set(value.exportColumns.filter(key=>known.has(key)))]:[]}
}
export function windowRows(rows,columns,input={}){
 const applied=normalizeView(input,columns),indexed=rows.map((row,index)=>({row,index})),enums={}
 for(const column of columns.filter(column=>column.type==='enum'))enums[column.key]=[...new Set(rows.map(row=>scalar(row[column.key])))].sort()
 const filtered=indexed.filter(({row})=>(!applied.search||columns.some(column=>text(row[column.key]).includes(text(applied.search))))&&Object.entries(applied.filters).every(([key,condition])=>{
  const value=row[key],column=columns.find(column=>column.key===key),numeric=column.type==='number',compare=numeric?Number(value):column.type==='date'?scalar(value).slice(0,10):scalar(value)
  return (condition.contains===undefined||text(value).includes(text(condition.contains)))&&(condition.equals===undefined||scalar(value)===condition.equals)&&(condition.min===undefined||value!=null&&(!numeric||Number.isFinite(compare))&&compare>=(numeric?Number(condition.min):condition.min))&&(condition.max===undefined||value!=null&&(!numeric||Number.isFinite(compare))&&compare<=(numeric?Number(condition.max):condition.max))
 }))
 if(applied.sort){const column=columns.find(column=>column.key===applied.sort);filtered.sort((a,b)=>{const av=a.row[column.key],bv=b.row[column.key],order=av==null?(bv==null?0:1):bv==null?-1:column.type==='number'?Number(av)-Number(bv):scalar(av).localeCompare(scalar(bv),'en',{numeric:true});return (applied.direction==='desc'?-order:order)||a.index-b.index})}
 const size=applied.size,matched=filtered.length,pages=size?Math.max(1,Math.ceil(matched/size)):1,page=Math.max(1,Math.min(pages,Math.floor(Number(input.page)||1))),start=size?(page-1)*size:0,end=size?Math.min(matched,start+size):matched
 if(input.keys&&matched>5000)fail('More than 5,000 rows match. Narrow the filters before selecting all.',413)
 return {rows:filtered.slice(start,end).map(item=>item.row),query:{applied,total:rows.length,matched,page,pages,start,end,sent:end-start,enums,...(input.keys?{keys:filtered.map(item=>item.row.id)}:{})},matchedRows:filtered.map(item=>item.row)}
}
const cell=value=>{let result=scalar(value);if(/^[\s]*[=+@-]/.test(result))result="'"+result;return '"'+result.replaceAll('"','""')+'"'}
export function createCollections({store}){
 const definitions=new Map()
 const definition=(user,id)=>{const result=definitions.get(id);if(!result||result.roles&&!result.roles.includes(user.role)||result.available&&!result.available(user))fail('This collection is unavailable for this account.',404);return result}
 const key=(user,id)=>`${user.role}:${id}`
 const preference=(user,id)=>{const entry=definition(user,id),saved=store.get(user.id,'ui-view-preferences',key(user,id));return {revision:saved?.revision||0,values:normalizeView(saved?.values||entry.defaults||empty,entry.columns)}}
 const load=async(user,id,input)=>{const entry=definition(user,id),source=await entry.load(user);return {entry,...windowRows(source,entry.columns,input)}}
 return {
  register(entry){if(!entry.id||!Array.isArray(entry.columns)||typeof entry.load!=='function')throw new Error('Collections need an id, columns and an authorized row source.');if(definitions.has(entry.id))throw new Error('Collection already registered.');definitions.set(entry.id,entry);return()=>{if(definitions.get(entry.id)===entry)definitions.delete(entry.id)}},
  preference,
  async save(user,id,input){const entry=definition(user,id),current=preference(user,id);if(input.expectedRevision!==current.revision)fail('Your saved view changed in another window. Reload it before saving.',409);const values=normalizeView(input.reset?entry.defaults||empty:input.values,entry.columns);await store.put(user.id,'ui-view-preferences',{id:key(user,id),values,revision:current.revision+1},{actor:user.id,event:'webui/view-preferences-saved',expectedRevision:current.revision||null});return preference(user,id)},
  async query(user,id,input={}){const {entry,rows,query}=await load(user,id,input);return {rows:copy(rows),query,columns:copy(entry.columns),title:entry.label||id,preferences:preference(user,id)}},
  async export(user,id,input={}){const {entry,matchedRows}=await load(user,id,input),selected=normalizeView(input,entry.columns).exportColumns,columns=selected.length?entry.columns.filter(column=>selected.includes(column.key)):entry.columns;return {filename:`${id}.csv`,mime:'text/csv;charset=utf-8',rows:matchedRows.length,columns:columns.map(column=>column.key),content:[columns.map(column=>cell(column.label)).join(','),...matchedRows.map(row=>columns.map(column=>cell(row[column.key])).join(','))].join('\r\n')+'\r\n'}},
  dispose(){definitions.clear()},
 }
}
