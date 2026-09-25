/** Generic Cordis HTTP/UI contribution service. Business routes belong to plugins. */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
export const name = 'webui-product'
export const inject = []
export function apply(ctx, config = {}) {
  const routes = [], navigation = [], extensions = []
  const prefix = (config.prefix || '/quotagent').replace(/\/$/, '')
  const assets = resolve(config.assets || 'src/system/webui/client/dist')
  let accounts = null, server = null
  ctx.inject(['accounts'], child => { accounts = child.accounts; child.effect(() => () => { accounts = null }) })
  const register = (list, entry) => { list.push(entry); return () => { const i = list.indexOf(entry); if (i >= 0) list.splice(i, 1) } }
  const applicable = user => extensions.filter(x => user && (x.owner === '*' || x.owner === user.id)).sort((a,b) => (a.owner === '*' ? 0 : 1) - (b.owner === '*' ? 0 : 1)).map(x => ({...structuredClone(x.descriptor),enabled:true}))
  const route = (method,path,handler,options = {}) => {
    const names = []
    const pattern = new RegExp('^' + path.split('/').map(part => part.startsWith(':') ? (names.push(part.slice(1)), '([^/]+)') : part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('/') + '/?$')
    return register(routes,{method,path,handler,options,pattern,names})
  }
  const json = (res,status,payload) => {
    if (res.writableEnded) return
    res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'})
    res.end(JSON.stringify(payload))
  }
  const handle = async (req,res) => {
    const url = new URL(req.url, 'http://localhost')
    const pathname = decodeURIComponent(url.pathname)
    if (pathname === '/api/health' || pathname === `${prefix}/api/health`) return json(res,200,{ok:true,service:'quotagent',runtime:'cordis-product'})
    if (pathname === prefix) { res.writeHead(302,{Location:prefix+'/'}); return res.end() }
    if (!pathname.startsWith(prefix + '/')) return json(res,404,{error:'Not found'})
    const path = pathname.slice(prefix.length)
    try {
      if (path.startsWith('/api/')) {
        const apiPath = path.slice(4)
        const user = accounts ? await accounts.resolve(req) : null
        if (apiPath === '/bootstrap') return json(res,200,{user,navigation:navigation.filter(item => user && (!item.roles || item.roles.includes(user.role))).sort((a,b)=>(a.order||0)-(b.order||0)),extensions:applicable(user)})
        const entry = routes.find(row => row.method === req.method && row.pattern.test(apiPath))
        if (!entry) return json(res,404,{error:'This action is not available'})
        if (!entry.options.public && !user) return json(res,401,{error:'Please sign in to continue'})
        if (entry.options.admin && user?.role !== 'admin') return json(res,403,{error:'Administrator account required'})
        if (entry.options.capability && accounts?.can && !accounts.can(user,entry.options.capability)) return json(res,403,{error:'Your administrator has disabled this capability for your account'})
        let raw = '', body = {}
        for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) throw Object.assign(new Error('Please use a smaller file or message'),{status:413}) }
        if (raw) { try { body = JSON.parse(raw) } catch { throw new Error('Invalid request data') } }
        const match = apiPath.match(entry.pattern)
        const params = Object.fromEntries(entry.names.map((key,i)=>[key,match[i+1]]))
        const result = await entry.handler({user,body,params,query:url.searchParams,req,res})
        if (!res.writableEnded) json(res,200,result ?? {ok:true})
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res,405,{error:'Method not supported'})
      const requested = resolve(assets, '.' + path)
      if (requested !== assets && !requested.startsWith(assets + sep)) return json(res,404,{error:'Not found'})
      let filename = requested
      try { if (!(await stat(filename)).isFile()) filename = resolve(assets,'index.html') }
      catch { filename = resolve(assets,'index.html') }
      const content = await readFile(filename)
      const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}[extname(filename)] || 'application/octet-stream'
      res.writeHead(200,{'Content-Type':mime + (mime.startsWith('text/') ? '; charset=utf-8' : ''),'Cache-Control':extname(filename)==='.html' ? 'no-store' : 'public, max-age=3600'})
      res.end(req.method === 'HEAD' ? undefined : content)
    } catch(error) {
      console.error('[webui]',req.method,path,error.message)
      json(res,error.status || 400,{ok:false,error:error.message || 'Unable to complete this action'})
    }
  }
  ctx.provide('web',{
    prefix,route,
    contribute: item => register(navigation, structuredClone(item)),
    extension: (owner, descriptor) => register(extensions,{owner,descriptor:structuredClone(descriptor)}),
    extensions: applicable,
    routes: () => routes.map(({method,path})=>({method,path})),
    async listen() {
      server = createServer(handle)
      await new Promise((resolve,reject)=>{ server.once('error',reject); server.listen(config.port || 8093,config.host || '127.0.0.1',resolve) })
      return server.address()
    },
  })
  ctx.effect(() => () => new Promise(resolve => { if (!server) return resolve(); server.closeAllConnections(); server.close(resolve) }))
}
