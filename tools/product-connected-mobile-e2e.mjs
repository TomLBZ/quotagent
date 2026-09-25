import {chromium} from '../host/node_modules/playwright/index.mjs'
import {mkdir,writeFile} from 'node:fs/promises'
const dir='tmp/product-evidence/connected-mobile';await mkdir(dir,{recursive:true})
const browser=await chromium.launch({executablePath:'/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--disable-dev-shm-usage']})
const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true}),errors=[],pages=[];page.on('pageerror',e=>errors.push(e.message))
try{
 await page.goto(process.env.BASE_URL||'https://novara.remoteblossom.com/quotagent/');await page.getByRole('button',{name:'I’m a contractor'}).click();await page.getByRole('button',{name:'Open navigation',exact:true}).waitFor()
 for(const name of ['Agent workroom','Email','Telegram','Agent connections','Review actions','Notifications']){
   await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name,exact:true}).click();await page.waitForTimeout(1000)
   const size=await page.evaluate(()=>({width:innerWidth,document:document.documentElement.scrollWidth}));if(size.document>size.width+1)throw new Error(name+' overflows '+JSON.stringify(size));pages.push({name,...size});await page.screenshot({path:dir+'/'+name.replaceAll(' ','-').toLowerCase()+'.png',fullPage:true})
 }
 await writeFile(dir+'/report.json',JSON.stringify({ok:true,pages,errors},null,2));console.log(JSON.stringify({ok:true,pages,errors}))
}finally{await browser.close()}
