/* ──────────────────────────────────────────────────────────────────────────
   FlyTAP — CDP unified profile, identity stitching & segmentation (Phase 3)
   ----------------------------------------------------------------------------
   A local mirror of the Adobe RT-CDP profile store. Every touch (a PSS booking,
   a website search, a web booking) is recorded against a profile resolved by
   identity (loyaltyId primary, email secondary). When the same identity is seen
   on more than one channel the profile is STITCHED — one 360° view spanning the
   offline/partner (pss) and online (web) worlds.

   Segments are recomputed from the unified profile on every touch, and offers are
   driven by SEGMENT MEMBERSHIP (not a single transaction) — so the same customer
   booking offline in the PSS and then searching online qualifies for, and is
   shown, a segment-based offer off the combined profile.
   ────────────────────────────────────────────────────────────────────────── */
"use strict";

const dbmod = require("./db");
const { db, now } = dbmod;
const PERSONAS = dbmod.PERSONAS || {};

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// Best-effort enrichment from the seeded personas (name/tier/affinity) by loyalty id.
function personaFor(loyaltyId, email) {
  for (const p of Object.values(PERSONAS)) {
    const u = p.user || {};
    if ((loyaltyId && u.member_no === loyaltyId) || (email && u.email && u.email.toLowerCase() === String(email).toLowerCase()))
      return { name: u.full_name, tier: u.tier, affinity: u.affinity_label };
  }
  return {};
}

function findRow(identity) {
  let row = null;
  if (identity.loyaltyId) row = db.prepare("SELECT * FROM cdp_profiles WHERE loyalty_id=?").get(identity.loyaltyId);
  if (!row && identity.email) row = db.prepare("SELECT * FROM cdp_profiles WHERE lower(email)=lower(?)").get(identity.email);
  return row;
}

/* ── Segmentation: derived purely from the unified profile ─────────────────*/
function computeSegments(p) {
  const seg = [];
  const ch = p.channels || {};
  if ((ch.pss || 0) > 0 && (ch.web || 0) > 0) seg.push("Stitched · Offline + Online");
  if (p.total_spend >= 800) seg.push("High-Value Traveller");
  else if (p.total_spend >= 400) seg.push("Mid-Value Traveller");
  if (p.bookings >= 2) seg.push("Repeat Booker");
  if (p.lounge_flag) seg.push("Lounge & Premium Affinity");
  if ((p.miles || 0) >= 50000) seg.push("Miles-Rich");
  if (p.affinity) seg.push(p.affinity);   // e.g. "Football fan" / "Golf enthusiast" / "Live-music lover"
  return seg;
}

/* ── Offer decisioning: keyed off SEGMENT membership, matched TOLERANTLY ───────
   Real Adobe audience names map without code changes via keyword patterns (e.g.
   "High Value Travellers (PROD)" → high_value). For anything the patterns miss,
   paste the exact audience name into AUDIENCE_ALIASES → it takes precedence. */
const AUDIENCE_ALIASES = {
  // "Your exact Adobe RT-CDP audience name": "welcome_cross_channel" | "high_value_lounge" | "lounge_affinity"
  // e.g. "TAP_CrossChannel_Stitched_PROD": "welcome_cross_channel",
};
const OFFER_BY_SEGMENT = [
  { match: /stitch|cross.?channel|unified|omni.?channel|offline.*online|online.*offline/i,
    label: "welcome_cross_channel",
    email: {
      subject: "We've connected your trips, {first}",
      title: "Your travel, now in one place.",
      preheader: "Your partner booking and your online activity — unified.",
      body_html: "We recognised you across a partner booking and your activity on xperion.example, so your profile is now unified. Your seat, extras and miles follow you everywhere — and your next trip is ready in one tap.",
      cta: "See my unified trips",
    } },
  { match: /high.?value|platinum|premium|top.?tier|vip|elite/i,
    label: "high_value_lounge",
    email: {
      subject: "A lounge pass on us, {first}",
      title: "Thank you for flying with us.",
      preheader: "A {tier} perk for your next departure.",
      body_html: "As one of our most valued travellers, your next departure now includes complimentary lounge access and priority boarding.",
      cta: "Add my perks",
    } },
  { match: /lounge|fast.?track|premium.?affinity/i,
    label: "lounge_affinity",
    email: {
      subject: "Your lounge, ready when you are",
      title: "Premium, the way you like it.",
      preheader: "Lounge + fast-track pre-selected.",
      body_html: "You usually add the lounge — we've pre-selected it and a fast-track pass for your next trip.",
      cta: "Confirm my add-ons",
    } },
];
const normSeg = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function offerForProfile(p) {
  const segs = p.segments || [];
  const first = (p.name || "there").split(" ")[0];
  const fill = (e) => ({
    subject: e.subject.replace("{first}", first), title: e.title.replace("{first}", first),
    preheader: e.preheader.replace("{tier}", p.tier || "Member"), body_html: e.body_html.replace("{tier}", p.tier || "Member"),
    cta: e.cta,
  });
  const byLabel = (lab) => OFFER_BY_SEGMENT.find((o) => o.label === lab);
  // 1) Exact alias match (operator-provided real audience names) — highest precedence.
  for (const s of segs) {
    const o = byLabel(AUDIENCE_ALIASES[s] || AUDIENCE_ALIASES[normSeg(s)]);
    if (o) return { label: o.label, segment: s, email: fill(o.email) };
  }
  // 2) Tolerant keyword match against audience / segment names.
  for (const o of OFFER_BY_SEGMENT) {
    const hit = segs.find((s) => o.match.test(String(s)));
    if (hit) return { label: o.label, segment: hit, email: fill(o.email) };
  }
  // 3) Affinity fallback (loose): a segment that names the member's affinity.
  if (p.affinity) {
    const aff = normSeg(p.affinity).split(" ")[0];
    const hit = aff && segs.find((s) => normSeg(s).includes(aff));
    if (hit) return { label: "affinity_offer", segment: hit, email: fill({
      subject: `Picked for you, {first}`, title: `Because you're a ${p.affinity.toLowerCase()}.`,
      preheader: "Something for your interests on your next trip.",
      body_html: `We lined up an experience for the ${p.affinity.toLowerCase()} in you on your next trip.`, cta: "Show me",
    }) };
  }
  return null;
}

/* ── Record a touch from any channel; returns the updated unified profile ──*/
function record(touch) {
  const id = touch.identity || {};
  if (!id.loyaltyId && !id.email) return null;
  const ts = now();
  const enrich = personaFor(id.loyaltyId, id.email);
  let row = findRow(id);

  if (!row) {
    db.prepare(`INSERT INTO cdp_profiles (loyalty_id,email,ecid,name,tier,affinity,identities_json,channels_json,segments_json,first_seen,last_seen)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      id.loyaltyId || null, id.email || null, id.ecid || null,
      touch.name || enrich.name || null, touch.tier || enrich.tier || null, touch.affinity || enrich.affinity || null,
      JSON.stringify({ loyaltyId: id.loyaltyId ? [id.loyaltyId] : [], email: id.email ? [id.email] : [], ecid: id.ecid ? [id.ecid] : [] }),
      JSON.stringify({}), JSON.stringify([]), ts, ts);
    row = findRow(id);
  }

  const channels = parse(row.channels_json, {});
  const identities = parse(row.identities_json, { loyaltyId: [], email: [], ecid: [] });
  const add = (k, v) => { if (v && !(identities[k] || (identities[k] = [])).includes(v)) identities[k].push(v); };
  add("loyaltyId", id.loyaltyId); add("email", id.email); add("ecid", id.ecid);

  channels[touch.channel] = (channels[touch.channel] || 0) + 1;
  const bookings = row.bookings + (touch.type === "booked" ? 1 : 0);
  const total_spend = +(row.total_spend + (Number(touch.spend) || 0)).toFixed(2);
  const miles = row.miles + (Number(touch.miles) || 0);
  const lounge_flag = row.lounge_flag || (touch.lounge ? 1 : 0);
  const pss_events = row.pss_events + (touch.channel === "pss" ? 1 : 0);
  const web_events = row.web_events + (touch.channel === "web" ? 1 : 0);
  const stitched = ((channels.pss || 0) > 0 && (channels.web || 0) > 0) ? 1 : 0;
  const affinity = row.affinity || touch.affinity || enrich.affinity || null;
  const name = row.name || touch.name || enrich.name || null;
  const tier = row.tier || touch.tier || enrich.tier || null;

  const segments = computeSegments({ channels, bookings, total_spend, miles, lounge_flag, affinity });

  db.prepare(`UPDATE cdp_profiles SET loyalty_id=COALESCE(?,loyalty_id),email=COALESCE(?,email),ecid=COALESCE(?,ecid),
      name=?,tier=?,affinity=?,identities_json=?,channels_json=?,segments_json=?,
      bookings=?,total_spend=?,miles=?,lounge_flag=?,pss_events=?,web_events=?,stitched=?,last_seen=? WHERE id=?`)
    .run(id.loyaltyId || null, id.email || null, id.ecid || null,
      name, tier, affinity, JSON.stringify(identities), JSON.stringify(channels), JSON.stringify(segments),
      bookings, total_spend, miles, lounge_flag, pss_events, web_events, stitched, ts, row.id);

  return shape(findRow(id));
}

function shape(row) {
  if (!row) return null;
  const p = {
    id: row.id, loyaltyId: row.loyalty_id, email: row.email, ecid: row.ecid, name: row.name, tier: row.tier, affinity: row.affinity,
    identities: parse(row.identities_json, {}), channels: parse(row.channels_json, {}), segments: parse(row.segments_json, []),
    bookings: row.bookings, pss_events: row.pss_events, web_events: row.web_events,
    total_spend: row.total_spend, miles: row.miles, lounge_flag: !!row.lounge_flag, stitched: !!row.stitched,
    first_seen: row.first_seen, last_seen: row.last_seen,
  };
  p.offer = offerForProfile(p);
  return p;
}

const getProfile = (identity) => shape(findRow(identity || {}));
const listProfiles = () => db.prepare("SELECT * FROM cdp_profiles ORDER BY last_seen DESC").all().map(shape);

// Adobe-aware variant: when the cdp module is wired, real RT-CDP audiences take
// precedence and are merged over the locally-derived segments; the offer is then
// recomputed from the merged set. Falls back to the local profile when CDP is absent.
const cdpAudiences = require("./cdp-audiences");
async function getProfileLive(identity) {
  const p = shape(findRow(identity || {}));
  if (!p) return null;
  const audiences = await cdpAudiences.audiencesFor({ loyaltyId: p.loyaltyId, email: p.email });
  if (audiences.length) {
    p.segments = [...audiences, ...p.segments.filter((s) => !audiences.includes(s))];
    p.adobeAudiences = audiences;
    p.segmentSource = "adobe";
    p.offer = offerForProfile(p);
  } else {
    p.segmentSource = "local";
  }
  return p;
}

module.exports = { record, getProfile, getProfileLive, listProfiles, computeSegments, offerForProfile };
