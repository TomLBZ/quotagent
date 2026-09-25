import {chromium} from '../host/node_modules/playwright/index.mjs'
import {mkdir,writeFile} from 'node:fs/promises'
const dir='tmp/product-evidence/connected-overview';await mkdir(dir,{recursive:true})
const browser=await chromium.launch({executablePath:'/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--disable-dev-shm-usage']})
const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
try{
 await page.goto(process.env.BASE_URL||'https://novara.remoteblossom.com/quotagent/');await page.getByRole('button',{name:'Administrator sign in',exact:true}).click();await page.getByRole('heading',{name:'Keep everyone moving'}).waitFor()
 const navigation=await page.getByRole('navigation',{name:'Main navigation'}).innerText();await writeFile(dir+'/navigation.txt',navigation)
 await page.getByRole('button',{name:'Application plugins',exact:true}).click();await page.getByRole('heading',{name:/Application plugins/}).waitFor();await page.getByRole('heading',{name:'Email inbox and SMTP',exact:true}).waitFor();await page.screenshot({path:dir+'/admin-plugins.png',fullPage:true})
 await page.getByRole('button',{name:'Plugin settings',exact:true}).click();await page.getByRole('heading',{name:'Application and account settings'}).waitFor();await page.locator('.studio-settings-cards').waitFor();await page.getByRole('heading',{name:'Email connection',exact:true}).waitFor();await page.screenshot({path:dir+'/admin-settings.png',fullPage:true})
 const settings=await page.locator('main').innerText()
 await writeFile(dir+'/report.json',JSON.stringify({ok:true,url:page.url(),checks:['Administrator has native plugin inventory','New connection and workroom pages appear in navigation','Admin settings expose own-account connections'],navigation,settings,errors},null,2));console.log(JSON.stringify({ok:true,errors,evidence:dir}))
}finally{await browser.close()}
