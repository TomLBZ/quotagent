// Labelled GUI-created accounts isolate protocol checks from demo routes and credentials.
import assert from 'node:assert/strict'
export async function createProtocolAccount(page,base,{prefix,role}){
 const stamp=Date.now()+'-'+Math.random().toString(36).slice(2,7),email=`${prefix}-${role}-${stamp}@fixture.invalid`
 await page.goto(base);await page.getByRole('button',{name:'Create an account',exact:true}).click()
 for(const[label,value]of[['Your name',`[Local protocol fixture] ${role}`],['Company',`[Local protocol fixture] ${prefix}`],['Email address',email],['Password','fixture-browser-only']])await page.getByLabel(label,{exact:true}).fill(value)
 await page.getByLabel('Your workspace',{exact:true}).selectOption(role)
 const pending=page.waitForResponse(response=>response.url().endsWith('/api/auth/register')&&response.request().method()==='POST')
 await page.getByRole('button',{name:'Create workspace',exact:true}).click();const response=await pending,result=await response.json();assert.equal(response.status(),200,JSON.stringify(result))
 await page.getByRole('navigation',{name:'Main navigation'}).waitFor();await page.getByRole('button',{name:'Not now',exact:true}).click({timeout:1200}).catch(()=>{})
 return result.user
}
