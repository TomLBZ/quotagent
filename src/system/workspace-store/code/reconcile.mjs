const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value
const equal = (left,right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
const clone = value => value === undefined ? undefined : structuredClone(value)
// Only transferred public keys are considered. Local-only data never becomes a
// suggestion, conflict payload or outbound package.
export function reconcile({from,to,collection,record,local,base,metadata}, policy) {
  if (!local) return {record:clone(record),conflicts:[]}
  const conflicts=[], decisions=[]
  const visit=(incoming,mine,prior,path=[])=>{
    if(equal(incoming,mine))return clone(mine)
    if(incoming && typeof incoming==='object' && !Array.isArray(incoming)) {
      const result=mine&&typeof mine==='object'&&!Array.isArray(mine)?clone(mine):{}
      for(const key of new Set([...Object.keys(incoming),...Object.keys(prior&&typeof prior==='object'&&!Array.isArray(prior)?prior:{})])){const value=visit(incoming[key],mine?.[key],prior?.[key],[...path,key]);if(value===undefined)delete result[key];else result[key]=value}
      return result
    }
    if(Array.isArray(incoming)&&incoming.every(row=>row&&typeof row==='object'&&typeof row.id==='string'))return incoming.map(row=>visit(row,Array.isArray(mine)?mine.find(item=>item.id===row.id):undefined,Array.isArray(prior)?prior.find(item=>item.id===row.id):undefined,[...path,row.id]))
    if(prior!==undefined&&equal(incoming,prior))return clone(mine)
    if(mine===undefined||prior!==undefined&&equal(mine,prior))return clone(incoming)
    // Without a shared base, an authority-owned update is still meaningful. A
    // concurrent modification of commitment fields always needs human review.
    const authority=policy?.authority?.({collection,path,record,from,to})
    const owner=authority?.owner
    const concurrent=prior!==undefined&&!equal(mine,prior)&&!equal(incoming,prior)
    const commitment=authority?.commitment??metadata?.eventClass==='commitment'
    if((owner==='sender'||owner===from)&&!(commitment&&concurrent)){decisions.push({path:path.join('.'),choice:'sender',owner,reason:'declared authority',base:clone(prior)??null,local:clone(mine)??null,incoming:clone(incoming)??null});return clone(incoming)}
    if((owner==='recipient'||owner===to)&&!(commitment&&concurrent)){decisions.push({path:path.join('.'),choice:'recipient',owner,reason:'declared authority',base:clone(prior)??null,local:clone(mine)??null,incoming:clone(incoming)??null});return clone(mine)}
    // Metadata timestamps are descriptive; their updates alone cannot turn an
    // otherwise compatible record into a monetary conflict.
    if(['updatedAt','revision'].includes(path[0])&&!concurrent)return clone(incoming)
    if(!policy)return clone(incoming)
    conflicts.push({path:path.join('.'),base:clone(prior)??null,local:clone(mine)??null,incoming:clone(incoming)??null,owner:owner||'unknown',commitment:!!commitment})
    return clone(mine)
  }
  return {record:visit(record,local,base),conflicts,decisions}
}

// Accept only the incoming public shape; preserve local-only private extensions.
export function acceptPublic(local,incoming,base){
 if(Array.isArray(incoming)&&incoming.every(row=>row&&typeof row==='object'&&typeof row.id==='string'))return incoming.map(row=>acceptPublic(local?.find?.(item=>item.id===row.id),row,base?.find?.(item=>item.id===row.id)))
 if(incoming&&typeof incoming==='object'&&!Array.isArray(incoming)){const result=local&&typeof local==='object'?clone(local):{};for(const key of new Set([...Object.keys(incoming),...Object.keys(base&&typeof base==='object'&&!Array.isArray(base)?base:{})])){if(!Object.hasOwn(incoming,key))delete result[key];else result[key]=acceptPublic(local?.[key],incoming[key],base?.[key])}return result}
 return clone(incoming)
}
