/** Build-time generator: exact shell allowlist, no data caching or write replay. */
export function workerSource(files, version, scope='/quotagent/') {
  return `const ROOT=${JSON.stringify(scope)}, FAMILY='quotagent-shell:'+ROOT+':', NAME=FAMILY+${JSON.stringify(version)};
const FILES=${JSON.stringify([scope,...files.map(file=>scope+file)])}, ALLOWED=new Set(FILES);
self.addEventListener('install',event=>event.waitUntil(caches.open(NAME).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith(FAMILY)&&key!==NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin||url.search||!ALLOWED.has(url.pathname))return;
 if(request.mode==='navigate'){
  if(url.pathname===ROOT)event.respondWith(fetch(request).catch(async()=>{const cached=await (await caches.open(NAME)).match(ROOT);if(!cached)throw new Error('Offline shell unavailable');const html=(await cached.text()).replace('<head>','<head><script>window.__QUOTAGENT_OFFLINE_SHELL__=true</script>'),headers=new Headers(cached.headers);headers.delete('content-length');headers.set('cache-control','no-store');headers.set('x-quotagent-offline','1');return new Response(html,{status:200,headers})}));
  return;
 }
 event.respondWith(caches.open(NAME).then(async cache=>await cache.match(request)||fetch(request)));
});
`
}
