import {chromium} from '../../../../host/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
const root=process.cwd();
const out=root+'/docs/work/evidence/independent-final-2026-09-26';
const session=root+'/tmp/product-evidence/independent-final-2026-09-26/';
const role=process.env.ROLE||'fresh';
const browser=await chromium.launch({executablePath:'/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--disable-dev-shm-usage']});
const exists=await fs.stat(session+role+'.json').then(()=>true).catch(()=>false);
const context=await browser.newContext({viewport:{width:1440,height:1000},...(exists?{storageState:session+role+'.json'}:{})});
const page=await context.newPage(); page.setDefaultTimeout(8000);
await page.goto('https://novara.remoteblossom.com/quotagent/',{waitUntil:'networkidle'});
const code=process.env.ACTION_FILE ? await fs.readFile(process.env.ACTION_FILE,'utf8') : process.env.ACTION||'';
if(code&&!code.includes('Enter your password')) await fs.appendFile(out+'/executed-actions.jsonl',JSON.stringify({at:new Date().toISOString(),role,shot:process.env.SHOT,code})+'\n');
try { if(code) await (new Function('page','context','fs','out','session','return (async()=>{'+code+'})();'))(page,context,fs,out,session); await page.waitForTimeout(1200); if(!process.env.QUIET) console.log((await page.locator('body').innerText()).slice(-20000)); await context.storageState({path:session+role+'.json'}); }
catch(e){console.error(e);console.log((await page.locator('body').innerText()).slice(0,18000));process.exitCode=1;}
if(process.env.SHOT) {await page.screenshot({path:out+'/'+process.env.SHOT+'.png',fullPage:true});await fs.writeFile(out+'/'+process.env.SHOT+'.txt',await page.locator('body').innerText());}
await browser.close();
