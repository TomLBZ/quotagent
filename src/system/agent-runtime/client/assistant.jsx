import React, { useState, useEffect, useRef } from 'react'
import { registry, useApp, useResource, api, Icon, Button, Badge, Modal, Field, ErrorNotice } from '../../webui/client/core.jsx'

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

function Assistant() {
  const app = useApp(), resource = useResource('/assistant',{messages:[],preferences:{},provider:{available:false}})
  const [messages,setMessages] = useState([]), [input,setInput] = useState(''), [busy,setBusy] = useState(false), [error,setError] = useState(''), [review,setReview] = useState(null)
  const list = useRef(), textarea = useRef(), lastPrompt = useRef(0), activeRequest = useRef(false)
  useEffect(() => { if (!busy && resource.data.messages) setMessages(resource.data.messages) },[resource.data.messages,busy])
  useEffect(() => { list.current?.scrollTo({top:list.current.scrollHeight,behavior:'smooth'}) },[messages,busy])
  async function send(text = input, rfqId = app.context.rfqId) {
    if (!text.trim() || activeRequest.current) return
    activeRequest.current = true; setBusy(true); setError(''); setInput('')
    setMessages(old => [...old,{id:`local-${Date.now()}`,role:'user',content:text,createdAt:new Date().toISOString()}])
    try {
      const response = await api('/assistant/chat',{method:'POST',body:{message:text,rfqId}})
      const message = typeof response.message === 'string' ? {role:'assistant',content:response.message} : response.message
      setMessages(old => [...old,{...message,id:message.id || `reply-${Date.now()}`,actions:response.actions || message.actions || [],tools:response.toolResults || message.tools}])
      await resource.reload(); app.refresh()
    } catch(e) {setError(e.message); setInput(text)} finally {setBusy(false); activeRequest.current = false}
  }
  useEffect(() => {
    const prompt = app.assistantPrompt
    if (!prompt || prompt.at === lastPrompt.current) return
    lastPrompt.current = prompt.at
    if (prompt.send && prompt.text) send(prompt.text,prompt.rfqId)
    else {setInput(prompt.text || ''); textarea.current?.focus()}
  },[app.assistantPrompt])
  async function actionClick(action) {
    const name = action.action || action.type || action.name
    const args = action.input || action.args || action.payload || {}
    if (name === 'navigate') {app.navigate(action.target || args.view || 'workspace', args); app.setAssistantOpen(false); return}
    setReview({...action,action:name,input:{...args},label:action.label || action.title || 'Review suggested action'})
  }
  const suggestions = app.user.role === 'supplier' ? [
    ['Read my RFQs','Summarize my open RFQs, identify missing scope details, and tell me which opportunity to work on first.'],
    ['Prepare a quote','Help me prepare a quotation for one of my incoming RFQs. Use my preferences and ask for any pricing information you need.'],
    ['Build a useful skill','Create a reusable workflow skill that reviews my open quotation deadlines and drafts follow-up messages for review.'],
  ] : app.user.role === 'admin' ? [
    ['Create a workspace theme','Create a personal UI theme with a calm ocean teal accent and a light warm background.'],
    ['Explore extensions','Help me create a useful workspace extension or reusable process automation skill.'],
  ] : [
    ['Turn a brief into an RFQ','Help me turn my project brief into a structured RFQ with line items. Ask me for the requirements to extract.'],
    ['Compare my offers','Compare my current quotations. Highlight price differences, lead times, terms, and specific trade-offs before I award.'],
    ['Draft a negotiation','Review my current offers and draft a specific supplier negotiation message for me to review.'],
  ]
  return <><div className="assistant-header"><div className="assistant-avatar"><Icon name="spark" size={21}/></div><div><h2>Your AI teammate</h2><span><i className={resource.data.provider?.available ? 'available' : ''}/>{resource.data.provider?.available ? 'Ready to work with you' : resource.loading ? 'Connecting…' : 'Provider not connected'}</span></div><button className="icon-button assistant-close" aria-label="Close AI assistant" onClick={() => app.setAssistantOpen(false)}><Icon name="close" size={18}/></button></div><div className="assistant-context"><Icon name={app.context.rfqId ? 'file' : 'grid'} size={14}/><span>{app.context.rfqId ? 'Working with your selected request' : 'Connected to your workspace'}</span></div><div className="assistant-messages" ref={list}>{!messages.length ? <div className="assistant-welcome"><div className="assistant-welcome-art"><Icon name="spark" size={30}/></div><h3>What can we move<br/>forward today?</h3><p>I can read the details, prepare the groundwork, and help you decide what comes next.</p><div className="assistant-prompts">{suggestions.map(([label,prompt]) => <button key={label} disabled={busy} onClick={() => send(prompt)}><span>{label}</span><Icon name="arrow" size={15}/></button>)}</div><div className="assistant-capability"><span><Icon name="file" size={14}/> Understand your work</span><span><Icon name="puzzle" size={14}/> Build your own tools</span></div></div> : messages.map((message,i) => <article className={`assistant-message ${message.role === 'user' ? 'from-user' : 'from-assistant'}`} key={message.id || i}><div className="assistant-message-label">{message.role === 'user' ? 'YOU' : <><Icon name="spark" size={13}/> QUOTAGENT</>}</div><RichText text={message.content}/>{message.tools?.length > 0 && <details className="tool-details"><summary><Icon name="check" size={12}/> {message.tools.length} {message.tools.length === 1 ? 'step completed' : 'steps completed'}</summary>{message.tools.map((tool,index) => <div key={index}><strong>{String(tool.name || tool.tool || 'Workspace action').replace(/_/g,' ')}</strong><span>{tool.result?.message || tool.result?.summary || (tool.result?.error ? String(tool.result.error) : 'Using your account’s workspace context')}</span></div>)}</details>}{message.actions?.length > 0 && <div className="assistant-action-cards">{message.actions.map((action,index) => <button key={index} onClick={() => actionClick(action)}><span className="action-card-icon"><Icon name="file" size={17}/></span><span><strong>{action.label || action.title || 'Review draft'}</strong><small>Ready for your review</small></span><Icon name="arrow" size={16}/></button>)}</div>}</article>)}{busy && <div className="assistant-thinking"><Icon name="spark" size={15}/><span>Working through the details</span><span className="thinking-dots"><i/><i/><i/></span></div>}</div><div className="assistant-composer"><ErrorNotice error={error || resource.error}/>{app.context.rfqId && <div className="composer-context"><Icon name="file" size={13}/> Selected RFQ included<button aria-label="Clear request context" onClick={() => app.setContext({})}><Icon name="close" size={12}/></button></div>}<form onSubmit={e => {e.preventDefault();send()}}><textarea ref={textarea} aria-label="Message your AI assistant" placeholder="Ask anything, or paste a brief…" rows={3} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => {if(e.key === 'Enter' && !e.shiftKey){e.preventDefault();send()}}}/><div className="composer-bottom"><span>Shift + Enter for a new line</span><button type="submit" disabled={busy || !input.trim()} aria-label="Send to AI assistant"><Icon name="arrow" size={17}/></button></div></form><p><Icon name="shield" size={12}/> You review and approve commitments.</p></div>{review && <ReviewAction review={review} setReview={setReview}/>}</>
}
function ReviewAction({review,setReview}) {
  const app = useApp(), [busy,setBusy] = useState(false), [error,setError] = useState('')
  const [input,setInput] = useState(review.input)
  const message = review.action === 'send-message'
  async function submit(e) {e.preventDefault();setBusy(true);setError('');try {await api(`/workspace/${review.action}`,{method:'POST',body:{...input,confirmed:true}});app.refresh();app.notify(message ? 'Message sent.' : 'Action completed.');setReview(null)}catch(e){setError(e.message)}finally{setBusy(false)}}
  return <Modal title={review.label} description={message ? 'Make this message your own, then choose when to send it.' : 'Review the details before approving this action.'} onClose={() => setReview(null)}><form onSubmit={submit}><ErrorNotice error={error}/>{message ? <Field label="Draft message"><textarea rows={8} required value={input.text || ''} onChange={e => setInput({...input,text:e.target.value})}/></Field> : <div className="commitment-review"><h3>{review.title || review.record?.title || 'Review this commitment'}</h3><p>{review.summary || 'Confirming applies this change and sends the update to the other party.'}</p>{review.record?.description && <p className="muted">{review.record.description}</p>}<div className="request-meta">{review.supplierName && <div><span>Supplier</span><strong>{review.supplierName}</strong></div>}{typeof review.amount === 'number' && <div><span>{review.action === 'approve-change' ? 'Price adjustment' : 'Total'}</span><strong>{new Intl.NumberFormat('en-US',{style:'currency',currency:review.currency || 'USD'}).format(review.amount)}</strong></div>}{review.record?.leadDays && <div><span>Lead time</span><strong>{review.record.leadDays} days</strong></div>}{review.record?.paymentTerms && <div><span>Payment terms</span><strong>{review.record.paymentTerms}</strong></div>}</div>{review.record?.items?.length > 0 && <div className="table-scroll"><table><thead><tr><th>Item</th><th>Quantity</th></tr></thead><tbody>{review.record.items.map((item,i) => <tr key={i}><td>{item.description}</td><td>{item.quantity} {item.unit}</td></tr>)}</tbody></table></div>}<div className="confirmation-note"><Icon name="check" size={18}/><p>You approve this action as <strong>{app.user.name}</strong>.</p></div></div>}<div className="form-actions"><Button variant="secondary" onClick={() => setReview(null)}>Keep draft</Button><Button type="submit" busy={busy} icon={message ? 'send' : 'check'}>{message ? 'Send message' : 'Approve & continue'}</Button></div></form></Modal>
}
registry.slot('assistant', Assistant)
