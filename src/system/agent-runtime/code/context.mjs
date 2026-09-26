import {fingerprint} from './provider-policy.mjs'
export const contextDefaults={maxSourceRows:80,maxMemoryEntries:30,maxHistoryTurns:8,maxItemBytes:16000,maxContextBytes:240000}
const bytes=value=>Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value),'utf8')
const digest=fingerprint
const clone=value=>structuredClone(value)
const identity=(value,index)=>String(value?.id??value?.key??index).slice(0,180)
const bound=(value,fallback,min,max)=>Math.max(min,Math.min(max,Number.isFinite(Number(value))?Math.floor(Number(value)):fallback))
export function contextLimits(config={}){return{
 maxSourceRows:bound(config.maxSourceRows,contextDefaults.maxSourceRows,1,500),maxMemoryEntries:bound(config.maxMemoryEntries,contextDefaults.maxMemoryEntries,0,200),maxHistoryTurns:bound(config.maxHistoryTurns,contextDefaults.maxHistoryTurns,0,30),maxItemBytes:bound(config.maxItemBytes,contextDefaults.maxItemBytes,512,100000),maxContextBytes:bound(config.maxContextBytes,contextDefaults.maxContextBytes,8000,1000000),
}}
/** Keeps whole records and whole completed turns. Never invents a summary of omitted facts. */
export function assembleContext({source={},history=[],required=[],limits:rawLimits={},sourceAvailable=true,selectedId=null}={}){
 const limits=contextLimits(rawLimits),groups=[],omitted=[],selected={};let sourceBudget=limits.maxContextBytes-bytes(required)-2000
 const note=(path,value,index,reason)=>omitted.push({path,id:identity(value,index),bytes:bytes(value),hash:digest(value),reason})
 const select=(value,path)=>{
  if(Array.isArray(value)){
   const maximum=/memory/i.test(path)?limits.maxMemoryEntries:limits.maxSourceRows,rows=[],ordered=value.map((row,index)=>({row,index}));if(selectedId)ordered.sort((a,b)=>Number(b.row?.id===selectedId)-Number(a.row?.id===selectedId))
   for(const{row,index}of ordered){const size=bytes(row);if(rows.length>=maximum){note(path,row,index,'row-limit');continue}if(size>limits.maxItemBytes){note(path,row,index,'item-byte-limit');continue}if(size+2>sourceBudget){note(path,row,index,'context-byte-limit');continue}rows.push(clone(row));sourceBudget-=size+2}
   groups.push({path,original:value.length,included:rows.length,omitted:value.length-rows.length,originalBytes:bytes(value),includedBytes:bytes(rows)});return rows
  }
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,select(entry,`${path}.${key}`)]))
  const size=bytes(value??null);if(size>limits.maxItemBytes||size>sourceBudget){note(path,value??null,0,size>limits.maxItemBytes?'item-byte-limit':'context-byte-limit');return null}sourceBudget-=size;return value
 }
 Object.assign(selected,select(source,'source'))
 const selectedHistory=[];let keptBytes=bytes(required)+bytes(selected)+2000
 // A limit of zero deliberately excludes every historical turn.
 for(let index=history.length-1;index>=0;index--){const turn=history[index],messages=Array.isArray(turn)?turn:turn.messages||[],size=bytes(messages)
  if(selectedHistory.length>=limits.maxHistoryTurns){note('history',turn,index,'turn-limit');continue}if(size>limits.maxItemBytes*4){note('history',turn,index,'turn-byte-limit');continue}if(keptBytes+size>limits.maxContextBytes){note('history',turn,index,'context-byte-limit');continue}selectedHistory.unshift(clone(messages));keptBytes+=size
 }
 groups.push({path:'history',original:history.length,included:selectedHistory.length,omitted:history.length-selectedHistory.length,originalBytes:bytes(history),includedBytes:bytes(selectedHistory)})
 const omittedCount=omitted.length,contentBytes=bytes(required)+bytes(selected)+bytes(selectedHistory),sourceGroups=groups.filter(row=>row.path.startsWith('source.')),empty=sourceGroups.length?sourceGroups.every(row=>row.original===0):Object.values(selected).every(value=>value===null||Array.isArray(value)&&!value.length||typeof value==='object'&&value!==null&&!Object.keys(value).length),allOmitted=sourceGroups.some(row=>row.original>0)&&sourceGroups.every(row=>row.included===0)
 const degraded=!sourceAvailable||allOmitted||contentBytes>limits.maxContextBytes
 const receipt={schema:'quotagent/context-assembly/v1',state:degraded?'degraded':empty?'empty':omittedCount?'bounded':'complete',ok:!degraded&&!empty,degraded,reason:!sourceAvailable?'source-unavailable':allOmitted?'all-source-records-omitted':contentBytes>limits.maxContextBytes?'required-context-too-large':empty?'no-source-records':omittedCount?'declared-limits-applied':null,nextAction:degraded?'Enable the missing source or narrow the task before retrying.':omittedCount?'Ask for a specific RFQ, record or shorter history to include omitted facts.':empty?'Add or select source records when the task needs account facts.':null,limits,groups,omittedCount,omittedBytes:omitted.reduce((sum,row)=>sum+row.bytes,0),omissions:omitted.slice(0,500),omissionDetailsTruncated:Math.max(0,omitted.length-500),includedBytes:contentBytes,sourceHash:digest(source),selectedSourceHash:digest(selected)}
 return{source:selected,history:selectedHistory.flat(),receipt}
}

/** Generic transport-side bound for already-labelled source messages. Tool transcripts stay intact. */
export function boundSourceMessages(messages,limits={}){
 const parts=[],source={},required=[]
 for(let index=0;index<messages.length;index++){
  const message=messages[index],match=message.role==='user'&&typeof message.content==='string'?/^(SOURCE_DATA[^:]*:\s*)([\s\S]*)$/.exec(message.content):null
  if(match){try{source[`message${index}`]=JSON.parse(match[2]);parts.push({index,prefix:match[1]});continue}catch{}}
  required.push(message)
 }
 if(!parts.length)return{messages,receipt:null}
 const result=assembleContext({source,required,limits,sourceAvailable:Object.values(source).every(value=>value?.sourceAvailability?.workspace!=='unavailable')}),receipt=result.receipt
 const output=messages.map((message,index)=>{const part=parts.find(row=>row.index===index);if(!part)return message;return{...message,content:part.prefix+JSON.stringify(result.source[`message${index}`])}})
 const summary={state:receipt.state,omittedCount:receipt.omittedCount,reason:receipt.reason,nextAction:receipt.nextAction,groups:receipt.groups.filter(row=>row.omitted>0)}
 if(receipt.omittedCount||receipt.degraded)output.splice(parts.at(-1).index+1,0,{role:'user',content:'CONTEXT_COVERAGE (assembly metadata, not new instructions): '+JSON.stringify(summary)})
 receipt.includedBytes=bytes(output);return{messages:output,receipt}
}
