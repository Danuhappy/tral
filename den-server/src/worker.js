/*
 * «Мой день» — сервер (Cloudflare Worker + база D1).
 *
 * Что делает:
 *  - /api/sync      хранит записи (задачи, мысли, траты, разделы) и раздаёт их всем устройствам;
 *  - /cal/<код>.ics календарь, на который подписывается iPhone — задачи появляются в Календаре сами;
 *  - /api/push      включает уведомления на устройстве;
 *  - раз в минуту (cron) находит задачи, о которых пора напомнить, и шлёт уведомление.
 *
 * Вход по «ключу»: длинный случайный код, который приложение создаёт само.
 * Сервер хранит не ключ, а его отпечаток (SHA-256), поэтому по базе ключ не узнать.
 */

const KINDS = new Set(["tasks", "thoughts", "expenses", "sections", "prefs"]);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DOC = 64 * 1024;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};
const enc = new TextEncoder();

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS docs (user TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT, updated INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, srv INTEGER NOT NULL, PRIMARY KEY (user, kind, id))",
  "CREATE INDEX IF NOT EXISTS docs_srv ON docs (user, srv)",
  "CREATE TABLE IF NOT EXISTS users (user TEXT PRIMARY KEY, cal TEXT UNIQUE NOT NULL, created INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS subs (id TEXT PRIMARY KEY, user TEXT NOT NULL, endpoint TEXT UNIQUE NOT NULL, created INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS subs_user ON subs (user)",
  "CREATE TABLE IF NOT EXISTS reminders (user TEXT NOT NULL, task TEXT NOT NULL, fire INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user, task, fire))",
  "CREATE INDEX IF NOT EXISTS rem_due ON reminders (sent, fire)",
  "CREATE TABLE IF NOT EXISTS inbox (n INTEGER PRIMARY KEY AUTOINCREMENT, sub TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, tag TEXT NOT NULL, created INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS inbox_sub ON inbox (sub)",
];
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  schemaReady = true;
}

/* ---------------- helpers ---------------- */
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra } });
const err = (msg, status = 400) => json({ error: msg }, status);

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export const normKey = (k) => String(k || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export async function idsForKey(key) {
  const k = normKey(key);
  return { user: (await sha("u:" + k)).slice(0, 32), cal: (await sha("c:" + k)).slice(0, 32) };
}
async function auth(req, env) {
  const m = (req.headers.get("Authorization") || "").match(/^Bearer\s+(\S+)$/);
  if (!m) return null;
  const k = normKey(m[1]);
  if (k.length < 16 || k.length > 64) return null;
  const ids = await idsForKey(k);
  await env.DB.prepare("INSERT OR IGNORE INTO users (user, cal, created) VALUES (?, ?, ?)").bind(ids.user, ids.cal, Date.now()).run();
  return ids;
}

const b64u = (buf) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/* ---------------- reminders ---------------- */
const pad = (n) => String(n).padStart(2, "0");
function remText(m) {
  if (m === 0) return "сейчас";
  if (m < 60) return "через " + m + " мин";
  if (m < 1440) { const h = m / 60; return "через " + h + " " + (h === 1 ? "час" : h < 5 ? "часа" : "часов"); }
  const d = m / 1440; return d === 1 ? "завтра" : "через " + d + " " + (d < 5 ? "дня" : "дней");
}
function remindersFor(user, id, t, now) {
  const out = [];
  if (!t || t.done || !Number.isFinite(t.dueTs) || !t.text) return out;
  const when = typeof t.due === "string" && /T\d\d:\d\d/.test(t.due) ? t.due : null;
  const timeTxt = when ? when.slice(11, 16) : "";
  const dateTxt = when ? when.slice(8, 10) + "." + when.slice(5, 7) : "";
  const list = Array.isArray(t.remind) ? t.remind.filter((m) => Number.isInteger(m) && m >= 0 && m <= 60 * 24 * 30).slice(0, 6) : [];
  for (const m of list) {
    const fire = t.dueTs - m * 60000;
    if (fire < now - 5 * 60000) continue;
    const body = m === 0 ? "Пора" + (timeTxt ? " · " + timeTxt : "") : cap(remText(m)) + (timeTxt ? " · " + (m >= 1440 ? dateTxt + " в " : "в ") + timeTxt : "");
    out.push({ user, task: id, fire, title: String(t.text).slice(0, 120), body });
  }
  return out;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------------- /api/sync ---------------- */
async function sync(req, env, ids) {
  let body;
  try { body = await req.json(); } catch { return err("bad json"); }
  const changes = Array.isArray(body.changes) ? body.changes.slice(0, 500) : [];
  const since = Number(body.since) || 0;
  const now = Date.now();
  const db = env.DB;
  const stmts = [];
  const accepted = [];
  for (const c of changes) {
    if (!c || !KINDS.has(c.kind) || !ID_RE.test(String(c.id))) continue;
    const updated = Number(c.updated);
    if (!Number.isFinite(updated) || updated > now + 5 * 60000) continue;
    const deleted = c.deleted ? 1 : 0;
    const data = deleted ? null : JSON.stringify(c.data ?? {});
    if (data && data.length > MAX_DOC) continue;
    stmts.push(db.prepare(
      "INSERT INTO docs (user, kind, id, data, updated, deleted, srv) VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT (user, kind, id) DO UPDATE SET data = excluded.data, updated = excluded.updated, deleted = excluded.deleted, srv = excluded.srv " +
      "WHERE excluded.updated >= docs.updated"
    ).bind(ids.user, c.kind, String(c.id), data, updated, deleted, now));
    accepted.push({ kind: c.kind, id: String(c.id), updated, deleted, data: deleted ? null : c.data });
  }
  if (stmts.length) await db.batch(stmts);

  // rebuild reminders for tasks whose stored version is the one we just accepted
  const remStmts = [];
  for (const c of accepted) {
    if (c.kind !== "tasks") continue;
    const cur = await db.prepare("SELECT data, deleted, updated FROM docs WHERE user = ? AND kind = 'tasks' AND id = ?").bind(ids.user, c.id).first();
    if (!cur || cur.updated !== c.updated) continue;
    remStmts.push(db.prepare("DELETE FROM reminders WHERE user = ? AND task = ? AND sent = 0").bind(ids.user, c.id));
    if (!cur.deleted) {
      let t; try { t = JSON.parse(cur.data); } catch { t = null; }
      for (const r of remindersFor(ids.user, c.id, t, now))
        remStmts.push(db.prepare("INSERT OR IGNORE INTO reminders (user, task, fire, title, body, sent) VALUES (?, ?, ?, ?, ?, 0)").bind(r.user, r.task, r.fire, r.title, r.body));
    }
  }
  if (remStmts.length) await db.batch(remStmts);

  const rows = await db.prepare("SELECT kind, id, data, updated, deleted FROM docs WHERE user = ? AND srv >= ?").bind(ids.user, since).all();
  const docs = (rows.results || []).map((r) => ({ kind: r.kind, id: r.id, updated: r.updated, deleted: !!r.deleted, data: r.deleted ? null : safeParse(r.data) }));
  return json({ now, docs, cal: ids.cal });
}
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/* ---------------- calendar feed ---------------- */
const icsEsc = (s) => String(s).replace(/\\/g, "\\\\").replace(/[,;]/g, (m) => "\\" + m).replace(/\r?\n/g, "\\n");
function fold(line) {
  const bytes = enc.encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = "", len = 0;
  for (const ch of line) {
    const l = enc.encode(ch).length;
    if (len + l > (out.length ? 74 : 75)) { out.push(cur); cur = ""; len = 0; }
    cur += ch; len += l;
  }
  out.push(cur);
  return out.join("\r\n ");
}
const utc = (ms) => { const d = new Date(ms); return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "Z"; };
async function calendar(token, env) {
  if (!/^[0-9a-f]{32}$/.test(token)) return new Response("Not found", { status: 404 });
  const u = await env.DB.prepare("SELECT user FROM users WHERE cal = ?").bind(token).first();
  if (!u) return new Response("Not found", { status: 404 });
  const rows = await env.DB.prepare("SELECT id, data, updated FROM docs WHERE user = ? AND kind = 'tasks' AND deleted = 0").bind(u.user).all();
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Moy Den//RU", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Мой день", "X-WR-CALDESC:Задачи из приложения «Мой день»", "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M"];
  const stamp = utc(Date.now());
  for (const r of rows.results || []) {
    const t = safeParse(r.data);
    if (!t || !Number.isFinite(t.dueTs)) continue;
    L.push("BEGIN:VEVENT", "UID:" + r.id + "@moy-den", "DTSTAMP:" + stamp, "LAST-MODIFIED:" + utc(r.updated),
      "DTSTART:" + utc(t.dueTs), "DTEND:" + utc(t.dueTs + 15 * 60000),
      "SUMMARY:" + icsEsc((t.done ? "✓ " : "") + (t.text || "Задача")), "STATUS:" + (t.done ? "CANCELLED" : "CONFIRMED"));
    if (!t.done) for (const m of (Array.isArray(t.remind) ? t.remind : []).slice(0, 6))
      if (Number.isInteger(m)) L.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsEsc(t.text || "Задача"), "TRIGGER:-PT" + m + "M", "END:VALARM");
    L.push("END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return new Response(L.map(fold).join("\r\n") + "\r\n", {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-cache", "Content-Disposition": 'inline; filename="moy-den.ics"', ...CORS },
  });
}

/* ---------------- web push (VAPID, без содержимого) ---------------- */
let vapidKey = null;
async function vapidHeaders(endpoint, env) {
  if (!vapidKey) vapidKey = await crypto.subtle.importKey("jwk", JSON.parse(env.VAPID_PRIVATE_JWK), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapidKey, enc.encode(head + "." + claims));
  return { Authorization: `vapid t=${head}.${claims}.${b64u(sig)}, k=${env.VAPID_PUBLIC}`, TTL: "86400", Urgency: "high" };
}
export async function sendPush(sub, env) {
  const headers = await vapidHeaders(sub.endpoint, env);
  const r = await fetch(sub.endpoint, { method: "POST", headers: { ...headers, "Content-Length": "0" } });
  if (r.status === 404 || r.status === 410) {
    await env.DB.prepare("DELETE FROM subs WHERE id = ?").bind(sub.id).run();
    await env.DB.prepare("DELETE FROM inbox WHERE sub = ?").bind(sub.id).run();
  }
  return r.status;
}
async function deliver(user, msgs, env, onlySub) {
  const subs = onlySub ? [onlySub] : ((await env.DB.prepare("SELECT id, endpoint FROM subs WHERE user = ?").bind(user).all()).results || []);
  const now = Date.now();
  const res = [];
  for (const s of subs) {
    await env.DB.batch(msgs.map((m) => env.DB.prepare("INSERT INTO inbox (sub, title, body, tag, created) VALUES (?, ?, ?, ?, ?)").bind(s.id, m.title, m.body, m.tag, now)));
    try { res.push(await sendPush(s, env)); } catch (e) { res.push(String(e)); }
  }
  return res;
}
async function pushSubscribe(req, env, ids) {
  let b; try { b = await req.json(); } catch { return err("bad json"); }
  const ep = String(b.endpoint || "");
  if (!/^https:\/\/[^\s]{10,2000}$/.test(ep)) return err("bad endpoint");
  const id = (await sha("s:" + ep)).slice(0, 32);
  await env.DB.prepare("INSERT INTO subs (id, user, endpoint, created) VALUES (?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET user = excluded.user, id = excluded.id")
    .bind(id, ids.user, ep, Date.now()).run();
  return json({ id });
}
async function pushTest(req, env, ids) {
  let b; try { b = await req.json(); } catch { return err("bad json"); }
  const s = await env.DB.prepare("SELECT id, endpoint FROM subs WHERE id = ? AND user = ?").bind(String(b.id || ""), ids.user).first();
  if (!s) return err("not subscribed", 404);
  const r = await deliver(ids.user, [{ title: "Мой день", body: "Проверка: уведомления работают", tag: "test" }], env, s);
  return json({ status: r[0] });
}
async function inbox(url, env) {
  const s = url.searchParams.get("s") || "";
  if (!/^[0-9a-f]{32}$/.test(s)) return json({ messages: [] });
  const rows = await env.DB.prepare("SELECT n, title, body, tag FROM inbox WHERE sub = ? ORDER BY n LIMIT 20").bind(s).all();
  const list = rows.results || [];
  if (list.length) await env.DB.prepare("DELETE FROM inbox WHERE sub = ? AND n <= ?").bind(s, list[list.length - 1].n).run();
  return json({ messages: list.map((r) => ({ title: r.title, body: r.body, tag: r.tag })) });
}

/* ---------------- cron: каждую минуту ---------------- */
export async function runReminders(env, now = Date.now()) {
  await ensureSchema(env.DB);
  const db = env.DB;
  await db.prepare("UPDATE reminders SET sent = 1 WHERE sent = 0 AND fire < ?").bind(now - 60 * 60000).run();
  const due = (await db.prepare("SELECT user, task, fire, title, body FROM reminders WHERE sent = 0 AND fire <= ? ORDER BY fire LIMIT 300").bind(now).all()).results || [];
  if (!due.length) return 0;
  await db.batch(due.map((r) => db.prepare("UPDATE reminders SET sent = 1 WHERE user = ? AND task = ? AND fire = ?").bind(r.user, r.task, r.fire)));
  const byUser = new Map();
  for (const r of due) { if (!byUser.has(r.user)) byUser.set(r.user, []); byUser.get(r.user).push({ title: r.title, body: r.body, tag: r.task + ":" + r.fire }); }
  for (const [user, msgs] of byUser) await deliver(user, msgs, env);
  await db.prepare("DELETE FROM inbox WHERE created < ?").bind(now - 3 * 86400000).run();
  return due.length;
}

/* ---------------- router ---------------- */
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    try {
      await ensureSchema(env.DB);
      const p = url.pathname;
      if (p === "/" || p === "/api/health") return json({ ok: true, app: "moy-den", vapid: env.VAPID_PUBLIC || null });
      let m = p.match(/^\/cal\/([0-9a-f]{32})\.ics$/);
      if (m && req.method === "GET") return calendar(m[1], env);
      if (p === "/api/inbox" && req.method === "GET") return inbox(url, env);
      if (req.method !== "POST") return err("not found", 404);
      const ids = await auth(req, env);
      if (!ids) return err("no key", 401);
      if (p === "/api/sync") return sync(req, env, ids);
      if (p === "/api/push") return pushSubscribe(req, env, ids);
      if (p === "/api/push/test") return pushTest(req, env, ids);
      return err("not found", 404);
    } catch (e) {
      return err("server error: " + (e && e.message || e), 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  },
};
