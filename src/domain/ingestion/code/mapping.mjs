const clean = value => String(value ?? '').trim()
const normalized = value => clean(value).toLowerCase().replace(/[\s_\-()./]+/g, '')
const aliases = {
  description: ['description','itemdescription','item','product','productname','name','scope','material','partdescription','项目','品名','描述','名称'],
  quantity: ['quantity','qty','quant','amountrequired','数量','工程量'],
  unit: ['unit','uom','units','measure','单位'],
  unitPrice: ['unitprice','price','rate','unitrate','quotedprice','单价','价格'],
  cost: ['cost','unitcost','privatecost','成本'],
}
export function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  let text = clean(value).replace(/^(?:(?:USD|GBP|EUR|AUD|SGD|HKD|CNY|JPY|CAD|NZD|CHF)\s*|[£$€¥]\s*)/i, '').replace(/\s*(USD|GBP|EUR|AUD|SGD|HKD|CNY|JPY|CAD|NZD|CHF)$/i, '')
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, '')
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null
}
export function suggestMapping(columns) {
  return Object.fromEntries(Object.entries(aliases).map(([field, names]) => [field, columns.find(column => names.includes(normalized(column).replace(/(?:usd|gbp|eur|aud|sgd|hkd|cny|jpy|cad|nzd|chf|[$£€¥])$/,''))) || '']))
}
export function mapRows(rows, mapping = suggestMapping([...new Set(rows.flatMap(row => Object.keys(row)))]), {fallbackAliases = false} = {}) {
  return rows.map((row, index) => {
    const local = fallbackAliases ? suggestMapping(Object.keys(row)) : {}
    const value = field => row[Object.hasOwn(row, mapping[field]) ? mapping[field] : local[field]]
    return { id: `import-item-${index + 1}`, description: clean(value('description')),
      quantity: numberOf(value('quantity')), unit: clean(value('unit')),
      unitPrice: numberOf(value('unitPrice')), cost: numberOf(value('cost')),
      source: { row: index + 1, sheet: row._sheet || undefined, file: row._file || undefined } }
  })
    .filter(item => item.description)
}
export function sourceCurrencies(text) {
  const found = [...String(text).toUpperCase().matchAll(/\b(USD|GBP|EUR|AUD|SGD|HKD|CNY|JPY|CAD|NZD|CHF)\b/g)].map(match => match[1])
  if (String(text).includes('€')) found.push('EUR')
  if (String(text).includes('£')) found.push('GBP')
  return [...new Set(found)]
}
export function cleanItems(items) {
  if (!Array.isArray(items)) return []
  return items.map((item,index) => ({ id: clean(item.id) || `import-item-${index + 1}`, description: clean(item.description),
    quantity: numberOf(item.quantity), unit: clean(item.unit), unitPrice: numberOf(item.unitPrice), cost: numberOf(item.cost),
    ...(item.rfqItemId ? { rfqItemId: clean(item.rfqItemId) } : {}),
    ...(item.source ? { source: structuredClone(item.source) } : {}) }))
}
