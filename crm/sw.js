/* Кентавр CRM: offline cache, version 866842f2 */
const CACHE="kentavr-crm-866842f2";
const CORE=["./","index.html","manifest.webmanifest","icons/icon-192.png","icons/apple-touch-icon.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith("kentavr-crm-")&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{
  const req=e.request;if(req.method!=="GET")return;const url=new URL(req.url);
  if(url.origin===location.origin&&url.pathname.startsWith(new URL("./",self.registration.scope).pathname)){
    e.respondWith(fetch(req).then(r=>{if(r&&r.ok){const cp=r.clone();caches.open(CACHE).then(c=>c.put(req,cp))}return r}).catch(()=>caches.match(req,{ignoreSearch:true})));
  }else if(/fonts\.(googleapis|gstatic)\.com/.test(url.host)){
    e.respondWith(caches.match(req).then(hit=>hit||fetch(req).then(r=>{const cp=r.clone();caches.open(CACHE).then(c=>c.put(req,cp));return r})));
  }
});
