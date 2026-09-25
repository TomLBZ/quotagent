import { require, register, tableRows } from './common.mjs'
const XLSX = require('xlsx')
export const name = 'ingestion-spreadsheet'
export const inject = ['ingestion']
export async function parse({buffer,filename}) {
  const book = XLSX.read(buffer,{type:'buffer',cellDates:true,cellFormula:true})
  const rows = [], sections = [], sheets = []
  let formulas = 0
  for (const sheetName of book.SheetNames) {
    const sheet = book.Sheets[sheetName]
    const matrix = XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:false,dateNF:'yyyy-mm-dd'})
    const entries = tableRows(matrix,sheetName)
    rows.push(...entries); sheets.push({name:sheetName,rows:entries.length})
    sections.push(`Sheet: ${sheetName}\n${matrix.map(row => row.join('\t')).join('\n')}`)
    formulas += Object.values(sheet).filter(cell => cell?.f).length
  }
  return {text:sections.join('\n\n'),rows,metadata:{format:filename.split('.').pop(),sheets,formulaCells:formulas},
    warnings:formulas ? ['Formula cells use saved workbook results; formulas are not recalculated.'] : []}
}
export function apply(ctx) { register(ctx,{id:'spreadsheet',name:'Excel workbook parser',description:'Reads all sheets in modern XLSX and legacy XLS files, preserving source sheet and row data.',extensions:['.xlsx','.xls','.xlsm','.xlsb','.ods'],parse}) }
