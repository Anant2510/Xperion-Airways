"use strict";
/* bridge.js — joins the Enterprise Autonomy layer to the live customer app.

   Before this module the autonomy pipeline reasoned over a synthetic manifest and its messages
   landed in the autonomy outbox. The bridge makes the app's real customers first-class citizens
   of the knowledge graph and routes the agents' decisions into the channels those customers
   actually use:

     link()        real app users → Passenger + PNR nodes on the disrupted flight, backed by a
                   real row in `bookings` (+ `flights`) so the trip shows in My Trips and the
                   home-page hero exactly like any other booking.
     onOffer()     the Offer agent's message → in-app assistant inbox (proactive bubble + banner),
                   WhatsApp / SMS / push / email through the app's existing providers, with
                   honest statuses when a provider is not configured. Mirrored into chat_turns so
                   the assistant remembers what it proactively said.
     onAccepted()  the Execution agent's saga result → the real booking is rebooked (status,
                   itinerary, recovery bundle), confirmation on the same channel + inbox card.
     pending()     the customer's open offer, for the chat and WhatsApp intercepts.
     intercept()   plain-language acceptance ("take the Orlando option", "2", "refund") from the
                   assistant or WhatsApp → the same accept saga as a button press.

   The in-process acceptance suite never calls link(), so its 214-passenger world is untouched;
   the server router links after every world reset. */

const { db, now } = require("../db");
const G = require("./graph");
const O = require("./ontology");
const clock = require("./clock");

db.exec(`CREATE TABLE IF NOT EXISTS ai_inbox (
  id INTEGER PRIMARY KEY, user_id INTEGER, kind TEXT, text TEXT, card_json TEXT,
  seen INTEGER DEFAULT 0, created_at TEXT
);`);

const PAX = (uid) => `pax:app:${uid}`;
const PNR = (uid) => `pnr:app:${uid}`;
const LOC = (uid) => `XPW${String(uid).padStart(2, "0")}A`;
const CITY = { DEL: "Delhi", MIA: "Miami", JFK: "New York", MCO: "Orlando", FLL: "Fort Lauderdale", ATL: "Atlanta", JAI: "Jaipur", AMD: "Ahmedabad" };
const city = (c) => CITY[c] || c;
const hhmm = (iso) => { try { return new Date(iso).toISOString().slice(11, 16); } catch { return ""; } };
const j = (o) => JSON.stringify(o ?? null);
const parse = (s, d = null) => { try { return JSON.parse(s || "null") ?? d; } catch { return d; } };

/* lazy app modules: the autonomy layer must stay loadable in the in-process test harness */
let _notify, _wa, _email;
const notify = () => { try { return _notify || (_notify = require("../notify")); } catch { return null; } };
const wa = () => { try { return _wa || (_wa = require("../whatsapp")); } catch { return null; } };
const email = () => { try { return _email || (_email = require("../email")); } catch { return null; } };

/* ─────────────────────────── world lookups ─────────────────────────── */
function disruptedFlight() {
  return G.nodesByKind("FlightInstance").find((n) => n.flight_no === "XP201" && !n.recovery) || null;
}
function activePrediction() {
  return G.nodesByKind("DisruptionPrediction")
    .filter((p) => !["RESOLVED", "STOOD_DOWN"].includes(p.state))
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))[0] || null;
}
function users() {
  try { return db.prepare("SELECT id, first_name, full_name, email, phone, tier, nationality, home_airport FROM users ORDER BY id").all(); }
  catch { return []; }
}
function seatPref(uid) {
  try {
    const p = db.prepare("SELECT seat FROM preferences WHERE user_id=?").get(uid);
    const s = (p?.seat || "").split(" ")[0];
    return /^\d{1,2}[A-K]$/.test(s) ? s : "14C";
  } catch { return "14C"; }
}

/* ─────────────────────────── 1 · link real customers ─────────────────────────── */
function ensureFlightRow(fi, extra = {}) {
  const dep = hhmm(fi.sched_dep), arr = fi.sched_arr ? hhmm(fi.sched_arr) : "";
  const row = { flight_no: fi.flight_no, origin: fi.origin, dest: fi.dest, dep, arr, duration: fi.sched_arr ? durationOf(fi.sched_dep, fi.sched_arr) : "", aircraft: fi.aircraft_type === "A339" ? "A330-900neo" : (fi.aircraft_type || "A330-900neo"), price: 780, seats_left: 9, flight_date: fi.date || (fi.sched_dep || "").slice(0, 10), status: "scheduled", ...extra };
  const ex = db.prepare("SELECT id FROM flights WHERE flight_no=? AND flight_date=?").get(row.flight_no, row.flight_date);
  if (ex) {
    db.prepare("UPDATE flights SET origin=?, dest=?, dep=?, arr=?, duration=?, aircraft=?, status=? WHERE id=?").run(row.origin, row.dest, row.dep, row.arr, row.duration, row.aircraft, row.status, ex.id);
    return ex.id;
  }
  return db.prepare("INSERT INTO flights (flight_no,origin,dest,dep,arr,duration,aircraft,price,seats_left,flight_date,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(row.flight_no, row.origin, row.dest, row.dep, row.arr, row.duration, row.aircraft, row.price, row.seats_left, row.flight_date, row.status).lastInsertRowid;
}
function durationOf(a, b) {
  const m = Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function link() {
  const fi = disruptedFlight();
  if (!fi) return { linked: [] };
  ensureFlightRow(fi);
  const linked = [];
  for (const u of users()) {
    const uid = u.id, loc = LOC(uid);
    const locale = (u.nationality || "").toUpperCase() === "IN" ? "hi-IN" : "en-US";
    const channels = [
      { channel: "whatsapp", consent: !!u.phone },
      { channel: "push", consent: true },
      { channel: "sms", consent: !!u.phone },
      { channel: "email", consent: !!u.email },
    ];
    G.upsertNode(PAX(uid), "Passenger", {
      name: u.full_name || u.first_name, loyalty_tier: u.tier || "Silver", vulnerability_flags: [],
      contact_channels: channels, preferred_channel: u.phone ? "whatsapp" : "push",
      quiet_hours: null,            // app customers opted into urgent travel alerts at any hour (profile setting)
      locale, flexible: false, ltv_band: u.tier === "Platinum" ? "top" : u.tier === "Gold" ? "high" : "std",
      app_uid: uid, app_email: u.email || null, app_phone: u.phone || null, source: "app-profile",
    });
    G.upsertNode(PNR(uid), "PNR", { record_locator: loc, party_size: 1, fare_class: u.tier === "Platinum" ? "J" : "Y", segments: [{ f: fi.flight_no }], app_uid: uid, source: "app-booking" });
    G.upsertEdge(fi.id, "CARRIES", PNR(uid));
    G.upsertEdge(PNR(uid), "BELONGS_TO", PAX(uid));

    /* real booking row — the trip customers see in My Trips */
    const meta = { origin: fi.origin, dest: fi.dest, dep: hhmm(fi.sched_dep), arr: hhmm(fi.sched_arr), duration: durationOf(fi.sched_dep, fi.sched_arr), aircraft: "A330-900neo", autonomy: { flight_instance: fi.id, pnr_node: PNR(uid) } };
    const ex = db.prepare("SELECT id, meta_json FROM bookings WHERE pnr=? AND user_id=?").get(loc, uid);
    if (ex) {
      db.prepare("UPDATE bookings SET flight_no=?, flight_date=?, status='confirmed', checked_in=0, meta_json=? WHERE id=?").run(fi.flight_no, fi.date, j(meta), ex.id);
      G.setProps(PNR(uid), { app_booking_id: ex.id });
    } else {
      const r = db.prepare("INSERT INTO bookings (pnr,user_id,flight_no,flight_date,seat,status,checked_in,items_json,meta_json,created_at) VALUES (?,?,?,?,?,'confirmed',0,'[]',?,?)")
        .run(loc, uid, fi.flight_no, fi.date, seatPref(uid), j(meta), now());
      G.setProps(PNR(uid), { app_booking_id: Number(r.lastInsertRowid) });
    }
    linked.push({ uid, name: u.first_name, pnr: loc, tier: u.tier });
  }
  db.prepare("DELETE FROM ai_inbox WHERE kind LIKE 'disruption%'").run();
  O.audit({ actor: "bridge", action: "LINK_APP_CUSTOMERS", rationale: `${linked.length} real customers linked to ${fi.id} as Passenger/PNR nodes with live bookings` });
  return { linked };
}
function linked() {
  return G.nodesByKind("PNR").filter((p) => p.app_uid).map((p) => {
    const pax = G.getNode(PAX(p.app_uid)) || {};
    const off = offerFor(p.app_uid);
    return { uid: p.app_uid, name: pax.name, tier: pax.loyalty_tier, pnr: p.record_locator, channel: off?.channel || null, state: off ? (off.executed ? "EXECUTED" : off.state) : "NO_OFFER", delivery: off?.app_delivery || "" };
  });
}
function isLinked() { return G.nodesByKind("PNR").some((p) => p.app_uid); }

/* ─────────────────────────── 2 · offers → real channels ─────────────────────────── */
function optionView(o) {
  const c = o.components || [];
  if (o.type === "REROUTE") {
    const legs = c.filter((x) => x.flight).map((x) => `${x.flight} ${x.route}`).join(" + ");
    return { id: o.id, type: o.type, label: "Reroute via New York, arrive next morning", detail: `${legs} · seats held ${o.seat_hold_ref ? "for you" : ""}`.trim(), cost: "no charge", tag: "Fastest to Miami" };
  }
  if (o.type === "DIVERT_PLUS_GROUND") {
    return { id: o.id, type: o.type, label: "Land in Orlando tonight, hotel + taxi + morning transfer to Miami", detail: "Hotel voucher, taxi from MCO and a morning transfer, all arranged and prepaid", cost: "no charge", tag: "Rest tonight" };
  }
  if (o.type === "REFUND") return { id: o.id, type: o.type, label: "Hold my seat and prepare a full refund", detail: "Refund packaged for a human controller to approve", cost: "full refund", tag: "Not travelling" };
  if (o.type === "WAITLIST") return { id: o.id, type: o.type, label: "Waitlist — a controller will call you", detail: "No seats left on alternatives right now", cost: "", tag: "Escalated" };
  return { id: o.id, type: o.type, label: o.type, detail: "", cost: "" };
}
function reasonsOf(pred) {
  const s = pred?.scorecard || pred?.reasons || pred?.evidence;
  if (Array.isArray(s)) return s.map((x) => (typeof x === "string" ? x : x.label || x.reason || JSON.stringify(x))).slice(0, 4);
  if (s && typeof s === "object") return Object.entries(s).filter(([, v]) => typeof v !== "object").map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).slice(0, 4);
  return [];
}
function inbox(uid, kind, text, card) {
  const r = db.prepare("INSERT INTO ai_inbox (user_id,kind,text,card_json,seen,created_at) VALUES (?,?,?,?,0,?)").run(uid, kind, text, j(card), now());
  try { db.prepare("INSERT INTO chat_turns (user_id,channel,role,content,created_at) VALUES (?,?,?,?,?)").run(uid, "app", "assistant", text, now()); } catch {}
  return Number(r.lastInsertRowid);
}
function record(uid, pnr, event, channel, recipient, status, body) {
  const n = notify(); if (n?.record) n.record({ uid, pnr, event, channel, recipient, status, body });
}
async function deliver({ uid, pnr, channel, text, event, emailType, emailData }) {
  const u = db.prepare("SELECT email, phone, wa_id FROM users WHERE id=?").get(uid) || {};
  /* WhatsApp recipient, same precedence as the app's existing proactive push: the demo's
     configured number, then the real WhatsApp number that last spoke as this persona, then
     the profile phone. */
  const waTo = process.env.WHATSAPP_DEFAULT_TO || u.wa_id || u.phone || null;
  const results = [];
  const push = async (ch, fn) => { try { results.push({ channel: ch, ...(await fn()) }); } catch (e) { results.push({ channel: ch, status: "send failed: " + e.message.slice(0, 60) }); } };
  if (channel === "whatsapp") {
    await push("whatsapp", async () => {
      const w = wa();
      if (!waTo) return { status: "skipped (no WhatsApp number known)", recipient: null };
      if (!w?.sendText) return { status: "queued (WhatsApp module unavailable)", recipient: waTo };
      /* sendText delivers via Twilio when configured, otherwise logs the outbound message to the
         WhatsApp log with an honest status — either way it returns that status string */
      const status = await w.sendText(waTo, text);
      return { status: typeof status === "string" ? status : "queued", recipient: waTo };
    });
  } else if (channel === "sms") {
    await push("sms", async () => { const n = notify(); const r = n?.sendSMS ? await n.sendSMS(u.phone, text) : null; return { status: r?.status || "queued (no SMS provider configured)", recipient: u.phone }; });
  } else if (channel === "email") {
    await push("email", async () => { const e = email(); if (e?.sendEmail && emailType) { const r = await e.sendEmail(emailType, { ...emailData, to: u.email }); return { status: r?.status || "logged", recipient: u.email }; } return { status: "logged (no SMTP configured)", recipient: u.email }; });
  } else {
    await push("push", async () => { const n = notify(); const r = n?.sendPush ? await n.sendPush(null, "Xperion Airways", text) : null; return { status: r?.status || "queued (no push token)", recipient: "app" }; });
  }
  for (const r of results) record(uid, pnr, event, r.channel, r.recipient, r.status, text);
  return results;
}

/* called by the Offer agent for every passenger it contacts; no-op for synthetic passengers */
function onOffer({ offId, pax, pnr, pred, fi, ordered, framing, incentive, channel, text }) {
  if (!pax?.app_uid) return null;
  const uid = pax.app_uid;
  const options = ordered.map((id) => optionView(G.getNode(id)));
  const prob = Math.round((pred.probability ?? pred.p ?? 0) * 100);
  const holdUntil = options.map((o) => G.getNode(o.id)?.expiry).filter(Boolean).sort()[0] || null;
  const first = (pax.name || "").split(" ")[0];
  const reply = `${first}, a heads-up before anything goes wrong: a tornado watch near ${city(fi.dest)} overlaps the arrival of your flight ${fi.flight_no} on ${fi.date}. I put the disruption risk at ${prob}%. I've already held seats and prepared ${options.length} option${options.length === 1 ? "" : "s"} for you — nothing is charged and your original booking stays as it is until you choose. One tap and I handle the rest.` + (incentive ? ` This includes a goodwill credit of ${incentive.currency} ${incentive.amount}.` : "");
  const card = {
    type: "disruption", offerId: offId, pnr: pnr.record_locator, flight: fi.flight_no, date: fi.date,
    origin: fi.origin, dest: fi.dest, destCity: city(fi.dest), probability: prob, state: pred.state,
    reasons: reasonsOf(pred), options, incentive, framing, channel, holdUntil, sentAt: clock.nowIso(),
  };
  inbox(uid, "disruption_offer", reply, card);
  G.setProps(offId, { app_uid: uid, app_delivery: "pending" });
  deliver({
    uid, pnr: pnr.record_locator, channel, text: `${text}\n\n` + options.map((o, i) => `${i + 1}. ${o.label}`).join("\n") + "\n\nReply with a number to accept, or open Xperion AI in the app.",
    event: "disruption_offer", emailType: "weather_alert", emailData: { fi, card },
  }).then((results) => {
    G.setProps(offId, { app_delivery: results.map((r) => `${r.channel}: ${r.status}`).join(" · ") });
    O.audit({ actor: "bridge", action: "DELIVER_OFFER", predictionId: pred.id, rationale: `app customer ${uid} · ${results.map((r) => `${r.channel} ${r.status}`).join(", ")} · mirrored to assistant inbox` });
  }).catch(() => {});
  return card;
}

/* ─────────────────────────── 3 · accept → real booking ─────────────────────────── */
function onAccepted({ offerId, off, pax, pnr, opt, refs }) {
  if (!pax?.app_uid) return null;
  const uid = pax.app_uid;
  const b = db.prepare("SELECT * FROM bookings WHERE pnr=? AND user_id=?").get(pnr.record_locator, uid);
  if (!b) return null;
  const meta = parse(b.meta_json, {}) || {};
  const view = optionView(opt);
  const comps = opt.components || [];
  const recovery = { type: opt.type, label: view.label, detail: view.detail, refs, accepted_at: clock.nowIso(), offerId, components: comps, items: [] };
  let flightNo = b.flight_no, status = "rebooked";
  if (opt.type === "REROUTE") {
    const legs = comps.filter((c) => c.flight).map((c) => { const f = G.nodesByKind("FlightInstance").find((n) => n.flight_no === c.flight) || {}; const [o, d] = (c.route || "").split("-"); return { flight_no: c.flight, origin: o, dest: d, dep: hhmm(f.sched_dep), arr: f.sched_arr ? hhmm(f.sched_arr) : "", date: (f.sched_dep || "").slice(0, 10) }; });
    for (const l of legs) { const f = G.nodesByKind("FlightInstance").find((n) => n.flight_no === l.flight_no); if (f) ensureFlightRow({ ...f, date: l.date, aircraft_type: "A321neo" }); }
    recovery.legs = legs; recovery.items = ["Seats held and confirmed", "Ticket reissued", "Same cabin, no charge"];
    if (legs[0]) { flightNo = legs[0].flight_no; Object.assign(meta, { origin: legs[0].origin, dest: legs[legs.length - 1].dest, dep: legs[0].dep, arr: legs[legs.length - 1].arr, duration: "", via: legs.slice(1).map((l) => l.origin).join(", ") }); }
  } else if (opt.type === "DIVERT_PLUS_GROUND") {
    const hotel = comps.find((c) => c.hotel); const taxi = comps.find((c) => c.taxi); const xfer = comps.find((c) => c.transfer);
    recovery.items = [`Hotel voucher: ${G.getNode(hotel?.hotel)?.name || "Orlando airport hotel"} · 1 night`, `Taxi from Orlando airport (ref ${refs?.taxi || "confirmed"})`, `${xfer?.when === "morning" ? "Morning" : "Next"} transfer Orlando → Miami`, "Ticket reissued, no charge"];
    Object.assign(meta, { dest: "MCO", arr: meta.arr, diverted_from: "MIA" });
    try { db.prepare("UPDATE flights SET dest='MCO', status='diverted' WHERE flight_no=? AND flight_date=?").run(b.flight_no, b.flight_date); } catch {}
  } else if (opt.type === "REFUND") {
    status = "refund_pending"; recovery.items = ["Seat held", "Full refund packaged for controller approval (Tier 2)"];
  }
  meta.recovery = recovery;
  db.prepare("UPDATE bookings SET flight_no=?, status=?, meta_json=? WHERE id=?").run(flightNo, status, j(meta), b.id);
  const first = (pax.name || "").split(" ")[0];
  const reply = opt.type === "REFUND"
    ? `Done, ${first}. Your seat is held and a full refund is packaged for a controller to approve — you'll get a confirmation the moment it clears.`
    : `Done, ${first}. ${view.label}. ${recovery.items.join(" · ")}. Your booking ${pnr.record_locator} is updated in My Trips and nothing was charged.`;
  const card = { type: "disruption_confirmed", offerId, pnr: pnr.record_locator, option: view, items: recovery.items, legs: recovery.legs || null, refs, status, flight: flightNo, ms: null };
  inbox(uid, "disruption_confirmed", reply, card);
  deliver({ uid, pnr: pnr.record_locator, channel: off.channel || "push", text: reply, event: "disruption_confirmed", emailType: "recovery_confirmed", emailData: { pnr: pnr.record_locator, option: view, items: recovery.items } }).catch(() => {});
  O.audit({ actor: "bridge", action: "APPLY_TO_BOOKING", predictionId: off.prediction, rationale: `booking ${pnr.record_locator} (app customer ${uid}) → ${status} · ${view.label}` });
  return card;
}
function onDeclined({ off, pax }) {
  if (!pax?.app_uid) return;
  inbox(pax.app_uid, "disruption_declined", "Understood — I'll leave your booking exactly as it is and won't message you again about this. If the weather changes I'll still keep options ready in My Trips.", { type: "disruption_declined", offerId: off.id, pnr: G.getNode(off.pnr)?.record_locator });
}
function onAllClear({ pax, fi }) {
  if (!pax?.app_uid) return;
  inbox(pax.app_uid, "disruption_allclear", `Good news: the weather risk for ${fi.flight_no} on ${fi.date} has cleared. Any held seats were released and your original booking stands.`, { type: "disruption_allclear", flight: fi.flight_no, date: fi.date });
}

/* ─────────────────────────── 4 · customer-side API ─────────────────────────── */
function offerFor(uid) {
  return G.nodesByKind("Offer").filter((o) => o.passenger_ref === PAX(uid)).sort((a, b) => String(b.sent_at || "").localeCompare(String(a.sent_at || "")))[0] || null;
}
function pending(uid) {
  const off = offerFor(uid);
  if (!off || off.executed || off.state === "DECLINED") return null;
  return { offerId: off.id, options: (off.options || []).map((id) => optionView(G.getNode(id))), channel: off.channel };
}
function inboxList(uid, sinceId = 0) {
  return db.prepare("SELECT * FROM ai_inbox WHERE user_id=? AND id>? ORDER BY id").all(uid, sinceId).map((r) => ({ id: r.id, kind: r.kind, text: r.text, card: parse(r.card_json), seen: !!r.seen, at: r.created_at }));
}
function markSeen(uid, ids) {
  if (!ids?.length) { db.prepare("UPDATE ai_inbox SET seen=1 WHERE user_id=?").run(uid); return; }
  const st = db.prepare("UPDATE ai_inbox SET seen=1 WHERE user_id=? AND id=?");
  for (const id of ids) st.run(uid, id);
}
function status(uid) {
  const pend = pending(uid);
  const unseen = db.prepare("SELECT COUNT(*) AS n FROM ai_inbox WHERE user_id=? AND seen=0 AND kind LIKE 'disruption%'").get(uid)?.n || 0;
  const pred = activePrediction();
  const b = db.prepare("SELECT pnr, flight_no, flight_date, status, meta_json FROM bookings WHERE user_id=? AND pnr=? ORDER BY id DESC").get(uid, LOC(uid)) || null;
  return { linked: !!G.getNode(PNR(uid)), pending: pend, unseen, prediction: pred ? { id: pred.id, state: pred.state, probability: pred.probability ?? pred.p ?? null } : null, booking: b ? { ...b, recovery: parse(b.meta_json, {})?.recovery || null, meta_json: undefined } : null };
}
function acceptForUser(uid, optionId, offerId) {
  const A = require("./agents");
  const pend = pending(uid);
  if (!pend) return { ok: false, error: "no_pending_offer" };
  const opt = pend.options.find((o) => o.id === optionId) || pend.options[Number(optionId) - 1] || pend.options.find((o) => o.type === String(optionId).toUpperCase());
  if (!opt) return { ok: false, error: "unknown_option", options: pend.options };
  const r = A.accept(offerId || pend.offerId, opt.id);
  const last = inboxList(uid).filter((m) => m.kind === "disruption_confirmed").pop();
  if (last) markSeen(uid, [last.id]);
  return { ...r, option: opt, card: last?.card || null, reply: last?.text || null, inboxId: last?.id || null };
}
function declineForUser(uid) {
  const A = require("./agents");
  const pend = pending(uid);
  if (!pend) return { ok: false, error: "no_pending_offer" };
  const r = A.decline(pend.offerId);
  const last = inboxList(uid).filter((m) => m.kind === "disruption_declined").pop();
  if (last) markSeen(uid, [last.id]);
  return { ...r, reply: last?.text || null, inboxId: last?.id || null };
}

/* plain-language intent from the assistant or WhatsApp → same saga as a button press */
function intercept(uid, text) {
  const pend = pending(uid);
  if (!pend) return null;
  const t = String(text || "").trim().toLowerCase();
  if (!t) return null;
  const pick = (o) => acceptForUser(uid, o.id, pend.offerId);
  const num = t.match(/^\s*(?:option\s*)?([1-3])\b/) || t.match(/\b(?:option|number|choice)\s*([1-3])\b/);
  if (num && pend.options[Number(num[1]) - 1]) return pick(pend.options[Number(num[1]) - 1]);
  const byType = (re, type) => re.test(t) && pend.options.find((o) => o.type === type);
  const chosen = byType(/orlando|mco|hotel|taxi|divert|tonight/, "DIVERT_PLUS_GROUND") || byType(/new york|jfk|reroute|re-route|next morning|fastest/, "REROUTE") || byType(/refund|not travel|cancel my trip|money back/, "REFUND");
  if (chosen && /accept|take|go with|book|yes|ok|choose|pick|do it|please|prefer|want|option|reroute|refund|orlando|new york|hotel/.test(t)) return pick(chosen);
  if (/\b(no thanks|decline|leave it|keep my booking|don't change|do nothing|not now)\b/.test(t)) return declineForUser(uid);
  if (/\b(accept|yes|ok|go ahead|do it|take it)\b/.test(t) && pend.options.length === 1) return pick(pend.options[0]);
  return null;
}
function contextLine(uid) {
  const s = status(uid);
  if (!s.linked) return "";
  if (s.pending) return ` ACTIVE DISRUPTION for this customer: booking ${LOC(uid)} XP201 Delhi→Miami is under a tornado watch at Miami; the autonomy layer has already sent them these options (they can accept by saying the option name or number, and you must not invent other options): ${s.pending.options.map((o, i) => `${i + 1}) ${o.label}`).join("; ")}.`;
  if (s.booking?.recovery) return ` The customer's booking ${LOC(uid)} was already recovered by the autonomy layer: ${s.booking.recovery.label} (${s.booking.status}).`;
  if (s.prediction) return ` Weather is being monitored for their booking ${LOC(uid)} XP201 Delhi→Miami (state ${s.prediction.state}); no action needed from them yet.`;
  return ` The customer holds booking ${LOC(uid)} on XP201 Delhi→Miami; the autonomy layer is monitoring it.`;
}

module.exports = { link, linked, isLinked, onOffer, onAccepted, onDeclined, onAllClear, pending, inboxList, markSeen, status, acceptForUser, declineForUser, intercept, contextLine, LOC, PAX, PNR };
