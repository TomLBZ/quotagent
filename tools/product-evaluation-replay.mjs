// Read-only replay of the independent public evaluation; requires the recorded demo drafts.
import {chromium} from '../host/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
const out=process.env.EVIDENCE_DIR || 'tmp/product-evidence/evaluation/final/replay';
const base=(process.env.BASE_URL || 'https://novara.remoteblossom.com/quotagent').replace(/\/$/,'')+'/';
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
async function snap(name){const text=await page.locator('body').innerText();await fs.writeFile(out+'/'+name+'.txt',text);await page.screenshot({path:out+'/'+name+'.png',fullPage:true});}
try {
 await page.goto(base,{waitUntil:'networkidle'});
 await page.getByRole('button',{name:'I’m a contractor'}).click();
 await page.getByRole('button',{name:'Requests',exact:true}).waitFor();await snap('overview');
 await page.getByRole('button',{name:'Requests',exact:true}).click();
 await page.getByRole('button').filter({hasText:'[Evaluation] Library lighting 20260925'}).click();
 await page.getByRole('button',{name:'Edit draft',exact:true}).click();
 const deadline=await page.getByLabel('Quotation deadline').inputValue();
 const items=await page.getByRole('spinbutton').evaluateAll(es=>es.map(e=>e.value));
 await snap('library-draft');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:'Requests',exact:true}).click();
 await page.getByRole('button').filter({hasText:'[Demo] Riverside office lighting'}).click();
 await page.getByRole('button',{name:/Compare offers/}).click();await page.waitForTimeout(1000);
 await snap('comparison');const comparison=await page.locator('main').innerText();
 await page.getByRole('button',{name:'Plugin studio',exact:true}).click();
 await page.getByRole('button',{name:/^Saved skills/}).click();await snap('skills');
 await page.setViewportSize({width:390,height:844});await page.goto(base+'#workspace',{waitUntil:'networkidle'});await snap('mobile');
 const width=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));
 const result={date:new Date().toISOString(),url:base,deadline,items,width,comparison};
 await fs.writeFile(out+'/summary.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
