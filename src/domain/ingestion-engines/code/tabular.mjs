import { require, register, tableRows, decode } from './common.mjs'
const {parse:parseCsv} = require('csv-parse/sync')
export const name = 'ingestion-tabular'
export const inject = ['ingestion']
export async function parse({buffer,filename,settings={}}) {
  const text = decode(buffer)
  let delimiter = settings.delimiter || 'auto'
  if (delimiter === 'auto') {
    if (/\.tsv$/i.test(filename)) delimiter = '\t'
    else {
      const first = text.split(/\r?\n/).find(line => line.trim()) || ''
      delimiter = [',',';','\t','|'].map(value => {
        try { return {value,count:parseCsv(first,{delimiter:value,relax_quotes:true})[0]?.length || 0} }
        catch { return {value,count:0} }
      }).sort((a,b) => b.count-a.count)[0].value
    }
  }
  const matrix = parseCsv(text,{delimiter,bom:true,skip_empty_lines:true,relax_column_count:true,trim:true})
  return {text,rows:tableRows(matrix),metadata:{delimiter:delimiter === '\t' ? 'tab' : delimiter,physicalRows:matrix.length},warnings:[]}
}
export function apply(ctx) { register(ctx,{id:'tabular',name:'CSV and TSV parser',description:'Reads quoted fields, multiline cells, UTF-8/UTF-16 and comma, tab, semicolon or pipe delimiters.',extensions:['.csv','.tsv'],parse}) }
