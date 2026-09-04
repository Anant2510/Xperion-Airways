/* ──────────────────────────────────────────────────────────────────────────
   FlyTAP — local segment (audience) engine + offer mapping
   ----------------------------------------------------------------------------
   Evaluates which audiences a member's UNIFIED profile qualifies for, keyed by
   loyalty number (member_no), and maps the top segment to a personalized offer.

   "Unified profile" = the member's directory row (members table) + their booking
   history across channels: PSS-origin bookings tagged with this member_no AND, when
   this member is the live id=1 record, their online/seeded bookings too. That mirrors
   the online + offline (third-party) picture Adobe RT-CDP holds after identity
   stitching, so segment membership here is representative of the CDP audience.

   Interface (consumed by server.js and server/pss.js):
     evaluate(memberNo) → { member, profile, segments:[{id,name,why}], decided }
     offerFor(memberNo) → { label, email, segment } | null
   In production the real audiences come from RT-CDP (see pss.resolveSegments); this
   engine is the demoable path that works without Adobe audiences configured.
   ────────────────────────────────────────────────────────────────────────── */
"use strict";
const { db } = require("./db");

function unifiedProfile(memberNo) {
  if (!memberNo) return null;
  const m = db.prepare("SELECT * FROM members WHERE member_no=?").get(memberNo) || {};
  const activeUser = db.prepare("SELECT * FROM users WHERE id=1").get() || {};
  const isActive = activeUser.member_no === memberNo ? 1 : 0;
  // Bookings tagged with this member_no (PSS/offline) OR the live member's online rows.
  const rows = db.prepare(`SELECT b.id,b.status,b.source,b.items_json,p.total
    FROM bookings b LEFT JOIN payments p ON p.booking_id=b.id
    WHERE b.member_no=? OR (?=1 AND b.user_id=1)`).all(memberNo, isActive);
  const ancillaries = rows.flatMap(b => { try { return JSON.parse(b.items_json || "[]"); } catch { return []; } })
    .map(a => (a && (a.name || a.label)) || a).filter(Boolean);
  const src = (k) => m[k] != null ? m[k] : (isActive ? activeUser[k] : undefined);
  return {
    memberNo,
    first: src("first_name") || "there",
    tier: src("tier") || "Member",
    miles: src("miles") || 0,
    affinity: src("affinity") || null,
    affinityLabel: src("affinity_label") || null,
    bookings: rows.length,
    pssCount: rows.filter(b => b.source === "pss").length,
    totalSpend: Math.round(rows.reduce((s, b) => s + (b.total || 0), 0)),
    maxTrip: rows.reduce((mx, b) => Math.max(mx, b.total || 0), 0),
    hasPartner: ancillaries.some(a => /hotel|car|lounge|transfer|insurance/i.test(a)),
    upcoming: rows.filter(b => b.status === "confirmed").length,
  };
}

// Priority-ordered: offerFor() returns the first match.
const SEGMENTS = [
  {
    id: "offline_online_unified", name: "Offline + Online Unified",
    why: p => `${p.pssCount} offline/partner booking(s) stitched onto the online profile`,
    test: p => p.pssCount > 0,
    offer: p => ({ subject: `We brought your trips together, ${p.first}`, title: "One profile, every channel.",
      preheader: "A unified offer across your whole journey.",
      body_html: `Your partner/offline bookings now sit alongside your online trips. Here's an offer across your whole journey — flights, stay and lounge in one tap.`, cta: "See your unified offer" }),
  },
  {
    id: "high_value_flyer", name: "High-Value Flyer",
    why: p => `total spend $${p.totalSpend}${p.maxTrip >= 500 ? ` · a $${p.maxTrip} trip` : ""}`,
    test: p => p.totalSpend >= 1500 || p.maxTrip >= 500,
    offer: p => ({ subject: `A premium thank-you, ${p.first}`, title: "Your status just earned more.",
      preheader: "A high-value-traveller benefit.",
      body_html: `As a high-value <b>${p.tier}</b> flyer, complimentary lounge access and a seat upgrade on your next trip are ready to add.`, cta: "Add my perks" }),
  },
  {
    id: "partner_crosssell", name: "Partner Cross-sell Prospect",
    why: () => `hotel / car / lounge present in recent bookings`,
    test: p => p.hasPartner,
    offer: p => ({ subject: "Triple miles on your extras", title: "3× miles on partner services.",
      preheader: "Bonus miles on your partner bookings.",
      body_html: `Activate <b>3× miles</b> on the hotel, car or lounge in your recent trips${p.affinityLabel ? `, plus a ${p.affinityLabel.toLowerCase()} offer picked for you` : ""}.`, cta: "Activate 3× miles" }),
  },
  { id: "affinity_football", name: "Football Affinity", test: p => p.affinity === "football", why: () => "card-spend affinity: football",
    offer: p => ({ subject: "Matchday in Miami?", title: "A football fan offer.", preheader: "Picked from your interests.", body_html: `Flights plus a matchday experience, bundled for you.`, cta: "See football trips" }) },
  { id: "affinity_golf", name: "Golf Affinity", test: p => p.affinity === "golf", why: () => "card-spend affinity: golf",
    offer: p => ({ subject: "Tee times in Palm Beach", title: "A golf escape.", preheader: "Picked from your interests.", body_html: `Flights plus green fees in Palm Beach, bundled for you.`, cta: "See golf trips" }) },
  { id: "affinity_music", name: "Live-music Affinity", test: p => p.affinity === "music", why: () => "card-spend affinity: live music",
    offer: p => ({ subject: "Live music, away.", title: "Concerts + flights.", preheader: "Picked from your interests.", body_html: `A live-music weekend bundle picked for you.`, cta: "See music trips" }) },
];

const safe = (fn, p) => { try { return !!fn(p); } catch { return false; } };
const safeStr = (fn, p) => { try { return fn ? fn(p) : ""; } catch { return ""; } };

function evaluate(memberNo) {
  const p = unifiedProfile(memberNo);
  if (!p) return { member: memberNo || null, profile: null, segments: [], decided: null };
  const segments = SEGMENTS.filter(s => safe(s.test, p)).map(s => ({ id: s.id, name: s.name, why: safeStr(s.why, p) }));
  const top = SEGMENTS.find(s => safe(s.test, p));
  return {
    member: memberNo,
    profile: { tier: p.tier, miles: p.miles, totalSpend: p.totalSpend, bookings: p.bookings, pssCount: p.pssCount, hasPartner: p.hasPartner, affinity: p.affinityLabel || p.affinity },
    segments,
    decided: top ? { segment: top.id, name: top.name, email: top.offer(p) } : null,
  };
}

function offerFor(memberNo) {
  const p = unifiedProfile(memberNo);
  if (!p) return null;
  const s = SEGMENTS.find(x => safe(x.test, p));
  return s ? { label: s.id, segment: s.name, email: s.offer(p) } : null;
}

module.exports = { evaluate, offerFor, list: SEGMENTS.map(s => ({ id: s.id, name: s.name })) };
