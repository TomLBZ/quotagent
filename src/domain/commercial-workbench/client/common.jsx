import React from 'react'
import { Field, money } from '../../../system/webui/client/core.jsx'
const localTime = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString()
export const stamp = () => localTime().slice(0, 16)
export const today = () => localTime().slice(0, 10)
export const amount = (value, currency) => value === null || value === undefined ? 'Unknown' : money(value, currency)
export function Input({ label, value, onChange, type = 'text', ...props }) { return <Field label={label}><input aria-label={label} type={type} value={value ?? ''} onChange={e => onChange(e.target.value)} {...props}/></Field> }
export function Select({ label, value, onChange, children, ...props }) { return <Field label={label}><select aria-label={label} value={value ?? ''} onChange={e => onChange(e.target.value)} {...props}>{children}</select></Field> }
export function Source({ refs, label = 'Inspect sources and calculation', value }) { return <details className="cw-source"><summary>{label}</summary>{refs?.map((ref, i) => <p key={i}><strong>Ledger #{ref.seq}</strong> · {ref.collection}/{ref.recordId}{ref.path ? ` · ${ref.path}` : ''}<small>{ref.hash}</small></p>)}{value !== undefined && <pre>{JSON.stringify(value, null, 2)}</pre>}</details> }
export function SubmitForm({ children, onSubmit, ...props }) { return <form {...props} onSubmit={e => { e.preventDefault(); Promise.resolve(onSubmit()).catch(() => {}) }}>{children}</form> }
export function Table({ headers, children }) { return <div className="table-scroll"><table><thead><tr>{headers.map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div> }
export function Download({ kind, id, children }) { return <a className="button button-secondary" href={`api/commercial/export?kind=${encodeURIComponent(kind)}${id ? `&id=${encodeURIComponent(id)}` : ''}`} download>{children}</a> }
