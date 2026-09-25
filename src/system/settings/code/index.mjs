import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
export const name = 'product-settings'
export const inject = ['store', 'web', 'accounts']
export const provides = ['settings']
const clone = value => structuredClone(value)
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }
const GLOBAL = 'system'
export function apply(ctx) {
  const schemas = new Map()
  const directory = join(ctx.store.root, 'settings')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const secretFile = join(directory, 'credentials.json')
  let secrets = existsSync(secretFile) ? JSON.parse(readFileSync(secretFile, 'utf8')) : {}
  const writeSecrets = next => {
    const temporary = `${secretFile}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, secretFile); secrets = next
  }
  const schema = id => { const value=schemas.get(id); if(!value) fail('This plugin has not registered editable settings.',404); return value }
  const realm = (user, definition) => !user || user.role === 'admin' || definition.scope === 'admin' ? GLOBAL : user.id
  const authorize = (user, definition, write = false) => {
    if(!user) fail('Please sign in.',401)
    if(definition.scope === 'admin' && user.role !== 'admin') fail('Only administrators can configure this application plugin.',403)
    if(write && user.role !== 'admin' && !ctx.accounts.can(user,'plugins:manage')) fail('Your administrator has disabled plugin configuration.',403)
  }
  const stored = (owner,id) => ctx.store.get(owner,'plugin-settings',id)?.values || {}
  const defaults = definition => clone(typeof definition.defaults === 'function' ? definition.defaults() : definition.defaults || {})
  const get = (user,id) => {
    const definition = schema(id), target = realm(user,definition)
    return { ...defaults(definition), ...stored(GLOBAL,id), ...(secrets[GLOBAL]?.[id] || {}),
      ...(target !== GLOBAL ? stored(target,id) : {}), ...(target !== GLOBAL ? secrets[target]?.[id] || {} : {}) }
  }
  const view = (user,id) => {
    const definition=schema(id);authorize(user,definition)
    const target=realm(user,definition), values=get(user,id), own=stored(target,id)
    const configuredSecrets=[], overriddenKeys=new Set(Object.keys(own))
    for(const field of definition.fields) if(field.type === 'password') {
      if(values[field.key]) configuredSecrets.push(field.key)
      if(Object.hasOwn(secrets[target]?.[id] || {},field.key)) overriddenKeys.add(field.key)
      values[field.key]=''
    }
    return {id,name:definition.name || id,description:definition.description || '',fields:clone(definition.fields),
      values,configuredSecrets,overriddenKeys:[...overriddenKeys],scope:target===GLOBAL?'global':'personal',
      hasOverrides:overriddenKeys.size>0,revision:ctx.store.get(target,'plugin-settings',id)?.updatedAt || null}
  }
  const define = definition => {
    if(!/^[\w.-]+$/.test(definition.id || '')) throw new Error('Setting IDs must contain letters, numbers, dots or hyphens.')
    if(schemas.has(definition.id)) throw new Error(`Duplicate configuration schema: ${definition.id}`)
    if(!Array.isArray(definition.fields)) throw new Error('A settings schema needs fields.')
    const keys=new Set()
    for(const field of definition.fields) {
      if(!field.key || keys.has(field.key) || !['text','textarea','password','number','boolean','select','color'].includes(field.type)) throw new Error(`Invalid settings field in ${definition.id}`)
      keys.add(field.key)
    }
    schemas.set(definition.id,{scope:'user',...definition})
    return ()=>schemas.delete(definition.id)
  }
  const validate = (field,value) => {
    if(field.type === 'boolean') {if(typeof value !== 'boolean')fail(`${field.label} must be on or off.`);return value}
    if(field.type === 'number') {
      const number=Number(value)
      if(value === '' || !Number.isFinite(number) || field.min!==undefined && number<field.min || field.max!==undefined && number>field.max) fail(`Enter a valid ${field.label.toLowerCase()}${field.min!==undefined?` (minimum ${field.min})`:''}${field.max!==undefined?` (maximum ${field.max})`:''}.`)
      return number
    }
    const text=String(value??'').trim()
    if(text.length>(field.maxLength || 16000))fail(`${field.label} is too long.`)
    if(field.required && !text)fail(`${field.label} is required.`)
    if(field.type==='color' && !/^#[\da-f]{6}$/i.test(text))fail(`${field.label} must be a six-digit color.`)
    if(field.type==='select' && !(field.options || []).map(option=>typeof option==='object'?String(option.value):String(option)).includes(text))fail(`Choose a valid ${field.label.toLowerCase()}.`)
    return text
  }
  let pending=Promise.resolve()
  const save = (user,id,input={}) => {
    const operation=async()=>{
      const definition=schema(id);authorize(user,definition,true)
      const target=realm(user,definition), before=get(user,id)
      const values={...stored(target,id)}, nextSecrets=clone(secrets)
      nextSecrets[target] ||= {};nextSecrets[target][id] ||= {}
      if(input.reset === true) {for(const key of Object.keys(values))delete values[key];nextSecrets[target][id]={}}
      const submitted=input.values || {}, known=new Map(definition.fields.map(field=>[field.key,field]))
      for(const key of Object.keys(submitted)) {
        const field=known.get(key);if(!field)fail(`Unknown setting: ${key}`)
        const value=validate(field,submitted[key])
        if(field.type==='password') {if(value) nextSecrets[target][id][key]=value}
        else values[key]=value
      }
      for(const key of input.clearSecrets || []) {if(known.get(key)?.type!=='password')fail('Only credential fields can be cleared.');nextSecrets[target][id][key]=''}
      const next={...defaults(definition),...stored(GLOBAL,id),...(nextSecrets[GLOBAL]?.[id] || {}),...values,...nextSecrets[target][id]}
      if(definition.validate)await definition.validate(next,{user,previous:before})
      const record={id,values,updatedAt:new Date().toISOString(),changedBy:user.id}
      await ctx.store.put(target,'plugin-settings',record,{actor:user.id,event:'settings/config-saved'})
      writeSecrets(nextSecrets)
      if(definition.onChange)await definition.onChange(get(user,id),{user,previous:before})
      return {ok:true,...view(user,id)}
    }
    const result=pending.then(operation);pending=result.catch(()=>{});return result
  }
  const list = user => [...schemas.values()].filter(definition=>definition.scope!=='admin' || user?.role==='admin').map(definition=>view(user,definition.id))
  ctx.provide('settings',{define,get,view,list,save})
  ctx.effect(()=>ctx.web.route('GET','/settings',({user})=>({settings:list(user)})))
  ctx.effect(()=>ctx.web.route('GET','/settings/:id',({user,params})=>view(user,params.id)))
  ctx.effect(()=>ctx.web.route('PATCH','/settings/:id',({user,params,body})=>save(user,params.id,body)))
}
