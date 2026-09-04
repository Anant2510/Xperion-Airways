"use strict";
/* ──────────────────────────────────────────────────────────────────────────
   FlyTAP — Modern Retailing engine (Offer → Order → Settlement)
   ----------------------------------------------------------------------------
   The commercial core the PNR model lacks, layered OVER it (strangler pattern):

   • OFFER  — a priced, time-bound, ID'd, customer-specific set of products.
              Composed per customer from continuous pricing + targeted value
              adjustments + propensity-ranked ancillaries + a dynamic bundle.
              Every price carries an explainable adjustments[] breakdown.
   • ORDER  — one commercial record for everything bought (ONE Order semantics).
              The flight item's fulfilment_ref is the PNR: the PNR stays the
              FULFILMENT record, the Order becomes the COMMERCIAL record.
   • SETTLEMENT — per-item ledger rows (revenue by party + payment legs), so
              "no coupon/EMD reconciliation" is a query, not a slide.

   API surface is NDC-ALIGNED IN SEMANTICS (Shop → Price → OrderCreate →
   OrderRetrieve → OrderChange), not schema-conformant NDC XML/JSON — that is
   deliberate and documented in RETAIL.md.

   Pricing honesty: the shared components (demand, advance purchase) are
   customer-independent continuous pricing; the customer-specific components
   are TARGETED DISCOUNTS/VALUE, never targeted surcharges.
   ────────────────────────────────────────────────────────────────────────── */

const crypto = require("node:crypto");
const { db, now, searchToday, PERSONAS } = require("./db");
const propensity = require("./propensity");

let cdpEvents = {}; try { cdpEvents = require("./cdp-events"); } catch {}
let cdpProfile = {}; try { cdpProfile = require("./cdp-profile"); } catch {}

const OFFER_TTL_MS = Number(process.env.RETAIL_OFFER_TTL_MS) || 20 * 60e3;
const CUR = "EUR";
const r2 = (n) => Math.round(n * 100) / 100;
const oid = (p) => p + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();

/* ── schema (new tables only; never ALTERs an existing one) ── */
db.exec(`
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY, user_id INTEGER, tenant TEXT DEFAULT 'xperion',
  origin TEXT, dest TEXT, travel_date TEXT, flight_no TEXT,
  currency TEXT DEFAULT 'EUR', base_total REAL, total REAL,
  items_json TEXT, pricing_json TEXT, bundle_json TEXT, propensity_json TEXT,
  status TEXT DEFAULT 'active', expires_at TEXT, created_at TEXT,
  superseded_by TEXT, converted_order_id TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, user_id INTEGER, tenant TEXT DEFAULT 'xperion',
  offer_id TEXT, channel TEXT DEFAULT 'web', status TEXT DEFAULT 'paid',
  currency TEXT DEFAULT 'EUR', total REAL, refunded_total REAL DEFAULT 0,
  idem_key TEXT UNIQUE, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY, order_id TEXT, type TEXT, code TEXT, descr TEXT,
  qty INTEGER DEFAULT 1, price REAL, status TEXT DEFAULT 'confirmed',
  fulfillment_ref TEXT, meta_json TEXT
);
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY, order_id TEXT, item_id INTEGER,
  entry TEXT, party TEXT, method TEXT, amount REAL, created_at TEXT
);`);

/* ── product catalogue with eligibility + per-segment price rules ──
   Upgrades the static 6-row ancillaries table without touching it. */
const CATALOG_RULES = {
  lounge: {
    eligible: () => true,
    price: (u, ctx, base) => (u.tier === "Platinum" ? { price: 0, note: "included — Platinum benefit" } : { price: base }),
  },
  fast: {
    eligible: (u, ctx) => ["LIS", "OPO", "FNC"].includes(ctx.origin) || ["LIS", "OPO"].includes(u.home_airport),
    price: (u, ctx, base) => ({ price: base }),
  },
  xbag: {
    eligible: () => true,
    price: (u, ctx, base) => (ctx.shortHaul ? { price: r2(base * 0.8), note: "short-haul rate" } : { price: base }),
  },
  wifi: { eligible: (u, ctx) => !ctx.shortHaul || true, price: (u, ctx, base) => ({ price: base }) },
  meal: { eligible: () => true, price: (u, ctx, base) => ({ price: base }) },
  seat: { eligible: () => true, price: (u, ctx, base) => (["Gold", "Platinum"].includes(u.tier) ? { price: 0, note: `included — ${u.tier} benefit` } : { price: base || 9 }) },
  bag: { eligible: () => true, price: () => ({ price: 0, note: "included in fare" }) },
};

function catalogFor(u, ctx) {
  const rows = db.prepare("SELECT * FROM ancillaries").all();
  return rows.map((a) => {
    const code = a.code.toLowerCase();
    const rule = CATALOG_RULES[code] || { eligible: () => true, price: (_u, _c, b) => ({ price: b }) };
    const ok = !!rule.eligible(u, ctx);
    const pr = ok ? rule.price(u, ctx, a.price) : { price: a.price };
    return { code, name: a.name, descr: a.descr, list_price: a.price, price: r2(pr.price), included: pr.price === 0, rule_note: pr.note || null, eligible: ok, icon: a.icon };
  }).filter((a) => a.eligible);
}

/* ── explainable per-customer pricing ─────────────────────────────────────
   adjustments[]: { code, label, amount } — amount in EUR, negative = discount.
   Shared (continuous) components apply to everyone; customer components are
   discounts/value only. */
function priceFlight(u, f, ctx = {}) {
  const base = Number(f.price) || 0;
  const adj = [];
  const daysTo = Math.max(0, Math.round((new Date((f.flight_date || ctx.date) + "T00:00:00Z") - new Date(searchToday() + "T00:00:00Z")) / 86400e3));

  // continuous, customer-independent
  if (f.seats_left != null && f.seats_left <= 5) adj.push({ code: "demand_high", label: `high demand — ${f.seats_left} seats left`, amount: r2(base * 0.08) });
  else if (f.seats_left != null && f.seats_left <= 10) adj.push({ code: "demand", label: "filling up", amount: r2(base * 0.04) });
  if (daysTo <= 6) adj.push({ code: "close_in", label: "close to departure", amount: r2(base * 0.10) });
  else if (daysTo >= 45) adj.push({ code: "early_bird", label: "early booking", amount: r2(base * -0.04) });

  // customer-specific — discounts / value only
  const trips = db.prepare("SELECT COUNT(*) c FROM bookings WHERE user_id=? AND status!='cancelled'").get(u.id)?.c || 0;
  const topRoute = db.prepare("SELECT route FROM travel_history WHERE user_id=? GROUP BY route ORDER BY COUNT(*) DESC LIMIT 1").get(u.id)?.route || "";
  const pair = `${f.origin}→${f.dest}`, rpair = `${f.dest}→${f.origin}`;
  if (u.tier === "Gold" && (topRoute === pair || topRoute === rpair)) adj.push({ code: "commuter", label: "commuter fare — your regular route", amount: r2(base * -0.05) });
  else if (u.tier === "Gold") adj.push({ code: "loyalty", label: "Gold loyalty fare", amount: r2(base * -0.03) });
  else if (u.tier === "Silver") adj.push({ code: "member", label: "Silver member fare", amount: r2(base * -0.02) });
  else if (u.tier === "Bronze" || !u.tier) adj.push({ code: "welcome", label: trips < 3 ? "welcome fare — new flyer" : "saver fare", amount: r2(base * (trips < 3 ? -0.06 : -0.04)) });
  if (u.tier === "Platinum") adj.push({ code: "flex", label: "flex change included (worth €15)", amount: 0 });
  if ((u.miles || 0) >= 100000) adj.push({ code: "miles_nudge", label: "eligible: pay fully with miles at 1,000 ≈ €3", amount: 0 });

  const total = r2(Math.max(19, base + adj.reduce((s, a) => s + a.amount, 0)));
  return { base, adjustments: adj, total, currency: CUR, days_to_departure: daysTo };
}

/* ── offer composition ── */
function userRow(uid) { return db.prepare("SELECT * FROM users WHERE id=?").get(uid); }
const shortHaulOf = (f) => { const m = /(\d+)h/.exec(f.duration || ""); return !m || Number(m[1]) < 2 ? 1 : 0; };

function composeOffers(uid, { origin, dest, date, tenant = "xperion", limit = 3, persist = true, flights }) {
  const u = userRow(uid);
  if (!u) return { ok: false, error: "unknown customer" };
  const list = (flights || []).slice().sort((a, b) => (a.dep || "").localeCompare(b.dep || "")).slice(0, limit);
  if (!list.length) return { ok: false, error: "no flights for route/date" };

  const offers = list.map((f) => {
    const ctx = { origin, dest, date, shortHaul: shortHaulOf(f) };
    const pricing = priceFlight(u, f, ctx);
    const scores = propensity.scoreAll(u, ctx);
    const cat = catalogFor(u, ctx).map((a) => ({ ...a, propensity: scores[a.code] || null }));
    const ranked = cat.filter((a) => !a.included).sort((a, b) => (b.propensity?.p || 0) - (a.propensity?.p || 0));
    const BUNDLE_MIN_P = Number(process.env.RETAIL_BUNDLE_MIN_P) || 0.15;
    const bundleItems = ranked.filter((a) => (a.propensity?.p || 0) >= BUNDLE_MIN_P).slice(0, 3);
    const bundleSum = r2(bundleItems.reduce((s, a) => s + a.price, 0));
    const bundle = bundleItems.length >= 2 ? {
      name: "Your trip kit", items: bundleItems.map((a) => a.code),
      list_total: bundleSum, price: r2(bundleSum * 0.85), saving: r2(bundleSum * 0.15),
      reason: "composed from your highest-propensity extras",
    } : null;
    const included = cat.filter((a) => a.included);
    const items = [
      { type: "flight", code: f.flight_no, descr: `${f.origin}→${f.dest} ${f.dep} · ${f.flight_date || date}`, price: pricing.total },
      ...included.map((a) => ({ type: "ancillary", code: a.code, descr: a.name, price: 0, included: true, note: a.rule_note })),
    ];
    const id = oid("OFR");
    const expires_at = new Date(Date.now() + OFFER_TTL_MS).toISOString();
    const rec = {
      id, user_id: uid, tenant, origin, dest, travel_date: f.flight_date || date, flight_no: f.flight_no,
      currency: CUR, base_total: pricing.base, total: pricing.total,
      items, pricing, bundle, catalog: cat, status: "active", expires_at,
      propensity_top: ranked.slice(0, 4).map((a) => ({ code: a.code, name: a.name, price: a.price, p: a.propensity?.p ?? null, low_confidence: a.propensity?.low_confidence ?? null, drivers: a.propensity?.drivers || [] })),
    };
    if (persist) db.prepare(`INSERT INTO offers (id,user_id,tenant,origin,dest,travel_date,flight_no,currency,base_total,total,items_json,pricing_json,bundle_json,propensity_json,status,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, uid, tenant, origin, dest, rec.travel_date, f.flight_no, CUR, pricing.base, pricing.total,
        JSON.stringify(items), JSON.stringify(pricing), JSON.stringify(bundle), JSON.stringify(rec.propensity_top), "active", expires_at, now());
    return rec;
  });

  const best = offers.reduce((m, o) => (o.total < m.total ? o : m), offers[0]);
  best.badge = "best value";
  try { cdpEvents.emit && cdpEvents.emit("search", { loyaltyId: u.member_no, email: u.email }, { origin, dest, offers: offers.length, channel: "retail-api" }); } catch {}
  return { ok: true, customer: { id: u.id, name: u.full_name, tier: u.tier }, offer_ttl_seconds: Math.round(OFFER_TTL_MS / 1e3), offers };
}

function loadOffer(id) {
  const r = db.prepare("SELECT * FROM offers WHERE id=?").get(id);
  if (!r) return null;
  const o = { ...r, items: JSON.parse(r.items_json || "[]"), pricing: JSON.parse(r.pricing_json || "null"), bundle: JSON.parse(r.bundle_json || "null"), propensity_top: JSON.parse(r.propensity_json || "[]") };
  if (o.status === "active" && o.expires_at && new Date(o.expires_at).getTime() < Date.now()) {
    db.prepare("UPDATE offers SET status='expired' WHERE id=?").run(id);
    o.status = "expired";
  }
  return o;
}

/* Re-shop the same flight for the same customer at TODAY's price. */
function repriceOffer(old, flights) {
  const f = (flights || []).find((x) => x.flight_no === old.flight_no) || flights?.[0];
  if (!f) return null;
  const res = composeOffers(old.user_id, { origin: old.origin, dest: old.dest, date: old.travel_date, tenant: old.tenant, limit: 1, flights: [f] });
  const nu = res.ok ? res.offers[0] : null;
  if (nu) db.prepare("UPDATE offers SET status='superseded', superseded_by=? WHERE id=?").run(nu.id, old.id);
  return nu;
}

/* ── ORDER + SETTLEMENT ──────────────────────────────────────────────────── */
const PARTY = { flight: "carrier — air revenue", ancillary: "carrier — ancillary", seat: "carrier — ancillary", bundle_discount: "carrier — promotion", hotel: "partner — hotel", event: "partner — events" };

function writeSettlement(orderId, itemId, entry, party, method, amount) {
  db.prepare("INSERT INTO settlements (order_id,item_id,entry,party,method,amount,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(orderId, itemId, entry, party, method, r2(amount), now());
}

/* One entry point for EVERY channel — offer acceptance, legacy web /api/pay,
   agent chat checkout, and PSS webhooks all converge here. That convergence
   IS the ONE Order story. */
function createOrder({ uid, tenant = "xperion", channel = "web", offerId = null, pnr, flight, date, items = [], anc = [], total, split = {}, idemKey = null }) {
  if (idemKey) {
    const dup = db.prepare("SELECT id FROM orders WHERE idem_key=?").get(idemKey);
    if (dup) return { ...getOrder(dup.id), replayed: true };
  }
  const id = oid("ORD");
  const ancRows = anc.length ? anc : resolveAnc(items);
  const ancSum = r2(ancRows.reduce((s, a) => s + a.price, 0));
  const farePortion = r2(Math.max(0, (Number(total) || 0) - ancSum));
  db.prepare(`INSERT INTO orders (id,user_id,tenant,offer_id,channel,status,currency,total,idem_key,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, uid, tenant, offerId, channel, "paid", CUR, r2(Number(total) || 0), idemKey, now(), now());

  const fi = db.prepare(`INSERT INTO order_items (order_id,type,code,descr,price,fulfillment_ref,meta_json) VALUES (?,?,?,?,?,?,?)`)
    .run(id, "flight", flight?.flight_no || "", `${flight?.origin || "?"}→${flight?.dest || "?"} · ${date || flight?.flight_date || ""}`, farePortion, pnr || null, JSON.stringify({ dep: flight?.dep, seat: split.seat || null }));
  writeSettlement(id, Number(fi.lastInsertRowid), "revenue", PARTY.flight, null, farePortion);

  for (const a of ancRows) {
    const it = db.prepare(`INSERT INTO order_items (order_id,type,code,descr,price,fulfillment_ref) VALUES (?,?,?,?,?,?)`)
      .run(id, a.type || "ancillary", a.code, a.descr || a.name || a.code, r2(a.price), pnr || null);
    writeSettlement(id, Number(it.lastInsertRowid), a.price >= 0 ? "revenue" : "promotion", PARTY[a.type] || PARTY.ancillary, null, a.price);
  }

  const legs = [["voucher", split.voucher], ["miles", split.miles_amt ?? split.miles_eur], ["card", split.card ?? split.card_amt]];
  let paid = 0;
  for (const [m, v] of legs) if (Number(v) > 0) { writeSettlement(id, null, "payment", "customer", m, Number(v)); paid = r2(paid + Number(v)); }
  if (paid === 0 && Number(total) > 0) writeSettlement(id, null, "payment", "customer", "card", Number(total));

  if (offerId) db.prepare("UPDATE offers SET status='converted', converted_order_id=? WHERE id=?").run(id, offerId);
  try { const u = userRow(uid); cdpProfile.record && cdpProfile.record({ identity: { loyaltyId: u.member_no, email: u.email }, channel, type: "order", spend: 0 }); } catch {}
  return getOrder(id);
}

function resolveAnc(codes) {
  const rows = db.prepare("SELECT code,name,price FROM ancillaries").all();
  const by = Object.fromEntries(rows.map((r) => [r.code.toLowerCase(), r]));
  return (codes || []).map((c) => (typeof c === "string" ? c : c.code || c.id || "")).map((c) => String(c).toLowerCase()).filter((c) => by[c])
    .map((c) => ({ type: "ancillary", code: c, descr: by[c].name, price: Number(by[c].price) || 0 }));
}

function getOrder(id) {
  const o = db.prepare("SELECT * FROM orders WHERE id=?").get(id);
  if (!o) return null;
  const items = db.prepare("SELECT * FROM order_items WHERE order_id=? ORDER BY id").all(id);
  const ledger = db.prepare("SELECT * FROM settlements WHERE order_id=? ORDER BY id").all(id);
  const revenue = r2(ledger.filter((l) => ["revenue", "promotion"].includes(l.entry)).reduce((s, l) => s + l.amount, 0));
  const payments = r2(ledger.filter((l) => l.entry === "payment").reduce((s, l) => s + l.amount, 0));
  const refunds = r2(ledger.filter((l) => l.entry === "refund").reduce((s, l) => s + l.amount, 0));
  return { ...o, items, settlement: { ledger, revenue_total: revenue, payment_total: payments, refund_total: Math.abs(refunds), balanced: Math.abs(revenue - payments) < 0.01 } };
}

function cancelItem(orderId, itemId) {
  const it = db.prepare("SELECT * FROM order_items WHERE order_id=? AND id=?").get(orderId, itemId);
  if (!it) return { ok: false, error: "item not found" };
  if (it.type === "flight") return { ok: false, error: "flight items are cancelled via booking cancellation (whole-order path)" };
  if (it.status !== "confirmed") return { ok: false, error: `item is ${it.status}` };
  db.prepare("UPDATE order_items SET status='refunded' WHERE id=?").run(itemId);
  writeSettlement(orderId, itemId, "refund", PARTY[it.type] || PARTY.ancillary, null, -it.price);
  writeSettlement(orderId, itemId, "payment", "customer", "card", -it.price);
  db.prepare("UPDATE orders SET status='partially_refunded', refunded_total=refunded_total+?, updated_at=? WHERE id=?").run(it.price, now(), orderId);
  return { ok: true, order: getOrder(orderId) };
}

/* Legacy-channel wrapper: any existing booking write becomes an Order too. */
function recordOrderFromBooking(p) {
  try { return createOrder(p); } catch (e) { try { db.prepare("INSERT INTO events (type, meta_json, created_at) VALUES ('retail_order_error', ?, ?)").run(JSON.stringify({ e: String(e.message || e) }), now()); } catch {} return null; }
}

/* ── HTTP surface (NDC-aligned semantics) ── */
function mount(app, deps) {
  const flightsFor = (origin, dest, date) => {
    if (!deps.getRoute(origin, dest)) return [];
    deps.persistFlights(deps.generateFlights(origin, dest, date));
    return db.prepare("SELECT * FROM flights WHERE origin=? AND dest=? AND flight_date=? ORDER BY dep").all(origin, dest, date);
  };

  app.get("/api/retail/catalog", (req, res) => {
    const u = userRow(req.uid);
    const ctx = { origin: (req.query.origin || u.home_airport || "LIS").toUpperCase(), shortHaul: req.query.shortHaul !== "0" };
    res.json({ ok: true, customer: { name: u.full_name, tier: u.tier }, products: catalogFor(u, ctx) });
  });

  app.get("/api/retail/model", (_req, res) => res.json(propensity.info()));
  app.post("/api/retail/model/train", (_req, res) => res.json(propensity.train()));

  // Shop: offers for a route/date, priced for THIS customer
  app.post("/api/retail/offers", (req, res) => {
    const origin = (req.body.origin || "LIS").toUpperCase(), dest = (req.body.dest || "OPO").toUpperCase();
    const date = req.body.date || searchToday();
    const flights = flightsFor(origin, dest, date);
    const out = composeOffers(req.uid, { origin, dest, date, flights, limit: Number(req.body.limit) || 3 });
    res.status(out.ok ? 200 : 400).json(out);
  });

  // OfferPrice: re-validate one offer (expiry surfaces here)
  app.get("/api/retail/offers/:id", (req, res) => {
    const o = loadOffer(req.params.id);
    if (!o) return res.status(404).json({ ok: false, error: "offer not found" });
    res.json({ ok: true, offer: o });
  });

  // OrderCreate: accept an offer → order (+ booking as fulfilment). Idempotent.
  app.post("/api/retail/orders", (req, res) => {
    const idemKey = req.get("Idempotency-Key") || req.body.idempotency_key || null;
    const o = loadOffer(req.body.offer_id || "");
    if (!o) return res.status(404).json({ ok: false, error: "offer not found" });
    if (o.user_id !== req.uid) return res.status(403).json({ ok: false, error: "offer belongs to another customer" });
    if (o.status === "converted") return res.json({ ok: true, order: getOrder(o.converted_order_id), replayed: true });
    if (o.status !== "active") {
      const nu = repriceOffer(o, flightsFor(o.origin, o.dest, o.travel_date));
      return res.status(409).json({ ok: false, error: "OFFER_EXPIRED_REPRICED_AT_COMMIT", repriced: true, old_total: o.total, offer: nu });
    }
    if (idemKey) { const dup = db.prepare("SELECT id FROM orders WHERE idem_key=?").get(idemKey); if (dup) return res.json({ ok: true, order: getOrder(dup.id), replayed: true }); }

    const withBundle = req.body.accept_bundle && o.bundle;
    const picked = Array.isArray(req.body.items) ? req.body.items.map((c) => String(c).toLowerCase()) : [];
    const fromOffer = (c) => { const p = o.propensity_top.find((x) => x.code === c); return { type: "ancillary", code: c, descr: p?.name || c, price: p?.price ?? 0 }; };
    const anc = withBundle
      ? [...o.bundle.items.map(fromOffer),
         { type: "bundle_discount", code: "bundle", descr: `${o.bundle.name} — bundle saving`, price: -o.bundle.saving }]
      : picked.map(fromOffer);
    const total = r2(o.total + (withBundle ? o.bundle.price : anc.reduce((s, a) => s + a.price, 0)));
    const pnr = "XP" + crypto.randomBytes(3).toString("hex").slice(0, 4).toUpperCase();
    const f = db.prepare("SELECT * FROM flights WHERE flight_no=? AND flight_date=?").get(o.flight_no, o.travel_date) || db.prepare("SELECT * FROM flights WHERE flight_no=?").get(o.flight_no) || { flight_no: o.flight_no, origin: o.origin, dest: o.dest, flight_date: o.travel_date };
    const seat = ["Gold", "Platinum"].includes(userRow(req.uid).tier) ? "4C" : "22C";
    db.prepare(`INSERT INTO bookings (pnr,user_id,flight_no,flight_date,seat,items_json,meta_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(pnr, req.uid, o.flight_no, o.travel_date, seat,
      JSON.stringify(anc.filter((a) => a.type === "ancillary").map((a) => a.code)),
      JSON.stringify({ origin: f.origin, dest: f.dest, dep: f.dep, arr: f.arr, duration: f.duration, aircraft: f.aircraft, via: "retail-offer", offer_id: o.id }), now());
    db.prepare(`INSERT INTO payments (booking_id,total,voucher_amt,miles_used,miles_amt,card_amt,created_at)
      SELECT id,?,0,0,0,?,? FROM bookings WHERE pnr=?`).run(total, total, now(), pnr);
    const order = createOrder({ uid: req.uid, channel: "retail-api", offerId: o.id, pnr, flight: f, date: o.travel_date, anc, total, split: { card: total, seat }, idemKey });
    res.json({ ok: true, order, pnr, reprice_at_commit: false });
  });

  app.get("/api/retail/orders", (req, res) => {
    const rows = db.prepare("SELECT id FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 25").all(req.uid);
    res.json({ ok: true, orders: rows.map((r) => getOrder(r.id)) });
  });
  app.get("/api/retail/orders/:id", (req, res) => {
    const o = getOrder(req.params.id);
    if (!o || o.user_id !== req.uid) return res.status(404).json({ ok: false, error: "order not found" });
    res.json({ ok: true, order: o });
  });
  app.get("/api/retail/orders/:id/settlement", (req, res) => {
    const o = getOrder(req.params.id);
    if (!o || o.user_id !== req.uid) return res.status(404).json({ ok: false, error: "order not found" });
    res.json({ ok: true, order_id: o.id, ...o.settlement });
  });
  app.post("/api/retail/orders/:id/items/:itemId/cancel", (req, res) => {
    const o = getOrder(req.params.id);
    if (!o || o.user_id !== req.uid) return res.status(404).json({ ok: false, error: "order not found" });
    const out = cancelItem(req.params.id, Number(req.params.itemId));
    res.status(out.ok ? 200 : 400).json(out);
  });

  // Persona price comparison — the workshop money shot (dry-run, nothing persisted)
  app.get("/api/retail/compare", (req, res) => {
    const origin = (req.query.origin || "LIS").toUpperCase(), dest = (req.query.dest || "OPO").toUpperCase();
    const date = req.query.date || searchToday();
    const flights = flightsFor(origin, dest, date);
    const out = [];
    for (const p of Object.values(PERSONAS)) {
      const uid = db.prepare("SELECT id FROM users WHERE member_no=? OR email=?").get(p.user.member_no, p.user.email)?.id;
      const r = uid ? composeOffers(uid, { origin, dest, date, flights, limit: 1, persist: false }) : null;
      if (r?.ok) out.push({ persona: p.id, name: p.user.full_name, tier: p.user.tier, total: r.offers[0].total, base: r.offers[0].pricing.base, adjustments: r.offers[0].pricing.adjustments });
    }
    res.json({ ok: true, origin, dest, date, flight: flights[0]?.flight_no, personas: out });
  });
}

module.exports = { mount, composeOffers, loadOffer, repriceOffer, createOrder, getOrder, cancelItem, recordOrderFromBooking, priceFlight, catalogFor };
