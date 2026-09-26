import React, { useState, useEffect, useRef } from 'react'
import { registry, useApp, useResource, api, Icon, Button, Badge, Modal, Field, ErrorNotice, PageHeader } from '../../webui/client/core.jsx'
import './assistant.css'

function RichText({text}) {
  const lines = String(text || '').split(/\n/), output = []
  const inline = value => value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part,i) => part.startsWith('**') ? <strong key={i}>{part.slice(2,-2)}</strong> : part.startsWith('`') ? <code key={i}>{part.slice(1,-1)}</code> : part)
  const cells = line => line.trim().replace(/^\||\|$/g,'').split('|').map(cell => cell.trim())
  for (let i=0; i<lines.length; i++) {
    const line = lines[i]
    if (line.includes('|') && i+1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i+1]) && /^[\s|:\-]+$/.test(lines[i+1])) {
      const headings = cells(line), rows = []; i+=2
      while(i<lines.length && lines[i].includes('|') && lines[i].trim()) {rows.push(cells(lines[i]));i++}
      i--
      output.push(<div className="assistant-table" key={`table-${i}`}><table><thead><tr>{headings.map((heading,k) => <th key={k}>{inline(heading)}</th>)}</tr></thead><tbody>{rows.map((row,j) => <tr key={j}>{row.map((value,k) => <td key={k}>{inline(value)}</td>)}</tr>)}</tbody></table></div>)
      continue
    }
    const content = line.replace(/^#{1,4}\s*/,'').replace(/^[-*]\s/,'• ')
    if (/^---+$/.test(content)) {output.push(<hr key={i}/>);continue}
    output.push(<div key={i} className={/^#{1,4}\s/.test(line) ? 'assistant-text-heading' : !line.trim() ? 'text-spacer' : ''}>{inline(content)}</div>)
  }
  return <div className="assistant-rich-text">{output}</div>
}

function Assistant({expanded=false}) {
  const app=useApp(),resource=useResource('/assistant',{messages:[],run:null,preferences:{},provider:{available:false}})
  const [input,setInput]=useState(''),[pending,setPending]=useState(''),[error,setError]=useState(''),[review,setReview]=useState(null),[historyLimit,setHistoryLimit]=useState(30)
  const list=useRef(),textarea=useRef(),lastPrompt=useRef(0),activeRequest=useRef(false)
  const run=resource.data.run,active=run&&!['completed','stopped'].includes(run.status),busy=run?.status==='running',messages=resource.data.messages||[]
  useEffect(()=>{list.current?.scrollTo({top:list.current.scrollHeight,behavior:'smooth'})},[messages.at(-1)?.id,busy])
  useEffect(()=>{
    if(!active)return
    const timer=setInterval(()=>resource.reload(),1000)
    return()=>clearInterval(timer)
  },[active,resource.reload])
  async function send(text=input,rfqId=app.context.rfqId){
    if(!text.trim()||activeRequest.current)return
    activeRequest.current=true;setPending('send');setError('');setInput('')
    try{
      await api(active?'/assistant/control':'/assistant/chat',{method:'POST',body:active?{id:run.id,action:'steer',message:text}:{message:text,rfqId}})
      await resource.reload();app.refresh()
    }catch(e){setError(e.message);setInput(text)}finally{setPending('');activeRequest.current=false}
  }
  async function control(action){
    if(activeRequest.current)return
    activeRequest.current=true;setPending(action);setError('')
    try{await api('/assistant/control',{method:'POST',body:{id:run.id,action}});await resource.reload();app.refresh()}
    catch(e){setError(e.message)}finally{setPending('');activeRequest.current=false}
  }
  useEffect(()=>{
    const prompt=app.assistantPrompt
    if(!prompt||prompt.at===lastPrompt.current)return
    lastPrompt.current=prompt.at
    if(prompt.send&&prompt.text)send(prompt.text,prompt.rfqId)
    else{setInput(prompt.text||'');textarea.current?.focus()}
  },[app.assistantPrompt])
  async function actionClick(action){
    const name=action.action||action.type||action.name,args=action.input||action.args||action.payload||{}
    if(name==='navigate'){app.navigate(action.target||args.view||'workspace',args);app.setAssistantOpen(false);return}
    setReview({...action,action:name,input:{...args},label:action.label||action.title||'Review suggested action'})
  }
  const suggestions=app.user.role==='supplier'?[
    ['Read my RFQs','Summarize my open RFQs, identify missing scope details, and tell me which opportunity to work on first.'],
    ['Prepare a quote','Help me prepare a quotation for one of my incoming RFQs. Use my preferences and ask for any pricing information you need.'],
    ['Build a useful skill','Create a reusable workflow skill that reviews my open quotation deadlines and drafts follow-up messages for review.'],
  ]:app.user.role==='admin'?[
    ['Create a workspace theme','Create a personal UI theme with a calm ocean teal accent and a light warm background.'],
    ['Explore extensions','Help me create a useful workspace extension or reusable process automation skill.'],
  ]:[
    ['Turn a brief into an RFQ','Help me turn my project brief into a structured RFQ with line items. Ask me for the requirements to extract.'],
    ['Compare my offers','Compare my current quotations. Highlight price differences, lead times, terms, and specific trade-offs before I award.'],
    ['Draft a negotiation','Review my current offers and draft a specific supplier negotiation message for me to review.'],
  ]
  const actionCards=actions=>actions?.length>0&&<div className="assistant-action-cards">{actions.map((action,index)=><button key={index} onClick={()=>actionClick(action)}><span className="action-card-icon"><Icon name="file" size={17}/></span><span><strong>{action.label||action.title||'Review draft'}</strong><small>Ready for your review</small></span><Icon name="arrow" size={16}/></button>)}</div>
  return <>
    <div className="assistant-header"><div className="assistant-avatar"><Icon name="spark" size={21}/></div><div><h2>Your AI teammate</h2><span><i className={resource.data.provider?.available?'available':''}/>{resource.data.provider?.available?'Ready to work with you':resource.loading?'Connecting…':'Provider not connected'}</span></div>{!expanded&&<button className="icon-button assistant-close" aria-label="Close AI assistant" onClick={()=>app.setAssistantOpen(false)}><Icon name="close" size={18}/></button>}</div>
    {app.context.rfqId&&<div className="assistant-context"><Icon name="file" size={14}/><span>Working with your selected request</span><button aria-label="Clear request context" onClick={()=>app.setContext({})}><Icon name="close" size={12}/></button></div>}
    <div className="assistant-messages" ref={list}>
      {!messages.length?<div className="assistant-welcome"><div className="assistant-welcome-art"><Icon name="spark" size={30}/></div><h3>What can we move forward today?</h3><p>Give me an outcome or paste a brief. I can read the details, prepare drafts, and bring decisions back to you.</p><div className="assistant-prompts">{suggestions.map(([label,prompt])=><button key={label} disabled={!!pending||active} onClick={()=>send(prompt)}><span>{label}</span><Icon name="arrow" size={15}/></button>)}</div></div>:<>
      {messages.length>historyLimit&&<button className="text-button" onClick={()=>setHistoryLimit(n=>n+30)}>Show earlier messages</button>}
      {messages.slice(-historyLimit).map((message,i)=><article className={`assistant-message ${message.role==='user'?'from-user':'from-assistant'}`} key={message.id||i}><div className="assistant-message-label">{message.role==='user'?(message.steering?'YOUR GUIDANCE':'YOU'):<><Icon name="spark" size={13}/> QUOTAGENT</>}</div><RichText text={message.content}/>{message.tools?.length>0&&<details className="tool-details"><summary><Icon name="check" size={12}/> {message.tools.length} tool results</summary>{message.tools.map((tool,index)=><div key={index}><strong>{String(tool.name||tool.tool||'Workspace action').replace(/_/g,' ')}</strong><span>{String(tool.result?.message||tool.result?.summary||tool.result?.error||'Saved in your workspace')}</span></div>)}</details>}{actionCards(message.actions)}</article>)}
      </>}
      {busy&&<div className="assistant-thinking"><Icon name="spark" size={15}/><span>{run.phase==='tools'?'Working with your workspace':'Working through the details'}</span><span className="thinking-dots"><i/><i/><i/></span></div>}
      {active&&actionCards(run.actions)}
    </div>
    {active&&<section className="assistant-task" aria-label="Current assistant task"><div className="assistant-task-status"><Badge status={busy?'accent':'neutral'}>{pending==='pause'?'Pausing…':pending==='stop'?'Stopping…':run.status==='running'?'Working':run.status==='failed'?'Needs attention':'Paused'}</Badge><span>{run.results?.length||0} tool results saved</span></div><p>{run.notice||'You can pause or add guidance at any time.'}</p><div className="assistant-task-buttons">{busy?<Button variant="secondary" disabled={!!pending} onClick={()=>control('pause')}>Pause task</Button>:<Button disabled={!!pending} onClick={()=>control('resume')}>Resume task</Button>}<Button variant="ghost" disabled={!!pending} onClick={()=>control('stop')}>Stop task</Button></div></section>}
    <div className="assistant-composer"><ErrorNotice error={error||resource.error||run?.error}/><form onSubmit={e=>{e.preventDefault();send()}}><textarea ref={textarea} aria-label="Message your AI assistant" placeholder={active?'Add guidance or change direction…':'Ask anything, or paste a brief…'} rows={expanded?2:3} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}}}/><div className="composer-bottom"><span>{active?(busy?'Guidance updates the current task':'Guidance is saved until you resume'):'Shift + Enter for a new line'}</span><button type="submit" disabled={!!pending||!input.trim()} aria-label={active?'Send guidance to AI assistant':'Send to AI assistant'}><Icon name="arrow" size={17}/></button></div></form><p><Icon name="shield" size={12}/> You review and approve commitments.</p></div>
    {review&&<ReviewAction review={review} setReview={setReview}/>}
  </>
}
function AgentWorkspace(){
  const app=useApp(),available=id=>app.bootstrap.navigation.some(item=>item.id===id)
  return <div className="agent-home"><PageHeader eyebrow="YOUR AGENT WORKSPACE" title={app.user.role==='supplier'?'Prepare your next winning quote.':app.user.role==='admin'?'Make the workspace work better.':'Move your quotation work forward.'}>Describe the outcome. Your agent prepares the work and brings decisions back to you.</PageHeader><div className="agent-home-links">{[['approvals','Review actions','check'],['workroom','Delegate a larger task','users'],['ingestion','Bring in a document','file']].filter(([id])=>available(id)).map(([id,label,icon])=><Button key={id} variant="secondary" icon={icon} onClick={()=>app.navigate(id)}>{label}</Button>)}</div><section className="agent-main-conversation" aria-label="AI assistant"><Assistant expanded/></section></div>
}
function ReviewAction({review,setReview}) {
  const app = useApp(), [busy,setBusy] = useState(false), [error,setError] = useState('')
  const [input,setInput] = useState(review.input)
  const message = review.action === 'send-message'
  async function submit(e) {e.preventDefault();setBusy(true);setError('');try {await api(`/workspace/${review.action}`,{method:'POST',body:{...input,confirmed:true}});app.refresh();app.notify(message ? 'Message sent.' : 'Action completed.');setReview(null)}catch(e){setError(e.message)}finally{setBusy(false)}}
  return <Modal title={review.label} description={message ? 'Make this message your own, then choose when to send it.' : 'Review the details before approving this action.'} onClose={() => setReview(null)}><form onSubmit={submit}><ErrorNotice error={error}/>{message ? <Field label="Draft message"><textarea rows={8} required value={input.text || ''} onChange={e => setInput({...input,text:e.target.value})}/></Field> : <div className="commitment-review"><h3>{review.title || review.record?.title || 'Review this commitment'}</h3><p>{review.summary || 'Confirming applies this change and sends the update to the other party.'}</p>{review.record?.description && <p className="muted">{review.record.description}</p>}<div className="request-meta">{review.supplierName && <div><span>Supplier</span><strong>{review.supplierName}</strong></div>}{typeof review.amount === 'number' && <div><span>{review.action === 'approve-change' ? 'Price adjustment' : 'Total'}</span><strong>{new Intl.NumberFormat('en-US',{style:'currency',currency:review.currency || 'USD'}).format(review.amount)}</strong></div>}{review.record?.leadDays && <div><span>Lead time</span><strong>{review.record.leadDays} days</strong></div>}{review.record?.paymentTerms && <div><span>Payment terms</span><strong>{review.record.paymentTerms}</strong></div>}</div>{review.record?.items?.length > 0 && <div className="table-scroll"><table><thead><tr><th>Item</th><th>Quantity</th></tr></thead><tbody>{review.record.items.map((item,i) => <tr key={i}><td>{item.description}</td><td>{item.quantity} {item.unit}</td></tr>)}</tbody></table></div>}<div className="confirmation-note"><Icon name="check" size={18}/><p>You approve this action as <strong>{app.user.name}</strong>.</p></div></div>}<div className="form-actions"><Button variant="secondary" onClick={() => setReview(null)}>Keep draft</Button><Button type="submit" busy={busy} icon={message ? 'send' : 'check'}>{message ? 'Send message' : 'Approve & continue'}</Button></div></form></Modal>
}
registry.slot('assistant', Assistant)

registry.page('agent',{component:AgentWorkspace,icon:'spark',assistantMode:'hidden'})
