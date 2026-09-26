#!/usr/bin/env node
// Standalone verification uses only these two supplied files, never an account ledger.
import {readFileSync} from 'node:fs'
import {verifyBundle} from '../code/bundle.mjs'
const [packagePath,keyPath]=process.argv.slice(2)
if(!packagePath){console.error('Usage: node src/system/evidence/tools/verify-native.mjs PACKAGE.audit.json TRUSTED.public.pem');process.exitCode=2}else{try{const bundle=JSON.parse(readFileSync(packagePath,'utf8')),trustedPublicKey=keyPath?readFileSync(keyPath,'utf8'):'';const result=await verifyBundle(bundle,{trustedPublicKey});console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1}catch(error){console.error(error.message);process.exitCode=1}}
