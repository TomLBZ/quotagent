import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { readRoute, routeHash } from './routing.mjs'
import { WorkspaceNavigation } from './navigation.jsx'
import { OfflineShell, OfflineSettings } from './offline.jsx'
import './styles.css'

export const registry = {
  pages: new Map(), slots: new Map(), slotOptions: new Map(), commands: new Map(),
  command(id, contribution) { this.commands.set(id, contribution); return () => { if (this.commands.get(id) === contribution) this.commands.delete(id) } },
  page(id, contribution) { this.pages.set(id, contribution); return () => this.pages.delete(id) },
  slot(id, component, options = {}) { this.slots.set(id, component); this.slotOptions.set(id, options); return () => {this.slots.delete(id);this.slotOptions.delete(id)} },
}
registry.slot('account:offline-shell',OfflineSettings)
const AppContext = createContext(null)
export const useApp = () => useContext(AppContext)
export async function api(path, options = {}) {
  let response
  try { response = await fetch(`/quotagent/api${path}`, { credentials: 'same-origin', ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) }) } catch(cause) {window.dispatchEvent(new CustomEvent('quotagent:contact',{detail:{ok:false}}));throw new Error(navigator.onLine&&!window.__QUOTAGENT_OFFLINE_SHELL__?'Cannot reach the application. Check your connection and retry; this action was not queued.':'You are offline. Reconnect before saving or sending; this action was not queued.',{cause})}
  window.__QUOTAGENT_OFFLINE_SHELL__=false
  window.dispatchEvent(new CustomEvent('quotagent:contact',{detail:{ok:true}}))
  const text = await response.text()
  let result
  try { result = text ? JSON.parse(text) : {} } catch { result = { error: text || 'The server returned an unreadable response.' } }
  if (!response.ok || result.ok === false) {
    const error = new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || result.reason || `Request failed (${response.status})`)
    error.status = response.status; error.code=result.code; error.nextAction=result.nextAction; error.details=result.details; throw error
  }
  return result
}
export function useResource(path, initial = {}) {
  const app = useApp()
  const [data, setData] = useState(initial)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const fetchId = useRef(0), loadedKey = useRef(null), initialValue = useRef(initial)
  const resourceKey = `${app.user?.id || ''}:${app.user?.role || ''}:${app.user?.workspaceOwnerId || ''}:${path}`
  const reload = useCallback(async () => {
    const id = ++fetchId.current
    if (!path) { setData(initialValue.current); setLoading(false); setRefreshing(false); setError(''); return initialValue.current }
    // Loading replaces content only when opening a new resource/account. Background
    // refreshes keep the existing component tree, active input and unsaved forms.
    if (loadedKey.current !== resourceKey) setLoading(true)
    setRefreshing(true)
    try {
      const value = await api(path)
      if (fetchId.current === id) { loadedKey.current = resourceKey; setData(value); setError('') }
      return value
    } catch (e) { if (fetchId.current === id) setError(e.message) }
    finally { if (fetchId.current === id) { setLoading(false); setRefreshing(false) } }
  }, [path, resourceKey])
  useEffect(() => {
    if (loadedKey.current !== resourceKey) setData(initialValue.current)
    reload()
    return () => { fetchId.current++ }
  }, [reload, app.version, resourceKey])
  return { data, setData, loading, refreshing, error, reload }
}

const paths = {
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4',
  mail: 'M3 5h18v14H3z M3 5l9 7 9-7',
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5',
  quote: 'M5 3h14v18l-3-2-4 2-4-2-3 2z M8 8h8 M8 12h8',
  box: 'M21 8l-9 5-9-5 M12 13v9 M3 7l9-5 9 5v10l-9 5-9-5z M7 5l10 6',
  chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 3V11.5a8.5 8.5 0 0 1 8.5-8.5h3a8.5 8.5 0 0 1 8.5 8.5z M6 10h10 M6 14h6',
  spark: 'm12 2 2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6z',
  puzzle: 'M9 3H4v6a3 3 0 1 1 0 6v6h6a3 3 0 1 1 6 0h5v-6a3 3 0 1 1 0-6V3h-6a3 3 0 1 1-6 0z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 2h6l1 4 4 1 2 5-3 3v5l-5 2-3-3H6l-3-5 3-3V6z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M20 21v-2a4 4 0 0 0-3-4 M16 3a4 4 0 0 1 0 8',
  arrow: 'M5 12h14 M12 5l7 7-7 7', plus: 'M12 5v14 M5 12h14', check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12 M6 18 18 6', chevron: 'm9 5 7 7-7 7', send: 'm22 2-7 20-4-9-9-4z M22 2 11 13',
  download: 'M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5', clock: 'M12 8v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  logout: 'M9 3H4v18h5 M10 12h12 m-5-5 5 5-5 5', menu: 'M3 6h18 M3 12h18 M3 18h18',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', shield: 'm12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6z',
  sun: 'M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2 M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
}
export function Icon({ name = 'grid', size = 20, ...props }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name] || paths.grid}/></svg> }
export function Button({ children, icon, variant = 'primary', type = 'button', busy, className = '', ...props }) {
  return <button className={`button button-${variant} ${className}`} type={type} {...props} disabled={props.disabled || busy}>{busy ? <span className="spinner"/> : icon ? <Icon name={icon} size={17}/> : null}{children}</button>
}
export const Badge = ({ children, status = 'neutral' }) => <span className={`badge badge-${status}`}>{children}</span>
export function Empty({ icon = 'file', title, children, action }) { return <div className="empty"><span className="empty-icon"><Icon name={icon} size={26}/></span><h3>{title}</h3><p>{children}</p>{action}</div> }
export function Loading() { return <div className="loading"><span className="spinner"/> Getting your workspace ready…</div> }
export function ErrorNotice({ error, retry }) { if (!error) return null; return <div className="error-notice" role="alert">{error}{retry && <button onClick={retry}>Try again</button>}</div> }
export function PageHeader({ eyebrow, title, children, actions }) { return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{children && <p>{children}</p>}</div><div className="heading-actions">{actions}</div></div> }
export function Field({ label, hint, children, className = '' }) {
  const controls=React.Children.map(children,child=>React.isValidElement(child)&&['input','select','textarea'].includes(child.type)&&typeof label==='string'&&!child.props['aria-label']&&!child.props['aria-labelledby']?React.cloneElement(child,{'aria-label':label}):child)
  return <label className={`field ${className}`}><span>{label}</span>{controls}{hint && <small>{hint}</small>}</label>
}
const modalLayers=[],originalInert=new Map()
function syncModalLayers(){
  const top=modalLayers.at(-1)
  if(!top){for(const [node,inert] of originalInert)node.inert=inert;originalInert.clear();return}
  for(const node of document.body.children){if(!originalInert.has(node))originalInert.set(node,node.inert);node.inert=node!==top}
}
export function Modal({ title, description, children, onClose, wide = false }) {
  const dialog=useRef(null),close=useRef(onClose),[host]=useState(()=>document.createElement('div'))
  close.current=onClose
  useEffect(()=>{
    const before=document.activeElement
    host.className='dialog-portal';document.body.appendChild(host);modalLayers.push(host);syncModalLayers()
    const focusable=()=>[...dialog.current.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]')].filter(node=>node.getClientRects().length&&!node.closest('[hidden],[inert]'))
    ;(dialog.current.querySelector('input:not([readonly]):not([disabled]),textarea:not([disabled]),select:not([disabled])')||focusable()[0]||dialog.current).focus()
    const key=event=>{
      if(modalLayers.at(-1)!==host)return
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close.current()}
      if(event.key==='Tab'){
        const nodes=focusable(),first=nodes[0],last=nodes.at(-1)
        if(!nodes.length){event.preventDefault();dialog.current.focus()}
        else if(event.shiftKey&&(document.activeElement===first||!nodes.includes(document.activeElement))){event.preventDefault();last.focus()}
        else if(!event.shiftKey&&(document.activeElement===last||!nodes.includes(document.activeElement))){event.preventDefault();first.focus()}
      }
    }
    document.addEventListener('keydown',key)
    return()=>{document.removeEventListener('keydown',key);const i=modalLayers.indexOf(host);if(i>=0)modalLayers.splice(i,1);host.remove();syncModalLayers();if(before?.isConnected&&!before.closest('[inert]'))before.focus()}
  },[host])
  return createPortal(<div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&modalLayers.at(-1)===host)close.current()}}><section className={`modal ${wide?'modal-wide':''}`} ref={dialog} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}><div className="modal-heading"><div><h2>{title}</h2>{description&&<p>{description}</p>}</div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close"/></button></div>{children}</section></div>,host)
}

export const money = (value, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value) || 0)
export const date = value => value ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'No deadline'
export const initials = text => String(text || '?').split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase()
export function Brand({ light = false }) { return <div className={`brand ${light ? 'brand-light' : ''}`}><span className="brand-mark"><svg viewBox="0 0 30 30" width="25" height="25" fill="none"><path d="M7 8h7v9H7zM17 8h7v9h-7z" fill="currentColor"/><path d="M14 17c0 5-4 7-7 7M24 17c0 5-4 7-7 7" stroke="currentColor" strokeWidth="3"/></svg></span><span>quotagent<span className="brand-dot">.</span></span></div> }

function App() {
  const [bootstrap, setBootstrap] = useState(null), [failure, setFailure] = useState('')
  const [version, setVersion] = useState(0), [page, setPage] = useState(()=>readRoute(location.hash,registry.pages).page)
  const [context, saveContext] = useState(()=>readRoute(location.hash,registry.pages).context), [toast, setToast] = useState(null)
  const [menu, setMenu] = useState(false), [assistantOpen, setAssistantOpen] = useState(false), [assistantPrompt, setAssistantPrompt] = useState(null)
  const [presentations,setPresentations] = useState([])
  const toastTimer = useRef(), user = bootstrap?.user, identity=useRef(null), route=useRef({page,context}),currentRoute=useRef(page)
  route.current={page,context}
  const refresh = useCallback(() => setVersion(v => v + 1), [])
  const refreshSession = useCallback(async () => { try { const value=await api('/bootstrap');setBootstrap(value);setFailure('');return value } catch(e) { setFailure(e.message) } }, [])
  useEffect(() => { refreshSession() }, [refreshSession, version])
  useEffect(() => {
    const sync = () => { if (document.visibilityState !== 'hidden') refresh() }
    const seconds=Math.max(3,Math.min(120,Number(bootstrap?.ui?.refreshSeconds) || 8))
    const timer=setInterval(sync,seconds*1000);window.addEventListener('focus',sync)
    return () => {clearInterval(timer);window.removeEventListener('focus',sync)}
  },[refresh,bootstrap?.ui?.refreshSeconds])
  useEffect(() => {const handler=()=>{const next=readRoute(location.hash,registry.pages);setPage(next.page);saveContext(next.context);setMenu(false)};window.addEventListener('hashchange',handler);window.addEventListener('popstate',handler);return()=>{window.removeEventListener('hashchange',handler);window.removeEventListener('popstate',handler)}},[])
  useEffect(()=>()=>clearTimeout(toastTimer.current),[])
  useEffect(()=>{const next=user?user.id+':'+user.role:null;if(identity.current&&identity.current!==next){setAssistantOpen(false);setAssistantPrompt(null);saveContext({});setPage('');history.replaceState(null,'',location.pathname+location.search)}identity.current=next},[user?.id,user?.role])
  const notify=useCallback((message,type='success')=>{clearTimeout(toastTimer.current);setToast({message,type});toastTimer.current=setTimeout(()=>setToast(null),6000)},[])
  const navigate=useCallback((id,nextContext={})=>{saveContext(nextContext);setPage(id);history.pushState(null,'',routeHash(id,nextContext,registry.pages.get(id)));setMenu(false)},[])
  const setContext=useCallback(value=>{const next=typeof value==='function'?value(route.current.context):value;saveContext(next);history.replaceState(null,'',routeHash(currentRoute.current,next,registry.pages.get(currentRoute.current)))},[])
  const home=useCallback(()=>{saveContext({});setPage('');history.pushState(null,'',location.pathname+location.search);setMenu(false);setAssistantOpen(false)},[])
  const ask=useCallback((text='',rfqId,send=true)=>{setAssistantPrompt({text,rfqId,send,at:Date.now()});setAssistantOpen(true)},[])
  const registerPresentation=useCallback((ownerId,value)=>{
    const token=Symbol(ownerId),entry={ownerId,token,value,accountId:user?.id}
    setPresentations(old=>[...old.filter(item=>item.ownerId!==ownerId),entry])
    return()=>setPresentations(old=>old.filter(item=>item.token!==token))
  },[user?.id])
  const presentation=Object.assign({},...presentations.filter(item=>item.accountId===user?.id).map(item=>item.value))
  const items=(bootstrap?.navigation||[]).filter(item=>registry.pages.has(item.id)&&(!item.roles||item.roles.includes(user?.role))).sort((a,b)=>(a.order||0)-(b.order||0))
  const current=items.find(item=>item.id===(page||presentation.landingPage))||(!page?items[0]:undefined)
  currentRoute.current=current?.id||page
  const contribution=current&&registry.pages.get(current.id),Component=contribution?.component
  const mode=contribution?.assistantMode||presentation.assistantMode||'on-demand'
  const app={user,bootstrap,version,refresh,refreshSession,page:current?.id,navigate,home,context,setContext,notify,ask,assistantPrompt,assistantOpen,setAssistantOpen,registerPresentation}
  const visible=id=>!registry.slotOptions.get(id)?.navigation||items.some(item=>item.id===registry.slotOptions.get(id).navigation)
  const slots=prefix=>[...registry.slots.entries()].filter(([id])=>id.startsWith(prefix)&&visible(id))
  const Login=registry.slots.get('login'),Assistant=registry.slots.get('assistant')
  const Navigation=visible('shell:navigation')&&registry.slots.get('shell:navigation')
  const extensions=bootstrap?.extensions?.plugins||bootstrap?.extensions||[],extensionList=Array.isArray(extensions)?extensions:[]
  const theme=[...extensionList].reverse().find(p=>p.enabled&&p.kind==='theme')?.spec
  const themeStyle=theme?{'--accent':theme.accent,'--canvas':theme.background,'--surface':theme.surface,'--ink':theme.text,'--radius':typeof theme.radius==='number'?`${theme.radius}px`:theme.radius}:{}
  return <AppContext.Provider value={app}><OfflineShell/><a className="skip-link" href="#main-content" onClick={event=>{event.preventDefault();document.getElementById('main-content')?.focus()}}>Skip to main content</a><div className={`product assistant-mode-${mode} layout-${presentation.layout||'default'} density-${presentation.density||'comfortable'} ${presentation.className||''}`} style={{...presentation.variables,...themeStyle}}>
    {!bootstrap?<div className="startup"><Brand/><ErrorNotice error={failure} retry={refreshSession}/>{!failure&&<Loading/>}</div>:!user?Login?<Login/>:<Empty title="Welcome">The account plugin is not available.</Empty>:<>
      {slots('shell:effect:').map(([id,Effect])=><Effect key={`${user.id}:${id}`}/>)}
      {menu&&<button className="sidebar-scrim" aria-label="Close navigation" onClick={()=>setMenu(false)}/>}
      <aside className={`sidebar ${menu?'sidebar-open':''}`}>
        <a className="brand-link" href="#" onClick={e=>{e.preventDefault();home()}}><Brand/></a>
        <div className="workspace-label"><span className="workspace-avatar">{initials(user.company)}</span><div><strong>{user.company||'My workspace'}</strong><span>{user.role==='admin'?'Administration':`${user.role[0].toUpperCase()}${user.role.slice(1)} workspace`}</span></div></div>
        {Navigation?<Navigation items={items} currentId={current?.id} navigate={navigate}/>:<nav aria-label="Main navigation">{items.map(item=><button key={item.id} className={`nav-item ${current?.id===item.id?'active':''}`} aria-current={current?.id===item.id?'page':undefined} onClick={()=>navigate(item.id)}><Icon name={registry.pages.get(item.id)?.icon||item.icon}/><span>{item.label}</span></button>)}</nav>}
        <div className="sidebar-bottom"><div className="profile"><span className="avatar">{initials(user.name)}</span><div><strong>{user.name}</strong><span>{user.email}</span></div><button className="icon-button" title="Sign out" aria-label="Sign out" onClick={async()=>{await api('/auth/logout',{method:'POST'});home();await refreshSession()}}><Icon name="logout" size={17}/></button></div></div>
      </aside>
      <div className="workspace-main"><header className="topbar"><div className="topbar-location"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={()=>setMenu(true)}><Icon name="menu"/></button><nav aria-label="Breadcrumb"><button className="breadcrumb-root" onClick={home}>Workspace</button><Icon name="chevron" size={13}/><strong aria-current="page">{current?.label||'Unavailable page'}</strong></nav></div><div className="topbar-right"><WorkspaceNavigation items={items} current={current} contribution={contribution}/>{slots('header:').map(([id,Contribution])=><Contribution key={id}/>)}{Assistant&&mode!=='hidden'&&<button className="assistant-toggle" onClick={()=>setAssistantOpen(v=>!v)}><Icon name="spark" size={17}/> AI assistant</button>}<span className="avatar avatar-small">{initials(user.name)}</span></div></header><main id="main-content" tabIndex={-1} className="main-content">{Component?<Component key={`${user.id}:${current.id}`}/>:<Empty title={page?"This page is unavailable":"No pages available"} action={<Button onClick={home}>Go to my home</Button>}>{page?"This page is not enabled for your current account. Sign in with the account that received the work, or ask its owner for access.":"This account has no registered workspace pages."}</Empty>}{extensionList.filter(p=>p.enabled&&p.kind==='widget').map(p=><section className="card extension-widget" key={p.id}><div className="section-heading"><h3>{p.spec?.title||p.name}</h3><Badge>Personal extension</Badge></div><p>{p.spec?.body}</p>{p.spec?.items?.length>0&&<ul>{p.spec.items.map((item,i)=><li key={i}>{typeof item==='string'?item:JSON.stringify(item)}</li>)}</ul>}</section>)}</main></div>
      {Assistant&&mode!=='hidden'&&(assistantOpen||mode==='persistent')&&<aside className={`assistant-dock ${assistantOpen?'assistant-open':''}`} aria-label="AI assistant"><Assistant key={user.id}/></aside>}
      {slots('shell:overlay:').map(([id,Overlay])=><Overlay key={`${user.id}:${id}`}/>)}
    </>}{toast&&<div className={`toast toast-${toast.type}`} role="status"><Icon name={toast.type==='error'?'close':'check'} size={18}/>{toast.message}<button aria-label="Dismiss notification" onClick={()=>setToast(null)}><Icon name="close" size={16}/></button></div>}
  </div></AppContext.Provider>
}
export function mountApp(){createRoot(document.getElementById('root')).render(<App/>)}
