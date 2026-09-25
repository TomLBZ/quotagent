// Capture public, account-visible state before restart, then compare after restart.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from '../host/node_modules/playwright/index.mjs'
const mode=process.argv[2] || 'after'
const base=(process.env.BASE_URL || 'https://novara.remoteblossom.com/quotagent').replace(/\/$/,'')+'/'
const out=resolve(process.env.EVIDENCE_DIR || 'tmp/product-evidence/plugin-workspace/restart')
mkdirSync(out,{recursive:true})
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || '/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--disable-dev-shm-usage']})
const state={},errors=[]
const sorted=rows=>rows.sort((a,b)=>String(a.id || a.name).localeCompare(String(b.id || b.name)))
const canonical=value=>Array.isArray(value) ? value.map(canonical) : value && typeof value==='object'
 ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,entry])=>[key,canonical(entry)])) : value
const fingerprint=state=>{
 const value=structuredClone(state)
 // Cordis creates new fiber UIDs on remount; parent/name/status identify the same service.
 for(const account of Object.values(value))if(account.runtime)account.runtime=sorted(account.runtime.map(row=>({...row,
  id:row.id.startsWith('runtime:') ? row.id.split(':').slice(0,-1).join(':')+':'+row.name : row.id})))
 return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
try {
 for(const role of ['contractor','supplier','supplier2','admin']) {
  const page=await browser.newPage({viewport:{width:1440,height:1000}})
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto(base)
  await page.getByLabel('Email address').fill(role+'@demo.local')
  await page.getByLabel('Password',{exact:true}).fill('demo1234')
  await page.getByRole('button',{name:'Sign in',exact:true}).click()
  await page.getByRole('navigation',{name:'Main navigation'}).waitFor()
  const read=async path=>{const response=await page.request.get(base+'api/'+path);assert(response.ok(),`${role}:${path}`);return response.json()}
  const [bootstrap,config,studio]=await Promise.all([read('bootstrap'),read('settings'),read('studio')])
  const snapshot={settings:sorted(config.settings.map(({id,values,configuredSecrets,overriddenKeys})=>({id,values,configuredSecrets,overriddenKeys}))),
   extensions:sorted(bootstrap.extensions.map(({id,lineageId,spec})=>({id,lineageId,spec}))),
   studio:sorted(studio.plugins.map(({id,lineageId,enabled,scope})=>({id,lineageId,enabled,scope}))),
   market:sorted(studio.market.map(({id,installedId,installed,installedEnabled})=>({id,installedId,installed,installedEnabled})))}
  if(role==='admin') {
   const inventory=await read('plugins')
   snapshot.runtime=sorted(inventory.plugins.filter(row=>row.status!=='available').map(({id,name,status})=>({id,name,status})))
  } else {
   const ingestion=await read('ingestion')
   snapshot.documents=sorted(ingestion.documents.map(({id,fileId,itemCount,imported})=>({id,fileId,itemCount,imported})))
   snapshot.files=sorted(ingestion.files.map(({id,sha256,size})=>({id,sha256,size})))
   snapshot.engines=sorted(ingestion.engines.map(({id,available})=>({id,available})))
  }
  state[role]=snapshot
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:role==='admin'?'Application plugins':'Plugin settings',exact:true}).click()
  await page.getByRole('heading',{name:role==='admin'?'Application plugins':'Plugin settings',exact:true}).waitFor()
  if(mode==='after')await page.screenshot({path:out+'/'+role+'-after-restart.png',fullPage:true})
  await page.close()
 }
 assert.deepEqual(errors,[])
 writeFileSync(out+'/'+mode+'-state.json',JSON.stringify(state,null,2)+'\n')
 if(mode==='before')writeFileSync(out+'/before.json',JSON.stringify(state,null,2)+'\n')
 else assert.equal(fingerprint(state),fingerprint(JSON.parse(readFileSync(out+'/before.json','utf8'))),'Account-visible plugin/configuration/document state survives restart')
 const report={ok:true,mode,base,at:new Date().toISOString(),accounts:Object.fromEntries(Object.entries(state).map(([role,data])=>[role,{settings:data.settings.length,extensions:data.extensions.length,documents:data.documents?.length,files:data.files?.length,runtime:data.runtime?.length}])),checks:['GUI login and navigation','masked effective settings and inheritance preserved','installed and effective extension identity preserved','uploaded content hashes and parsed/imported records preserved','native and engine inventory preserved'],browserErrors:errors}
 writeFileSync(out+'/'+mode+'-report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
} finally {await browser.close()}
