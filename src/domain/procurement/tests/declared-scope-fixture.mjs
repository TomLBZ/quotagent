// Explicit authored test-fixture scope. Production code never imports this helper.
// Each distinct spelling is its own fixture dimension; no cross-unit equivalence is inferred.
export function declaredScope(items,{owner='Supplier',deliverables='Supply the listed fixture items as specified.',exclusions='None declared for this authored test fixture.'}={}){
 const units=[...new Set(items.map(item=>item.unit||'each'))],id=unit=>'fixture-measure-'+encodeURIComponent(unit)
 return{scope:{measurementRules:units.map(unit=>({id:id(unit),name:'Fixture quantity measured in '+unit,dimension:'fixture-'+unit,units:[{unit,factor:1}]})),interfaces:[{id:'fixture-supply',name:'Supply of the listed fixture items',responsibilityOwner:owner}],deliverables,exclusions},items:items.map(item=>({...item,unit:item.unit||'each',measurementRuleId:id(item.unit||'each'),interfaceId:'fixture-supply'}))}
}
export async function fillDeclaredScope(page,{dimension='count',owner='Supplier',deliverables='Supply the listed test items.',exclusions='None.'}={}){
 const dialog=page.getByRole('dialog').last();await dialog.getByRole('button',{name:'Define structured scope',exact:true}).click();await dialog.getByLabel('Deliverables',{exact:true}).fill(deliverables);await dialog.getByLabel('Exclusions',{exact:true}).fill(exclusions)
 const names=dialog.getByLabel(/^Rule \d+ name$/),count=await names.count();for(let i=1;i<=count;i++){await dialog.getByLabel(`Rule ${i} name`,{exact:true}).fill('Authored fixture quantity');await dialog.getByLabel(`Rule ${i} dimension`,{exact:true}).fill(dimension)}
 await dialog.getByLabel('Interface 1 description',{exact:true}).fill('Supply the authored request items');await dialog.getByLabel('Interface 1 responsibility owner',{exact:true}).fill(owner)
}
export function authoredFixtureInput(action,input){return ['create-rfq','save-amendment'].includes(action)&&input?.items&&!input.scope?{...input,...declaredScope(input.items)}:input}
