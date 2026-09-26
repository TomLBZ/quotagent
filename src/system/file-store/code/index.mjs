import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import {artifactServices} from './artifacts.mjs'

export const name = 'file-store'
export const inject = ['store', 'web', 'settings']
export const provides = ['files']
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }

export function apply(ctx) {
  const root = join(ctx.store.root, 'files')
  const defaults = { maxFileMb: 10, maxTotalMb: 1024 }, guards=new Map(),faults=new Set(),writes=new Map();let closed=false
  const serial=(user,work)=>{if(closed)return Promise.reject(new Error('File storage is reloading.'));const key=user?.id,pending=(writes.get(key)||Promise.resolve()).catch(()=>{}).then(work);writes.set(key,pending);pending.finally(()=>{if(writes.get(key)===pending)writes.delete(key)}).catch(()=>{});return pending}
  const fault=(user,operation,error)=>{if(!user?.id)return;const pending=ctx.store.append(user.id,'files/operation-failed',{operation,error:String(error.message).slice(0,1000)},{actor:`human:${user.actorId||user.id}`}).catch(()=>{}).finally(()=>faults.delete(pending));faults.add(pending)}
  ctx.effect(() => ctx.settings.define({ id: 'file-store', name: 'Uploaded files', scope: 'user', defaults,
    fields: [{ key: 'maxFileMb', name: 'Maximum file size (MB)', label: 'Maximum file size (MB)', type: 'number', min: 1, max: 20,
      description: 'Applies to each uploaded document. Files stay within your account.' },{key:'maxTotalMb',label:'Total stored file capacity (MB)',type:'number',min:1,max:102400,description:'Counts unique retained file bytes in this account; no automatic deletion occurs.'}] }))
  const ensure = user => { if (!user?.id) fail('Sign in to use your files.', 401) }
  const pathOf = (user, hash) => join(root, createHash('sha256').update(user.id).digest('hex'), `${hash}.bin`)
  const get = (user, id, {includeDeleted=false,includeDisposed=false}={}) => {
    ensure(user)
    const record = ctx.store.get(user.id, 'files', id)
    if (!record || record.deletedAt&&!includeDeleted || record.disposedAt&&!includeDisposed) fail('This file is not available in your account.', 404)
    return record
  }
  const all=user=>{ensure(user);return ctx.store.list(user.id,'files')}
  const list = user => {
    ensure(user)
    return ctx.store.list(user.id, 'files').filter(row => !row.deletedAt&&!row.disposedAt).sort((a,b) => b.createdAt.localeCompare(a.createdAt))
  }
  const read = (user, id, options={}) => {
   try{
    const record = get(user, id, options)
    const path = pathOf(user, record.sha256)
    if (!existsSync(path)) fail('The stored file is unavailable. Upload it again.', 404)
    const buffer = readFileSync(path)
    if (createHash('sha256').update(buffer).digest('hex') !== record.sha256) fail('The stored file differs from its recorded content. Upload the original again.')
    return buffer
   }catch(error){fault(user,'read',error);throw error}
  }
  const putOnce = async (user, { filename, mime = 'application/octet-stream', buffer, contentBase64, sourceFileId = null, kind='upload', provenance=null, actor=user.actorId||user.id }) => {
   try{
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
    const retained=new Map(all(user).filter(row=>!row.disposedAt).map(row=>[row.sha256,row.size]));if(!retained.has(sha256)&&[...retained.values()].reduce((sum,size)=>sum+size,0)+buffer.length>options.maxTotalMb*1024*1024)fail('This upload exceeds your total file capacity. Review retained files or change the explicit capacity setting.',413)
    const path = pathOf(user, sha256)
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    const repair=existsSync(path)&&createHash('sha256').update(readFileSync(path)).digest('hex')!==sha256
    const missing=!existsSync(path)
    if(missing||repair){const temporary=`${path}.${randomUUID()}.tmp`;writeFileSync(temporary,buffer,{mode:0o600,flag:'wx'});renameSync(temporary,path)}
    if(existing){if(missing||repair)await ctx.store.append(user.id,'files/content-restored',{fileId:existing.id,sha256,size:buffer.length,reason:missing?'missing':'digest-mismatch'},{actor:`human:${actor}`});return{...existing,duplicate:true,restored:missing||repair}}
    const record = { id: `file-${randomUUID()}`, ownerId: user.id, filename: name, mime: String(mime), size: buffer.length,
      sha256, sourceFileId, kind, provenance, uploadedBy:actor, createdAt: new Date().toISOString() }
    await ctx.store.put(user.id, 'files', record, { actor: `human:${actor}`, event: 'files/uploaded' })
    return record
   }catch(error){fault(user,'upload',error);throw error}
  }
  const put=(user,input)=>serial(user,()=>putOnce(user,input))
  const artifacts=artifactServices({ctx,pathOf,ensure,get,read,all,guards,serial})
  ctx.effect(()=>async()=>{closed=true;await Promise.allSettled([...writes.values()]);await Promise.allSettled([...faults]);guards.clear()})
  ctx.provide('files', { list, get, read, put, all,...artifacts,flush:()=>Promise.allSettled([...faults]) })
  ctx.effect(()=>ctx.web.route('GET','/files/summary',({user})=>artifacts.summary(user)))
  ctx.effect(()=>ctx.web.route('GET','/files/:id/preview',({user,params})=>artifacts.preview(user,params.id)))
  ctx.effect(() => ctx.web.route('GET', '/files', ({ user }) => ({ files: list(user) })))
  ctx.effect(() => ctx.web.route('POST', '/files', async ({ user, body }) => ({ ok: true, file: await put(user, {...body,actor:user.id,kind:'upload',provenance:null}) }), { capability: 'workspace:write' }))
  ctx.effect(() => ctx.web.route('GET', '/files/:id/download', ({ user, params, res }) => {
    const record = get(user, params.id)
    res.writeHead(200, { 'content-type': record.mime, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.filename)}` })
    res.end(read(user, params.id))
  }))
  ctx.effect(() => ctx.web.route('DELETE', '/files/:id', async ({ user, params }) => {
    await artifacts.archive(user,params.id)
    return { ok: true }
  }, { capability: 'workspace:write' }))
}
