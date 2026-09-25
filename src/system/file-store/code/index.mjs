import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'file-store'
export const inject = ['store', 'web', 'settings']
export const provides = ['files']
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }

export function apply(ctx) {
  const root = join(ctx.store.root, 'files')
  const defaults = { maxFileMb: 10 }
  ctx.effect(() => ctx.settings.define({ id: 'file-store', name: 'Uploaded files', scope: 'user', defaults,
    fields: [{ key: 'maxFileMb', name: 'Maximum file size (MB)', label: 'Maximum file size (MB)', type: 'number', min: 1, max: 20,
      description: 'Applies to each uploaded document. Files stay within your account.' }] }))
  const ensure = user => { if (!user?.id) fail('Sign in to use your files.', 401) }
  const pathOf = (user, hash) => join(root, createHash('sha256').update(user.id).digest('hex'), `${hash}.bin`)
  const get = (user, id) => {
    ensure(user)
    const record = ctx.store.get(user.id, 'files', id)
    if (!record || record.deletedAt) fail('This file is not available in your account.', 404)
    return record
  }
  const list = user => {
    ensure(user)
    return ctx.store.list(user.id, 'files').filter(row => !row.deletedAt).sort((a,b) => b.createdAt.localeCompare(a.createdAt))
  }
  const read = (user, id) => {
    const record = get(user, id)
    const path = pathOf(user, record.sha256)
    if (!existsSync(path)) fail('The stored file is unavailable. Upload it again.', 404)
    const buffer = readFileSync(path)
    if (createHash('sha256').update(buffer).digest('hex') !== record.sha256) fail('The stored file differs from its recorded content. Upload the original again.')
    return buffer
  }
  const put = async (user, { filename, mime = 'application/octet-stream', buffer, contentBase64, sourceFileId = null }) => {
    ensure(user)
    if (user.permissions?.includes('workspace:read-only')) fail('This account has read-only workspace access.', 403)
    const name = String(filename || 'document').split(/[\\/]/).pop().replace(/[\x00-\x1f]/g, '').slice(0, 200)
    if (!name) fail('Choose a named file.')
    if (!Buffer.isBuffer(buffer)) {
      if (typeof contentBase64 !== 'string' || !/^[A-Za-z0-9+/=\r\n]*$/.test(contentBase64)) fail('Upload a valid base64-encoded file.')
      buffer = Buffer.from(contentBase64, 'base64')
    }
    const options = { ...defaults, ...ctx.settings.get(user, 'file-store') }
    const maxBytes = Math.min(20, Math.max(1, Number(options.maxFileMb) || 10)) * 1024 * 1024
    if (!buffer.length) fail('This file is empty. Choose a document with content.')
    if (buffer.length > maxBytes) fail(`This file exceeds your ${maxBytes / 1024 / 1024} MB upload limit. Change it in plugin settings or choose a smaller file.`, 413)
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    const existing = list(user).find(row => row.sha256 === sha256 && row.filename === name)
    if (existing) return { ...existing, duplicate: true }
    const path = pathOf(user, sha256)
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    if (!existsSync(path)) writeFileSync(path, buffer, { mode: 0o600, flag: 'wx' })
    const record = { id: `file-${randomUUID()}`, ownerId: user.id, filename: name, mime: String(mime), size: buffer.length,
      sha256, sourceFileId, createdAt: new Date().toISOString() }
    await ctx.store.put(user.id, 'files', record, { actor: `human:${user.id}`, event: 'files/uploaded' })
    return record
  }
  ctx.provide('files', { list, get, read, put })
  ctx.effect(() => ctx.web.route('GET', '/files', ({ user }) => ({ files: list(user) })))
  ctx.effect(() => ctx.web.route('POST', '/files', async ({ user, body }) => ({ ok: true, file: await put(user, body) }), { capability: 'workspace:write' }))
  ctx.effect(() => ctx.web.route('GET', '/files/:id/download', ({ user, params, res }) => {
    const record = get(user, params.id)
    res.writeHead(200, { 'content-type': record.mime, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.filename)}` })
    res.end(read(user, params.id))
  }))
  ctx.effect(() => ctx.web.route('DELETE', '/files/:id', async ({ user, params }) => {
    const record = get(user, params.id)
    await ctx.store.put(user.id, 'files', { ...record, deletedAt: new Date().toISOString() }, { actor: `human:${user.id}`, event: 'files/removed-from-library' })
    return { ok: true }
  }, { capability: 'workspace:write' }))
}
