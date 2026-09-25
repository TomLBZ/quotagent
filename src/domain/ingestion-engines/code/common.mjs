import { createRequire } from 'node:module'
import { suggestMapping, mapRows } from '../../ingestion/code/mapping.mjs'
export const require = createRequire(new URL('../../../../host/package.json', import.meta.url))
const { convert } = require('html-to-text')
const XLSX = require('xlsx')
export const plainHtml = html => convert(String(html || ''), { wordwrap: false, selectors: [{selector:'a',options:{ignoreHref:true}},{selector:'img',format:'skip'},{selector:'table',format:'dataTable'}] })
export function decode(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le')
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return buffer.subarray(2).swap16().toString('utf16le')
  return buffer.toString('utf8').replace(/^\uFEFF/, '')
}
export function tableRows(matrix, sheet = '') {
  const nonempty = matrix.filter(row => row.some(value => value !== null && value !== undefined && String(value).trim() !== ''))
  if (!nonempty.length) return []
  let headerIndex = 0, best = 0
  for (let i = 0; i < Math.min(nonempty.length, 20); i++) {
    const mapping = suggestMapping(nonempty[i].map(String))
    const score = Object.values(mapping).filter(Boolean).length
    if (score > best) { best = score; headerIndex = i }
  }
  const seen = new Map()
  const headers = nonempty[headerIndex].map((value,index) => {
    const name = String(value ?? '').trim() || `Column ${index + 1}`
    const n = (seen.get(name) || 0) + 1; seen.set(name,n)
    return n > 1 ? `${name} (${n})` : name
  })
  return nonempty.slice(headerIndex + 1).map(values => ({...Object.fromEntries(headers.map((header,index) => [header,values[index] ?? ''])),...(sheet ? {_sheet:sheet} : {})}))
}
export function htmlRows(html) {
  const rows = []
  for (const [index, match] of [...String(html).matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].entries()) {
    try {
      const book = XLSX.read(match[0], { type:'string',raw:true })
      rows.push(...tableRows(XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1,defval:'',raw:false}), `Table ${index + 1}`))
    } catch { /* Plain text remains available if a malformed table cannot be read. */ }
  }
  return rows
}
export function textItems(text) {
  const rows = []
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(?:[-*•]\s*)?(\d+(?:\.\d+)?)\s+(each|ea|pcs?|pieces?|sets?|m|m2|m²|m3|kg|tonnes?|hours?|days?|units?)\s+(.+?)(?:\s+@\s*[$£€¥]?(\d+(?:\.\d{1,2})?))?\s*$/i.exec(line)
    if (match) rows.push({Description:match[3],Quantity:Number(match[1]),Unit:match[2],...(match[4] ? {'Unit price':Number(match[4])} : {})})
  }
  return { rows, items:mapRows(rows) }
}
export const register = (ctx, definition) => ctx.effect(() => ctx.ingestion.engine(definition))
