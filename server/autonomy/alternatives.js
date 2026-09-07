"use strict";
/* alternatives.js — the "how do I not get stuck?" agent.

   Given a booking and everything the layer knows about its destination — the research brief
   (political, social, strike, transport, health events with dates), the live weather outlook,
   and any active disruption prediction — it builds a risk window and scores concrete
   alternatives against it:

     SHIFT_DATE        same route, a day or more earlier/later that dodges the risk window,
                       with the cheapest real flight for that day
     ALTERNATE_AIRPORT another served airport in the same country within reach, with its own
                       weather looked up and a ground-transfer estimate
     KEEP_WITH_FLEX    keep the plan and add free changes up to departure (when nothing better)

   Every candidate carries a transparent risk score (0–1) and the reasons behind it. Nothing is
   executed here: candidates are Tier-0 information until the customer picks one, and taking a
   date shift runs SHIFT_TRIP_DATE (Tier 1, reversible) through the policy engine. */

const { db } = require("../db");
const G = require("./graph");
const O = require("./ontology");
const clock = require("./clock");
const research = require("./research");
const feeds = require("./feeds");
const { geocode } = require("./geo");
const search = require("../search");
const countries = require("../countries");
const { AIRPORTS } = require("../routes-data");

const KIND_RISK = { strike: 0.55, transport: 0.5, political: 0.4, civil: 0.45, health: 0.25, festival: 0.15, sport: 0.1, concert: 0.05, conference: 0.05, other: 0.15 };
const IMPACT_MULT = { high: 1.0, medium: 0.7, low: 0.35 };
const WEATHER_RISK = { thunderstorm: 0.35, heavy_rain: 0.2, snow: 0.35, snow_showers: 0.3, fog: 0.3, rain: 0.05, drizzle: 0.03, fair: 0 };
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmtDay = (iso) => { try { return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }); } catch { return iso; } };
const label = (r) => (r >= 0.5 ? "high" : r >= 0.3 ? "elevated" : r >= 0.12 ? "low" : "clear");

/* parse "2026-09-10", "2026-09-04/2026-09-06", "2026-09-04 to 2026-09-06", "Sept 10" (year of the trip) */
function eventDays(ev, tripDate) {
  const s = String(ev.date || "");
  const isoAll = s.match(/\d{4}-\d{2}-\d{2}/g) || [];
  if (isoAll.length >= 2) { const out = []; for (let d = isoAll[0]; d <= isoAll[1] && out.length < 14; d = addDays(d, 1)) out.push(d); return out; }
  if (isoAll.length === 1) return [isoAll[0]];
  const m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?/i) || s.match(/\b(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/i);
  if (m) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const mon = months.indexOf(String(m[1].length === 3 || isNaN(m[1]) ? m[1] : m[3]).slice(0, 3).toLowerCase());
    const d1 = Number(isNaN(m[1]) ? m[2] : m[1]), d2 = Number(isNaN(m[1]) ? m[3] : m[2]) || d1;
    const y = tripDate.slice(0, 4); const out = [];
    for (let d = d1; d <= d2 && out.length < 14; d++) out.push(`${y}-${String(mon + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    return out;
  }
  return [];
}

/* the risk window: per day, the max of what threatens a traveller arriving that day, with reasons */
function riskWindow(brief, { from, to }, prediction) {
  const days = {}; for (let d = from; d <= to; d = addDays(d, 1)) days[d] = { risk: 0, reasons: [] };
  const bump = (d, r, why) => { if (!days[d]) return; if (r > days[d].risk) days[d].risk = Number(r.toFixed(2)); days[d].reasons.push(why); };
  for (const day of brief.weather?.days || []) bump(day.date, WEATHER_RISK[day.label] ?? 0.05, `${day.label}${day.gust_kmh >= 60 ? ", gusts" : ""}`);
  for (const a of brief.weather?.alerts || []) { for (let d = String(a.valid?.from || "").slice(0, 10); d && d <= String(a.valid?.to || d).slice(0, 10) && days[d] !== undefined; d = addDays(d, 1)) bump(d, 0.45, a.headline || a.type); }
  for (const ev of brief.events || []) {
    const r = (KIND_RISK[ev.kind] ?? 0.15) * (IMPACT_MULT[ev.impact] ?? 0.5);
    const evDays = eventDays(ev, from);
    if (!evDays.length) continue;
    for (const d of evDays) { bump(d, r, ev.title); if (/strike|transport/.test(ev.kind)) bump(addDays(d, 1), r * 0.6, `after: ${ev.title}`); }
  }
  if (prediction && prediction.probability) bump(from, Number(prediction.probability), `disruption prediction ${prediction.state} p=${prediction.probability}`);
  return days;
}

function cheapestFlight(origin, dest, date) {
  try { const fl = search.generateFlights(origin, dest, date); if (!fl?.length) return null; return fl.slice().sort((a, b) => a.price - b.price)[0]; } catch { return null; }
}
function haversine(a, b) { const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLon = (b.lon - a.lon) * Math.PI / 180; const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); }

/* build alternatives for a booking; returns the assessment (also stored in the graph) */
async function assess(booking, { brief = null, prediction = null, spread = 3 } = {}) {
  let meta = {}; try { meta = JSON.parse(booking.meta_json || "{}"); } catch {}
  const f = db.prepare("SELECT origin, dest, dep FROM flights WHERE flight_no=? AND flight_date=?").get(booking.flight_no, booking.flight_date) || db.prepare("SELECT origin, dest, dep FROM flights WHERE flight_no=?").get(booking.flight_no) || {};
  const origin = meta.origin || f.origin, dest = meta.dest || f.dest, date = booking.flight_date;
  if (!origin || !dest) return null;
  const from = addDays(date, -spread), to = addDays(date, spread + 2);
  brief = brief || await research.build(dest, date, addDays(date, 3));
  const window = riskWindow(brief, { from, to }, prediction);
  const trip = window[date] || { risk: 0, reasons: [] };
  const current = cheapestFlight(origin, dest, date);
  const cands = [];

  /* 1 · shift the date: every day in the window that is materially safer */
  for (const d of Object.keys(window)) {
    if (d === date) continue;
    const w = window[d]; if (w.risk >= trip.risk - 0.1 && trip.risk >= 0.12) continue;   // must actually reduce risk
    if (trip.risk < 0.12) continue;                                                     // nothing to dodge
    const fl = cheapestFlight(origin, dest, d); if (!fl) continue;
    const delta = Math.round((new Date(d) - new Date(date)) / 86400000);
    cands.push({ id: `alt:${booking.pnr}:date:${d}`, type: "SHIFT_DATE", label: `${delta < 0 ? "Go" : "Go"} ${Math.abs(delta)} day${Math.abs(delta) > 1 ? "s" : ""} ${delta < 0 ? "earlier" : "later"} — ${fmtDay(d)}`, date: d, flight_no: fl.flight_no, dep: fl.dep, arr: fl.arr, price: fl.price, price_delta: current ? fl.price - current.price : null, risk: w.risk, risk_label: label(w.risk), why: w.reasons.length ? `That day: ${w.reasons.slice(0, 2).join("; ")}` : "Nothing notable that day", detail: `${fl.flight_no} ${fl.dep}–${fl.arr} · $${fl.price}${current ? ` (${fl.price - current.price >= 0 ? "+" : ""}$${fl.price - current.price} vs your date)` : ""}` });
  }
  cands.sort((a, b) => a.risk - b.risk || Math.abs(new Date(a.date) - new Date(date)) - Math.abs(new Date(b.date) - new Date(date)));
  const shifts = cands.filter((c) => c.type === "SHIFT_DATE").slice(0, 2);

  /* 2 · another served airport in the same country within reach (own weather, no known events) */
  const alts = [];
  if (trip.risk >= 0.12) {
    const iso = AIRPORTS[dest]?.country; const here = await geocode(dest).catch(() => null);
    if (iso && here) {
      for (const code of countries.airportsIn(iso).filter((c) => c !== dest)) {
        const g = await geocode(code).catch(() => null); if (!g) continue;
        const km = haversine(here, g); if (km > 350 || !search.getRoute(origin, code)) continue;
        const daily = (await feeds.openMeteoDaily(code, 10).catch(() => null) || []).find((x) => x.date === date);
        const wr = daily ? (WEATHER_RISK[daily.label] ?? 0.05) : 0.1;
        const fl = cheapestFlight(origin, code, date); if (!fl) continue;
        alts.push({ id: `alt:${booking.pnr}:apt:${code}`, type: "ALTERNATE_AIRPORT", label: `Fly into ${AIRPORTS[code].city} (${code}) instead — ${Math.round(km)} km away`, code, city: AIRPORTS[code].city, date, flight_no: fl.flight_no, dep: fl.dep, arr: fl.arr, price: fl.price, distance_km: Math.round(km), transfer_min: Math.round(km / 70 * 60), risk: Number(wr.toFixed(2)), risk_label: label(wr), why: `${daily ? daily.label + " there" : "weather not checked"}; city-specific events at ${brief.city} don't apply · ground transfer ≈ ${Math.round(km / 70)}h`, detail: `${fl.flight_no} ${fl.dep}–${fl.arr} · $${fl.price}` });
        if (alts.length >= 4) break;
      }
    }
  }
  alts.sort((a, b) => a.risk - b.risk || a.distance_km - b.distance_km);
  const airports = alts.slice(0, 1);

  /* 3 · keep + flexibility, always available */
  const flex = { id: `alt:${booking.pnr}:flex`, type: "KEEP_WITH_FLEX", label: "Keep the plan, add free changes", date, risk: trip.risk, risk_label: label(trip.risk), why: "Change to any day up to 2 h before departure at no fee if things move", detail: "Flex add-on · $29", price: 29 };

  const assessment = {
    id: `risk:${booking.pnr}`, pnr: booking.pnr, uid: booking.user_id, flight_no: booking.flight_no, date, origin, dest, city: brief.city,
    trip_risk: trip.risk, trip_risk_label: label(trip.risk), trip_reasons: trip.reasons.slice(0, 4),
    window: Object.entries(window).map(([d, w]) => ({ date: d, risk: w.risk, label: label(w.risk) })),
    alternatives: [...shifts, ...airports, flex], brief_id: brief.id || null, prediction_id: prediction?.id || null, generated_at: clock.nowIso(),
  };
  G.upsertNode(assessment.id, "TripRiskAssessment", assessment);
  if (brief.id) G.upsertEdge(assessment.id, "BASED_ON", brief.id);
  O.audit({ actor: "alternatives", action: "RISK_ASSESSMENT", rationale: `${booking.pnr} → ${brief.city} ${date}: trip risk ${trip.risk} (${label(trip.risk)}); ${shifts.length} date shift(s), ${airports.length} alternate airport(s) proposed; customer decides` });
  return assessment;
}

/* the customer took one: SHIFT_TRIP_DATE / SWITCH_AIRPORT are Tier-1, reversible, policy-gated */
function take(uid, altId) {
  const policy = require("./policy");
  const bridge = require("./bridge");
  const [, pnr, kind] = String(altId || "").split(":");
  const a = G.getNode(`risk:${pnr}`); const alt = (a?.alternatives || []).find((x) => x.id === altId);
  if (!a || !alt || a.uid !== uid) return { ok: false, error: "unknown_alternative" };
  const b = db.prepare("SELECT * FROM bookings WHERE pnr=? AND user_id=?").get(pnr, uid);
  if (!b) return { ok: false, error: "no_booking" };
  let meta = {}; try { meta = JSON.parse(b.meta_json || "{}"); } catch {}
  if (alt.type === "KEEP_WITH_FLEX") {
    meta.flex = { added_at: clock.nowIso(), price: alt.price };
    db.prepare("UPDATE bookings SET meta_json=? WHERE id=?").run(JSON.stringify(meta), b.id);
    O.audit({ actor: "alternatives", action: "ADD_FLEX", rationale: `${pnr}: Flex added, plan kept` });
    return { ok: true, reply: `Done — your ${a.city} trip stays on ${fmtDay(b.flight_date)} with Flex added: change to any day up to 2 hours before departure, no fee. I'll keep watching ${a.city} for you.`, booking: { pnr, status: b.status } };
  }
  const gate = policy.execute(alt.type === "ALTERNATE_AIRPORT" ? "SWITCH_AIRPORT" : "SHIFT_TRIP_DATE", { passengerId: bridge.PAX(uid), channel: "push" }, { actor: "alternatives", rationale: `customer chose ${alt.label}` });
  if (!gate.ok) return { ok: false, error: gate.refused || gate.failed || "policy", gate };
  /* make the chosen flight real and move the booking onto it (reversible: original kept in meta) */
  try { db.prepare("INSERT INTO flights (flight_no,origin,dest,dep,arr,duration,aircraft,price,seats_left,flight_date,status) SELECT ?,?,?,?,?,'',?,?,?,?,'scheduled' WHERE NOT EXISTS (SELECT 1 FROM flights WHERE flight_no=? AND flight_date=?)").run(alt.flight_no, a.origin, alt.code || a.dest, alt.dep, alt.arr, "A321", alt.price, 9, alt.date, alt.flight_no, alt.date); } catch {}
  meta.original = meta.original || { flight_no: b.flight_no, flight_date: b.flight_date, dest: a.dest };
  meta.rebooked_from = { flight_no: b.flight_no, flight_date: b.flight_date, reason: alt.type, why: alt.why, at: clock.nowIso() };
  if (alt.type === "ALTERNATE_AIRPORT") { meta.dest = alt.code; meta.origin = a.origin; meta.dep = alt.dep; meta.arr = alt.arr; }
  else { meta.origin = a.origin; meta.dest = a.dest; meta.dep = alt.dep; meta.arr = alt.arr; }
  db.prepare("UPDATE bookings SET flight_no=?, flight_date=?, status='rebooked', checked_in=0, meta_json=? WHERE id=?").run(alt.flight_no, alt.date, JSON.stringify(meta), b.id);
  O.audit({ actor: "alternatives", action: alt.type === "ALTERNATE_AIRPORT" ? "SWITCH_AIRPORT" : "SHIFT_TRIP_DATE", rationale: `${pnr}: ${b.flight_no} ${b.flight_date} → ${alt.flight_no} ${alt.date}${alt.code ? " into " + alt.code : ""}; risk ${a.trip_risk} → ${alt.risk}` });
  const reply = alt.type === "ALTERNATE_AIRPORT"
    ? `Done — you now fly into ${alt.city} (${alt.code}) on ${fmtDay(alt.date)}, ${alt.flight_no} ${alt.dep}–${alt.arr}, about ${Math.round(alt.distance_km / 70)}h by road from ${a.city}. Risk there is ${alt.risk_label}. Booking ${pnr} is updated in My Trips; your original flight is kept on file if you want it back.`
    : `Done — you now travel on ${fmtDay(alt.date)}, ${alt.flight_no} ${alt.dep}–${alt.arr}${alt.price_delta != null ? ` (${alt.price_delta >= 0 ? "+" : ""}$${alt.price_delta})` : ""}. That day looks ${alt.risk_label} instead of ${a.trip_risk_label}. Booking ${pnr} is updated in My Trips; your original date is kept on file if you want it back.`;
  return { ok: true, reply, booking: { pnr, flight_no: alt.flight_no, date: alt.date, status: "rebooked" }, alt };
}

function forBooking(pnr) { return G.getNode(`risk:${pnr}`) || null; }

module.exports = { assess, take, forBooking, riskWindow, eventDays, label };
