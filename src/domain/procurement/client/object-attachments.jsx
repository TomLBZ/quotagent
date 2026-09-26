import React from 'react'
import {registry,useApp} from '../../../system/webui/client/core.jsx'

/** The file plugin owns storage, sharing and controls; procurement supplies context. */
export function ObjectAttachments(props) {
  const app=useApp(),Component=registry.slots.get('object-attachments')
  return Component && app.bootstrap.navigation.some(row=>row.id==='attachments')
    ? <Component {...props}/> : null
}
