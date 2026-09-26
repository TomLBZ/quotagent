import React, { useState } from 'react'
import { api, Button, ErrorNotice, Field, Modal } from '../../webui/client/core.jsx'

const display = value => value === null || value === undefined ? '—'
  : typeof value === 'object' ? JSON.stringify(value) : String(value)

/** Generic UI for any model-authored pure utility; no business formulas here. */
export function GeneratedTool({ plugin, onClose, endpoint = "/studio" }) {
  const fields = plugin.spec?.fields || []
  const [input, setInput] = useState(() => Object.fromEntries(fields.map(field => [field.name, field.default ?? ''])))
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function run(event) {
    event.preventDefault()
    setBusy(true); setError(''); setResult(null)
    try {
      const response = await api(`${endpoint}/${plugin.id}/run`, { method: 'POST', body: { input, expectedRevisionId: plugin.revisionId } })
      setResult(response.result)
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  const rows = Array.isArray(result?.rows) ? result.rows : []
  const details = result && typeof result === 'object' && !Array.isArray(result)
    ? Object.entries(result).filter(([key]) => !['summary', 'rows', 'error'].includes(key)) : []
  return <Modal title={plugin.spec?.title || plugin.name} description={plugin.description} onClose={onClose} wide>
    <form onSubmit={run}>
      <div className="form-grid">{fields.map(field => <Field key={field.name} label={field.label}>
        <input name={field.name} type={field.type === 'number' ? 'number' : 'text'}
          step={field.type === 'number' ? 'any' : undefined} required={field.type === 'number'}
          value={input[field.name]} onChange={event => setInput(values => ({ ...values, [field.name]: event.target.value }))}/>
      </Field>)}</div>
      <ErrorNotice error={error || result?.error}/>
      <div className="form-actions"><Button variant="secondary" onClick={onClose}>Close</Button>
        <Button type="submit" busy={busy} icon="arrow">Run tool</Button></div>
    </form>
    {result !== null && <section className="card section-space" aria-live="polite" aria-label="Utility result">
      <div className="section-heading"><h3>Result</h3></div>
      {result?.summary && <p>{display(result.summary)}</p>}
      {rows.length > 0 && <dl className="preference-list">{rows.map((row, index) => <div key={index}>
        <dt>{typeof row === 'object' ? display(row.label ?? row.name ?? `Item ${index + 1}`) : `Item ${index + 1}`}</dt>
        <dd>{typeof row === 'object' ? display(row.value ?? row.result ?? row) : display(row)}</dd>
      </div>)}</dl>}
      {!rows.length && !result?.summary && !details.length && <pre>{display(result)}</pre>}
      {details.length > 0 && <details><summary>Result details</summary><pre>{JSON.stringify(Object.fromEntries(details), null, 2)}</pre></details>}
    </section>}
  </Modal>
}
