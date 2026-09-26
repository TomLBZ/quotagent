#!/usr/bin/env python3
"""Read-only current documentation/catalog consistency; open work stays visible."""
from pathlib import Path
from collections import Counter
from urllib.parse import unquote
import hashlib,json,re,subprocess,sys
ROOT=Path(__file__).resolve().parents[4]
errors=[]
def check(condition,message):
 if not condition:errors.append(message)
def exists(path):return (ROOT/path).is_file()
def source_bytes(source):
 if source.get('revision'):
  result=subprocess.run(['git','show',source['revision']+':'+source['path']],cwd=ROOT,capture_output=True)
  check(result.returncode==0,'Unresolvable source: '+source['path'])
  return result.stdout
 return source.get('text','').encode()
def main():
 path=ROOT/'docs/requirements/catalog.json'
 try:catalog=json.loads(path.read_text())
 except (OSError,ValueError) as error:print('FAIL catalog:',error);return 1
 check(catalog.get('schema')=='quotagent/requirements-catalog/v1','Unknown catalog schema')
 check(path.stat().st_size<=catalog.get('budgetBytes',0),'Catalog exceeds declared byte budget')
 rows=catalog.get('requirements',[]);ids=[row.get('id') for row in rows]
 check(len(ids)==len(set(ids)),'Duplicate clause identifiers')
 expected=catalog.get('audit',{}).get('counts',{})
 for family,count in expected.items():check(sum(row.get('family')==family for row in rows)==count,'Missing audited '+family+' clauses')
 check(len(rows)>=catalog.get('audit',{}).get('total',1),'Audited clauses disappeared')
 sources=catalog.get('sources',{});source_cache={}
 for key,source in sources.items():
  check(key==source.get('path'),'Source path key mismatch: '+key)
  data=source_bytes(source);source_cache[key]=data.decode(errors='replace')
  check(bool(data),'Empty source: '+key)
  check(hashlib.sha256(data).hexdigest()==source.get('sha256'),'Source digest mismatch: '+key)
  check(bool(source.get('revision')) or source.get('kind')=='session-recovery-source','Source needs immutable revision or retained session text: '+key)
 historical=set()
 for key,text in source_cache.items():
  if re.search(r'docs/work/functional-requirements(?:-archive(?:-b)?)?\.md$',key):historical.update(re.findall(r'^\|\s*(FR-[A-Z]+-\d+)\s*\|',text,re.M))
 check(historical=={row['id'] for row in rows if row['family']=='historical'},'Historical definition IDs differ from immutable source tables')
 plugins=catalog.get('plugins',{})
 for owner,value in plugins.items():
  check(exists(value['root']+'/plugin.json'),'Owner has no plugin manifest: '+owner)
  check(exists(value['contract']),'Owner has no current contract: '+owner)
 for row in rows:
  id=row['id'];check(row.get('owner') in plugins,'Unknown sole owner: '+id)
  check(bool(row.get('originalText')),'Missing original clause: '+id)
  check(bool(row.get('sources')),'Missing provenance: '+id)
  for ref in row.get('sources',[]):check(ref.get('source') in sources,'Unknown source reference: '+id)
  check(exists(row.get('contract','')),'Missing current contract: '+id)
  check(row.get('status') in catalog.get('statusVocabulary',{}),'Unknown acceptance state: '+id)
  if row.get('status')=='verified':
   check(bool(row.get('acceptance')),'Verified without evidence: '+id)
   for proof in row.get('acceptance',[]):
    check(all(proof.get(field) for field in ['command','evidence','scope','observed']),'Incomplete proof metadata: '+id)
    check(exists(proof.get('evidence','')),'Missing evidence file: '+id)
    for script in re.findall(r'(?:src|tools|host)/[^\s`]+\.(?:mjs|py|sh)',proof.get('command','')):check(exists(script),'Missing acceptance executable '+script+' for '+id)
  if row.get('status')=='superseded':check(bool(row.get('resolution')) and bool(row.get('replacement')),'Superseded without reason/replacement: '+id)
 for entry in catalog.get('documents',[]):
  check(entry.get('source') in sources,'Removed document missing source: '+str(entry))
  check(entry.get('disposition') in ['removed-obsolete','replaced-current','retained-history','retained-contract'],'Unknown document disposition')
  check(bool(entry.get('replacement')),'Document missing replacement route: '+entry.get('source',''))
 current=set(catalog.get('currentDocuments',[]))|{'AGENTS.md','README.md'}
 for item in current:
  file=ROOT/item;check(file.is_file(),'Current document missing: '+item)
  if not file.is_file():continue
  text=file.read_text();match=re.search(r'<!--\s*budget:\s*(\d+)\s*bytes',text)
  check(bool(match),'No declared byte budget: '+item)
  if match:check(file.stat().st_size<=int(match[1]),'Byte budget exceeded: '+item)
  for target in re.findall(r'\]\(([^\s)]+)(?:\s+"[^"]*")?\)',text):
   if target.startswith(('http:','https:','mailto:','#')):continue
   target=unquote(target.split('#')[0]).split('?')[0]
   if target:check((file.parent/target).resolve().exists(),'Broken current link '+target+' in '+item)
 check((ROOT/'AGENTS.md').stat().st_size<=4096,'AGENTS.md exceeds4096bytes')
 handover=ROOT/'docs/work/handover.md'
 if handover.exists():check(handover.stat().st_size<=1024,'handover.md exceeds1024bytes')
 counts=Counter(row['status'] for row in rows)
 report={'ok':not errors,'clauses':len(rows),'owners':len(plugins),'sources':len(sources),'currentDocuments':len(current),'acceptanceStates':dict(sorted(counts.items())),'meaning':'Documentation consistency only; unresolved compatible requirements remain open.','errors':errors}
 print(json.dumps(report,ensure_ascii=False,indent=2));return bool(errors)
if __name__=='__main__':sys.exit(main())
