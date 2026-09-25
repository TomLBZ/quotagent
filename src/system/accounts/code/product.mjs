import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'product-accounts'
export const inject = ['web', 'store']
export const provides = ['accounts']

const CLIENT_ROLES = ['contractor', 'supplier']
const ROLES = [...CLIENT_ROLES, 'admin']
const CAPABILITY_FLAGS = {
  'workspace:write': 'workspace:read-only',
  'assistant:use': 'assistant:disabled',
  'plugins:manage': 'plugins:disabled',
}
const COOKIE = 'qa_session'
const SESSION_MS = 30 * 24 * 60 * 60 * 1000
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }
const clean = (value, max = 200) => String(value ?? '').trim().slice(0, max)
const emailOf = value => clean(value, 254).toLowerCase()
const copy = value => JSON.parse(JSON.stringify(value))
const passwordHash = (password, salt = randomBytes(16).toString('hex')) => ({
  salt, hash: scryptSync(password, salt, 32).toString('hex'),
})
const passwordMatches = (password, credential) => {
  if (!credential?.salt || !credential?.hash) return false
  const expected = Buffer.from(credential.hash, 'hex')
  const actual = scryptSync(password, credential.salt, 32)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
const publicProfile = account => account ? copy({
  id: account.id, email: account.email, name: account.name, company: account.company,
  role: account.role, preferences: account.preferences ?? {}, permissions: account.permissions ?? [],
  disabled: account.disabled === true, createdAt: account.createdAt,
}) : null

export function apply(ctx, config = {}) {
  const directory = join(config.root ?? ctx.store.root, 'accounts')
  const cookiePath = ctx.web.prefix || '/quotagent'
  const file = join(directory, 'accounts.json')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  let state = { accounts: [], sessions: {} }
  if (existsSync(file)) state = JSON.parse(readFileSync(file, 'utf8'))
  const persist = () => {
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, file)
  }
  const now = () => new Date().toISOString()
  let added = false
  for (const [id, email, userName, company, role] of [
    ['contractor-demo', 'contractor@demo.local', 'Alex Morgan', 'Northstar Construction', 'contractor'],
    ['supplier-demo', 'supplier@demo.local', 'Jordan Lee', 'Summit Supply', 'supplier'],
    ['supplier2-demo', 'supplier2@demo.local', 'Taylor Chen', 'Atlas Materials', 'supplier'],
    ['admin-demo', 'admin@demo.local', 'Platform Admin', 'Quotagent', 'admin'],
  ]) {
    if (state.accounts.some(account => account.email === email)) continue
    state.accounts.push({ id, email, name: userName, company, role, preferences: {}, permissions: [],
      credential: passwordHash('demo1234'), createdAt: now() })
    added = true
  }
  if (added) persist()
  const getRaw = id => state.accounts.find(account => account.id === id)
  const sessionId = req => {
    const cookies = String(req.headers?.cookie ?? '').split(';')
    const cookie = cookies.find(value => value.trim().startsWith(`${COOKIE}=`))
    return cookie ? cookie.trim().slice(COOKIE.length + 1) : ''
  }
  const resolve = req => {
    const session = state.sessions[sessionId(req)]
    if (!session || session.expiresAt <= Date.now()) return null
    const account = getRaw(session.accountId)
    return account && !account.disabled ? publicProfile(account) : null
  }
  const invalidate = accountId => {
    for (const [id, session] of Object.entries(state.sessions)) {
      if (session.accountId === accountId) delete state.sessions[id]
    }
  }
  const can = (user, capability) => {
    const account = user?.id ? getRaw(user.id) : null
    if (!account || account.disabled) return false
    const flag = CAPABILITY_FLAGS[capability]
    return !flag || !(account.permissions ?? []).includes(flag)
  }
  const update = async (id, patch = {}, { admin = false } = {}) => {
    const account = getRaw(id)
    if (!account) fail('Account not found.', 404)
    const next = {}
    if ('name' in patch) {
      next.name = clean(patch.name, 100)
      if (!next.name) fail('Enter your name.')
    }
    if ('company' in patch) next.company = clean(patch.company, 160)
    if ('role' in patch && patch.role !== account.role) {
      if (!(admin ? ROLES : CLIENT_ROLES).includes(patch.role)) fail('Select supplier or contractor.')
      if (!admin && account.role === 'admin') fail('An administrator account cannot switch to a client workspace.')
      if (account.role === 'admin' && state.accounts.filter(row => row.role === 'admin' && !row.disabled).length <= 1) {
        fail('Keep at least one active administrator.')
      }
      next.role = patch.role
    }
    if ('preferences' in patch) {
      if (!patch.preferences || typeof patch.preferences !== 'object' || Array.isArray(patch.preferences)) {
        fail('Preferences must be an object.')
      }
      next.preferences = { ...account.preferences, ...copy(patch.preferences) }
    }
    if (admin && 'permissions' in patch) {
      if (!Array.isArray(patch.permissions)) fail('Permissions must be a list.')
      next.permissions = [...new Set(patch.permissions.map(value => clean(value, 80)).filter(Boolean))]
    }
    if (admin && 'disabled' in patch) {
      if (patch.disabled === true && account.role === 'admin'
        && state.accounts.filter(row => row.role === 'admin' && !row.disabled).length <= 1) {
        fail('Keep at least one active administrator.')
      }
      next.disabled = patch.disabled === true
    }
    Object.assign(account, next, { updatedAt: now() })
    if (next.disabled) invalidate(id)
    persist()
    if (next.preferences) {
      await ctx.store.append(id, 'account/preferences-updated', { preferences: next.preferences }, { actor: id })
    }
    return publicProfile(account)
  }
  const setSession = (req, res, account) => {
    const id = randomBytes(32).toString('hex')
    const previous = sessionId(req)
    if (previous) delete state.sessions[previous]
    for (const [key, session] of Object.entries(state.sessions)) {
      if (session.expiresAt <= Date.now()) delete state.sessions[key]
    }
    state.sessions[id] = { accountId: account.id, expiresAt: Date.now() + SESSION_MS }
    persist()
    const secure = req.socket?.encrypted || req.headers?.['x-forwarded-proto'] === 'https'
    res.setHeader('Set-Cookie', `${COOKIE}=${id}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`)
  }
  ctx.provide('accounts', {
    resolve, get: id => publicProfile(getRaw(id)),
    list: () => state.accounts.filter(account => !account.disabled).map(account => ({
      id: account.id, email: account.email, name: account.name, company: account.company, role: account.role,
    })), update, can,
  })
  const route = (method, path, handler, options) => ctx.effect(() => ctx.web.route(method, path, handler, options))
  route('POST', '/auth/login', ({ body, req, res }) => {
    const account = state.accounts.find(row => row.email === emailOf(body.email))
    if (!account || account.disabled || !passwordMatches(String(body.password ?? ''), account.credential)) {
      fail('Email or password is incorrect.', 401)
    }
    setSession(req, res, account)
    return { user: publicProfile(account) }
  }, { public: true })
  route('POST', '/auth/register', ({ body, req, res }) => {
    const email = emailOf(body.email)
    const password = String(body.password ?? '')
    const userName = clean(body.name, 100)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid email address.')
    if (password.length < 8) fail('Use a password with at least 8 characters.')
    if (!userName) fail('Enter your name.')
    if (!CLIENT_ROLES.includes(body.role)) fail('Select supplier or contractor.')
    if (state.accounts.some(row => row.email === email)) fail('This email already has an account.', 409)
    const account = { id: `u-${randomUUID()}`, email, name: userName,
      company: clean(body.company, 160), role: body.role, preferences: {}, permissions: [],
      credential: passwordHash(password), createdAt: now() }
    state.accounts.push(account)
    setSession(req, res, account)
    return { user: publicProfile(account) }
  }, { public: true })
  route('POST', '/auth/logout', ({ req, res }) => {
    delete state.sessions[sessionId(req)]
    persist()
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=0`)
    return { ok: true }
  }, { public: true })
  route('GET', '/auth/me', ({ user }) => ({ user }), { public: true })
  route('PATCH', '/account', async ({ user, body }) => ({ user: await update(user.id, body) }))
  route('GET', '/admin/users', () => ({ users: state.accounts.map(publicProfile) }), { admin: true })
  route('PATCH', '/admin/users/:id', async ({ params, body }) => ({
    user: await update(params.id, body, { admin: true }),
  }), { admin: true })
  ctx.effect(() => ctx.web.contribute({ id: 'settings', label: 'Settings', icon: 'settings',
    roles: ROLES, order: 90 }))
  ctx.effect(() => ctx.web.contribute({ id: 'admin', label: 'Administration', icon: 'shield',
    roles: ['admin'], order: 10 }))
}
