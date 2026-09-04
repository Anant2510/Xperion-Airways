// Modern-Retailing validation harness — exercises the live server.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const B = process.env.BASE || 'http://127.0.0.1:3000';
const out = [];
const log = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };

async function J(path, opts = {}) {
  const r = await fetch(B + path, opts);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; }
  catch { return { status: r.status, body: t.slice(0, 300) }; }
}
const P = (path, obj, hdr = {}) => J(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...hdr },
  body: JSON.stringify(obj),
});

(async () => {
  log('\n########## 1. PERSONAS ##########');
  const per = await J('/api/personas');
  const personas = Array.isArray(per.body) ? per.body : (per.body.personas || []);
  log('status', per.status, '| count', personas.length);
  log(JSON.stringify(personas).slice(0, 700));

  log('\n########## 2. PRICE VARIANCE BY CUSTOMER ##########');
  log('Same route+date, different personas. If Modern Retailing were real, price/offer differs.');
  const ids = personas.map(p => p.id || p.key || p).slice(0, 4);
  const seen = {};
  for (const pid of ids) {
    await P('/api/persona', { persona: pid, id: pid });
    const f = await J('/api/flights?origin=JFK&dest=MIA&date=2026-09-20');
    const list = f.body.flights || f.body || [];
    const sig = (Array.isArray(list) ? list : []).slice(0, 5)
      .map(x => `${x.flight_no}:${x.price}`).join(' ');
    seen[pid] = sig;
    log(`  persona ${String(pid).padEnd(10)} → ${sig || JSON.stringify(f.body).slice(0, 120)}`);
  }
  const uniq = new Set(Object.values(seen).filter(Boolean));
  log(`  DISTINCT PRICE VECTORS: ${uniq.size} across ${ids.length} personas`);
  log(uniq.size <= 1
    ? '  ⇒ VERDICT: price is IDENTICAL for every customer. No customer-specific pricing.'
    : '  ⇒ VERDICT: price varies by customer.');

  log('\n########## 3. ANCILLARY CATALOGUE ##########');
  const anc = await J('/api/ancillaries');
  const acat = anc.body.ancillaries || anc.body || [];
  log('count', Array.isArray(acat) ? acat.length : '?');
  log(JSON.stringify(acat).slice(0, 500));
  log('  → check: does any ancillary carry eligibility rules / per-segment price?');

  log('\n########## 4. FULL AGENT FLOW (A2UI cards) ##########');
  const sid = 'val-' + Date.now();
  const turns = [
    'flights from New York to Miami on 20 September',
    'select the cheapest one',
    'add lounge and a checked bag',
    'pay for it',
    'check me in',
  ];
  const msgs = [];
  for (const t of turns) {
    msgs.push({ role: 'user', content: t });
    const r = await P('/api/ai/agent', { messages: msgs, sessionId: sid });
    const b = r.body || {};
    const cards = (b.cards || []).map(c => c.type).join(',');
    log(`  "${t}"\n     ai=${b.ai} cards=[${cards}]\n     reply="${String(b.reply || '').slice(0, 120)}"`);
    msgs.push({ role: 'assistant', content: b.reply || '' });
  }

  log('\n########## 5. MULTI-TENANT (nordvind) ##########');
  const nv = await P('/api/ai/agent',
    { messages: [{ role: 'user', content: 'flights from Oslo to Copenhagen' }], sessionId: 'nv-' + Date.now() },
    { 'x-airline-tenant': 'nordvind' });
  log('  brand:', JSON.stringify(nv.body.brand));
  log('  cards:', (nv.body.cards || []).map(c => c.type).join(','));
  log('  reply:', String(nv.body.reply || '').slice(0, 200));
  log('  ⇒ does a NON-Xperion tenant leak Xperion branding in the reply?');

  log('\n########## 6. CDP PROFILE + SEGMENTS ##########');
  const cp = await J('/api/cdp/profiles');
  log('  profiles:', JSON.stringify(cp.body).slice(0, 600));
  const adm = await J('/api/admin/cdp');
  log('  cdp config:', JSON.stringify(adm.body).slice(0, 500));

  log('\n########## 7. OFFERS ENDPOINTS ##########');
  for (const p of ['/api/offers/today', '/api/offers/tiles']) {
    const r = await J(p);
    log(` ${p} [${r.status}] ${JSON.stringify(r.body).slice(0, 400)}`);
  }

  log('\n########## 8. BUILT-IN SELFTEST ##########');
  const st = await J('/api/admin/selftest');
  log(JSON.stringify(st.body).slice(0, 900));

  require('fs');
})().catch(e => console.log('HARNESS ERROR', e.message, e.stack));
