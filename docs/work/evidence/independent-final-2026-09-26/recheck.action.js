console.log(await page.locator('script[src]').evaluateAll(es=>es.map(e=>e.src)));
await page.getByRole('textbox',{name:'Message your AI assistant'}).fill('[Independent evaluation corrected-release recheck] Read the same Riverside lighting quotes again and provide a detailed supplier comparison. Read only, no drafts or writes. Include deposit and balance amounts for the quoted payment terms when they can be calculated from the records.');
await page.getByRole('textbox',{name:'Message your AI assistant'}).press('Enter');
await page.getByRole('button',{name:'Pause task',exact:true}).waitFor({timeout:10000});
await page.getByRole('button',{name:'Pause task',exact:true}).waitFor({state:'hidden',timeout:55000});
await page.waitForTimeout(600);
console.log((await page.locator('body').innerText()).slice(-9500));
console.log(await page.locator('details').evaluateAll(es=>es.map(e=>({summary:e.querySelector('summary')?.textContent,text:e.textContent.slice(0,1000)})).slice(-8)));
