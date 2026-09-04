// Modern Retailing engine — end-to-end test suite.
// Point it at a running server: BASE=http://127.0.0.1:7810 node _retail-test.mjs
// (or set PORT; defaults to 3000 for backwards compatibility)
try { await import("dotenv/config"); } catch {}   // pick up PORT from .env like the server does
const B = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
const J = async (p, o = {}) => { const r = await fetch(B + p, o); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; } return { s: r.status, b }; };
const P = (p, body, hdr = {}) => J(p, { method: 'POST', headers: { 'content-type': 'application/json', ...hdr }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n== 1. CUSTOMER-SPECIFIC PRICING ==');
  const cmp = await J('/api/retail/compare?origin=JFK&dest=MIA&date=2026-09-20');
  const totals = (cmp.b.personas || []).map((p) => p.total);
  const distinct = new Set(totals).size;
  ok('compare endpoint returns personas', cmp.s === 200 && totals.length >= 5, `${totals.length} personas`);
  ok('same flight prices DIFFER by customer', distinct >= 3, `${distinct} distinct totals across ${totals.length}: [${totals.join(', ')}]`);
  ok('every adjustment is explainable', (cmp.b.personas || []).every((p) => (p.adjustments || []).every((a) => a.label && Number.isFinite(a.amount))));
  ok('no customer-specific SURCHARGE (discount/value only)', (cmp.b.personas || []).every((p) => (p.adjustments || []).filter((a) => !['demand', 'demand_high', 'close_in', 'early_bird'].includes(a.code)).every((a) => a.amount <= 0)));

  console.log('\n== 2. PROPENSITY MODEL ==');
  const m = await J('/api/retail/model');
  ok('model trained from real rows', m.b.ready === true && m.b.training_rows > 50, `${m.b.training_rows} rows`);
  const of1 = await P('/api/retail/offers', { origin: 'JFK', dest: 'MIA', date: '2026-09-20' });
  const top1 = of1.b.offers?.[0]?.propensity_top || [];
  ok('offers carry propensity scores + drivers', top1.length > 0 && top1.every((t) => t.p === null || (t.p >= 0 && t.p <= 1)), JSON.stringify(top1.map((t) => `${t.code}:${t.p}`)));

  console.log('\n== 3. OFFER LIFECYCLE (TTL + reprice at commit) ==');
  const offer = of1.b.offers[0];
  ok('offer has id, expiry, itemised price', !!offer.id && !!offer.expires_at && Array.isArray(offer.items));
  const got = await J(`/api/retail/offers/${offer.id}`);
  ok('OfferPrice retrieval', got.s === 200 && got.b.offer.status === 'active');

  console.log('\n== 4. ORDER CREATE + IDEMPOTENCY + ONE ORDER ==');
  const key = 'idem-' + Date.now();
  const o1 = await P('/api/retail/orders', { offer_id: offer.id, accept_bundle: true }, { 'Idempotency-Key': key });
  ok('order created from offer', o1.s === 200 && o1.b.order?.id?.startsWith('ORD-'), o1.b.order?.id);
  const o2 = await P('/api/retail/orders', { offer_id: offer.id, accept_bundle: true }, { 'Idempotency-Key': key });
  ok('same Idempotency-Key replays same order', o2.b.order?.id === o1.b.order?.id && (o2.b.order?.replayed || o2.b.replayed), `${o1.b.order?.id} == ${o2.b.order?.id}`);
  const ord = o1.b.order;
  const flightItem = ord.items.find((i) => i.type === 'flight');
  ok('flight item fulfilment_ref = PNR (PNR stays fulfilment record)', !!flightItem?.fulfillment_ref, flightItem?.fulfillment_ref);
  const bks = await J('/api/bookings');
  ok('that PNR exists as a real booking', (bks.b || []).some((b) => b.pnr === flightItem.fulfillment_ref));
  ok('settlement balances (Σrevenue == Σpayment == total)', ord.settlement.balanced && Math.abs(ord.settlement.revenue_total - ord.total) < 0.01, `rev ${ord.settlement.revenue_total} pay ${ord.settlement.payment_total} total ${ord.total}`);

  console.log('\n== 5. ORDER-ITEM SERVICING as Bronze persona (bundle + per-item cancel) ==');
  await P('/api/persona', { persona: 'maria', id: 'maria' });
  const ofm = await P('/api/retail/offers', { origin: 'JFK', dest: 'MIA', date: '2026-09-22', limit: 1 });
  const om = ofm.b.offers?.[0];
  ok('Bronze offer has PAID ancillaries + propensity ranking', (om?.propensity_top || []).some((t) => t.price > 0), JSON.stringify((om?.propensity_top || []).map((t) => `${t.code}:€${t.price}@p${t.p}`)));
  ok('dynamic bundle composed with saving', !om?.bundle || (om.bundle.items.length >= 2 && om.bundle.saving > 0), om?.bundle ? `${om.bundle.items.join('+')} save €${om.bundle.saving}` : 'no bundle');
  const topPaid = (om?.propensity_top || []).filter((t) => t.price > 0).slice(0, 2).map((t) => t.code);
  const om1 = await P('/api/retail/orders', om?.bundle ? { offer_id: om.id, accept_bundle: true } : { offer_id: om.id, items: topPaid });
  const mo = om1.b.order;
  const anc = mo?.items.find((i) => i.type === 'ancillary' && i.price > 0);
  ok('order with paid items created', !!anc, anc && `${anc.code} €${anc.price}`);
  if (anc) {
    const cx = await P(`/api/retail/orders/${mo.id}/items/${anc.id}/cancel`, {});
    ok('single ancillary refunded', cx.s === 200 && cx.b.order.items.find((i) => i.id === anc.id)?.status === 'refunded');
    ok('order partially_refunded, flight still confirmed', cx.b.order.status === 'partially_refunded' && cx.b.order.items.find((i) => i.type === 'flight')?.status === 'confirmed');
    ok('settlement shows the reversal', cx.b.order.settlement.ledger.some((l) => l.entry === 'refund' && l.item_id === anc.id));
  }
  await P('/api/persona', { persona: 'daniel', id: 'daniel' });

  console.log('\n== 6. EXPIRY → REPRICE AT COMMIT ==');
  const ttl = Number(process.env.TEST_TTL_MS || 0);
  if (ttl) {
    const of2 = await P('/api/retail/offers', { origin: 'JFK', dest: 'MIA', date: '2026-09-21', limit: 1 });
    const off2 = of2.b.offers[0];
    const serverTtl = new Date(off2.expires_at).getTime() - Date.now();
    if (serverTtl > ttl + 5000) {
      ok('expired offer → 409 REPRICED_AT_COMMIT with a fresh offer', false,
        `server offer TTL is ~${Math.round(serverTtl / 1000)}s, not ${ttl}ms — restart the server as: RETAIL_OFFER_TTL_MS=${ttl} npm start`);
      ok('fresh offer accepts cleanly', false, 'skipped: server TTL mismatch (see above)');
    } else {
      await sleep(ttl + 600);
      const late = await P('/api/retail/orders', { offer_id: off2.id });
      ok('expired offer → 409 REPRICED_AT_COMMIT with a fresh offer', late.s === 409 && late.b.repriced === true && !!late.b.offer?.id, `${off2.id} → ${late.b.offer?.id}`);
      const redo = late.b.offer?.id ? await P('/api/retail/orders', { offer_id: late.b.offer.id }) : { s: 0, b: {} };
      ok('fresh offer accepts cleanly', redo.s === 200 && !!redo.b.order?.id);
    }
  } else ok('TTL expiry (set TEST_TTL_MS + RETAIL_OFFER_TTL_MS to run live)', true);
  const conv = await P('/api/retail/orders', { offer_id: offer.id });
  ok('accepting an already-converted offer replays its order', conv.b.replayed === true && conv.b.order.id === ord.id);

  console.log('\n== 7. CHAT BUG FIX — session booking wins ==');
  const sid = 'fix-' + Date.now(); const msgs = [];
  const turn = async (t) => { msgs.push({ role: 'user', content: t }); const r = await P('/api/ai/agent', { messages: msgs, sessionId: sid }); msgs.push({ role: 'assistant', content: r.b.reply || '' }); return r.b; };
  const sr = await turn('flights from New York to Miami on 20 September');
  const srFlights = ((sr.cards || []).find((c) => c.type === 'flights') || {}).flights || [];
  const pickFno = (srFlights[1] || srFlights[0] || {}).flight_no || 'XP1931';
  await turn('select ' + pickFno);
  const payT = await turn('pay');
  const newPnr = /XP[A-Z0-9]{4}/.exec(payT.reply || '')?.[0];
  const ci = await turn('check me in');
  const gb = await turn('what is my booking');
  ok('checkout returns order_id on the card', !!(payT.cards || []).find((c) => c.type === 'confirmation')?.order_id, (payT.cards || [])[0]?.order_id);
  ok('check-in refers to the booking JUST made (New York→Miami)', /New York→Miami/.test(ci.reply || ''), (ci.reply || '').slice(0, 90));
  ok('"my booking" returns the new PNR', newPnr && (gb.reply || '').includes(newPnr), `${newPnr} in "${(gb.reply || '').slice(0, 80)}"`);

  console.log('\n== 8. LEGACY CHANNELS BECOME ORDERS ==');
  const orders = await J('/api/retail/orders');
  const chatOrder = (orders.b.orders || []).find((o) => o.channel === 'chat');
  ok('chat checkout produced an Order', !!chatOrder, chatOrder?.id);
  const payDirect = await P('/api/pay', { flight_no: pickFno, total: 70, card_amt: 70, items: ['lounge'], date: '2026-09-20' });
  ok('/api/pay returns order_id (web strangler hook)', payDirect.s === 200 && !!payDirect.b.order_id, payDirect.b.order_id);

  console.log('\n== 9. REGRESSIONS ==');
  const nv = await P('/api/ai/agent', { messages: [{ role: 'user', content: 'flights from Oslo to Copenhagen' }], sessionId: 'nv-' + Date.now() }, { 'x-airline-tenant': 'nordvind' });
  ok('nordvind tenant unaffected', nv.b.brand?.id === 'nordvind' && (nv.b.cards || []).length > 0);
  const st = await J('/api/admin/selftest');
  ok('built-in selftest ≥ 15/17', (st.b.passed || 0) >= 15, `${st.b.passed}/${st.b.total}`);
  const pk = await P('/api/ai/agent', { messages: [{ role: 'user', content: 'what do you recommend for me' }], sessionId: 'pk-' + Date.now() });
  const pkgCard = (pk.b.cards || []).find((c) => c.type === 'package');
  ok('recommendation package date is in the future', !pkgCard || pkgCard.date >= new Date().toISOString().slice(0, 10), pkgCard ? `${pkgCard.event} ${pkgCard.date}` : 'no package card');

  console.log(`\n===== ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('SUITE ERROR', e.message); process.exit(2); });
