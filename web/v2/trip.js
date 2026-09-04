// FlyTAP v2 — shared trip state across the booking spine (results → cart →
// passenger → payment → confirmation). Module-scoped so it persists across SPA
// navigation within a session. The server stays the source of truth on /api/pay.
export const trip = {
  type: "round", pax: 1, adults: 1, children: 0, infants: 0, cabin: "Economy", payMiles: false,
  origin: null, dest: null, date: null, ret: null,
  outbound: null, inbound: null,   // { flight, fare, price }
  legs: [],                         // B1 — multi-city: ordered [{ flight, fare, price }] beyond outbound/inbound
  extras: [],                       // [{ code, name, price, qty, cat, source }]  source: recommended | auto | user
  passengers: [], contact: null, payment: null, pnr: null,
  repriceDelta: 0,                  // H2 — accepted price change from a mid-booking revalidation (added to the total)
  seeded: false,                    // #18 — recommended extras are seeded once per fresh trip, never re-seeded
};

// Lightweight pub/sub so anything outside a screen (e.g. the top-nav basket badge)
// re-renders the moment the in-memory basket changes — keeps the count in the nav,
// the right-rail summary and the basket window in lock-step.
const _listeners = new Set();
export function onTripChange(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
function notify() { _listeners.forEach(fn => { try { fn(); } catch { } }); saveTrip(); }
export function pingBasket() { notify(); }

export function setLeg(leg, choice) { trip[leg] = choice; notify(); }
// Route sync — the selected flight and the searched route must always agree. If trip.origin/dest
// (the current search) no longer matches trip.outbound's flight (a leftover from a previous,
// unrelated search), the flight is stale and must be dropped so the page shows the correct route
// and prompts a fresh selection — instead of the header showing AMS–JFK while the flight card
// shows a stale DEL–JFK. Returns true if it cleared anything.
// v35 Important #4: hotels, transfers, lounge passes and experiences are bought for a specific
// destination. When the searched route changes they are stale by definition, so drop them and let
// the recommendation seeder rebuild for the new city. Route-agnostic extras (bags, meals, wifi,
// insurance, carbon) survive. seeded/carbonOptOut reset so the new destination gets a fresh pass.
const DEST_BOUND = new Set(["Hotels", "Cars & transfers", "Lounge & services", "Experiences"]);
function dropDestinationExtras() {
  const before = trip.extras.length;
  trip.extras = trip.extras.filter(x => !DEST_BOUND.has(x.cat));
  trip.seeded = false;
  trip.carbonOptOut = false;
  return trip.extras.length !== before;
}
export function syncTripRoute() {
  if (trip.pnr) return false;
  // Multi-city: each leg is its own route, but the legs must CHAIN — leg N's destination must be
  // leg N+1's origin (JFK→LIS then LIS→OPO). If a stale flight from a previous search breaks the
  // chain (e.g. a leftover direct JFK→OPO sitting in leg 1 while leg 2 is LIS→OPO, so the itinerary
  // shows a direct flight instead of the two stopover segments), drop the whole leg set so the user
  // re-picks each leg for the current multi-city route. Returns true if it cleared anything.
  if (trip.type === "multi") {
    const legs = (trip.legs && trip.legs.length ? trip.legs : [trip.outbound, trip.inbound]).filter(Boolean);
    if (legs.length >= 2) {
      for (let i = 0; i < legs.length - 1; i++) {
        const a = legs[i]?.flight, b = legs[i + 1]?.flight;
        if (a && b && a.dest && b.origin && a.dest !== b.origin) {
          trip.outbound = null; trip.inbound = null; trip.legs = [];
          dropDestinationExtras();
          notify();
          return true;
        }
      }
    }
    return false;
  }
  // Simple one-way / round trip: the outbound must match the searched origin→dest exactly.
  const o = trip.outbound?.flight;
  if (trip.origin && trip.dest && o && (o.origin !== trip.origin || o.dest !== trip.dest)) {
    trip.outbound = null; trip.inbound = null; trip.legs = [];
    dropDestinationExtras();
    notify();
    return true;
  }
  return false;
}
// Locking a fare must PERSIST — setting trip.fareHold directly skips notify(), so the
// snapshot is written without the lock and a reload loses it (the fare then re-validates
// and prompts "price has changed" on a fare the member is actually holding).
export function setFareHold(hold) { trip.fareHold = hold || null; notify(); }
// Clear the basket back to its initial state (called on login / persona switch / logout,
// so a new context never inherits a previous session's in-progress cart).
export function resetTrip() {
  _resetting = true;
  Object.assign(trip, {
    type: "round", pax: 1, adults: 1, children: 0, infants: 0, cabin: "Economy", payMiles: false,
    origin: null, dest: null, date: null, ret: null,
    outbound: null, inbound: null, legs: [], extras: [],
    passengers: [], contact: null, payment: null, pnr: null, repriceDelta: 0, seeded: false, fareHold: null,
  });
  try { localStorage.removeItem(TKEY); } catch {}
  _resetting = false;
  notify();
}
export function hasExtra(code) { return trip.extras.some(x => x.code === code); }
// Per-traveller categories. The cart shows a "× pax" hint for these (CAT_QTY) and item
// cards pre-multiply price by pax before storing, so qty stays 1 — see seedExtras / Row.
export const PER_PAX_CATS = new Set(["Insurance", "Lounge & services", "Experiences"]);
export function toggleExtra(item) {
  const i = trip.extras.findIndex(x => x.code === item.code);
  if (i >= 0) trip.extras.splice(i, 1); else trip.extras.push({ ...item, qty: item.qty || 1, cat: item.cat || "Extras", source: item.source || "user" });
  notify();
}
// Empty just the add-ons (keep the chosen flight) — the user's explicit "clear basket".
export function clearBasket() { trip.extras = []; trip.seeded = true; notify(); }
// A serializable snapshot persisted to the server so the basket survives an abandoned
// session: flight context + every add-on with its source (user / recommended / auto).
export function tripSnapshot() {
  return {
    type: trip.type, pax: trip.pax, cabin: trip.cabin,
    origin: trip.origin, dest: trip.dest, date: trip.date, ret: trip.ret,
    outbound: trip.outbound, inbound: trip.inbound,
    fareHold: trip.fareHold || null,        // a locked fare must survive a reload / basket restore
    extras: trip.extras.map(e => ({ code: e.code, name: e.name, price: e.price, qty: e.qty || 1, cat: e.cat, source: e.source || "user", ...(e.rate != null ? { rate: e.rate } : {}), ...(e.nights != null ? { nights: e.nights } : {}) })),
  };
}
// ── Local session persistence (Important #4) ────────────────────────────────
// Keep the in-progress trip across a hard refresh: the in-memory `trip` is the
// source of truth during a session, but a reload wipes module state, so we mirror
// it to localStorage and rehydrate on boot. Cleared on login/logout/persona switch
// (resetTrip) so a new member context never inherits a previous session's cart.
const TKEY = "flyxperion_trip";
let _resetting = false;
export function saveTrip() {
  if (_resetting) return;
  if (trip.pnr) { try { localStorage.removeItem(TKEY); } catch {} return; }  // #18 — a confirmed booking is not a resumable in-progress cart
  try {
    const snap = {
      type: trip.type, pax: trip.pax, cabin: trip.cabin,
      origin: trip.origin, dest: trip.dest, date: trip.date, ret: trip.ret,
      outbound: trip.outbound, inbound: trip.inbound,
      fareHold: trip.fareHold || null,        // a locked fare must survive a reload
      extras: trip.extras, passengers: trip.passengers, contact: trip.contact,
    };
    if (!snap.outbound && !snap.extras.length && !snap.passengers.length) localStorage.removeItem(TKEY);
    else localStorage.setItem(TKEY, JSON.stringify(snap));
  } catch {}
}
export function loadTrip() {
  try {
    const raw = localStorage.getItem(TKEY);
    if (!raw) return false;
    const s = JSON.parse(raw) || {};
    if (!s.outbound && !(s.extras || []).length && !(s.passengers || []).length) return false;
    Object.assign(trip, {
      type: s.type || "round", pax: s.pax || 1, cabin: s.cabin || "Economy",
      origin: s.origin ?? null, dest: s.dest ?? null, date: s.date ?? null, ret: s.ret ?? null,
      outbound: s.outbound || null, inbound: s.inbound || null,
      // Restore the lock, but only while it is still valid — an expired hold is released
      // so the fare re-validates at the live price like any unheld trip.
      fareHold: (s.fareHold && s.fareHold.until > Date.now()) ? s.fareHold : null,
      extras: Array.isArray(s.extras) ? s.extras : [],
      passengers: Array.isArray(s.passengers) ? s.passengers : [],
      contact: s.contact || null,
    });
    notify();
    return true;
  } catch { return false; }
}

// Rebuild an abandoned basket from the server snapshot so a returning member resumes
// exactly where they left off (flight + add-ons), with the count showing in the nav.
export function restoreFromSaved(saved) {
  if (!saved) return false;
  // Cart persistence #2 — a restore may NEVER overwrite the current booking context. If this
  // session already holds a confirmed booking (pnr) or an in-progress trip (a chosen flight),
  // that context wins; restoring a stale/superseded server basket here is exactly the bug where
  // "the cart reloads data from a previous booking". Only an empty context may be resumed.
  if (trip.pnr || trip.outbound || (trip.extras && trip.extras.length)) return false;
  const snap = saved.snapshot || {};
  const extras = Array.isArray(snap.extras) ? snap.extras : [];
  if (!extras.length && !snap.outbound) return false;
  Object.assign(trip, {
    type: snap.type || "round", pax: snap.pax || 1, cabin: snap.cabin || "Economy",
    origin: snap.origin ?? null, dest: snap.dest ?? null, date: snap.date ?? null, ret: snap.ret ?? null,
    outbound: snap.outbound || null, inbound: snap.inbound || null,
    fareHold: (snap.fareHold && snap.fareHold.until > Date.now()) ? snap.fareHold : null,
    extras: extras.map(e => ({ ...e, qty: e.qty || 1, cat: e.cat || "Extras", source: e.source || "recommended" })),
  });
  notify();
  return true;
}
// ── Multi-trip basket (Important #5) ─────────────────────────────────────────
// A member can park several in-progress trips in the basket and resume any later.
// The server keeps one "open" basket; this client layer holds the rest as an
// array of trip snapshots so the Basket page can manage multiple trips at once.
const BKEY = "flyxperion_basket_trips";
function readBasket() { try { const r = localStorage.getItem(BKEY); const a = r ? JSON.parse(r) : []; return Array.isArray(a) ? a : []; } catch { return []; } }
function writeBasket(a) { try { localStorage.setItem(BKEY, JSON.stringify(a)); } catch { } notify(); }
export function getBasketTrips() { return readBasket(); }
export function saveTripToBasket() {
  if (!trip.outbound) return null;
  const snap = { ...tripSnapshot(), passengers: (trip.passengers || []).map(p => ({ ...p })) };
  const id = "bt_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const key = (s) => (s.outbound?.flight?.flight_no || "") + "|" + (s.date || "");
  const a = readBasket().filter(x => key(x.snap) !== key(snap));   // re-saving the same trip updates in place
  a.unshift({ id, savedAt: Date.now(), snap });
  writeBasket(a.slice(0, 12));
  return id;
}
export function removeBasketTrip(id) { writeBasket(readBasket().filter(x => x.id !== id)); }
export function resumeBasketTrip(id) {
  const a = readBasket(); const found = a.find(x => x.id === id); if (!found) return false;
  restoreFromSaved({ snapshot: found.snap });
  if (found.snap.passengers) trip.passengers = found.snap.passengers.map(p => ({ ...p }));
  writeBasket(a.filter(x => x.id !== id));   // resuming moves it out of the basket into the active trip
  return true;
}
// ── Multi-trip checkout ───────────────────────────────────────────────────────
// Each itinerary is its own order/PNR, but a basket settles in ONE payment — so the
// trips the member picked ride along in a queue and are issued after the active trip.
const QKEY = "flyxperion_checkout_queue";
export function getQueue() { try { const r = localStorage.getItem(QKEY); const a = r ? JSON.parse(r) : []; return Array.isArray(a) ? a : []; } catch { return []; } }
export function setQueue(snaps) { try { localStorage.setItem(QKEY, JSON.stringify(snaps || [])); } catch { } notify(); }
export function clearQueue() { try { localStorage.removeItem(QKEY); } catch { } notify(); }
// Toggle a single line item off/on inside a PARKED trip (line-item level selection).
export function toggleSavedExtra(id, code) {
  const a = readBasket(); const x = a.find(v => v.id === id); if (!x) return false;
  const ex = Array.isArray(x.snap.extras) ? x.snap.extras : [];
  const i = ex.findIndex(e => e.code === code);
  if (i >= 0) { const e = ex[i]; ex.splice(i, 1); (x.snap._off = x.snap._off || []).push(e); }
  else { const off = x.snap._off || []; const j = off.findIndex(e => e.code === code); if (j >= 0) ex.push(off.splice(j, 1)[0]); }
  x.snap.extras = ex; writeBasket(a); return true;
}
export function savedExtraOn(snap, code) { return (snap.extras || []).some(e => e.code === code); }
export function savedAllExtras(snap) { return [...(snap.extras || []), ...(snap._off || [])]; }

export function basketTripTotal(snap) {
  const flights = (snap.outbound?.price || 0) + (snap.inbound?.price || 0);
  const extras = (snap.extras || []).reduce((s, e) => s + (e.price || 0), 0);
  return flights + extras;
}
// Source labels for the basket classification (recommended by system / auto-added / added by you).
export const SOURCE_META = {
  recommended: { label: "Recommended for you", tag: "Recommended", tone: "green" },
  auto: { label: "Auto-added", tag: "Auto-added", tone: "slate" },
  user: { label: "Extras you added", tag: "Added by you", tone: "lime" },
};
export const SOURCE_ORDER = ["user", "recommended", "auto"];
export function extrasBySource() {
  const g = { user: [], recommended: [], auto: [] };
  for (const e of trip.extras) (g[e.source] || g.recommended).push(e);
  return g;
}
// group added extras by category for the basket summary (Hotels / Cars / Insurance / …)
export function extrasByCategory() {
  const g = {};
  for (const e of trip.extras) { g[e.cat || "Extras"] = (g[e.cat || "Extras"] || 0) + (e.price || 0) * (e.qty || 1); }
  return g;
}
export function bundleSavings() {
  // Cross-sell bundle discount: 15% off when a stay (Hotels) and Lounge & services
  // are booked together. Proportional to the actual extras, not a fixed amount.
  const g = extrasByCategory();
  if (!(g["Hotels"] > 0 && g["Lounge & services"] > 0)) return 0;
  const base = (g["Hotels"] || 0) + (g["Lounge & services"] || 0);
  return Math.round(base * 0.15 * 100) / 100;
}
export function tripTotals() {
  // Round/one-way use outbound+inbound; multi-city sums every leg in trip.legs (B1).
  const legList = (trip.legs && trip.legs.length) ? trip.legs : [trip.outbound, trip.inbound];
  const legPrice = legList.reduce((s, l) => s + (l?.price || 0), 0);
  const flights = legPrice * (trip.pax || 1);
  const extras = trip.extras.reduce((s, x) => s + (x.price || 0) * (x.qty || 1), 0);
  const taxes = Math.round((flights + extras) * 0.085);
  const bundle = bundleSavings();
  const reprice = trip.repriceDelta || 0;   // H2 — mid-booking price change the passenger accepted
  const total = flights + extras + taxes - bundle + reprice;
  return { flights, extras, taxes, bundle, reprice, total };
}
