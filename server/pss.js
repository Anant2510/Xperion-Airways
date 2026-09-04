/* ──────────────────────────────────────────────────────────────────────────
   FlyTAP — PSS (Passenger Service System) ingestion gateway
   ----------------------------------------------------------------------------
   An external PSS (the demo uses Supabase Postgres) is the system that creates
   third-party bookings / transactions / loyalty accrual. On every write it fires
   a signed webhook to POST /api/pss/ingest, which calls ingest() here.

   This module is the SINGLE governed path that lands a PSS record into:
     • SQLite   — the system of record for transactions (bookings + payments),
                  tagged source='pss' so PSS-origin data stays distinguishable
                  (mirrors the existing X-App v1/v2 attribution).
     • Adobe RT-CDP — by emitting the SAME event shape the website streams
                  (cdpEvents.emit / streamEvent with a {loyaltyId,email} identity
                  map), so the PSS fragment STITCHES onto the known web/loyalty
                  profile and qualifies the customer for segments → offers.

   Consistency guarantees:
     • Idempotency  — keyed on pssRef+eventType; a re-delivered webhook is a no-op.
     • Outbox       — the SQLite write and the "to-be-sent-to-CDP" marker commit in
                      one transaction (events row, delivery='pending'); CDP delivery
                      happens AFTER commit and retries independently, so CDP being
                      down never corrupts the transaction truth.
   ────────────────────────────────────────────────────────────────────────── */
"use strict";

const crypto = require("node:crypto");
const { db, now, searchToday, PERSONAS } = require("./db");
const { AIRPORTS } = require("./routes-data");

// cdp-events lives in the full deployment (the website streams through it). Require
// it defensively so this module also loads in slices where it isn't present yet;
// forwardToCdp then degrades to "queued" and the outbox retries once it's available.
let cdpEvents = {};
try { cdpEvents = require("./cdp-events"); } catch { /* absent in this slice — outbox will retry */ }
// cdp exposes getProfileFromCdp(personaId) → { profile, provenance:{ audiences, ... } }.
// Used to drive segment-based offers off the unified profile's Adobe audience membership.
let cdp = {};
try { cdp = require("./cdp"); } catch { /* absent in this slice — offers fall back to local rules */ }
// Unified RT-CDP profile mirror (identity stitching across offline/online). The website
// feeds it on search/pay; PSS feeds it on ingest so the offline channel stitches in.
let cdpProfile = {};
try { cdpProfile = require("./cdp-profile"); } catch { /* absent in this slice */ }
const cdpAudiences = require("./cdp-audiences");   // Adobe audience reads + publish-back
let sendEmail = async () => ({ status: "email module absent" });
try { ({ sendEmail } = require("./email")); } catch { /* optional */ }
const segEngine = require("./segments");   // local segment engine (fallback to Adobe audiences)

const PSS_SECRET = process.env.PSS_WEBHOOK_SECRET || "tap-pss-demo-secret";
const cityName = (c) => (AIRPORTS[c] && AIRPORTS[c].city) || c;

/* ── 1 · Webhook trust ──────────────────────────────────────────────────────
   HMAC-SHA256 over the RAW request body, constant-time compared. server.js
   captures the raw bytes via express.json({ verify }) and passes them in. */
function verifySignature(rawBody, signature) {
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", PSS_SECRET).update(rawBody || "").digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sign(rawBody) {
  return crypto.createHmac("sha256", PSS_SECRET).update(rawBody || "").digest("hex");
}

/* ── 2 · Normalize ──────────────────────────────────────────────────────────
   Accepts a Supabase Database-Webhook envelope ({type, table, record}) OR a flat
   booking object, and maps either onto one canonical envelope. */
function normalize(body) {
  const r = body && body.record ? body.record : body || {};
  const toLower = (s) => (s ? String(s).toLowerCase() : null);
  return {
    pssRef: String(r.pss_ref || r.id || r.booking_id || r.pnr || ""),
    eventType: toLower(r.event_type || r.type || "booked"),
    pnr: r.pnr || r.record_locator || null,
    loyaltyId: r.loyalty_id || r.member_no || null,
    email: toLower(r.email),
    phone: r.phone || r.mobile || r.phone_number || null,
    fullName: r.full_name || r.passenger_name || null,
    origin: r.origin || null,
    destination: r.destination || r.dest || null,
    travelDate: r.travel_date || r.flight_date || null,
    flightNumber: r.flight_no || r.flight_number || null,
    seat: r.seat || null,
    cabin: r.cabin || "Economy",
    amount: Number(r.amount != null ? r.amount : (r.total != null ? r.total : 0)),
    currency: r.currency || "EUR",
    milesEarned: Number(r.miles_earned != null ? r.miles_earned : 0),
    ancillaries: Array.isArray(r.ancillaries) ? r.ancillaries : [],
    channel: r.channel || "PSS",
    occurredAt: r.created_at || r.occurred_at || now(),
  };
}

/* ── 3 · Identity resolution ────────────────────────────────────────────────
   Match the PSS record to a local user by loyaltyId (member_no), else email.
   The returned identity map is what CDP stitches on — it always carries whatever
   the PSS knew, so CDP can merge on email/loyaltyId even before a local user exists.

   NOTE: this demo keeps a single live customer at users.id=1. When no local user
   matches, the booking is still recorded (user_id=null) and still streamed to CDP;
   true multi-profile stitching just needs the users table to go multi-row. */
function resolveUser(env) {
  let user = null;
  if (env.loyaltyId) user = db.prepare("SELECT * FROM users WHERE member_no=?").get(env.loyaltyId);
  if (!user && env.email) user = db.prepare("SELECT * FROM users WHERE lower(email)=?").get(env.email);
  if (!user && env.phone) user = db.prepare("SELECT * FROM users WHERE phone=?").get(env.phone);
  // Also resolve a members-directory row, covering members who aren't the live id=1 record.
  let member = null;
  if (env.loyaltyId) member = db.prepare("SELECT * FROM members WHERE member_no=?").get(env.loyaltyId);
  if (!member && env.email) member = db.prepare("SELECT * FROM members WHERE lower(email)=?").get(env.email);
  if (!member && env.phone) member = db.prepare("SELECT * FROM members WHERE phone=?").get(env.phone);
  const memberNo = env.loyaltyId || (user && user.member_no) || (member && member.member_no) || null;
  const identity = {
    loyaltyId: memberNo,
    email: env.email || (user && user.email) || (member && member.email) || null,
    phone: env.phone || (user && user.phone) || (member && member.phone) || null,
  };
  return { user, member, memberNo, identity };
}

// Resolve any DB-registered identity from an inbound mobile number (WhatsApp `From`, SMS…).
// Tolerant of channel prefixes/spacing: matches users.phone / members.phone on the trailing
// 9 digits, so "whatsapp:+351 91 442 7781" still finds "+351 91 442 7781".
function resolveByPhone(raw) {
  if (!raw) return null;
  const tail = String(raw).replace(/[^0-9]/g, "").slice(-9);
  if (!tail) return null;
  const cmp = "replace(replace(replace(phone,' ',''),'+',''),'-','')";
  let u = db.prepare(`SELECT * FROM users WHERE ${cmp} LIKE ?`).get("%" + tail);
  if (u) return { kind: "user", member_no: u.member_no, email: u.email, name: u.full_name, tier: u.tier, home_airport: u.home_airport, phone: u.phone };
  let m = db.prepare(`SELECT * FROM members WHERE ${cmp} LIKE ?`).get("%" + tail);
  if (m) return { kind: "member", member_no: m.member_no, email: m.email, name: m.full_name, tier: m.tier, home_airport: m.home_airport, phone: m.phone };
  return null;
}

const processed = (key) => !!db.prepare("SELECT 1 FROM pss_ingest_log WHERE idem_key=?").get(key);

/* ── 4 · CDP forward ────────────────────────────────────────────────────────
   Emit the SAME shape the website uses. Prefer the awaitable streamEvent so we
   learn delivery success for the outbox; fall back to fire-and-forget emit. */
async function forwardToCdp(eventType, identity, attrs) {
  try {
    if (typeof cdpEvents.streamEvent === "function") {
      const r = await cdpEvents.streamEvent(eventType, identity, attrs);
      return r !== false;
    }
    if (typeof cdpEvents.emit === "function") {
      cdpEvents.emit(eventType, identity, attrs);
      return true;
    }
  } catch { return false; }
  return false; // module absent → leave outbox 'pending' for retry
}

/* ── 5 · The single governed ingest path ────────────────────────────────────*/
async function ingest(body, opts = {}) {
  const { rawBody, signature, skipVerify } = opts;
  if (!skipVerify && !verifySignature(rawBody != null ? rawBody : JSON.stringify(body || {}), signature)) {
    return { ok: false, error: "bad_signature", status: 401 };
  }

  const env = normalize(body);
  if (!env.pssRef) return { ok: false, error: "missing_pss_ref", status: 400 };

  const idemKey = `${env.pssRef}:${env.eventType}`;
  if (processed(idemKey)) return { ok: true, deduped: true, idemKey };

  let { user, member, memberNo, identity } = resolveUser(env);
  // Register / refresh the PSS customer in the members directory so the SAME email + mobile
  // resolve them later for transaction & offer emails, personalization and the WhatsApp flow.
  if (!user) {
    if (!memberNo && env.email) memberNo = "G-" + Buffer.from(env.email).toString("hex").slice(0, 10).toUpperCase();
    if (memberNo) {
      if (member) {
        db.prepare("UPDATE members SET email=COALESCE(?,email), phone=COALESCE(?,phone), full_name=COALESCE(?,full_name) WHERE member_no=?")
          .run(env.email, env.phone, env.fullName, memberNo);
      } else {
        db.prepare("INSERT OR IGNORE INTO members (member_no,email,full_name,first_name,tier,miles,home_airport,phone) VALUES (?,?,?,?,?,?,?,?)")
          .run(memberNo, env.email, env.fullName, (env.fullName || "").split(" ")[0] || null, "Member", 0, env.origin || null, env.phone);
      }
      identity.loyaltyId = identity.loyaltyId || memberNo;
    }
  } else if (env.phone) {
    db.prepare("UPDATE users SET phone=COALESCE(phone,?), wa_id=COALESCE(wa_id,?) WHERE id=?").run(env.phone, env.phone, user.id);
  }
  const ts = now();
  let bookingId = null;
  let outboxId = null;

  // (a) + (b) Persist transaction + write outbox marker in ONE transaction.
  db.exec("BEGIN");
  try {
    if (env.eventType === "booked" || env.eventType === "ancillary") {
      if (env.flightNumber && !db.prepare("SELECT 1 FROM flights WHERE flight_no=?").get(env.flightNumber)) {
        db.prepare(`INSERT INTO flights (flight_no,origin,dest,dep,arr,duration,aircraft,price,seats_left,flight_date,status)
          VALUES (?,?,?,?,?,?,?,?,?,?, 'scheduled')`)
          .run(env.flightNumber, env.origin || "", env.destination || "", "", "", "", "A320neo", env.amount, 9, env.travelDate || searchToday());
      }
      const pnr = env.pnr || ("PSS" + Math.random().toString(36).slice(2, 7).toUpperCase());
      const r = db.prepare(`INSERT INTO bookings (pnr,user_id,flight_no,flight_date,seat,status,checked_in,items_json,created_at,source,pss_ref,member_no)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(pnr, user ? user.id : null, env.flightNumber, env.travelDate, env.seat,
             "confirmed", 0, JSON.stringify(env.ancillaries), ts, "pss", env.pssRef, memberNo);
      bookingId = Number(r.lastInsertRowid);
      db.prepare(`INSERT INTO payments (booking_id,total,voucher_amt,miles_used,miles_amt,card_amt,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(bookingId, env.amount, 0, 0, 0, env.amount, ts);
      // Modern Retailing: an offline PSS booking is an ORDER in the same ledger as web/chat —
      // the ONE Order record spans channels even when the sale happened in a partner system.
      try {
        const retail = require("./retail");
        if (user) retail.recordOrderFromBooking({ uid: user.id, channel: "pss", pnr, flight: { flight_no: env.flightNumber, origin: env.origin, dest: env.destination, flight_date: env.travelDate }, date: env.travelDate, items: env.ancillaries || [], total: env.amount, split: { card: env.amount, seat: env.seat } });
      } catch { /* retail engine absent in this slice — booking truth is unaffected */ }
      // Accrue miles to the live record if matched, else to the members directory.
      if (env.milesEarned) {
        if (user) db.prepare("UPDATE users SET miles = miles + ? WHERE id=?").run(env.milesEarned, user.id);
        else if (memberNo) db.prepare("UPDATE members SET miles = miles + ? WHERE member_no=?").run(env.milesEarned, memberNo);
      }
    }

    const evPayload = {
      source: "pss", pssRef: env.pssRef, channel: env.channel, identity,
      origin: env.origin, destination: env.destination, travelDate: env.travelDate,
      flightNumber: env.flightNumber, seat: env.seat, cabin: env.cabin,
      amount: env.amount, currency: env.currency, milesEarned: env.milesEarned,
      ancillaries: env.ancillaries,
    };
    const ev = db.prepare(`INSERT INTO events (type,payload_json,created_at,app,source,delivery,idem_key)
      VALUES (?,?,?,?,?,?,?)`)
      .run("pss_" + env.eventType, JSON.stringify(evPayload), ts, "v2", "pss", "pending", idemKey);
    outboxId = Number(ev.lastInsertRowid);

    db.prepare("INSERT INTO pss_ingest_log (idem_key,pss_ref,event_type,booking_id,created_at) VALUES (?,?,?,?,?)")
      .run(idemKey, env.pssRef, env.eventType, bookingId, ts);

    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    return { ok: false, error: "persist_failed", detail: String(e && e.message || e), status: 500 };
  }

  // (c) Forward to RT-CDP AFTER commit. Map eventType to the website's vocabulary.
  const cdpType = env.eventType === "ancillary" ? "booked" : env.eventType;
  const cdpAttrs = {
    origin: env.origin, destination: env.destination, travelDate: env.travelDate,
    flightNumber: env.flightNumber, seat: env.seat, cabin: env.cabin,
    ancillaries: env.ancillaries.map((a) => a.name || a.label || a),
    amount: env.amount, currency: env.currency, channel: env.channel, abandoned: false,
  };
  const delivered = await forwardToCdp(cdpType, identity, cdpAttrs);
  db.prepare("UPDATE events SET delivery=? WHERE id=?").run(delivered ? "sent" : "pending", outboxId);

  // Record the OFFLINE (PSS) touch into the unified RT-CDP profile mirror → stitches with
  // the member's ONLINE (web) touches under the same identity → recomputes segments → the
  // 360° view (and its "Stitched · Offline + Online" segment) now reflects the offline channel.
  try {
    if (typeof cdpProfile.record === "function") {
      cdpProfile.record({
        identity, channel: "pss", type: env.eventType === "ancillary" ? "ancillary" : "booked",
        spend: env.amount, miles: env.milesEarned,
        lounge: (env.ancillaries || []).some(a => /lounge/i.test(a.name || a.label || a)),
      });
    }
  } catch { /* non-fatal */ }

  // (d) Decisioning — SEGMENT-DRIVEN first (Adobe audiences on the unified profile),
  //     falling back to local transaction rules. The offer is chosen by which segments
  //     the stitched 360° profile qualifies for; amount/ancillary rules are the fallback.
  let firedOffer = null, offerVia = null, segments = [];
  try {
    const decision = await decideOffer(env, user, memberNo);
    segments = decision.segments || [];
    const offer = decision.offer;
    if (offer) {
      if (user) { try { await sendEmail("personal_offer", { offer: offer.email }); } catch {} }
      db.prepare("INSERT INTO events (type,payload_json,created_at,app,source,delivery) VALUES (?,?,?,?,?,?)")
        .run("pss_offer_triggered", JSON.stringify({ offer: offer.label, via: offer.via || "rule", segments, pssRef: env.pssRef, identity }), now(), "v2", "pss", "sent");
      await forwardToCdp("offer", identity, { offer: offer.label, via: offer.via || "rule", channel: env.channel, amount: env.amount });
      firedOffer = offer.label; offerVia = offer.via || "rule";
    }
  } catch { /* non-fatal */ }

  // Publish the computed segment membership back to Adobe (streamed event; no-op if absent).
  try { await cdpAudiences.publish(identity, segments); } catch { /* non-fatal */ }

  return {
    ok: true, idemKey, bookingId,
    stitchedTo: user ? { member_no: user.member_no, name: user.full_name } : null,
    cdp: delivered ? "sent" : "queued (retry)",
    offer: firedOffer, offerVia, segments,
  };
}

/* ── 6 · Outbox flusher ─────────────────────────────────────────────────────
   Retry any PSS events that haven't been delivered to CDP (module was down/absent).
   Called periodically by server.js and exposed at POST /api/pss/flush. */
async function flushOutbox(limit = 25) {
  const pending = db.prepare("SELECT * FROM events WHERE source='pss' AND delivery='pending' AND type LIKE 'pss_%' LIMIT ?").all(limit);
  let sent = 0;
  for (const row of pending) {
    let p; try { p = JSON.parse(row.payload_json); } catch { continue; }
    const type = String(row.type).replace(/^pss_/, "").replace("ancillary", "booked");
    const ok = await forwardToCdp(type, p.identity || {}, p);
    db.prepare("UPDATE events SET delivery=? WHERE id=?").run(ok ? "sent" : "pending", row.id);
    if (ok) sent++;
  }
  // One-shot retry for pending WEB events (everything that isn't a pss_* outbox row). These
  // were forwarded best-effort at write time; if that attempt failed they're left 'pending'.
  // We retry exactly once here, then move them to a terminal state ('sent' or 'failed') so they
  // never loop — the pss_* rows above keep their continuous retry. The 60s age guard avoids
  // racing an initial forward that may still be in-flight.
  const ident = (() => { try { const u = db.prepare("SELECT member_no, email FROM users WHERE id=1").get() || {}; return { loyaltyId: u.member_no, email: u.email }; } catch { return {}; } })();
  const cutoff = new Date(Date.now() - 60000).toISOString().replace("T", " ").slice(0, 19);
  const web = db.prepare("SELECT * FROM events WHERE delivery='pending' AND type NOT LIKE 'pss_%' AND created_at < ? LIMIT ?").all(cutoff, limit);
  let webSent = 0;
  for (const row of web) {
    let p; try { p = JSON.parse(row.payload_json || "{}"); } catch { p = {}; }
    let ok = false;
    try { ok = await forwardToCdp(row.type, p.identity || ident, p); } catch { ok = false; }
    db.prepare("UPDATE events SET delivery=? WHERE id=?").run(ok ? "sent" : "failed", row.id);
    if (ok) webSent++;
  }
  return { checked: pending.length, sent, webRetried: web.length, webSent };
}

/* ── 7 · Local offer rules ──────────────────────────────────────────────────
   Pure functions of the PSS transaction + the matched member. Personalized using
   the member's affinity so the demo shows targeting, not a generic blast. */
function evaluateOffer(env, user) {
  const first = (user && user.first_name) || "there";
  const tier = (user && user.tier) || "Member";
  const aff = (user && user.affinity_label) || null;
  const destCity = cityName(env.destination || "");
  const hasPartnerAncillary = (env.ancillaries || []).some((a) => /hotel|car|lounge|transfer|insurance/i.test(a.name || a.label || a));

  // Rule A — high-value third-party trip → lounge/upgrade nudge.
  if (env.amount >= 500) {
    return {
      label: "pss_high_value_trip",
      email: {
        subject: `A little extra for your ${destCity || "trip"}, ${first}`,
        title: `Your ${destCity || "upcoming"} trip just unlocked a perk.`,
        preheader: `Spotted your booking — here's a ${tier} thank-you.`,
        body_html: `We saw your recent booking come through${destCity ? ` to <b>${destCity}</b>` : ""}. As a Xperion Miles <b>${tier}</b> member, your lounge access and a complimentary seat upgrade are ready to add${aff ? ` — and we lined up something for the ${aff.toLowerCase()} in you.` : "."}`,
        cta: "Add my perks",
      },
    };
  }
  // Rule B — partner cross-sell present → bonus-miles activation.
  if (hasPartnerAncillary) {
    return {
      label: "pss_partner_crosssell",
      email: {
        subject: `Earn 3× miles on your ${destCity || "trip"} extras`,
        title: `Triple miles on your booking, ${first}.`,
        preheader: `Your partner extras qualify for bonus miles.`,
        body_html: `Your recent booking includes partner services — activate <b>3× tap.miles</b> on them${aff ? `, plus a ${aff.toLowerCase()} offer picked for you` : ""}. One tap to activate.`,
        cta: "Activate 3× miles",
      },
    };
  }
  return null;
}

/* ── 7b · Segment-driven decisioning ────────────────────────────────────────
   Resolve the unified profile's Adobe audiences (via cdp.getProfileFromCdp — the same
   interface server.js uses) and map them to offers. Segment membership wins; the local
   transaction rules above are the fallback when CDP is unavailable or nothing matches.
   Audience matching is tolerant (regex/substring) so it works against your real Adobe
   segment names without code changes — adjust SEGMENT_OFFERS to taste. */
function personaIdFor(identity) {
  const mno = identity && identity.loyaltyId;
  const em = String((identity && identity.email) || "").toLowerCase();
  for (const p of Object.values(PERSONAS || {})) {
    if ((mno && p.user.member_no === mno) || (em && String(p.user.email || "").toLowerCase() === em)) return p.id;
  }
  return null;
}
async function resolveSegments(identity) {
  try {
    const pid = personaIdFor(identity);
    if (pid && typeof cdp.getProfileFromCdp === "function") {
      const r = await cdp.getProfileFromCdp(pid);
      const a = r && r.provenance && r.provenance.audiences;
      if (Array.isArray(a)) return a.map((x) => (typeof x === "string" ? x : (x && (x.name || x.id)) || "")).filter(Boolean);
    }
  } catch { /* CDP unavailable → no segments, caller falls back to rules */ }
  return [];
}
const SEGMENT_OFFERS = [
  { match: /high.?value|platinum|premium|top.?tier/i, label: "seg_high_value",
    email: { subject: "A premium perk on your booking", title: "Because you're one of our most valued flyers.", preheader: "A high-value-traveller benefit, picked for you.", body_html: "Your unified profile qualifies you for our <b>high-value traveller</b> benefits — lounge access and a complimentary upgrade on this trip.", cta: "Claim my benefits" } },
  { match: /commuter|frequent|shuttle|business.?trav/i, label: "seg_frequent_commuter",
    email: { subject: "Your commute, made faster", title: "Fast Track, on us.", preheader: "A frequent-commuter perk.", body_html: "We see you fly this route often — here's <b>complimentary Fast Track</b> and priority boarding on your next departures.", cta: "Add Fast Track" } },
  { match: /family/i, label: "seg_family",
    email: { subject: "A little something for the family", title: "Travelling together, sorted.", preheader: "A family-traveller offer.", body_html: "Your profile shows you travel as a family — enjoy <b>free seats together</b> and kids-eat-free on board.", cta: "See family perks" } },
  { match: /football|sport/i, label: "seg_football",
    email: { subject: "Matchday-ready", title: "For the football fan in you.", preheader: "Picked from your interests.", body_html: "We lined up a <b>matchday guide and partner offer</b> for your destination — because you're a football fan.", cta: "See the offer" } },
  { match: /golf/i, label: "seg_golf",
    email: { subject: "Tee time at your destination", title: "A round, on arrival.", preheader: "Picked from your interests.", body_html: "Your profile says golf — here's a <b>partner green-fee discount</b> near your destination.", cta: "Book a round" } },
  { match: /music|concert/i, label: "seg_music",
    email: { subject: "Live music where you're headed", title: "Sounds like your kind of trip.", preheader: "Picked from your interests.", body_html: "We found <b>live-music events and a partner offer</b> at your destination — curated for you.", cta: "See what's on" } },
  { match: /lounge/i, label: "seg_lounge",
    email: { subject: "Your lounge is ready", title: "Relax before you fly.", preheader: "A lounge-eligible offer.", body_html: "Your profile qualifies for <b>complimentary lounge access</b> on this trip.", cta: "Add lounge access" } },
];
// Paste exact Adobe audience names here for any the regex patterns don't catch.
const PSS_AUDIENCE_ALIASES = {
  // "Your exact Adobe RT-CDP audience name": "seg_high_value" | "seg_lounge" | "seg_frequent_commuter" | ...
};
function matchSegmentOffer(segments) {
  for (const aud of segments || []) {
    const aliased = SEGMENT_OFFERS.find((s) => s.label === PSS_AUDIENCE_ALIASES[aud]);
    if (aliased) return { label: aliased.label, via: aud, email: aliased.email };
    const hit = SEGMENT_OFFERS.find((s) => s.match.test(String(aud)));
    if (hit) return { label: hit.label, via: aud, email: hit.email };
  }
  return null;
}
async function decideOffer(env, user, memberNo) {
  // 1) Real Adobe audiences (when the CDP module is wired) → audience-mapped offer.
  const audiences = await resolveSegments({ loyaltyId: env.loyaltyId, email: env.email });
  const segOffer = matchSegmentOffer(audiences);
  // 2) Local segment engine over the unified SQLite profile (cross-channel, high-value,
  //    partner-affinity, frequent-commuter) — the demoable path without Adobe audiences set up.
  const local = (memberNo && segEngine.evaluate(memberNo)) || { segments: [] };
  const localNames = (local.segments || []).map((s) => s.name);
  const allSegments = [...audiences, ...localNames];
  if (segOffer) return { segments: allSegments, offer: { ...segOffer, via: segOffer.via || "adobe audience" } };
  const lo = memberNo ? segEngine.offerFor(memberNo) : null;
  return { segments: allSegments, offer: lo ? { label: lo.label, email: lo.email, via: lo.segment } : null };
}

/* ── 8 · Optional: write the booking into the external PSS store (Supabase) ──
   When SUPABASE_URL + a key are configured, /api/pss/book pushes the row into
   pss_bookings so the record genuinely lives in the third-party system. The
   Supabase webhook will then re-POST it to /api/pss/ingest, where idempotency
   makes it a no-op (the synchronous local ingest already counted it). Without
   creds this is a no-op and the demo runs purely local. */
async function pushToSupabase(record) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return { configured: false };
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/pss_bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}`, Prefer: "return=minimal" },
      body: JSON.stringify(record),
    });
    return { configured: true, ok: r.ok, status: r.status };
  } catch (e) {
    return { configured: true, ok: false, error: String(e && e.message || e) };
  }
}

module.exports = { ingest, flushOutbox, verifySignature, sign, normalize, resolveUser, resolveByPhone, evaluateOffer, decideOffer, resolveSegments, matchSegmentOffer, pushToSupabase };
