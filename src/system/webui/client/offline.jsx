import React,{useEffect,useState} from 'react'
import {useApp,Button,Icon,ErrorNotice} from './core.jsx'
import './offline.css'
const prefix='/quotagent/',family='quotagent-shell:'+prefix+':',preference='quotagent:offline-shell:'+prefix
const enabled=()=>{try{return localStorage.getItem(preference)==='enabled'}catch{return false}}
const announce=()=>window.dispatchEvent(new Event('quotagent:offline-shell'))
async function removeShell(){
 if('serviceWorker' in navigator)for(const registration of await navigator.serviceWorker.getRegistrations())if(registration.scope===location.origin+prefix)await registration.unregister()
 if('caches' in window)for(const key of await caches.keys())if(key.startsWith(family))await caches.delete(key)
}
function publish(state){window.dispatchEvent(new CustomEvent('quotagent:offline-status',{detail:state}))}
export function OfflineShell(){
 const [active,setActive]=useState(enabled),[connection,setConnection]=useState({offline:!navigator.onLine||window.__QUOTAGENT_OFFLINE_SHELL__===true,failed:false,lastGood:null})
 useEffect(()=>{const update=()=>setActive(enabled());window.addEventListener('quotagent:offline-shell',update);window.addEventListener('storage',update);return()=>{window.removeEventListener('quotagent:offline-shell',update);window.removeEventListener('storage',update)}},[])
 useEffect(()=>{let disposed=false
  if(active){if(!('serviceWorker' in navigator)){publish({state:'unavailable',message:'This browser does not support an offline application shell.'});return}
   navigator.serviceWorker.register(prefix+'sw.js',{scope:prefix,updateViaCache:'none'}).then(async registration=>{if(disposed||!enabled()){await registration.unregister();await removeShell();return null}return navigator.serviceWorker.ready}).then(registration=>{if(registration&&!disposed)publish({state:'ready',message:'The application shell is available on this device.'})}).catch(error=>{if(!disposed)publish({state:'error',message:'The offline shell could not be enabled: '+error.message})})
  }else void removeShell().then(()=>{if(!disposed)publish({state:'off',message:'The offline shell is not stored on this device.'})})
  return()=>{disposed=true}
 },[active])
 useEffect(()=>{
  const online=()=>setConnection(old=>({...old,offline:false})),offline=()=>setConnection(old=>({...old,offline:true})),contact=event=>setConnection(old=>({...old,offline:!navigator.onLine||(!event.detail.ok&&old.offline),failed:!event.detail.ok,lastGood:event.detail.ok?new Date().toISOString():old.lastGood}))
  window.addEventListener('online',online);window.addEventListener('offline',offline);window.addEventListener('quotagent:contact',contact)
  return()=>{window.removeEventListener('online',online);window.removeEventListener('offline',offline);window.removeEventListener('quotagent:contact',contact)}
 },[])
 if(!connection.offline&&!connection.failed)return null
 return <aside className="connection-warning" role="status" data-offline={connection.offline?'true':'false'}><Icon name="clock"/><div><strong>{connection.offline?'You are offline.':'The application cannot be reached.'}</strong><p>Work already on this page may be out of date. Actions need a connection and are never queued for later.{connection.lastGood&&<> Last successful contact: {new Date(connection.lastGood).toLocaleString()}.</>}</p></div><Button variant="secondary" onClick={()=>location.reload()}>Reconnect</Button></aside>
}
export function OfflineSettings(){
 const app=useApp(),[active,setActive]=useState(enabled),[state,setState]=useState({state:enabled()?'checking':'off'}),[busy,setBusy]=useState(false),[install,setInstall]=useState(null),[error,setError]=useState('')
 useEffect(()=>{const status=event=>setState(event.detail),prompt=event=>{event.preventDefault();setInstall(event)};window.addEventListener('quotagent:offline-status',status);window.addEventListener('beforeinstallprompt',prompt);if(active&&'serviceWorker' in navigator)navigator.serviceWorker.getRegistration(prefix).then(registration=>{if(registration?.active)setState({state:'ready'})});return()=>{window.removeEventListener('quotagent:offline-status',status);window.removeEventListener('beforeinstallprompt',prompt)}},[])
 async function toggle(){setBusy(true);setError('');try{if(active){localStorage.removeItem(preference);await removeShell();setState({state:'off'});app.notify('Offline shell removed from this device.')}else{localStorage.setItem(preference,'enabled');setState({state:'checking'})}setActive(!active);announce()}catch(error){setError(error.message)}finally{setBusy(false)}}
 return <section className="card section-space offline-settings"><div><h2>Use Quotagent as an app</h2><p>Keep just the interface on this device. Your account, files and business records still need a connection.</p></div><p role="status">{state.message||(state.state==='ready'?'Offline shell ready on this device.':state.state==='checking'?'Preparing the offline shell…':'Offline shell is not stored on this device.')}</p><ErrorNotice error={error}/><div className="row-actions"><Button variant="secondary" busy={busy} onClick={toggle}>{active?'Remove offline shell':'Enable offline shell'}</Button>{install&&<Button onClick={async()=>{await install.prompt();await install.userChoice;setInstall(null)}}>Install app</Button>}</div><p className="muted">{matchMedia('(display-mode: standalone)').matches?'Running in an application window.':'To install, use your browser’s “Install app” or “Add to Home Screen” menu when available.'} This preference applies to this browser. Removing the shell clears its cache; remove an installed app separately through your device.</p></section>
}
