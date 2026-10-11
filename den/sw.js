/* Мой день: offline cache + push, version a80802b9 */
const CACHE="moyden-a80802b9";
const CORE=["./","index.html","config.js","manifest.webmanifest","icons/icon-192.png","icons/icon-512.png","icons/apple-touch-icon.png","icons/favicon-32.png"];
self.addEventListener("install",e=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting())); });
self.addEventListener("activate",e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith("moyden-")&&k!==CACHE&&k!=="moyden-cfg").map(k=>caches.delete(k)))).then(()=>self.clients.claim())); });
self.addEventListener("fetch",e=>{
  const req=e.request; if(req.method!=="GET") return;
  const url=new URL(req.url);
  if(url.origin===location.origin&&url.pathname.endsWith("/config.js")){
    e.respondWith(fetch(req,{cache:"no-store"}).then(r=>{ const cp=r.clone(); caches.open(CACHE).then(c=>c.put(req,cp)); return r; }).catch(()=>caches.match(req)));
  } else if(url.origin===location.origin){
    e.respondWith(caches.match(req,{ignoreSearch:true}).then(hit=>{
      const net=fetch(req).then(r=>{ if(r&&r.ok){ const cp=r.clone(); caches.open(CACHE).then(c=>c.put(req,cp)); } return r; }).catch(()=>hit);
      return hit||net;
    }));
  } else if(/fonts\.(googleapis|gstatic)\.com/.test(url.host)){
    e.respondWith(caches.match(req).then(hit=>hit||fetch(req).then(r=>{ const cp=r.clone(); caches.open(CACHE).then(c=>c.put(req,cp)); return r; }).catch(()=>hit)));
  }
});
/* Напоминания: сервер шлёт пустой сигнал, текст забираем с сервера */
self.addEventListener("push",e=>{
  e.waitUntil((async()=>{
    let msgs=[];
    try{
      const hit=await (await caches.open("moyden-cfg")).match("cfg");
      const cfg=hit?await hit.json():null;
      if(cfg&&cfg.api&&cfg.sub){ const r=await fetch(cfg.api+"/api/inbox?s="+cfg.sub,{cache:"no-store"}); msgs=(await r.json()).messages||[]; }
    }catch(_){}
    if(!msgs.length) msgs=[{title:"Мой день",body:"Есть напоминание — открой приложение",tag:"moyden"}];
    for(const m of msgs) await self.registration.showNotification(m.title,{body:m.body,tag:m.tag,icon:"icons/icon-192.png",badge:"icons/icon-192.png",data:{url:"./"}});
  })());
});
self.addEventListener("notificationclick",e=>{
  e.notification.close();
  e.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(ws=>{ for(const w of ws){ if("focus" in w) return w.focus(); } return clients.openWindow("./"); }));
});
