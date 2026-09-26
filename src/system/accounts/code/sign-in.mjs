/** Transient bounded cooldown. Expiry permits a new attempt, never a session. */
export function signInCooldown(clock=Date.now){
 const failures=new Map(),windowMs=5*60*1000,cooldownMs=30*1000,maximum=1000
 const current=email=>{const row=failures.get(email);if(row&&(row.until?row.until<=clock():row.started+windowMs<=clock())){failures.delete(email);return null}return row}
 return {
  blocked:email=>(current(email)?.until||0)>clock(),
  failed(email){const old=current(email)||{count:0,started:clock(),until:0};if(old.until>clock())return;const count=old.count+1;failures.delete(email);failures.set(email,{...old,count,until:count>=5?clock()+cooldownMs:0});while(failures.size>maximum)failures.delete(failures.keys().next().value)},
  clear:email=>failures.delete(email),dispose:()=>failures.clear(),
 }
}
