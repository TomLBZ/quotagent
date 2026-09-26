import React,{useEffect,useRef,useState} from 'react'
import {useResource,Button,ErrorNotice} from '../../../system/webui/client/core.jsx'
import {PluginSettings} from '../../../system/settings/client/settings.jsx'
const fields={rfq:{currency:'currency',description:'requestBrief'},quote:{leadDays:'quoteLeadDays',paymentTerms:'quotePaymentTerms',notes:'quoteNotes'}}
const labels={currency:'Currency',description:'Request brief',leadDays:'Lead time (days)',paymentTerms:'Payment terms',notes:'Quote notes'}
export function useDraftDefaults(kind,context,existing,setForm){
 const edited=useRef(new Set()),[settings,setSettings]=useState(false),query=new URLSearchParams(Object.entries(context).filter(([,value])=>value)),resource=useResource('/workspace/draft-defaults?'+query.toString(),{values:{},provenance:{}}),mapping=fields[kind]
 const apply=(force=false)=>setForm(current=>{
  const next={...current};for(const[field,key]of Object.entries(mapping))if(resource.data.values[key]!==undefined&&(force||!edited.current.has(field))){next[field]=resource.data.values[key];if(force)edited.current.delete(field)}return next
 })
 useEffect(()=>{if(!existing)apply()},[resource.data,!!existing])
 const scope=context.sectionId?'section':context.projectId?'project':'workspace'
 return{
  mark:field=>edited.current.add(field),
  payload:form=>{const value={...form};if(!existing)for(const field of Object.keys(mapping))if(!edited.current.has(field))delete value[field];return value},
  panel:<section className="lifecycle-notice" onSubmit={event=>event.stopPropagation()}><details><summary>Draft defaults and sources</summary><p>Starting values come from your account and selected party context. Your manual edits and explicit blanks take precedence. Published records never change when a default changes.</p><ErrorNotice error={resource.error}/><dl>{Object.entries(mapping).map(([field,key])=><div key={field}><dt><strong>{labels[field]}</strong></dt><dd>{resource.data.values[key]===''?'Blank':resource.data.values[key]??'Loading…'}<small className="muted"> · {resource.data.provenance[key]?.scopeLabel||resource.data.provenance[key]?.layer||'Default'}</small></dd></div>)}</dl><div className="row-actions"><Button variant="secondary" disabled={resource.loading||!!resource.error} onClick={()=>apply(true)}>Use these defaults</Button><Button variant="ghost" onClick={()=>setSettings(true)}>Configure draft defaults</Button></div></details>{settings&&<PluginSettings plugin={{id:'procurement',name:'Draft defaults'}} context={context} scope={scope} onClose={()=>{setSettings(false);resource.reload()}}/>}</section>
 }
}

export function DraftBasis({record}){
 const entries=Object.entries(record.draftDefaults?.applied||{});if(!entries.length)return null
 return <details className="section-space"><summary>Initial draft preparation sources</summary><p className="muted">These values were inherited when this draft was prepared. Later manual edits are retained separately in record history.</p><ul>{entries.map(([field,entry])=><li key={field}><strong>{labels[field]||field}:</strong> {entry.value===''?'Blank':entry.value} · {entry.source.scopeLabel||entry.source.layer}</li>)}</ul></details>
}
