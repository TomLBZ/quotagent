import React from 'react'
import {registry,useApp} from '../../../system/webui/client/core.jsx'
/** Assessment interactions belong to the optional advisor contribution. */
export function ObjectAdvisor(props){const app=useApp(),Component=registry.slots.get('object-advisor');return Component&&app.bootstrap.navigation.some(row=>row.id==='advisor')?<Component {...props}/>:null}
