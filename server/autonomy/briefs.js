"use strict";
/* briefs.js — the proactive side of destination intelligence. For every upcoming real booking,
   72 hours before departure, build the destination brief (research.js) and send it as a Tier-0
   information message: what the weather, events and advisories look like, then three choices
   that leave the decision with the customer — keep the trip, look at alternatives, talk to a
   person. Gated by the same policy engine as every other action (consent, quiet hours, kill
   switch) and audited. Never rebooks anything on its own. */

const { db } = require("../db");
const G = require("./graph");
const O = require("./ontology");
const policy = require("./policy");
const research = require("./research");
const bridge = require("./bridge");
const { AIRPORTS } = require("../routes-data");

const HOURS = 3600000;
const WINDOW = { from: Number(process.env.BRIEF_T_MIN_H) || 60, to: Number(process.env.BRIEF_T_MAX_H) || 84 };   // hours before departure

function destOf(b) {
  let meta = {}; try { meta = JSON.parse(b.meta_json || "{}"); } catch {}
  if (meta.dest) return { code: meta.dest, dep: meta.dep };
  const f = db.prepare("SELECT dest, dep FROM flights WHERE flight_no=? AND flight_date=?").get(b.flight_no, b.flight_date) || db.prepare("SELECT dest, dep FROM flights WHERE flight_no=?").get(b.flight_no);
  return f ? { code: f.dest, dep: f.dep } : null;
}
function departureMs(b, dep) { const t = /^\d{2}:\d{2}$/.test(dep || "") ? dep : "12:00"; return Date.parse(`${b.flight_date}T${t}:00Z`); }

/* bookings inside the T-72 window that have not been briefed */
function due({ now = Date.now(), all = false } = {}) {
  const rows = db.prepare("SELECT * FROM bookings WHERE status IN ('confirmed','rebooked') AND flight_date >= date('now','-1 day')").all();
  const out = [];
  for (const b of rows) {
    let meta = {}; try { meta = JSON.parse(b.meta_json || "{}"); } catch {}
    if (meta.brief_sent && !all) continue;
    const d = destOf(b); if (!d?.code || !AIRPORTS[d.code]) continue;
    const hrs = (departureMs(b, d.dep) - now) / HOURS;
    if (all || (hrs >= WINDOW.from && hrs <= WINDOW.to)) out.push({ booking: b, dest: d.code, hoursToDeparture: Math.round(hrs) });
  }
  return out;
}

async function runForBooking(b, { force = false, reason = "T-72" } = {}) {
  const d = destOf(b); if (!d?.code) return { ok: false, error: "no_destination" };
  const uid = b.user_id;
  if (!G.getNode(bridge.PAX(uid))) bridge.link();
  const pax = G.getNode(bridge.PAX(uid)) || {};
  const from = b.flight_date, to = research.addDays(b.flight_date, 3);
  const brief = await research.build(d.code, from, to, { force });
  const channel = pax.preferred_channel || "push";
  const gate = policy.execute("SEND_DESTINATION_BRIEF", { passengerId: bridge.PAX(uid), channel }, { actor: "briefs", rationale: `${reason} brief for ${b.pnr} → ${brief.city} (${brief.travel_impact} impact)` });
  if (!gate.ok) return { ok: false, refused: gate.refused, failed: gate.failed, brief };
  const card = bridge.onBrief({ uid, booking: b, brief, channel });
  let meta = {}; try { meta = JSON.parse(b.meta_json || "{}"); } catch {}
  meta.brief_sent = new Date().toISOString(); meta.brief_id = brief.id || research.idFor(d.code, from, to);
  db.prepare("UPDATE bookings SET meta_json=? WHERE id=?").run(JSON.stringify(meta), b.id);
  O.audit({ actor: "briefs", action: "BRIEF_SENT", rationale: `${b.pnr} (customer ${uid}) → ${brief.city}: ${brief.travel_impact} impact via ${channel}; decision left with the customer` });
  return { ok: true, brief, card, channel };
}

async function run({ now = Date.now(), uids = null, force = false, reason = "T-72" } = {}) {
  const items = due({ now, all: !!uids }).filter((x) => !uids || uids.includes(x.booking.user_id));
  const results = [];
  for (const it of items) { try { results.push({ pnr: it.booking.pnr, uid: it.booking.user_id, ...(await runForBooking(it.booking, { force, reason })) }); } catch (e) { results.push({ pnr: it.booking.pnr, ok: false, error: String(e.message || e).slice(0, 120) }); } }
  return { checked: items.length, sent: results.filter((r) => r.ok).length, results };
}

let timer = null;
function start({ intervalMs = Number(process.env.BRIEFS_INTERVAL_MS) || 30 * 60 * 1000, log = console.log } = {}) {
  if (process.env.BRIEFS_ENABLED === "0") { log("   Briefs:  T-72 destination briefs OFF (BRIEFS_ENABLED=0)"); return null; }
  log(`   Briefs:  T-72 destination briefs ON for every booked trip (${research.status().llm})`);
  const tick = () => run().catch(() => {});
  setTimeout(tick, 25000);
  timer = setInterval(tick, intervalMs); if (timer.unref) timer.unref();
  return timer;
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { due, run, runForBooking, start, stop, WINDOW };
