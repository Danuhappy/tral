// Local stand-in for Cloudflare: runs the worker on http://localhost:8788 with SQLite as D1
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from '../src/worker.js';
const V = JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const sql = new DatabaseSync(':memory:');
const norm = v => v === undefined ? null : v;
function prep(q){ let args=[]; const o={ bind(...a){args=a.map(norm);return o}, async run(){sql.prepare(q).run(...args);return {}}, async first(){return sql.prepare(q).get(...args)??null}, async all(){return {results:sql.prepare(q).all(...args)}}, _x(){ return /^\s*select/i.test(q)? sql.prepare(q).all(...args): sql.prepare(q).run(...args)} }; return o }
const DB = { prepare: prep, async batch(list){ sql.exec('BEGIN'); try{ const r=list.map(s=>s._x()); sql.exec('COMMIT'); return r }catch(e){ sql.exec('ROLLBACK'); throw e } } };
const env = { DB, VAPID_PUBLIC: V.pub, VAPID_PRIVATE_JWK: JSON.stringify(V.jwk), VAPID_SUBJECT: 'https://danuhappy.github.io/tral/den/' };
http.createServer(async (req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);
  const r=await worker.fetch(new Request('http://localhost:8788'+req.url,{method:req.method,headers:req.headers,body:['GET','HEAD','OPTIONS'].includes(req.method)?undefined:Buffer.concat(chunks)}),env);
  res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8788,()=>console.log('api on 8788'));
