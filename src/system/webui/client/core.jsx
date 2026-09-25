import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

export const registry = {
  pages: new Map(), slots: new Map(), slotOptions: new Map(),
  page(id, contribution) { this.pages.set(id, contribution); return () => this.pages.delete(id) },
  slot(id, component, options = {}) { this.slots.set(id, component); this.slotOptions.set(id, options); return () => {this.slots.delete(id);this.slotOptions.delete(id)} },
}
const AppContext = createContext(null)
export const useApp = () => useContext(AppContext)
export async function api(path, options = {}) {
  const response = await fetch(`/quotagent/api${path}`, { credentials: 'same-origin', ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) })
  const text = await response.text()
  let result
  try { result = text ? JSON.parse(text) : {} } catch { result = { error: text || 'The server returned an unreadable response.' } }
  if (!response.ok || result.ok === false) {
    const error = new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || result.reason || `Request failed (${response.status})`)
    error.status = response.status; throw error
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
  const resourceKey = `${app.user?.id || ''}:${path}`
  const reload = useCallback(async () => {
    const id = ++fetchId.current
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
export function Field({ label, hint, children, className = '' }) { return <label className={`field ${className}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label> }
export function Modal({ title, description, children, onClose, wide = false }) {
  const dialog = useRef(null)
  useEffect(() => {
    const before = document.activeElement
    dialog.current?.focus()
    const key = e => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Tab') {
        const focusable = [...dialog.current.querySelectorAll('button:not([disabled]),input:not([disabled]),select,textarea,a[href],[tabindex="0"]')]
        const first = focusable[0], last = focusable.at(-1)
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); before?.focus() }
  }, [])
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><section className={`modal ${wide ? 'modal-wide' : ''}`} ref={dialog} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}><div className="modal-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close"/></button></div>{children}</section></div>
}
export const money = (value, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value) || 0)
export const date = value => value ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'No deadline'
export const initials = text => String(text || '?').split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase()
export function Brand({ light = false }) { return <div className={`brand ${light ? 'brand-light' : ''}`}><span className="brand-mark"><svg viewBox="0 0 30 30" width="25" height="25" fill="none"><path d="M7 8h7v9H7zM17 8h7v9h-7z" fill="currentColor"/><path d="M14 17c0 5-4 7-7 7M24 17c0 5-4 7-7 7" stroke="currentColor" strokeWidth="3"/></svg></span><span>quotagent<span className="brand-dot">.</span></span></div> }

function App() {
  const [bootstrap, setBootstrap] = useState(null), [failure, setFailure] = useState('')
  const [version, setVersion] = useState(0), [page, setPage] = useState(location.hash.slice(1).split('/')[0] || 'workspace')
  const [context, setContext] = useState({}), [toast, setToast] = useState(null)
  const [menu, setMenu] = useState(false), [assistantOpen, setAssistantOpen] = useState(false), [assistantPrompt, setAssistantPrompt] = useState(null)
  const toastTimer = useRef()
  const refresh = useCallback(() => setVersion(v => v + 1), [])
  const refreshSession = useCallback(async () => { try { setBootstrap(await api('/bootstrap')); setFailure('') } catch(e) { setFailure(e.message) } }, [])
  useEffect(() => { refreshSession() }, [refreshSession, version])
  useEffect(() => {
    const sync = () => { if (document.visibilityState !== 'hidden') refresh() }
    const seconds=Math.max(3,Math.min(120,Number(bootstrap?.ui?.refreshSeconds) || 8))
    const timer = setInterval(sync, seconds * 1000)
    window.addEventListener('focus', sync)
    return () => { clearInterval(timer); window.removeEventListener('focus', sync) }
  }, [refresh, bootstrap?.ui?.refreshSeconds])
  useEffect(() => { const handler = () => { setPage(location.hash.slice(1).split('/')[0] || 'workspace'); setMenu(false) }; window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler) }, [])
  const notify = useCallback((message, type = 'success') => { clearTimeout(toastTimer.current); setToast({ message, type }); toastTimer.current = setTimeout(() => setToast(null), 6000) }, [])
  const navigate = useCallback((id, nextContext = {}) => { setContext(nextContext); setPage(id); location.hash = id; setMenu(false) }, [])
  const ask = useCallback((text = '', rfqId, send = true) => { setAssistantPrompt({ text, rfqId, send, at: Date.now() }); setAssistantOpen(true) }, [])
  const app = { user: bootstrap?.user, bootstrap, version, refresh, refreshSession, page, navigate, context, setContext, notify, ask, assistantPrompt, assistantOpen, setAssistantOpen }
  const user = bootstrap?.user
  const items = (bootstrap?.navigation || []).filter(item => registry.pages.has(item.id) && (!item.roles || item.roles.includes(user?.role))).sort((a,b) => (a.order || 0) - (b.order || 0))
  const current = items.find(item => item.id === page) || items[0]
  const Component = current && registry.pages.get(current.id)?.component
  const Login = registry.slots.get('login'), Assistant = registry.slots.get('assistant')
  const extensions = bootstrap?.extensions?.plugins || bootstrap?.extensions || []
  const extensionList = Array.isArray(extensions) ? extensions : []
  const theme = [...extensionList].reverse().find(p => p.enabled && p.kind === 'theme')?.spec
  const themeStyle = theme ? { '--accent': theme.accent, '--canvas': theme.background, '--surface': theme.surface, '--ink': theme.text, '--radius': typeof theme.radius === 'number' ? `${theme.radius}px` : theme.radius } : {}
  return <AppContext.Provider value={app}><div className="product" style={themeStyle}>
    {!bootstrap ? <div className="startup"><Brand/><ErrorNotice error={failure} retry={refreshSession}/>{!failure && <Loading/>}</div> : !user ? Login ? <Login/> : <Empty title="Welcome">The account plugin is not available.</Empty> : <>
      {menu && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMenu(false)}/>}
      <aside className={`sidebar ${menu ? 'sidebar-open' : ''}`}><a className="brand-link" href="#workspace" onClick={() => navigate(items[0]?.id || 'workspace')}><Brand/></a><div className="workspace-label"><span className="workspace-avatar">{initials(user.company)}</span><div><strong>{user.company || 'My workspace'}</strong><span>{user.role === 'admin' ? 'Administration' : `${user.role[0].toUpperCase()}${user.role.slice(1)} workspace`}</span></div></div><div className="nav-section-label">WORKSPACE</div><nav aria-label="Main navigation">{items.filter(item => !['settings','admin'].includes(item.id)).map(item => <button key={item.id} className={`nav-item ${current?.id === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)}><Icon name={registry.pages.get(item.id)?.icon || item.icon}/><span>{item.label}</span>{current?.id === item.id && <span className="nav-active-dot"/>}</button>)}</nav><div className="sidebar-bottom"><div className="sidebar-help"><span className="small-spark"><Icon name="spark" size={17}/></span><strong>Make it your own</strong><p>Tell your agent what would make work easier.</p><button onClick={() => ask('Help me create a useful personal plugin for my workspace.')}>Build with your agent <Icon name="arrow" size={15}/></button></div>{items.filter(item => ['settings','admin'].includes(item.id)).map(item => <button key={item.id} className={`nav-item ${current?.id === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)}><Icon name={item.icon || 'settings'}/>{item.label}</button>)}<div className="profile"><span className="avatar">{initials(user.name)}</span><div><strong>{user.name}</strong><span>{user.email}</span></div><button className="icon-button" title="Sign out" aria-label="Sign out" onClick={async () => { await api('/auth/logout', {method:'POST'}); setContext({}); refresh(); navigate('workspace') }}><Icon name="logout" size={17}/></button></div></div></aside>
      <div className="workspace-main"><header className="topbar"><div className="topbar-location"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMenu(true)}><Icon name="menu"/></button><span className="breadcrumb-root">Workspace</span><Icon name="chevron" size={13}/><strong>{current?.label || 'Overview'}</strong></div><div className="topbar-right">{[...registry.slots.entries()].filter(([id])=>id.startsWith('header:') && (!registry.slotOptions.get(id)?.navigation || items.some(item=>item.id===registry.slotOptions.get(id).navigation))).map(([id,Contribution])=><Contribution key={id}/>)}<span className="live-indicator"><span/> Connected to your workspace</span><button className="assistant-toggle" onClick={() => setAssistantOpen(v => !v)}><Icon name="spark" size={17}/> AI assistant</button><span className="avatar avatar-small">{initials(user.name)}</span></div></header><main id="main-content" className="main-content">{Component ? <Component/> : <Empty title="No pages available">This account has no registered workspace pages.</Empty>}{extensionList.filter(p => p.enabled && p.kind === 'widget').map(p => <section className="card extension-widget" key={p.id}><div className="section-heading"><h3>{p.spec?.title || p.name}</h3><Badge>Personal extension</Badge></div><p>{p.spec?.body}</p>{p.spec?.items?.length > 0 && <ul>{p.spec.items.map((item,i) => <li key={i}>{typeof item === 'string' ? item : JSON.stringify(item)}</li>)}</ul>}</section>)}</main></div>
      {Assistant && <aside className={`assistant-dock ${assistantOpen ? 'assistant-open' : ''}`} aria-label="AI assistant"><Assistant/></aside>}
    </>}{toast && <div className={`toast toast-${toast.type}`} role="status"><Icon name={toast.type === 'error' ? 'close' : 'check'} size={18}/>{toast.message}<button aria-label="Dismiss notification" onClick={() => setToast(null)}><Icon name="close" size={16}/></button></div>}
  </div></AppContext.Provider>
}
export function mountApp() { createRoot(document.getElementById('root')).render(<App/>) }
