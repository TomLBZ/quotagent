import { require } from '../code/common.mjs'
import { mkdirSync,writeFileSync } from 'node:fs'
import { join } from 'node:path'
const XLSX=require('xlsx'), CFB=require('cfb'), JSZip=require('jszip')
const headers=['Description','Quantity','Unit','Unit Price']
const entries=[['CAT6 cable, installed and tested',1500,'m',1.8],['Dual data outlet with faceplate',48,'each',9.5]]
const esc=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
function pdf(lines) {
  const stream=['BT /F1 12 Tf 50 760 Td',...lines.map((line,index)=>`${index?'0 -20 Td ':''}(${line.replace(/[()\\]/g,'\\$&')}) Tj`),'ET'].join('\n')
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`]
  let body='%PDF-1.4\n',offsets=[0]
  objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(body));body+=`${index+1} 0 obj\n${object}\nendobj\n`})
  const xref=Buffer.byteLength(body)
  body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')
  body+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(body)
}
export async function fixtures(directory) {
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Riverside quotation'],headers,...entries]),'Offer')
  const xlsx=XLSX.write(book,{type:'buffer',bookType:'xlsx'})
  const mixedBook=XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(mixedBook,XLSX.utils.aoa_to_sheet([headers,entries[0]]),'Cabling')
  XLSX.utils.book_append_sheet(mixedBook,XLSX.utils.aoa_to_sheet([['Item','Qty','UOM','Rate'],entries[1]]),'Outlets')
  const html=`<html><body><h1>Riverside quotation</h1><table>${[headers,...entries].map((row,index)=>`<tr>${row.map(value=>`<${index?'td':'th'}>${esc(value)}</${index?'td':'th'}>`).join('')}</tr>`).join('')}</table></body></html>`
  const zip=new JSZip()
  zip.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml',`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Riverside quotation</w:t></w:r></w:p><w:tbl>${[headers,...entries].map(row=>`<w:tr>${row.map(value=>`<w:tc><w:p><w:r><w:t>${esc(value)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl></w:body></w:document>`)
  const plain='1500 m CAT6 cable, installed and tested @ 1.80\n48 each Dual data outlet with faceplate @ 9.50'
  const eml=['From: Taylor <supplier@example.test>','To: Buyer <buyer@example.test>','Subject: Riverside cabling offer','Date: Fri, 25 Sep 2026 10:00:00 +0000','MIME-Version: 1.0','Content-Type: multipart/mixed; boundary="quote-boundary"','','--quote-boundary','Content-Type: text/plain; charset=utf-8','','Please see the attached detailed cabling offer.','Payment is 30 days after delivery. Lead time is 12 days.','','--quote-boundary','Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition: attachment; filename="cabling-offer.xlsx"','Content-Transfer-Encoding: base64','',xlsx.toString('base64'),'--quote-boundary--',''].join('\r\n')
  const message=subject=>`From: supplier@example.test\r\nTo: buyer@example.test\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${plain}\r\n`
  const msg=CFB.utils.cfb_new({root:'Root Entry'})
  for(const [tag,value]of Object.entries({'0037001F':'Riverside cabling offer','1000001F':plain,'0C1A001F':'Taylor Supplier','0C1F001F':'supplier@example.test'}))CFB.utils.cfb_add(msg,'__substg1.0_'+tag,Buffer.from(value+'\0','utf16le'))
  CFB.utils.cfb_add(msg,'__properties_version1.0',Buffer.alloc(32))
  CFB.utils.cfb_add(msg,'__attach_version1.0_#00000000/__properties_version1.0',Buffer.alloc(8))
  CFB.utils.cfb_add(msg,'__attach_version1.0_#00000000/__substg1.0_3707001F',Buffer.from('offer.csv\0','utf16le'))
  CFB.utils.cfb_add(msg,'__attach_version1.0_#00000000/__substg1.0_37010102',Buffer.from('Description,Quantity,Unit\nWidget,2,each'))
  const records={
    'cabling-offer.xlsx':xlsx,'cabling-offer.xls':XLSX.write(book,{type:'buffer',bookType:'xls'}),
    'mixed-headings.xlsx':XLSX.write(mixedBook,{type:'buffer',bookType:'xlsx'}),
    'cabling-offer.csv':Buffer.from(headers.join(',')+'\n'+entries.map(row=>row.map(value=>`"${String(value).replace(/"/g,'""')}"`).join(',')).join('\n')),
    'quoted-multiline.csv':Buffer.from('Description,Quantity,Unit,Unit Price\n"Panel, white",12,each,42.50\n"Sensor\nceiling",4,each,18\n'),
    'cabling-offer.tsv':Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from([headers,...entries].map(row=>row.join('\t')).join('\n'),'utf16le')]),
    'cabling-offer.docx':await zip.generateAsync({type:'nodebuffer'}),'cabling-offer.pdf':pdf(plain.split('\n')),'scan-placeholder.pdf':pdf([]),
    'cabling-offer.txt':Buffer.from(plain),'cabling-offer.html':Buffer.from(html),
    'cabling-offer.json':Buffer.from(JSON.stringify({items:entries.map(row=>({description:row[0],quantity:row[1],unit:row[2],unitPrice:row[3]}))})),
    'cabling-offer.eml':Buffer.from(eml),'cabling-offer.mbox':Buffer.from(`From supplier@example.test Fri Sep 25 10:00:00 2026\n${message('First offer')}\nFrom supplier@example.test Fri Sep 25 10:01:00 2026\n${message('Revised offer')}`),
    'cabling-offer.msg':CFB.write(msg,{type:'buffer'}),
  }
  if(directory){mkdirSync(directory,{recursive:true});for(const [name,buffer]of Object.entries(records))writeFileSync(join(directory,name),buffer)}
  return records
}
