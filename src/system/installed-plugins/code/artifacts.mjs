import {createHash} from 'node:crypto'
import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs'
import {join} from 'node:path'
import {descriptorOf,moduleSource,now,fail} from '../../plugin-studio/code/descriptor.mjs'
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
export const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(canonical(value))).digest('hex')
export function artifacts(ctx,config={}){
 const root=join(config.root||ctx.store.root,'plugin-artifacts');mkdirSync(root,{recursive:true,mode:0o700})
 const directory=plugin=>{if(!/^[\w.-]{1,180}$/.test(plugin.id))fail('Invalid installed extension ID.');return join(root,plugin.ownerId.replace(/[^\w-]/g,'_'),plugin.id)}
 const list=id=>ctx.store.list('system','studio-revisions').filter(row=>row.pluginId===id).sort((a,b)=>b.number-a.number)
 const get=(id,revisionId)=>{const record=ctx.store.get('system','studio-revisions',revisionId);if(!record||record.pluginId!==id)fail('That revision does not belong to this extension.',404);return record}
 const files=(plugin,revision)=>{const dir=join(directory(plugin),'revisions',String(revision.number));return{dir,source:join(dir,'index.mjs'),manifest:join(dir,'plugin.json')}}
 const writeOnce=(file,bytes)=>{if(existsSync(file)){if(readFileSync(file,'utf8')!==bytes)fail('An immutable revision artifact differs from its recorded bytes.',409);return}writeFileSync(file,bytes,{mode:0o600,flag:'wx'})}
 const create=async(plugin,descriptor,{actor,reason='Configuration change',proposalId=null,origin=null}={})=>{
  const number=(list(plugin.id)[0]?.number||0)+1,id=`${plugin.id}:r${number}`,createdAt=now(),contentHash=hash(descriptorOf(descriptor))
  const source=moduleSource({...plugin,...descriptor,revisionId:id,revisionNumber:number,contentHash})
  const manifest=JSON.stringify({name:plugin.id,version:`${number}.0.0`,layer:plugin.global?'system':'userspace',entry:'index.mjs',provides:[],description:descriptor.description,kind:descriptor.kind,ownerId:plugin.ownerId,revisionId:id,contentHash},null,2)+'\n'
  const record={id,pluginId:plugin.id,ownerId:plugin.ownerId,number,descriptor:descriptorOf(descriptor),source,manifest,sourceHash:hash(source),manifestHash:hash(manifest),contentHash,createdAt,actor:actor||plugin.ownerId,reason,proposalId,origin}
  const paths=files(plugin,record);mkdirSync(paths.dir,{recursive:true,mode:0o700});writeOnce(paths.source,source);writeOnce(paths.manifest,manifest)
  await ctx.store.put('system','studio-revisions',record,{actor:record.actor,event:'studio/revision-created'});return record
 }
 const verify=(plugin,revision,{current=false}={})=>{
  const paths=files(plugin,revision),source=current?join(directory(plugin),'index.mjs'):paths.source,manifest=current?join(directory(plugin),'plugin.json'):paths.manifest,differences=[]
  const actual={sourceHash:existsSync(source)?hash(readFileSync(source)):null,manifestHash:existsSync(manifest)?hash(readFileSync(manifest)):null}
  for(const key of ['sourceHash','manifestHash'])if(actual[key]!==revision[key])differences.push({field:`${current?'active artifact':'revision artifact'}.${key}`,expected:revision[key],actual:actual[key]})
  if(hash(revision.source)!==revision.sourceHash)differences.push({field:'record.sourceHash',expected:revision.sourceHash,actual:hash(revision.source)})
  if(hash(revision.manifest)!==revision.manifestHash)differences.push({field:'record.manifestHash',expected:revision.manifestHash,actual:hash(revision.manifest)})
  if(hash(descriptorOf(revision.descriptor))!==revision.contentHash)differences.push({field:'record.contentHash',expected:revision.contentHash,actual:hash(descriptorOf(revision.descriptor))})
  return{ok:!differences.length,differences,actual,source,manifest}
 }
 const install=(plugin,revision)=>{
  const checked=verify(plugin,revision);if(!checked.ok)fail('Revision artifacts are inconsistent. Inspect the artifact inventory before restoring.',409)
  const dir=directory(plugin);mkdirSync(dir,{recursive:true,mode:0o700})
  for(const [name,bytes]of[['index.mjs',revision.source],['plugin.json',revision.manifest]]){const temporary=join(dir,`${name}.${process.pid}.tmp`);writeFileSync(temporary,bytes,{mode:0o600});renameSync(temporary,join(dir,name))}
  if(revision.descriptor.kind==='skill')writeFileSync(join(dir,'SKILL.md'),`---\nname: ${JSON.stringify(revision.descriptor.name)}\ndescription: ${JSON.stringify(revision.descriptor.description)}\n---\n\n${revision.descriptor.spec.prompt}\n\n${(revision.descriptor.spec.steps||[]).map((step,i)=>`${i+1}. ${step}`).join('\n')}\n`,{mode:0o600})
  const result=verify(plugin,revision,{current:true});if(!result.ok)fail('The active artifact did not match the selected revision.',409);return result.source
 }
 const retainLegacy=plugin=>{const file=join(directory(plugin),'index.mjs');if(existsSync(file)){const bytes=readFileSync(file),legacy=join(directory(plugin),'legacy-unversioned.mjs');if(!existsSync(legacy))writeFileSync(legacy,bytes,{mode:0o600,flag:'wx'});return hash(bytes)}return null}
 return{root,directory,files,list,get,create,verify,install,retainLegacy}
}
