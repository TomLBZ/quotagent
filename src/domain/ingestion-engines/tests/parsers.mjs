import assert from 'node:assert/strict'
import {resolve} from 'node:path'
import {fixtures} from './fixtures.mjs'
import * as email from '../code/email.mjs'
import * as spreadsheet from '../code/spreadsheet.mjs'
import * as tabular from '../code/tabular.mjs'
import * as documents from '../code/documents.mjs'
const files=await fixtures(resolve('tmp/ingestion-fixtures'))
const output=[]
for(const [filename,buffer]of Object.entries(files)) {
  const engine=/\.(eml|mbox|msg)$/.test(filename)?email:/\.(xlsx|xls)$/.test(filename)?spreadsheet:/\.(csv|tsv)$/.test(filename)?tabular:documents
  const parsed=await engine.parse({filename,buffer,settings:{delimiter:'auto'}})
  if(filename==='scan-placeholder.pdf')assert.match(parsed.warnings.join(' '),/no extractable text/)
  else if(filename.endsWith('.eml')){assert.equal(parsed.attachments.length,1);assert.match(parsed.text,/Payment is 30 days/);assert.equal(parsed.attachments[0].buffer.length,files['cabling-offer.xlsx'].length)}
  else if(filename.endsWith('.mbox')){assert.equal(parsed.metadata.messages,2);assert.equal(parsed.rows.length,4)}
  else {assert.equal(parsed.rows.length,2,`${filename} must extract two actual lines`);assert.ok(parsed.text.length>20)}
  if(filename==='quoted-multiline.csv'){assert.equal(parsed.rows[0].Description,'Panel, white');assert.equal(parsed.rows[1].Description,'Sensor\nceiling')}
  if(filename.endsWith('.msg')){assert.equal(parsed.attachments.length,1);assert.equal(parsed.attachments[0].filename,'offer.csv')}
  output.push({filename,rows:parsed.rows.length,attachments:parsed.attachments?.length||0,warnings:parsed.warnings})
}
console.log(JSON.stringify({ok:true,fixtures:'tmp/ingestion-fixtures',formats:output},null,2))
