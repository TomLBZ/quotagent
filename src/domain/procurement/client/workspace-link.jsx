import React,{useState} from 'react'
import {api,Button,ErrorNotice} from '../../../system/webui/client/core.jsx'
export function WorkspaceLink({workspaceId,onStay}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 return <section className="card"><h2>This link belongs to another party workspace</h2><p>Keep the requested record and switch workspaces explicitly. Your active team membership is checked before any linked record is shown. A shared link does not grant access.</p><ErrorNotice error={error}/><div className="row-actions"><Button variant="secondary" onClick={onStay}>Stay in current workspace</Button><Button busy={busy} onClick={async()=>{setBusy(true);setError('');try{await api('/teams/select',{method:'POST',body:{ownerId:workspaceId}});window.location.reload()}catch(error){setError(error.message);setBusy(false)}}}>Switch to linked workspace</Button></div></section>
}
