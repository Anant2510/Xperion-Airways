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
const city = (c) => { if (!c) return ""; if (CITY[c]) return CITY[c]; let n = null; try { n = G.getNode(`ap:${c}`)?.city; } catch {} if (!n || n === c) { try { n = require("../routes-data").AIRPORTS[c]?.city || require("./geo").NAMES[c] || c; } catch { n = c; } } return String(n).split(",")[0].trim(); };
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
  return G.nodesByKind("FlightInstance").find((n) => n.flight_no === "XP201" && n.origin === "DEL" && n.dest === "MIA" && !n.recovery) || null;
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
/* Who gets a seat on the disrupted flight: the seeded demo personas. Accounts created at runtime
   (a signup on the shared VM, a WhatsApp guest, a tester's own registration) are left out unless
   AUTONOMY_LINK_ALL=1, because a stray account with the presenter's phone number would receive a
   second copy of every brief and offer under its own name. */
function linkableUsers() {
  const all = users();
  if (/^(1|true|yes)$/i.test(String(process.env.AUTONOMY_LINK_ALL || ""))) return all;
  let known = null;
  try { known = new Set((require("../db").KNOWN_USERS || []).map(([id]) => Number(id))); } catch {}
  return known && known.size ? all.filter((u) => known.has(Number(u.id))) : all;
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
  for (const u of linkableUsers()) {
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
/* Every upcoming real booking becomes a FlightInstance + PNR in the graph, so the live weather
   feeds can score it and the disruption agents can act on it exactly as they do for the demo
   flight. Runs after each world reset and before each feed poll (AUTONOMY_LIVE_TRIPS=1). */
async function syncTrips({ horizonDays = Number(process.env.AUTONOMY_TRIP_HORIZON_DAYS) || 10 } = {}) {
  const geo = require("./geo");
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare("SELECT * FROM bookings WHERE status IN ('confirmed','rebooked') AND flight_date >= ? AND flight_date <= date(?, '+' || ? || ' days')").all(today, today, horizonDays);
  let synced = 0; const flights = [];
  for (const b of rows) {
    if (/^XPW/.test(b.pnr || "")) continue;                       // the linked demo trip already lives in the graph
    let meta = {}; try { meta = JSON.parse(b.meta_json || "{}"); } catch {}
    const f = db.prepare("SELECT origin, dest, dep, arr FROM flights WHERE flight_no=? AND flight_date=?").get(b.flight_no, b.flight_date) || db.prepare("SELECT origin, dest, dep, arr FROM flights WHERE flight_no=?").get(b.flight_no) || {};
    const origin = meta.origin || f.origin, dest = meta.dest || f.dest, dep = meta.dep || f.dep || "12:00", arr = meta.arr || f.arr || null;
    if (!origin || !dest || origin === dest) continue;
    for (const code of [origin, dest]) {
      const id = `ap:${code}`; const ex = G.getNode(id);
      if (!ex || !ex.geo) { const g = (await geo.geocode(code).catch(() => null)) || (geo.SEED[code] ? { lat: geo.SEED[code][0], lon: geo.SEED[code][1] } : null); G.upsertNode(id, "Airport", { iata: code, code, city: city(code), ...(g ? { geo: { lat: g.lat, lon: g.lon } } : {}) }); }
    }
    const depIso = `${b.flight_date}T${/^\d{2}:\d{2}$/.test(dep) ? dep : "12:00"}:00Z`;
    let arrIso; if (arr && /^\d{2}:\d{2}$/.test(arr)) { const a = new Date(`${b.flight_date}T${arr}:00Z`); if (a < new Date(depIso)) a.setUTCDate(a.getUTCDate() + 1); arrIso = a.toISOString(); } else arrIso = new Date(Date.parse(depIso) + 3 * 3600000).toISOString();
    const fiId = `fi:${b.flight_no}:${b.flight_date}`;
    G.upsertNode(fiId, "FlightInstance", { flight_no: b.flight_no, date: b.flight_date, sched_dep: depIso, sched_arr: arrIso, origin, dest, aircraft_type: "A321", status: "scheduled", app_trip: true });
    G.upsertEdge(fiId, "DEPARTS_FROM", `ap:${origin}`); G.upsertEdge(fiId, "ARRIVES_AT", `ap:${dest}`);
    if (!G.getNode(PAX(b.user_id))) link();
    const pnrId = `pnr:trip:${b.pnr}`;
    G.upsertNode(pnrId, "PNR", { record_locator: b.pnr, party_size: 1, fare_class: "Y", segments: [{ f: b.flight_no }], app_uid: b.user_id, app_booking_id: b.id, source: "app-booking" });
    G.upsertEdge(fiId, "CARRIES", pnrId); G.upsertEdge(pnrId, "BELONGS_TO", PAX(b.user_id));
    synced++; flights.push(`${b.flight_no} ${origin}→${dest} ${b.flight_date}`);
  }
  if (synced) O.audit({ actor: "bridge", action: "SYNC_APP_TRIPS", rationale: `${synced} upcoming real trip(s) in the graph for live sensing: ${flights.slice(0, 6).join(", ")}${flights.length > 6 ? "…" : ""}` });
  return { synced, flights };
}
const liveTrips = () => process.env.AUTONOMY_LIVE_TRIPS !== "0";   // on unless switched off: every upcoming real trip is in the graph and scored

/* the golden-trip customers only (pnr:app:<uid>); the pnr:trip:* nodes that syncTrips mirrors for
   every real booking also carry app_uid, and must not make the world look linked when it is not */
const GOLDEN_PNR = /^pnr:app:/;
function linked() {
  return G.nodesByKind("PNR").filter((p) => p.app_uid && GOLDEN_PNR.test(p.id)).map((p) => {
    const pax = G.getNode(PAX(p.app_uid)) || {};
    const off = offerFor(p.app_uid);
    return { uid: p.app_uid, name: pax.name, tier: pax.loyalty_tier, pnr: p.record_locator, channel: off?.channel || null, state: off ? (off.executed ? "EXECUTED" : off.state) : "NO_OFFER", delivery: off?.app_delivery || "" };
  });
}
function isLinked() { return G.nodesByKind("PNR").some((p) => p.app_uid && GOLDEN_PNR.test(p.id)); }

/* ─────────────────────────── 2 · offers → real channels ─────────────────────────── */
function optionView(o) {
  const c = o.components || [];
  if (o.type === "REROUTE") {
    const legs = c.filter((x) => x.flight);
    const via = o.via || (legs.length >= 2 ? String(legs[0].route || "").split("-")[1] : null);
    const dest = legs.length ? String(legs[legs.length - 1].route || "").split("-")[1] : null;
    const label = via ? `Reroute via ${city(via)}, arrive next morning` : "Next morning's direct flight, same cabin";
    return { id: o.id, type: o.type, label, detail: `${legs.map((x) => `${x.flight} ${x.route}`).join(" + ")} · seats held ${o.seat_hold_ref ? "for you" : ""}`.trim(), cost: "no charge", tag: dest ? `Fastest to ${city(dest)}` : "Fastest" };
  }
  if (o.type === "DIVERT_PLUS_GROUND") {
    const dv = c.find((x) => x.divert_to)?.divert_to; const xfer = c.find((x) => x.transfer); const dest = String(xfer?.transfer || "").split("-")[1];
    const mins = xfer?.minutes; const road = mins ? (mins >= 90 ? `${Math.round(mins / 30) / 2} h` : `${mins} min`) : null;
    return { id: o.id, type: o.type, label: `Land in ${city(dv)} tonight, hotel + taxi + morning transfer to ${city(dest)}`, detail: `Hotel voucher, taxi from ${dv} and a morning transfer${road ? ` (${road} by road)` : ""}, all arranged and prepaid`, cost: "no charge", tag: "Rest tonight" };
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
/* deliver() sends `text` on `channel` (the customer's preferred or accepting channel) plus every
   channel in `also`, minus `skip`. Confirmations of something the customer just did always add
   email, so the new itinerary exists somewhere they can keep; `skip` drops the channel that will
   carry the same words as the reply itself (a WhatsApp reply to a WhatsApp acceptance). */
async function deliver({ uid, pnr, channel, text, event, emailType, emailData, also = [], skip = [] }) {
  const u = db.prepare("SELECT email, phone, wa_id FROM users WHERE id=?").get(uid) || {};
  /* WhatsApp recipient, same precedence as the app's existing proactive push: the demo's
     configured number, then the real WhatsApp number that last spoke as this persona, then
     the profile phone. */
  let pinned = null, S = null; try { S = require("../session"); pinned = S.pinnedPhoneFor(uid); } catch {}
  const waTo = pinned || process.env.WHATSAPP_DEFAULT_TO || u.wa_id || u.phone || null;
  /* WA_PHONE_MAP pins a real phone to one persona. If this customer's number is that phone but the
     persona is someone else (a second account with the presenter's number), the message stays
     with the pinned persona and this one is skipped, so the phone never gets two copies. */
  let pinnedElsewhere = null;
  try { const owner = waTo && S?.pinnedUser ? S.pinnedUser(String(waTo).replace(/[^0-9]/g, "")) : null; if (owner && Number(owner.id) !== Number(uid)) pinnedElsewhere = owner.first_name || String(owner.id); } catch {}
  const results = [];
  const push = async (ch, fn) => { try { results.push({ channel: ch, ...(await fn()) }); } catch (e) { results.push({ channel: ch, status: "send failed: " + e.message.slice(0, 60) }); } };
  const wanted = [...new Set([channel, ...also].filter(Boolean))].filter((c) => !skip.includes(c));
  for (const ch of skip.filter((c) => c === channel || also.includes(c))) results.push({ channel: ch, status: "carried by the reply on the accepting channel", recipient: ch === "whatsapp" ? waTo : ch === "email" ? u.email : null });
  for (const channel of wanted) {
  if (channel === "whatsapp") {
    await push("whatsapp", async () => {
      const w = wa();
      if (!waTo) return { status: "skipped (no WhatsApp number known)", recipient: null };
      if (pinnedElsewhere) return { status: `skipped (number is pinned to ${pinnedElsewhere} by WA_PHONE_MAP)`, recipient: waTo };
      if (!w?.sendText) return { status: "queued (WhatsApp module unavailable)", recipient: waTo };
      /* sendText delivers via Twilio when configured, otherwise logs the outbound message to the
         WhatsApp log with an honest status — either way it returns that status string */
      const status = await w.sendText(waTo, text);
      return { status: typeof status === "string" ? status : "queued", recipient: waTo };
    });
  } else if (channel === "sms") {
    await push("sms", async () => { const n = notify(); const r = n?.sendSMS ? await n.sendSMS(u.phone, text) : null; return { status: r?.status || "queued (no SMS provider configured)", recipient: u.phone }; });
  } else if (channel === "email") {
    await push("email", async () => { const e = email(); if (e?.sendEmail && emailType) { let ctx = null; try { ctx = require("../appctx").appCtx; } catch {} const send = () => e.sendEmail(emailType, { ...emailData, to: u.email }); const r = await (ctx && !ctx.getStore() ? ctx.run({ app: "v2" }, send) : send()); return { status: r?.status || "logged", recipient: u.email }; } return { status: "logged (no SMTP configured)", recipient: u.email }; });
  } else {
    await push("push", async () => { const n = notify(); const r = n?.sendPush ? await n.sendPush(null, "Xperion Airways", text) : null; return { status: r?.status || "queued (no push token)", recipient: "app" }; });
  }
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
  const weNode = G.getNode(`we:${String(pred.id || "").split(":")[1] || ""}`);
  const hazard = weNode?.type ? String(weNode.type).replace(/_/g, " ").replace(/^convective outlook$/, "severe weather outlook") : "severe weather";
  const article = /^[aeiou]/i.test(hazard) ? "an" : "a";
  const near = G.edges({ src: weNode?.id || "", rel: "IMPACTS", dst: `ap:${fi.dest}` }).length ? fi.dest : fi.origin;
  const reply = `${first}, a heads-up before anything goes wrong: ${article} ${hazard} near ${city(near)} overlaps ${near === fi.dest ? "the arrival" : "the departure"} of your flight ${fi.flight_no} on ${fi.date}. I put the disruption risk at ${prob}%. I've already held seats and prepared ${options.length} option${options.length === 1 ? "" : "s"} for you — nothing is charged and your original booking stays as it is until you choose. One tap and I handle the rest.` + (incentive ? ` This includes a goodwill credit of ${incentive.currency} ${incentive.amount}.` : "");
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
    const legs = comps.filter((c) => c.flight).map((c) => { const f = G.nodesByKind("FlightInstance").find((n) => n.flight_no === c.flight) || {}; const [o, d] = (c.route || "").split("-"); return { flight_no: c.flight, origin: o, dest: d, dep: c.dep || hhmm(f.sched_dep), arr: c.arr || (f.sched_arr ? hhmm(f.sched_arr) : ""), date: c.date || (f.sched_dep || "").slice(0, 10) }; });
    for (const l of legs) { const f = G.nodesByKind("FlightInstance").find((n) => n.flight_no === l.flight_no); if (f) ensureFlightRow({ ...f, date: l.date, aircraft_type: "A321neo" }); }
    recovery.legs = legs; recovery.items = ["Seats held and confirmed", "Ticket reissued", "Same cabin, no charge"];
    if (legs[0]) { flightNo = legs[0].flight_no; Object.assign(meta, { origin: legs[0].origin, dest: legs[legs.length - 1].dest, dep: legs[0].dep, arr: legs[legs.length - 1].arr, duration: "", via: legs.slice(1).map((l) => l.origin).join(", ") }); }
  } else if (opt.type === "DIVERT_PLUS_GROUND") {
    const hotel = comps.find((c) => c.hotel); const taxi = comps.find((c) => c.taxi); const xfer = comps.find((c) => c.transfer);
    const dv = comps.find((c) => c.divert_to)?.divert_to || (xfer?.transfer || "").split("-")[0]; const finalDest = (xfer?.transfer || "").split("-")[1] || meta.dest;
    recovery.items = [`Hotel voucher: ${G.getNode(hotel?.hotel)?.name || `${city(dv)} airport hotel`} · 1 night`, `Taxi from ${city(dv)} airport (ref ${refs?.taxi || "confirmed"})`, `${xfer?.when === "morning" ? "Morning" : "Next"} transfer ${city(dv)} → ${city(finalDest)}`, "Ticket reissued, no charge"];
    Object.assign(meta, { dest: dv, arr: meta.arr, diverted_from: finalDest });
    try { db.prepare("UPDATE flights SET dest=?, status='diverted' WHERE flight_no=? AND flight_date=?").run(dv, b.flight_no, b.flight_date); } catch {}
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
  const via = acceptVia.get(offerId) || null; acceptVia.delete(offerId);
  const legsText = (recovery.legs || []).map((l) => `${l.flight_no} ${l.origin}→${l.dest}${l.dep ? ` ${l.dep}` : ""}${l.arr ? `–${l.arr}` : ""}${l.date ? ` (${l.date})` : ""}`);
  deliver({ uid, pnr: pnr.record_locator, channel: off.channel || "push", also: ["email"], skip: via === "whatsapp" ? ["whatsapp"] : [], text: reply, event: "disruption_confirmed",
    emailType: "recovery_confirmed", emailData: { pnr: pnr.record_locator, option: view, items: recovery.items, legs: legsText, status, flight: flightNo, date: b.flight_date, dest: meta.dest || null } }).catch(() => {});
  O.audit({ actor: "bridge", action: "APPLY_TO_BOOKING", predictionId: off.prediction, rationale: `booking ${pnr.record_locator} (app customer ${uid}) → ${status} · ${view.label}` });
  return card;
}
/* Tier-0 destination brief: information with the decision left to the customer */
function onBrief({ uid, booking, brief, channel, assessment = null }) {
  const research = require("./research");
  const first = (db.prepare("SELECT first_name FROM users WHERE id=?").get(uid) || {}).first_name || "there";
  const impact = brief.travel_impact || "none";
  const alts = (assessment?.alternatives || []);
  const altOptions = alts.map((a) => ({ id: a.id, label: a.label, detail: a.detail, why: a.why, risk: a.risk, risk_label: a.risk_label, type: a.type, date: a.date, price: a.price, price_delta: a.price_delta ?? null }));
  const altText = alts.length ? `\n\nTo lower the chance of getting stuck (your day looks ${assessment.trip_risk_label}):\n` + alts.map((a, i) => `${i + 1}. ${a.label} — ${a.detail} · risk ${a.risk_label}`).join("\n") : "";
  const lead = impact === "none"
    ? `${first}, a quick look ahead at ${brief.city} for your trip on ${booking.flight_date}: nothing that should get in your way. Here's what I found.`
    : `${first}, a heads-up before your trip to ${brief.city} on ${booking.flight_date}: there are things happening there worth knowing about (${impact} impact). Nothing has changed on your booking; you decide.`;
  const text = `${lead}\n\n${research.briefText(brief)}${altText}\n\nYour call: keep the trip as it is${alts.length ? ", take one of the options above" : ", look at alternative dates"}, or talk to a person.`;
  const card = { type: "destination_brief", pnr: booking.pnr, flight: booking.flight_no, date: booking.flight_date, code: brief.code, city: brief.city, window: brief.window,
    summary: brief.summary, impact, weather: { outlook: brief.weather.outlook, alerts: brief.weather.alerts.slice(0, 3), risk: brief.weather.risk, days: (brief.weather.days || []).slice(0, 5).map((d) => ({ date: d.date, label: d.label, tmax: d.tmax, tmin: d.tmin })) },
    events: (brief.events || []).slice(0, 6).map(research.customerSafe), advisories: (brief.advisories || []).slice(0, 3), news: (brief.news || []).slice(0, 3), holidays: brief.holidays || [],
    sources: (brief.sources || []).slice(0, 8), mode: brief.mode, confidence: brief.confidence, generated_at: brief.generated_at,
    risk: assessment ? { trip: assessment.trip_risk, label: assessment.trip_risk_label, reasons: assessment.trip_reasons, window: assessment.window } : null,
    options: [{ id: "keep", label: "Keep my trip as it is" }, ...altOptions, ...(alts.length ? [] : [{ id: "alternatives", label: `See other dates to ${brief.city}` }]), { id: "talk", label: "Talk to a person" }] };
  inbox(uid, "destination_brief", text, card);
  deliver({ uid, pnr: booking.pnr, channel, text: `${lead}\n\n${research.briefText(brief)}${altText}\n\nReply KEEP to keep the trip${alts.length ? ", a number to take an option" : ", DATES to see other dates"}, or TALK for a person.`, event: "destination_brief", emailType: "destination_brief", emailData: { brief, booking, first } })
    .then((results) => O.audit({ actor: "bridge", action: "DELIVER_BRIEF", rationale: `customer ${uid} · ${results.map((r) => `${r.channel} ${r.status}`).join(", ")} · mirrored to assistant inbox` })).catch(() => {});
  return card;
}
function briefResponse(uid, choice, via = null) {
  const last = inboxList(uid).filter((m) => m.kind === "destination_brief").pop();
  if (!last) return { ok: false, error: "no_brief" };
  const c = last.card || {};
  if (choice === "keep") { const t = `Noted — your trip to ${c.city} stays exactly as it is. I'll keep watching the weather and the news there and tell you if anything changes.`; inbox(uid, "brief_ack", t, { type: "brief_ack", pnr: c.pnr }); return { ok: true, reply: t }; }
  if (choice === "talk") {
    const qid = `tier2:CUSTOMER_CALLBACK:${G.hash({ uid, pnr: c.pnr, t: clock.nowIso() })}`;
    G.upsertNode(qid, "Tier2Item", { action: "CUSTOMER_CALLBACK", payload: { uid, pnr: c.pnr, city: c.city, reason: "destination brief" }, status: "PENDING", prepared_at: clock.nowIso(), rationale: `Customer asked to talk about ${c.city} after a destination brief` });
    O.audit({ actor: "bridge", action: "CUSTOMER_CALLBACK", rationale: `customer ${uid} asked for a person about ${c.city}; queued for a controller` });
    const t = `Of course. I've asked a travel specialist to call you about ${c.city}; you'll hear from them shortly, and your booking ${c.pnr} is untouched meanwhile.`;
    inbox(uid, "brief_ack", t, { type: "brief_ack", pnr: c.pnr, callback: qid }); return { ok: true, reply: t, queued: qid };
  }
  if (choice === "alternatives") return { ok: true, reply: `Let me look at other days to ${c.city} around ${c.date}.`, search: { dest: c.code, date: c.date, flexible: true } };
  if (/^alt:/.test(choice)) {
    const r = require("./alternatives").take(uid, choice, { via });
    if (r.ok) { inbox(uid, "brief_ack", r.reply, { type: "alternative_taken", pnr: c.pnr, booking: r.booking }); const last = inboxList(uid).pop(); return { ...r, inboxId: last?.id || null }; }
    return { ok: false, error: r.error, reply: `I couldn't make that change: ${r.error}.` };
  }
  return { ok: false, error: "unknown_choice" };
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
/* The inbox is the airline's record of what it told the customer; the assistant thread is one view
   of it. "Clear chat" dismisses rows from the view only: pending offers, briefs and every internal
   lookup still see them, so a WhatsApp "1" keeps working after the app chat was cleared. */
try { db.exec("ALTER TABLE ai_inbox ADD COLUMN dismissed INTEGER DEFAULT 0"); } catch {}
function inboxList(uid, sinceId = 0, { includeDismissed = true } = {}) {
  return db.prepare(`SELECT * FROM ai_inbox WHERE user_id=? AND id>? ${includeDismissed ? "" : "AND COALESCE(dismissed,0)=0"} ORDER BY id`).all(uid, sinceId).map((r) => ({ id: r.id, kind: r.kind, text: r.text, card: parse(r.card_json), seen: !!r.seen, at: r.created_at }));
}
function dismissInbox(uid) {
  const r = db.prepare("UPDATE ai_inbox SET seen=1, dismissed=1 WHERE user_id=? AND COALESCE(dismissed,0)=0").run(uid);
  return { dismissed: r.changes };
}
function markSeen(uid, ids) {
  if (!ids?.length) { db.prepare("UPDATE ai_inbox SET seen=1 WHERE user_id=?").run(uid); return; }
  const st = db.prepare("UPDATE ai_inbox SET seen=1 WHERE user_id=? AND id=?");
  for (const id of ids) st.run(uid, id);
}
function status(uid) {
  const pend = pending(uid);
  const unseen = db.prepare("SELECT COUNT(*) AS n FROM ai_inbox WHERE user_id=? AND seen=0 AND (kind LIKE 'disruption%' OR kind='destination_brief')").get(uid)?.n || 0;
  const latest = db.prepare("SELECT kind, card_json FROM ai_inbox WHERE user_id=? AND seen=0 ORDER BY id DESC LIMIT 1").get(uid);
  const latestCard = latest ? parse(latest.card_json) : null;
  const pred = activePrediction();
  const b = db.prepare("SELECT pnr, flight_no, flight_date, status, meta_json FROM bookings WHERE user_id=? AND pnr=? ORDER BY id DESC").get(uid, LOC(uid)) || null;
  return { linked: !!G.getNode(PNR(uid)), pending: pend, unseen, latest: latest ? { kind: latest.kind, city: latestCard?.city || null, impact: latestCard?.impact || null } : null, prediction: pred ? { id: pred.id, state: pred.state, probability: pred.probability ?? pred.p ?? null } : null, booking: b ? { ...b, recovery: parse(b.meta_json, {})?.recovery || null, meta_json: undefined } : null };
}
/* which channel an acceptance arrived on, per offer: onAccepted reads it once so the confirmation
   is not sent twice to the channel that also carries the reply */
const acceptVia = new Map();
function acceptForUser(uid, optionId, offerId, { via = null } = {}) {
  const A = require("./agents");
  const pend = pending(uid);
  if (!pend) return { ok: false, error: "no_pending_offer" };
  if (via) acceptVia.set(offerId || pend.offerId, via);
  const opt = pend.options.find((o) => o.id === optionId) || pend.options[Number(optionId) - 1] || pend.options.find((o) => o.type === String(optionId).toUpperCase());
  if (!opt) return { ok: false, error: "unknown_option", options: pend.options };
  const r = A.accept(offerId || pend.offerId, opt.id);
  if (!r.ok) return { ...r, option: opt, card: null, ...onFailed(uid, pend, opt, r) };
  const last = inboxList(uid).filter((m) => m.kind === "disruption_confirmed").pop();
  if (last) markSeen(uid, [last.id]);
  return { ...r, option: opt, card: last?.card || null, reply: last?.text || null, inboxId: last?.id || null };
}
/* The saga failed and was compensated (or the policy gate refused it): the booking is unchanged,
   a controller already has the full context (ESCALATE_TO_HUMAN), and the offer stays open so the
   customer can take another option. Say exactly that, in the customer's words, on every channel. */
function onFailed(uid, pend, opt, r) {
  const pax = G.getNode(`pax:app:${uid}`);
  const first = (pax?.name || "").split(" ")[0] || "there";
  const others = pend.options.filter((o) => o.id !== opt.id).map((o, i) => `${i + 1}. ${o.label}`).join("  ");
  const why = r.failed === "REBOOK" ? "the seats for that option could not be confirmed" : r.failed === "HOTEL" ? "the hotel could not be booked" : r.failed === "TAXI" ? "the transfer could not be booked" : r.refused === "kill_switch" ? "automatic changes are paused right now" : "that option could not be completed";
  const reply = `Sorry ${first}, ${why}, so nothing on your booking has changed and nothing was charged. A controller has the full picture and will follow up. You can still choose another option: ${others}`;
  const inboxId = inbox(uid, "disruption_failed", reply, { type: "disruption_failed", offerId: pend.offerId, failed: r.failed || r.refused || null, option: opt });
  markSeen(uid, [inboxId]);
  O.audit({ actor: "bridge", action: "OFFER_FAILED_REPLY", predictionId: G.getNode(pend.offerId)?.prediction || null, rationale: `customer ${uid} told option ${opt.type} failed at ${r.failed || r.refused || "unknown"}; offer left open` });
  return { reply, inboxId };
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
function intercept(uid, text, via = null) {
  const pend = pending(uid);
  if (!pend) {
    const t0 = String(text || "").trim().toLowerCase();
    const lastBrief = inboxList(uid).filter((m) => m.kind === "destination_brief").pop();
    const recent = lastBrief && (Date.now() - Date.parse(lastBrief.at || 0)) < 7 * 24 * 3600000;
    if (recent) {
      if (/^(keep|keep (it|my trip)|leave it|no change|i'?ll keep it)\b/.test(t0)) return briefResponse(uid, "keep", via);
      if (/^(talk|call me|speak to (someone|a person|an agent)|talk to (someone|a person|an agent))\b/.test(t0)) return briefResponse(uid, "talk");
      if (/^(dates|other dates|alternatives|see other dates)\b/.test(t0)) return briefResponse(uid, "alternatives");
      const alts = (lastBrief.card?.options || []).filter((o) => /^alt:/.test(o.id));
      const num = t0.match(/^\s*(?:option\s*)?([1-9])\b/);
      if (alts.length && num && alts[Number(num[1]) - 1]) return briefResponse(uid, alts[Number(num[1]) - 1].id, via);
      if (alts.length && /\b(earlier|later|day before|day after)\b/.test(t0)) { const pick = alts.find((o) => (/earlier|before/.test(t0) ? /earlier/.test(o.label) : /later/.test(o.label))); if (pick) return briefResponse(uid, pick.id); }
      if (alts.length && /\b(flex|free changes)\b/.test(t0)) { const pick = alts.find((o) => o.type === "KEEP_WITH_FLEX"); if (pick) return briefResponse(uid, pick.id); }
    }
    return null;
  }
  const t = String(text || "").trim().toLowerCase();
  if (!t) return null;
  const pick = (o) => acceptForUser(uid, o.id, pend.offerId, { via });
  const num = t.match(/^\s*(?:option\s*)?([1-3])\b/) || t.match(/\b(?:option|number|choice)\s*([1-3])\b/);
  if (num && pend.options[Number(num[1]) - 1]) return pick(pend.options[Number(num[1]) - 1]);
  const byType = (re, type) => re.test(t) && pend.options.find((o) => o.type === type);
  const words = (o) => String(o.label || "").toLowerCase().match(/[a-z][a-z' ]{3,}/g) || [];
  const byWords = pend.options.find((o) => ["REROUTE", "DIVERT_PLUS_GROUND"].includes(o.type) && words(o).some((w) => w.length > 4 && !/^(reroute via|arrive next|next morning|tonight|hotel|taxi|morning transfer to|same cabin|direct flight)$/.test(w.trim()) && t.includes(w.trim())));
  const chosen = byWords || byType(/hotel|taxi|divert|tonight|land in/, "DIVERT_PLUS_GROUND") || byType(/reroute|re-route|next morning|fastest|direct/, "REROUTE") || byType(/refund|not travel|cancel my trip|money back/, "REFUND");
  if (chosen && /accept|take|go with|book|yes|ok|choose|pick|do it|please|prefer|want|option|reroute|refund|orlando|new york|hotel/.test(t)) return pick(chosen);
  if (/\b(no thanks|decline|leave it|keep my booking|don't change|do nothing|not now)\b/.test(t)) return declineForUser(uid);
  if (/\b(accept|yes|ok|go ahead|do it|take it)\b/.test(t) && pend.options.length === 1) return pick(pend.options[0]);
  return null;
}
function contextLine(uid) {
  const s = status(uid);
  if (!s.linked) return "";
  const b = db.prepare("SELECT flight_no, flight_date, meta_json FROM bookings WHERE pnr=? AND user_id=?").get(LOC(uid), uid);
  let m = {}; try { m = JSON.parse(b?.meta_json || "{}"); } catch {}
  const trip = `${LOC(uid)} ${b?.flight_no || "XP201"} ${city(m.origin || "DEL")}→${city(m.dest || "MIA")}`;
  if (s.pending) return ` ACTIVE DISRUPTION for this customer: booking ${trip} is under a weather watch at ${city(m.dest || "MIA")}; the autonomy layer has already sent them these options (they can accept by saying the option number or name): ${s.pending.options.map((o, i) => `${i + 1}. ${o.label}`).join("; ")}. If they choose one, call nothing else: the acceptance is handled by the autonomy layer.`;
  if (s.booking?.recovery) return ` The customer's booking ${LOC(uid)} was already recovered by the autonomy layer: ${s.booking.recovery.label} (${s.booking.status}).`;
  if (s.prediction) return ` Weather is being monitored for their booking ${trip} (state ${s.prediction.state}); no action needed from them yet.`;
  return ` The customer holds booking ${trip}; the autonomy layer is monitoring it.`;
}

/* A real booking moved to another flight (alternatives.take): the graph must follow, or the next
   prediction on the old flight still "carries" this customer. Re-points the PNR node at a
   FlightInstance for the new flight and removes the old CARRIES edge. */
function moveTrip(b, { flight_no, date, origin, dest, dep, arr }) {
  const pnrId = /^XPW/.test(b.pnr || "") ? PNR(b.user_id) : `pnr:trip:${b.pnr}`;
  if (!G.getNode(pnrId)) return null;
  for (const e of G.edges({ rel: "CARRIES", dst: pnrId })) G.deleteEdge(e.src, e.rel, e.dst);
  for (const code of [origin, dest]) if (code && !G.getNode(`ap:${code}`)) G.upsertNode(`ap:${code}`, "Airport", { iata: code, code, city: city(code) });
  const depIso = `${date}T${/^\d{2}:\d{2}$/.test(dep || "") ? dep : "12:00"}:00Z`;
  let arrIso = null; if (arr && /^\d{2}:\d{2}$/.test(arr)) { const a = new Date(`${date}T${arr}:00Z`); if (a < new Date(depIso)) a.setUTCDate(a.getUTCDate() + 1); arrIso = a.toISOString(); }
  const fiId = `fi:${flight_no}:${date}`;
  if (!G.getNode(fiId)) G.upsertNode(fiId, "FlightInstance", { flight_no, date, sched_dep: depIso, sched_arr: arrIso, origin, dest, aircraft_type: "A321", status: "scheduled", app_trip: true });
  if (origin) G.upsertEdge(fiId, "DEPARTS_FROM", `ap:${origin}`); if (dest) G.upsertEdge(fiId, "ARRIVES_AT", `ap:${dest}`);
  G.setProps(pnrId, { segments: [{ f: flight_no }], moved_at: clock.nowIso() });
  G.upsertEdge(fiId, "CARRIES", pnrId);
  return fiId;
}

module.exports = { link, linked, isLinked, syncTrips, liveTrips, onOffer, onAccepted, onDeclined, onAllClear, onBrief, briefResponse, deliver, pending, inboxList, markSeen, dismissInbox, status, acceptForUser, declineForUser, intercept, contextLine, moveTrip, LOC, PAX, PNR };
