// Public/local browser journeys: mutations use visible controls only.
import { chromium } from '../host/node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const base=(process.env.BASE_URL || 'https://novara.remoteblossom.com/quotagent').replace(/\/$/,'')+'/'
const out=resolve(process.env.EVIDENCE_DIR || 'tmp/product-evidence/plugin-workspace/public');mkdirSync(out,{recursive:true})
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || '/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--disable-dev-shm-usage']})
const report={base,startedAt:new Date().toISOString(),checks:[],pageErrors:[],artifacts:{}};let current
const persist=()=>writeFileSync(out+'/report.json',JSON.stringify(report,null,2)+'\n')
const check=(ok,message,details)=>{if(!ok)throw new Error(message);report.checks.push({message,...(details ? {details}: {})});console.log('PASS '+message);persist()}
const shot=async(page,name)=>{await page.screenshot({path:out+'/'+name+'.png',fullPage:true});report.artifacts[name]=name+'.png';persist()}
async function login(email){const page=await browser.newPage({viewport:{width:1512,height:982}});page.setDefaultTimeout(30000);page.on('pageerror',e=>report.pageErrors.push(e.message));await page.goto(base);await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill('demo1234');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('navigation',{name:'Main navigation'}).waitFor();return page}
async function studio(page){await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Plugin studio',exact:true}).click();await page.locator('.studio-tabs').getByRole('button',{name:'Plugin settings',exact:true}).waitFor()}
const card=(page,name)=>page.locator('.plugin-card').filter({has:page.getByRole('heading',{name,exact:true})})
const accent=page=>page.locator('.product').evaluate(el=>getComputedStyle(el).getPropertyValue('--accent').trim())
async function waitAccent(page,value){await page.waitForFunction(value=>getComputedStyle(document.querySelector('.product')).getPropertyValue('--accent').trim()===value,value)}
async function verifyNativeLifecycle(admin){
 current=admin
 const nav=admin.getByRole('navigation',{name:'Main navigation'})
 await nav.getByRole('button',{name:'Application plugins',exact:true}).click()
 const studioPlugin=admin.locator('.studio-catalog-plugin').filter({has:admin.getByRole('heading',{name:'Personal plugins and marketplace',exact:true})})
 await studioPlugin.getByRole('button',{name:'Disable',exact:true}).click()
 try{
  await nav.getByRole('button',{name:'Plugin studio',exact:true}).waitFor({state:'detached'})
  await studioPlugin.getByRole('button',{name:'Enable',exact:true}).waitFor()
  check(await nav.getByRole('button',{name:'Application plugins',exact:true}).isVisible(),'Application manager remains available after optional Studio is disabled')
  const client=await login('supplier2@demo.local');current=client
  const clientNav=client.getByRole('navigation',{name:'Main navigation'})
  await clientNav.getByRole('button',{name:'Plugin settings',exact:true}).click()
  await client.getByRole('heading',{name:'AI model connection',exact:true}).waitFor()
  check(await clientNav.getByRole('button',{name:'Plugin studio',exact:true}).count()===0,'Client plugin settings remain usable while Studio is disabled')
  await shot(client,'07-client-settings-without-studio')
  await client.close();current=admin
  await shot(admin,'08-native-manager-with-studio-disabled')
 }finally{
  current=admin
  await studioPlugin.getByRole('button',{name:'Enable',exact:true}).click()
  await nav.getByRole('button',{name:'Plugin studio',exact:true}).waitFor()
 }
 check(true,'Administrator re-enables Studio through the surviving application manager')
}
const name=`[UI check] Configurable lake ${Date.now().toString().slice(-7)}`;report.extension=name
try{
 if(process.env.PLUGIN_LIFECYCLE_ONLY==='1'){
  await verifyNativeLifecycle(await login('admin@demo.local'))
 }else{
 const owner=await login('supplier2@demo.local');current=owner;await studio(owner)
 await owner.getByLabel('Describe an extension').fill(`Create a personal theme named exactly "${name}" with accent #287d68, background #f6faf8, surface #ffffff, text #203b33 and radius 12px.`)
 await owner.getByRole('button',{name:'Create with AI',exact:true}).click();await card(owner,name).waitFor({timeout:150000})
 await card(owner,name).getByRole('button',{name:'Configure',exact:true}).click()
 const config=owner.getByRole('dialog')
 await config.getByLabel('Accent color picker',{exact:true}).fill('#2455bc')
 await config.getByLabel('Description',{exact:true}).fill('My unfinished configuration must survive background refresh.')
 await owner.evaluate(()=>{window.formNode=document.querySelector('[role=dialog]');window.focusNode=document.activeElement;window.refreshProbe={removedGrids:0,loadingFrames:0};window.grid=document.querySelector('.extensions-grid');window.observer=new MutationObserver(records=>{for(const r of records){for(const n of r.removedNodes)if(n===window.grid||n.querySelector?.('.extensions-grid'))window.refreshProbe.removedGrids++;for(const n of r.addedNodes)if(n.classList?.contains('loading')||n.querySelector?.('.loading'))window.refreshProbe.loadingFrames++}});window.observer.observe(document.querySelector('#main-content'),{childList:true,subtree:true})})
 await owner.waitForTimeout(18000)
 const stability=await owner.evaluate(()=>({...window.refreshProbe,sameGrid:window.grid===document.querySelector('.extensions-grid'),sameDialog:window.formNode===document.querySelector('[role=dialog]'),focusPreserved:window.focusNode===document.activeElement}))
 check(stability.removedGrids===0&&stability.loadingFrames===0&&stability.sameGrid&&stability.sameDialog&&stability.focusPreserved,'Background refresh keeps content, configuration dialog, and input focus mounted',stability)
 check(await config.getByLabel('Description',{exact:true}).inputValue()==='My unfinished configuration must survive background refresh.','Unfinished configuration remains intact across periodic refresh')
 await config.getByRole('button',{name:'Save configuration',exact:true}).click();await config.getByText('Configuration saved.',{exact:true}).waitFor();await waitAccent(owner,'#2455bc')
 check(true,'Theme color picker saves and applies the chosen color to the live workspace')
 await shot(owner,'01-theme-color-configuration')
 await config.getByRole('button',{name:'Close',exact:true}).click();await owner.reload();await studio(owner)
 await card(owner,name).getByRole('button',{name:'Configure',exact:true}).click();check(await owner.getByRole('dialog').getByLabel('Accent color hex value',{exact:true}).inputValue()==='#2455bc','Theme configuration survives page reload')
 await owner.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click()
 await card(owner,name).getByRole('button',{name:'Publish to market',exact:true}).click();await card(owner,name).getByText('Shared with the community',{exact:true}).waitFor()
 await owner.getByRole('button',{name:/^Marketplace/}).click();await card(owner,name).getByText('Installed',{exact:true}).waitFor()
 check(await card(owner,name).getByRole('button',{name:'Install in my workspace',exact:true}).count()===0,'Marketplace marks the owner’s extension Installed without an install button')
 const other=await login('supplier@demo.local');current=other;await studio(other);await other.getByRole('button',{name:/^Marketplace/}).click()
 await card(other,name).getByRole('button',{name:'Install in my workspace',exact:true}).click();await card(other,name).getByText('Installed',{exact:true}).waitFor()
 check(await card(other,name).getByRole('button',{name:'Manage',exact:true}).count()===1&&await card(other,name).getByRole('button',{name:'Install in my workspace',exact:true}).count()===0,'Installed marketplace state changes to Manage and persists')
 await other.reload();await studio(other);await other.getByRole('button',{name:/^Marketplace/}).click();await card(other,name).getByText('Installed',{exact:true}).waitFor()
 check(await card(other,name).count()===1,'Marketplace presents one entry per shared extension lineage')
 await shot(other,'02-marketplace-installed-state')
 const admin=await login('admin@demo.local');current=admin;await studio(admin)
 await admin.getByRole('heading',{name:'The application is made of plugins.',exact:true}).waitFor()
 await admin.getByRole('heading',{name:'AI model provider',exact:true}).waitFor()
 const runtimeNames=await admin.locator('.studio-catalog-title h3').allTextContents()
 check(runtimeNames.some(n=>/AI model provider/i.test(n))&&runtimeNames.some(n=>/WebUI application/i.test(n))&&runtimeNames.some(n=>/Quotation and order workflow/i.test(n)),'Administrator sees actual WebUI, AI provider, workflow, and supporting runtime plugins',{runtimeNames})
 await admin.getByRole('button',{name:/^Repository/}).click();await admin.getByLabel('Search application plugins',{exact:true}).fill('mail')
 const mail=admin.locator('.studio-catalog-plugin').filter({hasText:/mail/i}).first();await mail.waitFor()
 check((await mail.innerText()).includes('Repository only')&&await mail.getByRole('button',{name:'Enable',exact:true}).count()===0,'Historical mail plugin is honestly identified as repository-only with no fake enable control')
 await shot(admin,'03-admin-repository-mail')
 await admin.getByLabel('Search application plugins',{exact:true}).fill('');await admin.getByRole('button',{name:/^Runtime/}).click()
 const webui=admin.locator('.studio-catalog-plugin').filter({has:admin.getByRole('heading',{name:'WebUI application',exact:true})})
 await webui.getByRole('button',{name:'Configure',exact:true}).click();await admin.getByRole('dialog').getByLabel('Background refresh interval (seconds)',{exact:true}).waitFor()
 check(true,'Application plugin Configure opens its real registered schema')
 await shot(admin,'04-admin-plugin-settings');await admin.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click()
 await admin.getByRole('button',{name:/^Personal & global extensions/}).click();await card(admin,name).getByRole('button',{name:'Promote globally',exact:true}).click();await card(admin,name).getByText('Global default',{exact:true}).waitFor()
 check(await card(admin,name).count()===1,'Admin global promotion keeps one lineage card instead of duplicate plugin cards')
 await card(admin,name).getByRole('button',{name:'View details',exact:true}).click()
 const instanceSelect=admin.getByRole('dialog').getByLabel(/^Extension instance/);await instanceSelect.waitFor()
 check(await instanceSelect.locator('option').count()>=3,'Administrator can select personal installations and global default inside one extension',{instances:await instanceSelect.locator('option').allTextContents()})
 await shot(admin,'05-admin-extension-instances');await admin.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click()
 const contractor=await login('contractor@demo.local');current=contractor;await studio(contractor);await card(contractor,name).waitFor()
 check(await card(contractor,name).getByRole('button',{name:'Disable',exact:true}).count()===0&&await card(contractor,name).getByRole('button',{name:'Customize a copy',exact:true}).count()===1,'Client global extension offers a personal customization copy without global controls')
 current=other;await other.locator('.studio-tabs').getByRole('button',{name:/^My extensions/}).click()
 await card(other,name).getByRole('button',{name:'Configure',exact:true}).click()
 await other.getByRole('dialog').getByLabel('Accent color picker',{exact:true}).fill('#8a4bc2')
 await other.getByRole('dialog').getByRole('button',{name:'Save configuration',exact:true}).click();await other.getByRole('dialog').getByText('Configuration saved.',{exact:true}).waitFor();await waitAccent(other,'#8a4bc2')
 await other.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click()
 await card(other,name).getByRole('button',{name:'Disable',exact:true}).click();await waitAccent(other,'#2455bc')
 await card(other,name).getByRole('button',{name:'Customize a copy',exact:true}).waitFor()
 check(await card(other,name).count()===1,'Disabling a personal theme applies the active global theme and keeps one lineage card')
 await card(other,name).getByRole('button',{name:'View details',exact:true}).click()
 const clientInstances=other.getByRole('dialog').getByLabel('Extension instance',{exact:true});await clientInstances.waitFor()
 const personalOption=clientInstances.locator('option').filter({hasText:/Personal.*Disabled/});const personalId=await personalOption.getAttribute('value');await clientInstances.selectOption(personalId)
 check(await other.getByRole('dialog').getByRole('button',{name:'Enable',exact:true}).isVisible()&&await other.getByRole('dialog').getByRole('button',{name:'Configure',exact:true}).isVisible(),'Client can still manage the disabled personal instance while a global fallback is active')
 await shot(other,'09-personal-instance-with-global-fallback');await other.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click()
 await card(other,name).getByRole('button',{name:'Customize a copy',exact:true}).click();await waitAccent(other,'#8a4bc2')
 await card(other,name).getByRole('button',{name:'View details',exact:true}).click()
 check(await other.getByRole('dialog').getByLabel('Extension instance',{exact:true}).inputValue()===personalId&&await other.getByRole('dialog').getByLabel('Extension instance',{exact:true}).locator('option').count()===2,'Customize a copy reuses the existing personal installation and its saved color')
 await other.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click()
 current=owner;await owner.locator('.studio-tabs').getByRole('button',{name:'Plugin settings',exact:true}).click()
 const aiSettings=owner.locator('.studio-settings-cards .card').filter({has:owner.getByRole('heading',{name:'AI model connection',exact:true})})
 await aiSettings.getByRole('button',{name:'Configure',exact:true}).click();const settings=owner.getByRole('dialog');await settings.getByLabel('Request timeout (seconds)',{exact:true}).waitFor()
 check(await settings.getByLabel('API key',{exact:true}).inputValue()==='','Existing model credentials are represented by configuration status, not exposed values')
 await settings.getByLabel('Request timeout (seconds)',{exact:true}).fill('90');const patchPromise=owner.waitForRequest(request=>request.method()==='PATCH'&&request.url().includes('/settings/ai'));await settings.getByRole('button',{name:'Save settings',exact:true}).click();const settingsPatch=(await patchPromise).postDataJSON();check(JSON.stringify(Object.keys(settingsPatch.values))===JSON.stringify(['timeoutSeconds']),'Editing one personal setting preserves inheritance for all untouched fields',{submittedKeys:Object.keys(settingsPatch.values)});await settings.getByText('Settings saved.',{exact:true}).waitFor()
 await settings.getByRole('button',{name:'Close',exact:true}).click();await owner.reload();await studio(owner);await owner.locator('.studio-tabs').getByRole('button',{name:'Plugin settings',exact:true}).click();await aiSettings.getByRole('button',{name:'Configure',exact:true}).click()
 check(await owner.getByRole('dialog').getByLabel('Request timeout (seconds)',{exact:true}).inputValue()==='90','Personal plugin settings save and persist across reload')
 await shot(owner,'06-personal-plugin-settings')
 await owner.getByRole('dialog').getByRole('button',{name:'Use default settings',exact:true}).click();await owner.getByRole('dialog').getByText('Settings saved.',{exact:true}).waitFor();await owner.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click()
 current=admin;await card(admin,name).getByRole('button',{name:'Disable',exact:true}).click();await admin.waitForTimeout(500)
 await verifyNativeLifecycle(admin)
 }
 check(report.pageErrors.length===0,'Plugin workspace journey has no browser JavaScript errors')
 report.ok=true
}catch(error){report.ok=false;report.failure={message:error.message,stack:error.stack};console.error(error);if(current){report.failure.visibleText=await current.locator('body').innerText().catch(()=> '');await shot(current,'failure').catch(()=>{})}}
finally{report.finishedAt=new Date().toISOString();persist();console.log(JSON.stringify(report,null,2));await browser.close()}
if(!report.ok)process.exitCode=1
