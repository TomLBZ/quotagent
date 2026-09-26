const text=value=>String(value??'').trim()
const copy=value=>structuredClone(value)
const fail=message=>{throw Object.assign(new Error(message),{status:400,code:'SCOPE_NORMALIZATION',nextAction:'Review the declared measurement rule and the original offered quantity, unit and price.'})}
const required=(value,label)=>{const result=text(value);if(!result)fail(`${label} is required.`);return result}
const rows=(value,label)=>{if(!Array.isArray(value))fail(`${label} must be a list.`);return value}
const unique=(values,label)=>{if(new Set(values).size!==values.length)fail(`${label} must have unique identifiers.`)}
const fraction=value=>{const valueText=text(value);if(!/^\d+(\.\d{1,6})?$/.test(valueText)||Number(value)<=0)fail('Measurement quantities and factors must be positive, with at most six decimals.');const [whole,part='']=valueText.split('.');return{n:BigInt(whole+part),d:10n**BigInt(part.length)}}

export function scopeFields(input,prior) {
  if(input===undefined)return prior===undefined?undefined:copy(prior)
  if(!input||typeof input!=='object'||Array.isArray(input))fail('Structured scope cannot be removed. Edit its declarations through an amendment.')
  const measurementRules=rows(input.measurementRules??[],'Measurement rules').map((rule,index)=>({id:required(rule.id,`Measurement rule ${index+1} ID`),name:text(rule.name),dimension:text(rule.dimension),units:rows(rule.units??[],'Admitted units').map(unit=>({unit:required(unit.unit,'Admitted unit'),factor:Number(unit.factor)}))}))
  unique(measurementRules.map(row=>row.id),'Measurement rules')
  for(const rule of measurementRules){unique(rule.units.map(row=>row.unit),'Admitted units');for(const unit of rule.units)fraction(unit.factor)}
  const interfaces=rows(input.interfaces??[],'Interfaces').map((row,index)=>({id:required(row.id,`Interface ${index+1} ID`),name:text(row.name),responsibilityOwner:text(row.responsibilityOwner)}))
  unique(interfaces.map(row=>row.id),'Interfaces')
  return{schema:'quotagent/structured-scope/v1',measurementRules,interfaces,deliverables:text(input.deliverables),exclusions:text(input.exclusions)}
}
export function scopeItemFields(item) {
  return Object.fromEntries(['measurementRuleId','interfaceId'].filter(key=>item[key]!==undefined).map(key=>[key,text(item[key])]))
}
export function validatePublishedScope(rfq) {
  if(!rfq.scope)return{structured:false}
  const scope=scopeFields(rfq.scope)
  if(!scope.measurementRules.length||!scope.interfaces.length)fail('Declare measurement rules and responsibility interfaces before publishing structured scope.')
  required(scope.deliverables,'Deliverables');required(scope.exclusions,'Exclusions (state None explicitly when there are none)')
  for(const rule of scope.measurementRules){required(rule.name,'Measurement rule name');required(rule.dimension,'Measurement dimension');if(!rule.units.length)fail('Each measurement rule needs at least one admitted unit.')}
  for(const face of scope.interfaces){required(face.name,'Interface description');required(face.responsibilityOwner,'One responsibility owner for each interface')}
  for(const item of rfq.items){const rule=scope.measurementRules.find(rule=>rule.id===item.measurementRuleId),face=scope.interfaces.find(face=>face.id===item.interfaceId);if(!rule||!rule.units.some(unit=>unit.unit===item.unit))fail(`“${item.description}” needs a measurement rule admitting unit ${item.unit}.`);if(!face)fail(`“${item.description}” needs one responsibility interface.`)}
  return{structured:true}
}

export function normalizeQuoteLines(items,rfq,{cents,quantity,lineCents}) {
  if(!Array.isArray(items)||!items.length)fail('Add quoted prices for the RFQ items.')
  const known=new Map(rfq.items.map(item=>[item.id,item])),seen=new Set(),covered=new Set()
  return items.map((item,index)=>{
    const classification=text(item.classification)||'base',id=required(item.id,`Quote line ${index+1} ID`)
    if(!['base','additional','alternative'].includes(classification))fail('Classify each quote line as base, additional or alternative.')
    if(seen.has(id))fail(`Quoted item ID ${id} is repeated.`);seen.add(id)
    let source
    if(classification==='base'){
      source=known.get(id);if(!source)fail(`Quoted item ${id} is not in this RFQ. Explicitly classify additional or alternative scope.`)
      if(covered.has(id))fail(`RFQ item ${id} is fulfilled more than once.`);covered.add(id)
      if(item.unit!==undefined&&item.unit!==source.unit&&!item.offered&&!item.normalization)fail(`Unit ${item.unit} differs from requested ${source.unit}; declare original offered units for controlled conversion.`)
      if(item.quantity!==undefined&&Number(item.quantity)!==source.quantity&&!item.offered&&!item.normalization)fail('Base quote quantity must match the request. Declare alternative scope for a different quantity.')
    }else{
      if(known.has(id))fail('Give additional or alternative scope a distinct quote line ID.')
      const sourceItemId=classification==='alternative'?required(item.sourceItemId,'Alternative original RFQ item'):undefined
      if(sourceItemId&&!known.has(sourceItemId))fail('An alternative must reference an existing RFQ item.')
      if(sourceItemId&&covered.has(sourceItemId))fail('Quote either the base line or its alternative, not both as accepted quantities.')
      if(sourceItemId)covered.add(sourceItemId)
      source={id,description:required(item.description,'Additional or alternative description'),quantity:quantity(item.quantity),unit:required(item.unit,'Additional or alternative unit'),classification,scopeReason:required(item.scopeReason,'Additional or alternative scope explanation'),...(sourceItemId?{sourceItemId}:{})}
    }
    let price=cents(item.unitPrice,`Price for ${source.description}`),normalization
    if(price<0)fail('Quoted unit prices cannot be negative.')
    const offered=item.offered||item.normalization?.source
    if(offered){
      if(classification!=='base')fail('Convert only a referenced base line; price additional or alternative scope directly in its declared unit.')
      const rule=rfq.scope?.measurementRules?.find(rule=>rule.id===source.measurementRuleId),from=rule?.units.find(unit=>unit.unit===text(offered.unit)),to=rule?.units.find(unit=>unit.unit===source.unit)
      if(!rule||!from||!to)fail('No declared compatible measurement rule admits both offered and requested units.')
      const fromFactor=fraction(from.factor),toFactor=fraction(to.factor),offeredQty=fraction(offered.quantity),requiredQty=fraction(source.quantity),ratioN=fromFactor.n*toFactor.d,ratioD=fromFactor.d*toFactor.n
      if(offeredQty.n*ratioN*requiredQty.d!==requiredQty.n*offeredQty.d*ratioD)fail('Converted offered quantity does not equal the requested quantity. Clarify or declare an alternative.')
      const sourcePrice=cents(offered.unitPrice,'Original offered unit price');if(sourcePrice<0)fail('Original offered unit price cannot be negative.')
      const numerator=BigInt(sourcePrice)*ratioD;if(numerator%ratioN!==0n)fail('Conversion would produce a fractional cent unit price. Ask for a directly priced requested unit; no rounding guess was applied.')
      const normalized=Number(numerator/ratioN);if(!Number.isSafeInteger(normalized))fail('Converted price is too large.')
      if(item.normalization&&!item.offered&&price!==normalized)fail('The converted price was edited without changing its source. Remove the conversion basis or update the original offered price.')
      price=normalized;normalization={rfqRevision:rfq.publishedRevision||rfq.revision||1,ruleId:rule.id,dimension:rule.dimension,source:{quantity:quantity(offered.quantity),unit:from.unit,unitPrice:sourcePrice/100},sourceFactor:from.factor,targetFactor:to.factor,target:{quantity:source.quantity,unit:source.unit,unitPrice:price/100}}
    }
    const result={...source,unitPrice:price/100,total:lineCents(price,source.quantity)/100,...(normalization?{normalization}:{})}
    if(item.cost!==undefined&&item.cost!==null&&item.cost!==''){const cost=cents(item.cost,'Private unit cost in the normalized quoted unit');if(cost<0)fail('Private costs cannot be negative.');result.cost=cost/100;result.costTotal=lineCents(cost,source.quantity)/100}
    return result
  })
}
export function publicQuoteLine(item) {
  return Object.fromEntries(['id','description','quantity','unit','unitPrice','total','measurementRuleId','interfaceId','classification','sourceItemId','scopeReason','normalization'].filter(key=>item[key]!==undefined).map(key=>[key,copy(item[key])]))
}
