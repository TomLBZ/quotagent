import React,{useEffect,useState} from 'react'
import {registry,useApp,Button,Icon,Field,Modal,Empty} from './core.jsx'
import {routeHash,matchesShortcut} from './routing.mjs'
import './navigation.css'

export function WorkspaceNavigation({items,current,contribution}) {
  const app=useApp(),[open,setOpen]=useState(false),[share,setShare]=useState(false),[search,setSearch]=useState(''),[error,setError]=useState('')
  const visible=new Set(items.map(item=>item.id))
  const commands=[
    ...items.map(item=>({id:'page:'+item.id,label:item.label,description:'Open workspace page',icon:item.icon,run:()=>app.navigate(item.id)})),
    {id:'shell:home',label:'Go to my home',shortcut:'alt+h',icon:'grid',run:()=>app.home()},
    {id:'shell:refresh',label:'Refresh this page',shortcut:'alt+r',icon:'clock',run:()=>app.refresh()},
    ...[...registry.commands.entries()].filter(([,item])=>(!item.page||visible.has(item.page))&&(!item.roles||item.roles.includes(app.user.role))&&(!item.when||item.when(app))).map(([id,item])=>({id,...item,run:()=>item.run(app)})),
  ]
  const run=async command=>{setOpen(false);setSearch('');try{await command.run()}catch(error){app.notify(error.message,'error')}}
  useEffect(()=>{
    const listener=event=>{
      if(event.defaultPrevented||event.repeat)return
      const dialog=document.querySelector('[role="dialog"]')
      if(matchesShortcut(event,'mod+k')){if(!dialog||open){event.preventDefault();setOpen(value=>!value);setSearch('')}return}
      if(dialog||event.target.closest?.('input,textarea,select,[contenteditable="true"]'))return
      const command=commands.find(item=>item.shortcut&&matchesShortcut(event,item.shortcut))
      if(command){event.preventDefault();run(command)}
    }
    document.addEventListener('keydown',listener);return()=>document.removeEventListener('keydown',listener)
  })
  const filtered=commands.filter(item=>(item.label+' '+(item.description||'')+' '+(item.keywords||'')).toLowerCase().includes(search.toLowerCase()))
  const link=location.origin+location.pathname+routeHash(current?.id,app.context,contribution)
  return <><button className="icon-button shell-command-toggle" title="Find a page or action (Ctrl / Cmd + K)" aria-label="Find a page or action" onClick={()=>{setOpen(true);setSearch('')}}><Icon name="search"/></button><button className="icon-button shell-share-toggle" title="Share this page" aria-label="Share this page" onClick={()=>{setError('');setShare(true)}}><Icon name="link"/></button>
    {open&&<Modal title="Find a page or action" description="Search the tools available to your account. Ctrl / Cmd + K opens this menu." onClose={()=>setOpen(false)}><Field label="Search pages and actions"><input autoFocus value={search} onChange={event=>setSearch(event.target.value)} placeholder="Try orders, review, settings…"/></Field><div className="shell-command-list">{filtered.length?filtered.map(command=><button key={command.id} onClick={()=>run(command)}><Icon name={command.icon||'arrow'}/><span><strong>{command.label}</strong>{command.description&&<small>{command.description}</small>}</span>{command.shortcut&&<kbd>{command.shortcut.replace('mod','⌘ / Ctrl')}</kbd>}</button>):<Empty title="No matching tools">Try a shorter name. Only tools available to this account are listed.</Empty>}</div></Modal>}
    {share&&<Modal title="Share this page" description={current?.label} onClose={()=>setShare(false)}><p>The recipient must sign in with their own account and already have access to this work. Sharing a link does not invite someone or grant permission. A private draft remains private.</p>{contribution?.shareNote&&<p className="shell-link-note">{contribution.shareNote}</p>}<Field label="Page link" hint="Only identifiers declared by this page are included. Unsaved form contents are not shared."><input readOnly value={link} onFocus={event=>event.target.select()}/></Field>{error&&<p role="status">{error}</p>}<div className="form-actions"><Button variant="secondary" onClick={()=>setShare(false)}>Close</Button><Button onClick={async()=>{try{await navigator.clipboard.writeText(link);app.notify('Page link copied.')}catch{setError('Select the page link above and copy it using your browser.')}}}>Copy link</Button></div></Modal>}
  </>
}
