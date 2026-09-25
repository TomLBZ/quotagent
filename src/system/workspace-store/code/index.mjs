import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export const name = 'workspace-store'
export const inject = []
export async function apply(ctx, config = {}) {
  const root = resolve(config.root || 'tmp/product-data')
  mkdirSync(root, { recursive: true })
  const child = spawn(config.python || process.env.QUOTAGENT_PYTHON || 'python3',
    [fileURLToPath(new URL('./bridge.py', import.meta.url)), root], { stdio: ['pipe','pipe','pipe'] })
  const pending = new Map(), records = new Map(), history = new Map()
  let sequence = 0, disposed = false, failure = null
  const copy = value => value === undefined ? undefined : structuredClone(value)
  const absorb = events => {
    for (const [realm, rows] of Object.entries(events || {})) {
      if (!history.has(realm)) history.set(realm, [])
      history.get(realm).push(...rows)
      if (!records.has(realm)) records.set(realm, new Map())
      for (const row of rows) {
        const body = row.body
        if (body?.schema !== 'quotagent/workspace-record/v1') continue
        if (!records.get(realm).has(body.collection)) records.get(realm).set(body.collection, new Map())
        records.get(realm).get(body.collection).set(body.record.id, body.record)
      }
    }
  }
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    try {
      const response = JSON.parse(line), task = pending.get(response.id)
      if (!task) return
      pending.delete(response.id)
      absorb(response.events)
      response.ok ? task.resolve(response.value) : task.reject(new Error(response.error))
    } catch (error) { console.error('[store] Invalid adapter response:', error.message) }
  })
  child.stderr.on('data', data => console.error('[store]', data.toString().slice(0, 1000)))
  const fail = error => { failure = error; for (const task of pending.values()) task.reject(error); pending.clear() }
  child.on('error', fail)
  child.on('exit', () => fail(new Error('Ledger adapter stopped')))
  const request = payload => new Promise((resolve, reject) => {
    if (disposed || failure) return reject(failure || new Error('Store unloaded'))
    const id = ++sequence; pending.set(id, {resolve,reject})
    child.stdin.write(JSON.stringify({id,...payload}) + '\n')
  })
  ctx.effect(() => () => { disposed = true; lines.close(); child.kill(); fail(new Error('Store unloaded')) })
  await request({op:'init'})
  ctx.provide('store', {
    root,
    list: (realm, collection) => copy([...(records.get(realm)?.get(collection)?.values() || [])]),
    get: (realm, collection, id) => copy(records.get(realm)?.get(collection)?.get(id)),
    events: realm => copy(history.get(realm) || []),
    put: (realm, collection, record, options = {}) => {
      if (!record?.id) throw new Error('A record needs an id')
      return request({op:'put',realm,collection,record,...options})
    },
    append: (realm,type,body,options = {}) => request({op:'append',realm,type,body,...options}),
    exchange: (from,to,collection,record,options = {}) => request({op:'exchange',realm:from,to,collection,record,...options}),
  })
}
