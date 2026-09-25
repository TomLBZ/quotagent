import { pathToFileURL } from 'node:url'
import { require, register, plainHtml, htmlRows, textItems, decode } from './common.mjs'
const mammoth = require('mammoth')
export const name = 'ingestion-documents'
export const inject = ['ingestion']
export async function parse({buffer,filename}) {
  const extension = filename.split('.').pop().toLowerCase()
  let text = '', rows = [], metadata = {format:extension}, warnings = []
  if (extension === 'docx') {
    const converted = await mammoth.convertToHtml({buffer})
    text = plainHtml(converted.value)
    rows = htmlRows(converted.value)
    warnings = converted.messages.map(message => message.message)
  } else if (extension === 'pdf') {
    const {getDocument} = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href)
    const loading = getDocument({data:new Uint8Array(buffer),useSystemFonts:true,isEvalSupported:false})
    try {
      const pdf = await loading.promise
      metadata.pages = pdf.numPages
      const pages = []
      for (let i = 1; i <= Math.min(pdf.numPages,200); i++) {
        const page = await pdf.getPage(i)
        const content = await page.getTextContent()
        let priorY = null, line = '', lines = []
        for (const item of content.items) {
          if (!('str' in item)) continue
          const y = Math.round(item.transform[5])
          if (priorY !== null && Math.abs(priorY-y) > 3 && line) {lines.push(line);line=''}
          line += (line ? ' ' : '') + item.str
          priorY = y
          if (item.hasEOL && line) {lines.push(line);line='';priorY=null}
        }
        if (line) lines.push(line)
        pages.push(`Page ${i}\n${lines.join('\n')}`)
        page.cleanup()
      }
      text = pages.join('\n\n')
      if (!pages.some(page => page.replace(/^Page \d+\s*/, '').trim())) warnings.push('This PDF has no extractable text. It may be a scan; OCR is not available. Upload a text PDF, Excel, DOCX or text export instead.')
      if (pdf.numPages > 200) warnings.push('Only the first 200 PDF pages were read.')
    } finally { await loading.destroy() }
  } else if (extension === 'html' || extension === 'htm') {
    const html = decode(buffer);text = plainHtml(html);rows = htmlRows(html)
  } else if (extension === 'json') {
    const value = JSON.parse(decode(buffer))
    const array = Array.isArray(value) ? value : ['items','rows','lineItems','data'].map(key => value?.[key]).find(Array.isArray)
    rows = (array || []).filter(item => item && typeof item === 'object' && !Array.isArray(item))
      .map(item => Object.fromEntries(Object.entries(item).map(([key,value]) => [key, typeof value === 'object' && value !== null ? JSON.stringify(value) : value])))
    text = JSON.stringify(value,null,2)
  } else text = decode(buffer)
  if (!rows.length) rows = textItems(text).rows
  return {text,rows,metadata,warnings}
}
export function apply(ctx) { register(ctx,{id:'documents',name:'Document text and table parser',description:'Extracts DOCX/HTML tables, text PDF pages, TXT and JSON. Scanned PDFs and legacy .doc are not supported.',extensions:['.docx','.pdf','.txt','.html','.htm','.json','.md'],parse}) }
