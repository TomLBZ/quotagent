/** Long-lived loopback-only fictitious services for browser verification. Never forwards messages. */
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {localServices} from './product-fixtures.mjs'
import {fixtures} from '../../../domain/ingestion-engines/tests/fixtures.mjs'
const source=await fixtures(),services=await localServices({source:source['cabling-offer.eml']})
const directory=resolve(process.env.EVIDENCE_DIR||'tmp/product-evidence/external-connections/fixture')
mkdirSync(directory,{recursive:true})
const details={loopbackOnly:true,neverForwards:true,imapPort:services.imapPort,smtpPort:services.smtpPort,telegramBase:services.telegramBase,
  statusUrl:services.telegramBase+'/fixture/status',mailSettings:{enabled:true,fromName:'Fixture buyer',fromAddress:'buyer@fixture.invalid',imapHost:'127.0.0.1',imapPort:services.imapPort,imapSecurity:'plain',imapUser:'fixture',imapPassword:'fixture-password',smtpHost:'127.0.0.1',smtpPort:services.smtpPort,smtpSecurity:'plain',smtpUser:'fixture',smtpPassword:'fixture-password',sentMailbox:'Sent'},
  telegramSettings:{enabled:true,botToken:'fixture-token',defaultChatId:'4242'}}
writeFileSync(join(directory,'connection.json'),JSON.stringify(details,null,2)+'\n')
console.log(JSON.stringify({ready:true,...details,directory}))
let stopping=false
const stop=async()=>{if(stopping)return;stopping=true;writeFileSync(join(directory,'receipts.json'),JSON.stringify({smtp:services.smtpMessages.map(message=>({envelope:message.envelope,source:message.source.toString()})),telegram:services.telegramSent},null,2)+'\n');await services.close();process.exit(0)}
process.once('SIGINT',stop);process.once('SIGTERM',stop)
