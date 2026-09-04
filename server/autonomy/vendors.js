/* autonomy/vendors.js
   STUB: hotel, ground-transport and partner-inventory contracts. Real vendor
   APIs were unavailable, so these implement the same contract shape the agents
   would call (reserve/cancel with idempotency keys, capacity that depletes,
   injectable failures) and are marked STUB throughout. Never invents fields of
   a real system. Also: the notification channel stub and message templates. */
"use strict";
const clock = require("./clock");

/* ---------- STUB: seat inventory (PSS shim for recovery flights) ---------- */
const seats = {};            // flight_no -> remaining
const seatHolds = {};        // holdRef -> { flight_no, n, expiry }
function seedSeats(map) { Object.assign(seats, map); }
function seatsLeft(fno) { return seats[fno] ?? 0; }
function holdSeats(fno, n, ref, ttlMs) {
  if (seatHolds[ref]) return { ok: true, ref, idempotent: true };
  if ((seats[fno] ?? 0) < n) return { ok: false, error: "inventory_exhausted" };
  seats[fno] -= n;
  seatHolds[ref] = { flight_no: fno, n, expiry: clock.now().getTime() + ttlMs };
  return { ok: true, ref, expiry: new Date(seatHolds[ref].expiry).toISOString() };
}
function releaseSeats(ref) {
  const h = seatHolds[ref]; if (!h) return { ok: true, idempotent: true };
  seats[h.flight_no] += h.n; delete seatHolds[ref];
  return { ok: true };
}
function confirmSeats(ref) {   // hold → firm booking (seats stay decremented)
  const h = seatHolds[ref]; if (!h) return { ok: false, error: "no_hold" };
  delete seatHolds[ref];
  return { ok: true, pssRef: "RB-" + ref.slice(-6).toUpperCase() };
}

/* ---------- STUB: hotel + taxi vendors with idempotent reserve ---------- */
const failures = { hotel: false, taxi: false };
const setFailure = (kind, on) => { failures[kind] = !!on; };
const reservations = {};     // idemKey -> record
function reserve(kind, vendorId, idemKey, details) {
  if (reservations[idemKey]) return { ok: true, ref: reservations[idemKey].ref, idempotent: true };
  if (failures[kind]) return { ok: false, error: `${kind}_api_unavailable` };
  const h = Math.abs([...idemKey].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)).toString(36).toUpperCase().slice(0, 6);
  const ref = `${kind.toUpperCase()}-${h}`;
  reservations[idemKey] = { kind, vendorId, ref, details, at: clock.nowIso() };
  return { ok: true, ref };
}
function cancel(idemKey) {
  if (!reservations[idemKey]) return { ok: true, idempotent: true };
  delete reservations[idemKey];
  return { ok: true, compensated: true };
}

/* ---------- STUB: notification channel — records sends, never claims delivery ---------- */
const outbox = [];
function send(channel, to, text, meta = {}) {
  const rec = { channel, to, text, status: `queued (demo ${channel} channel)`, at: clock.nowIso(), ...meta };
  outbox.push(rec);
  return { ok: true, status: rec.status };
}
const sent = () => outbox.slice();
function resetVendors() {
  for (const k of Object.keys(seats)) delete seats[k];
  for (const k of Object.keys(seatHolds)) delete seatHolds[k];
  for (const k of Object.keys(reservations)) delete reservations[k];
  outbox.length = 0; failures.hotel = false; failures.taxi = false;
}

/* ---------- message templates, EN + HI; facts are interpolated from the graph ONLY ---------- */
const TEMPLATES = {
  offer: {
    en: "Hi {name}. Weather near {dest} may disrupt {flight} on {date}. We prepared options for you: {optionList}. Tap once to confirm — everything else is handled. {incentiveLine}",
    hi: "Namaste {name}. {date} ko {flight} ki uraan par {dest} ke paas mausam ka asar ho sakta hai. Aapke liye vikalp tayyar hain: {optionList}. Ek tap mein pushti karein — baaki hum sambhal lenge. {incentiveLine}",
  },
  all_clear: {
    en: "Good news, {name}: the weather risk for {flight} on {date} has passed. Your original plan stands. No action needed.",
    hi: "Khushkhabri, {name}: {date} ko {flight} ke liye mausam ka khatra tal gaya hai. Aapki yatra yathavat hai. Kuch karne ki zaroorat nahin.",
  },
  confirm: {
    en: "Done, {name}. {summary}. Your updated itinerary and vouchers are in the app. Reference {ref}.",
    hi: "Ho gaya, {name}. {summary}. Aapka naya itinerary aur voucher app mein hain. Sandarbh {ref}.",
  },
};
function render(kind, locale, facts) {
  const t = (TEMPLATES[kind] || {})[locale?.startsWith("hi") ? "hi" : "en"] || TEMPLATES[kind].en;
  const msg = t.replace(/\{(\w+)\}/g, (_, k) => {
    if (!(k in facts)) throw new Error(`template fact missing: ${k}`);   // LLM/templates never invent facts
    return String(facts[k]);
  });
  if (/\{\w+\}/.test(msg)) throw new Error("unresolved template slot");
  return msg;
}

module.exports = { seedSeats, seatsLeft, holdSeats, releaseSeats, confirmSeats, reserve, cancel, setFailure, send, sent, resetVendors, render };
