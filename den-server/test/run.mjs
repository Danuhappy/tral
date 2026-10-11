import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker, { runReminders, idsForKey } from '../src/worker.js';
const V = JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
// --- D1 mock ---
const sql = new DatabaseSync(':memory:');
const norm = v => v === undefined ? null : v;
function prep(q){ let args=[]; const o={ bind(...a){args=a.map(norm);return o}, async run(){sql.prepare(q).run(...args);return {success:true}}, async first(){return sql.prepare(q).get(...args)??null}, async all(){return {results:sql.prepare(q).all(...args)}}, _x(){ return /^\s*select/i.test(q)? sql.prepare(q).all(...args): sql.prepare(q).run(...args)} }; return o }
const DB = { prepare: prep, async batch(list){ sql.exec('BEGIN'); try{ const r=list.map(s=>s._x()); sql.exec('COMMIT'); return r }catch(e){ sql.exec('ROLLBACK'); throw e } } };
const env = { DB, VAPID_PUBLIC: V.pub, VAPID_PRIVATE_JWK: JSON.stringify(V.jwk), VAPID_SUBJECT: 'https://danuhappy.github.io/tral/den/' };
// --- fake push service ---
const pushes=[]; const realFetch=globalThis.fetch;
globalThis.fetch = async (url, init) => { pushes.push({url, init}); return new Response(null,{status:201}) };
const call = (path, body, key='ABCD-EFGH-JKLM-NPQR-STUV') => worker.fetch(new Request('https://x.dev'+path,{method: body? 'POST':'GET', headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'}, body: body? JSON.stringify(body):undefined}), env);
const ok=(c,m)=>{ if(!c){ console.log('FAIL',m); process.exitCode=1 } else console.log('ok  ',m) };

const now=Date.now(); const due=now+30*60000;
const dl=new Date(due); const pad=n=>String(n).padStart(2,'0');
const dueStr=dl.getFullYear()+'-'+pad(dl.getMonth()+1)+'-'+pad(dl.getDate())+'T'+pad(dl.getHours())+':'+pad(dl.getMinutes());
// device A uploads
let r=await (await call('/api/sync',{since:0,changes:[
 {kind:'tasks',id:'t1',updated:now,data:{text:'Позвонить, заказчику; по грузу',due:dueStr,dueTs:due,remind:[0,15,60],done:false}},
 {kind:'expenses',id:'e1',updated:now,data:{amount:1000,cat:'food',note:'рыба',date:'2026-10-11'}},
 {kind:'bad',id:'x',updated:now,data:{}}]})).json();
ok(r.docs.length===2,'A: upload 2 docs, bad kind rejected');
// device B pulls with same key typed differently
const r2=await (await call('/api/sync',{since:0,changes:[]},'abcdefghjklmnpqrstuv')).json();
ok(r2.docs.length===2,'B: same key in lowercase without dashes sees same data');
// older write loses
await call('/api/sync',{since:0,changes:[{kind:'expenses',id:'e1',updated:now-1000,data:{amount:5}}]});
let r3=await (await call('/api/sync',{since:0,changes:[]})).json();
ok(r3.docs.find(d=>d.id==='e1').data.amount===1000,'older change does not overwrite newer');
// delete
await call('/api/sync',{since:0,changes:[{kind:'expenses',id:'e1',updated:now+1,deleted:true}]});
r3=await (await call('/api/sync',{since:r3.now,changes:[]})).json();
ok(r3.docs.some(d=>d.id==='e1'&&d.deleted),'deletion reaches other devices');
// other key isolated
const other=await (await call('/api/sync',{since:0,changes:[]},'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ')).json();
ok(other.docs.length===0,'another key sees nothing');
ok((await call('/api/sync',{since:0,changes:[]},'short')).status===401,'too short key refused');
// reminders
const rem=sql.prepare('SELECT fire,body FROM reminders ORDER BY fire').all();
ok(rem.length===2,'2 future reminders created (1-hour one is already past): '+rem.map(x=>x.body).join(' | '));
// subscribe + cron
const sub=await (await call('/api/push',{endpoint:'https://web.push.apple.com/QWERTY123456'})).json();
ok(/^[0-9a-f]{32}$/.test(sub.id),'push subscription stored');
let n=await runReminders(env, now+1000); ok(n===0,'nothing sent too early');
n=await runReminders(env, due-15*60000+1000); ok(n===1 && pushes.length===1,'15-min reminder sent at the right minute');
const p=pushes[0]; const auth=p.init.headers.Authorization;
const [, jwt, k]=auth.match(/^vapid t=([^,]+), k=(.+)$/);
const [h,c,s]=jwt.split('.');
const pub=await crypto.subtle.importKey('raw',Buffer.from(k,'base64url'),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
const valid=await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pub,Buffer.from(s,'base64url'),new TextEncoder().encode(h+'.'+c));
const claims=JSON.parse(Buffer.from(c,'base64url'));
ok(valid && claims.aud==='https://web.push.apple.com','VAPID signature valid, aud='+claims.aud);
n=await runReminders(env, due-15*60000+30000); ok(n===0,'not sent twice');
const box=await (await call('/api/inbox?s='+sub.id)).json();
ok(box.messages.length===1,'inbox gives message: '+JSON.stringify(box.messages[0]));
ok((await (await call('/api/inbox?s='+sub.id)).json()).messages.length===0,'inbox empties after reading');
// edit task time -> reminders rebuilt
await call('/api/sync',{since:0,changes:[{kind:'tasks',id:'t1',updated:now+5,data:{text:'Позвонить',due:dueStr,dueTs:due+3600000,remind:[0],done:false}}]});
ok(sql.prepare('SELECT count(*) c FROM reminders WHERE sent=0').get().c===1,'moving the task rebuilds its reminders');
await call('/api/sync',{since:0,changes:[{kind:'tasks',id:'t1',updated:now+6,data:{text:'Позвонить',due:dueStr,dueTs:due+3600000,remind:[0],done:true}}]});
ok(sql.prepare('SELECT count(*) c FROM reminders WHERE sent=0').get().c===0,'done task gets no reminder');
// calendar
const ids=await idsForKey('ABCD-EFGH-JKLM-NPQR-STUV');
const ics=await (await call('/cal/'+ids.cal+'.ics')).text();
ok(ics.includes('BEGIN:VEVENT') && ics.includes('✓ Позвонить') && ics.includes('X-WR-CALNAME:Мой день'),'calendar feed works');
ok((await call('/cal/'+'0'.repeat(32)+'.ics')).status===404,'unknown calendar 404');
ok(ics.split('\r\n').every(l=>new TextEncoder().encode(l).length<=75),'ics lines folded to 75 bytes');
// gone subscription cleaned
globalThis.fetch=async()=>new Response(null,{status:410});
await call('/api/sync',{since:0,changes:[{kind:'tasks',id:'t2',updated:now+7,data:{text:'X',due:dueStr,dueTs:now+60000,remind:[0]}}]});
await runReminders(env, now+61000);
ok(sql.prepare('SELECT count(*) c FROM subs').get().c===0,'expired subscription removed');
const opt=await worker.fetch(new Request('https://x.dev/api/sync',{method:'OPTIONS'}),env);
ok(opt.status===204 && opt.headers.get('Access-Control-Allow-Origin')==='*','CORS preflight');
