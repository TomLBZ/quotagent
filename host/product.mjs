/** Composition only: every product behavior is supplied by a native Cordis plugin. */
import { Context } from 'cordis'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as web from '../src/system/webui/code/product-server.mjs'
import * as store from '../src/system/workspace-store/code/index.mjs'
import * as accounts from '../src/system/accounts/code/product.mjs'
import * as settings from '../src/system/settings/code/index.mjs'
import * as manager from '../src/system/plugin-manager/code/index.mjs'
import * as agent from '../src/system/agent-runtime/code/product.mjs'
import * as procurement from '../src/domain/procurement/code/index.mjs'
import * as responses from '../src/domain/response-workbench/code/index.mjs'
import * as studio from '../src/system/plugin-studio/code/product.mjs'
import * as files from '../src/system/file-store/code/index.mjs'
import * as evidence from '../src/system/evidence/code/product.mjs'
import * as attachments from '../src/system/attachments/code/product.mjs'
import * as retention from '../src/system/retention/code/product.mjs'
import * as operations from '../src/system/observability/code/product.mjs'
import * as sandbox from '../src/system/sandbox/code/index.mjs'
import * as procurementSandbox from '../src/domain/procurement-sandbox/code/index.mjs'
import * as ingestion from '../src/domain/ingestion/code/index.mjs'
import * as emailEngine from '../src/domain/ingestion-engines/code/email.mjs'
import * as spreadsheetEngine from '../src/domain/ingestion-engines/code/spreadsheet.mjs'
import * as tabularEngine from '../src/domain/ingestion-engines/code/tabular.mjs'
import * as documentEngine from '../src/domain/ingestion-engines/code/documents.mjs'
import * as aiEngine from '../src/domain/ingestion-engines/code/ai.mjs'
import * as notifications from '../src/system/notifications/code/index.mjs'
import * as actions from '../src/system/action-center/code/index.mjs'
import * as mail from '../src/system/mail/code/product.mjs'
import * as telegram from '../src/system/telegram/code/product.mjs'
import * as connections from '../src/system/agent-connections/code/index.mjs'
import * as workflows from '../src/system/agent-workflows/code/index.mjs'
import * as workspaceStyles from '../src/system/workspace-styles/code/index.mjs'
import * as userGuide from '../src/system/user-guide/code/index.mjs'
import * as installed from '../src/system/installed-plugins/code/index.mjs'
import * as teams from '../src/system/teams/code/index.mjs'
import * as commercial from '../src/domain/commercial-workbench/code/index.mjs'
import * as exchange from '../src/system/exchange-workbench/code/index.mjs'
const root=fileURLToPath(new URL('../',import.meta.url))
const ctx=new Context(), mounted=[], definitions=[]
const mount=async(id,module,config={},metadata={})=>{
  const requested=!ctx.plugins || ctx.plugins.enabled(id)
  const missing=(Array.isArray(module.inject)?module.inject:[]).filter(service=>!ctx.get(service))
  const fiber=requested&&!missing.length?await ctx.plugin(module,config):null
  if(fiber&&fiber.state!==2)throw new Error(`Plugin ${id} did not activate (${fiber.state})`)
  if(fiber)mounted.push(fiber)
  const definition={id,module,config,fiber,...metadata}
  definitions.push(definition)
  if(ctx.plugins)ctx.effect(()=>ctx.plugins.register(definition))
  return fiber
}
await mount('webui',web,{port:Number(process.env.QUOTAGENT_WEBUI_PORT||8093),host:process.env.QUOTAGENT_WEBUI_HOST||'127.0.0.1',prefix:process.env.QUOTAGENT_WEBUI_PREFIX||'/quotagent',assets:process.env.QUOTAGENT_WEBUI_ASSETS||resolve(root,'src/system/webui/client/dist')},{name:'WebUI application',repoId:'system/webui',configurationId:'webui'})
await mount('workspace-store',store,{root:process.env.QUOTAGENT_PRODUCT_DATA||resolve(root,'tmp/product-data')},{name:'Workspace database and QEP',repoId:'system/workspace-store'})
await mount('accounts',accounts,{}, {name:'Accounts and permissions',repoId:'system/accounts'})
await mount('settings',settings,{}, {name:'Plugin configuration and credentials',repoId:'system/settings'})
await mount('plugin-manager',manager,{repositoryRoot:root},{name:'Application plugin manager',repoId:'system/plugin-manager'})
for(const definition of definitions.slice(0,-1))ctx.effect(()=>ctx.plugins.register(definition))
await mount('notifications',notifications,{}, {name:'Notifications',repoId:'system/notifications',configurationId:'notifications'})
await mount('teams',teams,{}, {name:'Party teams and authority',repoId:'system/teams'})
await mount('action-center',actions,{}, {name:'Human action review',repoId:'system/action-center'})
await mount('agent-runtime',agent,{}, {name:'AI agent runtime',repoId:'system/agent-runtime',configurationId:'ai'})
await mount('procurement',procurement,{}, {name:'Quotation and order workflow',repoId:'domain/procurement'})
await mount('response-workbench',responses,{}, {name:'Responses, read receipts and reports',repoId:'domain/response-workbench'})
await mount('exchange-workbench',exchange,{}, {name:'Quotation message delivery',repoId:'system/exchange-workbench'})
await mount('commercial-workbench',commercial,{}, {name:'Commercial workbench',repoId:'domain/commercial-workbench',configurationId:'commercial'})
await mount('installed-plugins',installed,{}, {name:'Installed plugins runtime',repoId:'system/installed-plugins'})
await mount('plugin-studio',studio,{}, {name:'Personal plugins and marketplace',repoId:'system/plugin-studio'})
await mount('file-store',files,{}, {name:'Account file storage',repoId:'system/file-store',configurationId:'file-store'})
await mount('evidence',evidence,{}, {name:'Evidence bundles and replay',repoId:'system/evidence'})
await mount('attachments',attachments,{}, {name:'Business attachments',repoId:'system/attachments'})
await mount('retention',retention,{}, {name:'File retention and legal holds',repoId:'system/retention'})
await mount('ingestion',ingestion,{}, {name:'Document ingestion workspace',repoId:'domain/ingestion',configurationId:'ingestion'})
for(const [id,module,label,file] of [
  ['ingestion-email',emailEngine,'Email import engine','email'],
  ['ingestion-spreadsheet',spreadsheetEngine,'Excel import engine','spreadsheet'],
  ['ingestion-tabular',tabularEngine,'CSV and TSV import engine','tabular'],
  ['ingestion-documents',documentEngine,'Document import engine','documents'],
  ['ingestion-ai',aiEngine,'AI line-item extraction','ai'],
]) await mount(id,module,{}, {name:label,repoId:'domain/ingestion-engines',source:`src/domain/ingestion-engines/code/${file}.mjs`,configurationId:id==='ingestion-ai'?'ai':'ingestion'})
await mount('mail',mail,{}, {name:'Email inbox and SMTP',repoId:'system/mail',configurationId:'mail'})
await mount('telegram',telegram,{apiBase:process.env.QUOTAGENT_TELEGRAM_API_BASE}, {name:'Telegram messaging',repoId:'system/telegram',configurationId:'telegram'})
await mount('agent-connections',connections,{}, {name:'MCP and A2A connections',repoId:'system/agent-connections'})
await mount('agent-workflows',workflows,{}, {name:'Agent workroom and memory',repoId:'system/agent-workflows',configurationId:'workflows'})
await mount('workspace-styles',workspaceStyles,{}, {name:'Workspace styles',repoId:'system/workspace-styles',configurationId:'workspace-styles'})
await mount('user-guide',userGuide,{}, {name:'Help and getting started',repoId:'system/user-guide'})
await mount('observability',operations,{}, {name:'Operations and event timeline',repoId:'system/observability',configurationId:'operations'})
await mount('sandbox',sandbox,{}, {name:'Isolated demo sandbox',repoId:'system/sandbox'})
await mount('procurement-sandbox',procurementSandbox,{}, {name:'Quotation demo scenario',repoId:'domain/procurement-sandbox'})
const address=await ctx.web.listen()
console.log(JSON.stringify({ready:true,port:address.port,url:`http://127.0.0.1:${address.port}${ctx.web.prefix}/`,plugins:definitions.map(d=>({id:d.id,state:d.fiber?.state??null}))}))
let closing=false
const stop=async()=>{if(closing)return;closing=true;for(const fiber of mounted.reverse())await fiber.dispose();process.exit(0)}
process.once('SIGTERM',stop);process.once('SIGINT',stop)
