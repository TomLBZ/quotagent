await page.getByRole('button',{name:'Personalize',exact:true}).click();
await page.getByRole('button',{name:'Plugin studio',exact:true}).click();
await page.getByRole('textbox',{name:'Describe an extension'}).fill('Create a personal utility named [Evaluation] Deposit split. Inputs: quote total and deposit percent. Outputs: deposit = total * percent / 100, balance = total - deposit, each to two decimals. Defaults 5532 and 30. Reject negative total, nonnumeric inputs, and percent outside 0 to 100. State that amounts are a local calculation, not contractual approval. No network or business record writes.');
await page.getByRole('button',{name:'Create with AI',exact:true}).click();
await page.waitForTimeout(1000);
console.log((await page.locator('body').innerText()).slice(-12000));
