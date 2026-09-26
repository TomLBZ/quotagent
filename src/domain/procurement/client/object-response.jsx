import React from 'react'
import {registry,useApp} from '../../../system/webui/client/core.jsx'
/** Response plugin owns disclosed reading, tracking and printable documents. */
export function ObjectResponse(props){const app=useApp(),Component=registry.slots.get('object-response');return Component&&app.bootstrap.navigation.some(row=>row.id==='responses')?<Component {...props}/>:null}
