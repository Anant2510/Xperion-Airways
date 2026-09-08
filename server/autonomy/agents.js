/* autonomy/agents.js — Phase 3 agent mesh (Impact, Recovery, Offer, Execution).
   Stateless workers: ALL state lives in the graph; every side effect goes
   through policy.execute(); every external write carries an idempotency key
   and a documented compensating action. Message text comes from templates with
   facts injected from the graph only — nothing is invented at send time. */
"use strict";
const G = require("./graph");
const O = require("./ontology");
const P = require("./policy");
const V = require("./vendors");
const clock = require("./clock");
const bridge = require("./bridge");   // app customers: real channels + real bookings (no-op for synthetic pax)

const tierW = { Platinum: 3, Gold: 2, Silver: 1, Base: 0 };

/* ---------------- Impact agent ---------------- */
function impact(predictionId) {
  const pred = G.getNode(predictionId);
  const fi = G.getNode(pred.flight_instance_ref);
  const ranked = [];
  for (const { node: pnr } of G.out(fi.id, "CARRIES")) {
    const members = G.out(pnr.id, "BELONGS_TO").map(x => x.node);
    const connection = (pnr.segments || []).length > 1;
    const misconnect = connection && (pnr.segments[1].connect_min ?? 999) < 120;
    for (const pax of members) {
      const score =
        3 * (pax.vulnerability_flags?.length ? 1 : 0) +
        tierW[pax.loyalty_tier] +
        0.5 * (pnr.party_size - 1) +
        (connection ? 2 : 0) + (misconnect ? 1 : 0);
      ranked.push({ pax: pax.id, pnr: pnr.id, score: +score.toFixed(1) });
      G.upsertEdge(predictionId, "AFFECTS", pax.id, { priority: score, pnr: pnr.id });
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  G.setProps(predictionId, { impacted: ranked.length, ranked_top: ranked.slice(0, 10) });
  O.audit({ actor: "impact", action: "RANK_IMPACT", predictionId, rationale: `ranked ${ranked.length} passengers across ${new Set(ranked.map(r => r.pnr)).size} PNRs` });
  return ranked;
}

/* ---------------- Recovery planner (any route) ----------------
   The golden scenario seeds two recovery flights (XP903 DEL→JFK, XP077 JFK→MIA) and Orlando
   vendors; those are used when they fit. For every other flight the same three options are built
   from what the graph and the airline's own inventory know: a reroute via the best hub (or a direct
   flight next morning) from search.generateFlights, a divert to the nearest alternate airport that
   the same weather event does not touch (ALTERNATE_OF edges, or airports within 350 km derived from
   known coordinates), with hotel and taxi stubs created per airport inside the policy caps, and a
   refund. Nothing downstream reads a flight number or an airport code from code any more: every
   label, saga step and booking update is driven by the option's components. */
const HUBS = ["JFK", "MIA", "LHR", "FRA", "CDG", "DEL", "DXB", "SIN", "ORD", "DFW", "LAX", "ATL"];
const R = 6371;
function coordsOf(code) {
  const g = G.getNode(`ap:${code}`)?.geo; if (g && g.lat != null) return { lat: g.lat, lon: g.lon };
  const geo = require("./geo"); if (geo.SEED[code]) return { lat: geo.SEED[code][0], lon: geo.SEED[code][1] };
  try { const row = require("../db").db.prepare("SELECT lat, lon FROM geo_cache WHERE code=?").get(code); if (row) return row; } catch {}
  return null;
}
function km(a, b) { if (!a || !b) return null; const dLat = (b.lat - a.lat) * Math.PI / 180, dLon = (b.lon - a.lon) * Math.PI / 180; const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
const nextDay = (d) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
const seededFlight = (no) => G.getNode(`fi:${no}`) || G.nodesByKind("FlightInstance").find((f) => f.flight_no === no && f.recovery);
function planReroute(fi) {
  /* 1 · seeded recovery flights that chain origin → hub → dest */
  const seeded = G.nodesByKind("FlightInstance").filter((f) => f.recovery);
  for (const a of seeded) { if (a.origin !== fi.origin) continue; const b = seeded.find((x) => x.origin === a.dest && x.dest === fi.dest); if (b) return { via: a.dest, legs: [{ flight: a.flight_no, route: `${a.origin}-${a.dest}`, date: fi.date }, { flight: b.flight_no, route: `${b.origin}-${b.dest}`, date: nextDay(fi.date) }] }; }
  /* 2 · the airline's own inventory: direct next morning, else via the hub with the least detour */
  let search = null; try { search = require("../search"); } catch { return null; }
  const day2 = nextDay(fi.date);
  const first = (list) => (list || []).slice().sort((x, y) => String(x.dep).localeCompare(String(y.dep)))[0];
  const last = (list) => (list || []).slice().sort((x, y) => String(y.dep).localeCompare(String(x.dep)))[0];
  const direct = first(search.generateFlights(fi.origin, fi.dest, day2));
  const o = coordsOf(fi.origin), d = coordsOf(fi.dest), od = km(o, d);
  let best = null;
  for (const h of HUBS) {
    if (h === fi.origin || h === fi.dest) continue;
    const detour = (km(o, coordsOf(h)) ?? 1e9) + (km(coordsOf(h), d) ?? 1e9);
    if (od != null && detour > od * 1.6) continue;
    if (!best || detour < best.detour) best = { h, detour };
  }
  if (best) {
    const l1 = last(search.generateFlights(fi.origin, best.h, fi.date)), l2 = first(search.generateFlights(best.h, fi.dest, day2));
    if (l1 && l2) return { via: best.h, legs: [{ flight: l1.flight_no, route: `${fi.origin}-${best.h}`, date: fi.date, dep: l1.dep, arr: l1.arr, seats_left: l1.seats_left }, { flight: l2.flight_no, route: `${best.h}-${fi.dest}`, date: day2, dep: l2.dep, arr: l2.arr, seats_left: l2.seats_left }] };
  }
  if (direct) return { via: null, legs: [{ flight: direct.flight_no, route: `${fi.origin}-${fi.dest}`, date: day2, dep: direct.dep, arr: direct.arr, seats_left: direct.seats_left }] };
  return null;
}
function ensureAlternates(dest) {
  if (G.out(`ap:${dest}`, "ALTERNATE_OF").length) return;
  const here = coordsOf(dest); if (!here) return;
  let AIRPORTS = {}; try { AIRPORTS = require("../routes-data").AIRPORTS; } catch {}
  const country = AIRPORTS[dest]?.country;
  const known = new Set([...G.nodesByKind("Airport").map((a) => a.iata || a.code), ...Object.keys(require("./geo").SEED)]);
  for (const code of known) {
    if (!code || code === dest) continue;
    if (country && AIRPORTS[code] && AIRPORTS[code].country !== country) continue;
    const d = km(here, coordsOf(code)); if (d == null || d > 350) continue;
    if (!G.getNode(`ap:${code}`)) G.upsertNode(`ap:${code}`, "Airport", { iata: code, code, geo: coordsOf(code), city: AIRPORTS[code]?.city || require("./geo").NAMES[code] || code });
    const min = Math.max(20, Math.round(d / 70 * 60));
    G.upsertEdge(`ap:${dest}`, "ALTERNATE_OF", `ap:${code}`, { ground_transfer_min: min, derived: true });
    G.upsertEdge(`ap:${code}`, "ALTERNATE_OF", `ap:${dest}`, { ground_transfer_min: min, derived: true });
  }
}
function vendorsAt(code) {
  const at = (t) => G.nodesByKind("Vendor").find((v) => v.type === t && v.location === code);
  let hotel = at("HOTEL"), taxi = at("TAXI");
  const capH = G.getNode("policy:cap_hotel")?.amount ?? 180, capT = G.getNode("policy:cap_taxi")?.amount ?? 90;
  const cityName = (() => { try { return String(require("../routes-data").AIRPORTS[code]?.city || require("./geo").NAMES[code] || code).split(",")[0].trim(); } catch { return code; } })();
  if (!hotel) { const id = `ven:hotel:${code.toLowerCase()}`; G.upsertNode(id, "Vendor", { type: "HOTEL", location: code, rate: Math.min(120, capH), name: `${cityName} Airport Hotel`, stub: true }); hotel = G.getNode(id); }
  if (!taxi) { const id = `ven:taxi:${code.toLowerCase()}`; G.upsertNode(id, "Vendor", { type: "TAXI", location: code, rate: Math.min(60, capT), name: `${cityName} Airport Transfers`, stub: true }); taxi = G.getNode(id); }
  return { hotel, taxi };
}
function planDivert(fi, predictionId) {
  ensureAlternates(fi.dest);
  const weKey = String(predictionId).split(":")[1];
  const we = G.getNode(`we:${weKey}`);
  const impacted = new Set(G.edges({ src: `we:${weKey}`, rel: "IMPACTS" }).map((e) => e.dst));
  const inStorm = (node) => { if (impacted.has(node.id)) return true; const g = we?.geometry; const c = node.geo || coordsOf(node.iata || node.code); const d = g && c ? km({ lat: g.lat, lon: g.lon }, c) : null; return d != null && d <= (g.radius_km || 0) + 50; };
  const cands = G.out(`ap:${fi.dest}`, "ALTERNATE_OF").filter(({ node }) => node && !inStorm(node)).sort((a, b) => (a.edge.ground_transfer_min ?? 1e9) - (b.edge.ground_transfer_min ?? 1e9));
  const pick = cands[0]; if (!pick) return null;
  const code = pick.node.iata || pick.node.code || pick.node.id.slice(3);
  const { hotel, taxi } = vendorsAt(code);
  return { code, transfer_min: pick.edge.ground_transfer_min ?? null, hotel, taxi };
}

/* ---------------- Recovery agent ---------------- */
function recovery(predictionId) {
  const pred = G.getNode(predictionId);
  const fi = G.getNode(pred.flight_instance_ref);
  const ttlH = G.getNode("policy:hold_ttl")?.hours ?? 4;
  const ttlMs = ttlH * 3600e3;
  const pnrs = [...new Set(G.edges({ src: predictionId, rel: "AFFECTS" }).map(e => e.pnr))];
  let built = 0, waitlisted = 0;
  for (const pnrId of pnrs) {
    const pnr = G.getNode(pnrId);
    const n = pnr.party_size;
    const options = [];

    /* Option A — REROUTE (party kept together): seeded recovery flights when they fit, else the airline's own inventory */
    const plan = planReroute(fi);
    const holdRef = `hold:${predictionId}:${pnrId}:A`;
    let held = !!plan;
    if (plan) {
      plan.legs.forEach((l, i) => { if (!seededFlight(l.flight)) V.ensureSeats(l.flight, l.seats_left ?? 20); });
      for (let i = 0; i < plan.legs.length && held; i++) { const h = V.holdSeats(plan.legs[i].flight, n, `${holdRef}:${i + 1}`, ttlMs); if (!h.ok) held = false; }
    }
    if (!held) {
      if (plan) plan.legs.forEach((_, i) => V.releaseSeats(`${holdRef}:${i + 1}`));
      G.upsertNode(`wait:${predictionId}:${pnrId}`, "RecoveryOption", { type: "WAITLIST", components: [], feasibility_score: 0, pnr: pnrId });
      P.execute("PREPARE_MANUAL_RECOVERY", { predictionId, pnr: pnrId }, { actor: "recovery", predictionId, rationale: `reroute inventory exhausted for ${pnrId}: waitlisted, manual package prepared` });
      P.execute("ESCALATE_TO_HUMAN", { predictionId, perform: () => null }, { actor: "recovery", predictionId, rationale: `inventory shortfall on recovery flights for ${pnrId}` });
      waitlisted++;
    } else {
      const oid = `opt:${predictionId}:${pnrId}:A`;
      G.upsertNode(oid, "RecoveryOption", {
        type: "REROUTE", via: plan.via, components: plan.legs.map((l) => ({ flight: l.flight, route: l.route, date: l.date, dep: l.dep, arr: l.arr })),
        total_cost: 0, seat_hold_ref: holdRef, expiry: new Date(clock.now().getTime() + ttlMs).toISOString(),
        feasibility_score: 0.9, party_size: n,
      });
      G.upsertEdge(oid, "RESOLVES", predictionId);
      P.execute("SOFT_HOLD_INVENTORY", { predictionId, optionId: oid, touched: [oid], perform: () => holdRef }, { actor: "recovery", predictionId, rationale: `soft hold ${n} seats ${plan.legs.map((l) => l.route).join(" + ")}, TTL ${ttlH}h` });
      options.push(oid);
    }

    /* Option B — DIVERT_PLUS_GROUND: nearest alternate the event does not touch + taxi + 1n hotel + morning transfer */
    const dv = planDivert(fi, predictionId);
    if (dv) {
      const { hotel, taxi } = dv;
      const cost = hotel.rate + taxi.rate;
      const oid = `opt:${predictionId}:${pnrId}:B`;
      G.upsertNode(oid, "RecoveryOption", {
        type: "DIVERT_PLUS_GROUND",
        components: [{ divert_to: dv.code }, { hotel: hotel.id, nights: 1 }, { taxi: taxi.id }, { transfer: `${dv.code}-${fi.dest}`, when: "morning", minutes: dv.transfer_min }],
        total_cost: cost, seat_hold_ref: null, expiry: new Date(clock.now().getTime() + ttlMs).toISOString(),
        feasibility_score: 0.85, party_size: n,
      });
      G.upsertEdge(oid, "RESOLVES", predictionId);
      G.upsertEdge(oid, "FULFILLED_BY", hotel.id); G.upsertEdge(oid, "FULFILLED_BY", taxi.id);
      options.push(oid);
    }

    /* Option C — HOLD + REFUND (Tier-2 execution path) */
    {
      const oid = `opt:${predictionId}:${pnrId}:C`;
      G.upsertNode(oid, "RecoveryOption", { type: "REFUND", components: [{ refund: "full" }], total_cost: 0, expiry: new Date(clock.now().getTime() + ttlMs).toISOString(), feasibility_score: 0.7, party_size: n });
      G.upsertEdge(oid, "RESOLVES", predictionId);
      options.push(oid);
    }

    for (const pid of G.out(pnrId, "BELONGS_TO").map(x => x.node.id)) {
      for (const oid of options) G.upsertEdge(pid, "QUALIFIES_FOR", oid);
    }
    built++;
  }
  O.audit({ actor: "recovery", action: "BUILD_OPTIONS", predictionId, rationale: `options for ${built} PNRs (≤3 each, party-identical); ${waitlisted} waitlisted` });
  return { built, waitlisted };
}

/* ---------------- Offer agent (marketing autonomy) ---------------- */
function framingFor(pax, pnr) {
  if (["Platinum", "Gold"].includes(pax.loyalty_tier)) return "vip_concierge";
  if ((pnr.party_size ?? 1) >= 3 || pax.vulnerability_flags?.length) return "family_together";
  if (pax.flexible) return "flex_shift";
  return "value_onetap";
}
function pickChannel(pax, atHour) {
  const quietable = ["push", "sms", "whatsapp"];
  /* a stated channel preference on the profile (app customers) wins over the default order */
  const order = [...new Set([pax.preferred_channel, "push", "sms", "whatsapp", "email"].filter(Boolean))];
  for (const ch of order) {
    const c = (pax.contact_channels || []).find(x => x.channel === ch && x.consent);
    if (!c) continue;
    if (quietable.includes(ch) && !O.PRED.outside_quiet_hours({ passengerId: pax.id, atHour })) continue;
    return ch;
  }
  return null;
}
function offers(predictionId) {
  const pred = G.getNode(predictionId);
  const fi = G.getNode(pred.flight_instance_ref);
  const affected = G.edges({ src: predictionId, rel: "AFFECTS" });
  const atHour = clock.hour();
  let sentN = 0, skipped = 0;
  for (const e of affected) {
    const pax = G.getNode(e.dst); const pnr = G.getNode(e.pnr);
    const optIds = G.out(pax.id, "QUALIFIES_FOR").map(x => x.node).filter(o => o.id.includes(predictionId)).map(o => o.id);
    if (!optIds.length) continue;
    const channel = pickChannel(pax, atHour);
    const gate = P.execute("NOTIFY_PASSENGER",
      { predictionId, passengerId: pax.id, channel: channel || "push", atHour, perform: () => true, touched: [] },
      { actor: "offer", predictionId, rationale: `offer outreach to ${pax.id} via ${channel || "none"}` });
    if (!channel || !gate.ok) { skipped++; continue; }

    const framing = framingFor(pax, pnr);
    let incentive = null;
    if (framing === "vip_concierge" || framing === "flex_shift") {
      const amt = framing === "vip_concierge" ? 50 : 40;
      const inc = P.execute("OFFER_INCENTIVE", { predictionId, amount: amt, perform: () => amt, touched: [] },
        { actor: "offer", predictionId, rationale: `${framing} goodwill €${amt}` });
      if (inc.ok) incentive = { amount: amt, currency: "EUR", kind: framing === "flex_shift" ? "move_early_credit" : "lounge_plus_voucher" };
    }
    const ordered = framing === "vip_concierge" ? [optIds.find(o => o.endsWith(":A")), ...optIds.filter(o => !o.endsWith(":A"))].filter(Boolean) : optIds;
    const facts = {
      name: pax.name.split(" ")[0], dest: fi.dest, flight: fi.flight_no, date: fi.date,
      optionList: ordered.map(o => G.getNode(o).type).join(" | "),
      incentiveLine: incentive ? `Includes a goodwill credit of EUR ${incentive.amount}.` : "",
    };
    const text = V.render("offer", pax.locale, facts);
    V.send(channel, pax.id, text, { predictionId });
    const offId = `offer:${predictionId}:${pax.id}`;
    G.upsertNode(offId, "Offer", { passenger_ref: pax.id, pnr: pnr.id, prediction: predictionId, options: ordered, channel, framing_variant: framing, state: "SENT", incentive, sent_at: clock.nowIso() });
    for (const o of ordered) G.upsertEdge(offId, "PRESENTS", o);
    bridge.onOffer({ offId, pax, pnr, pred, fi, ordered, framing, incentive, channel, text });
    const oe = G.edges({ src: predictionId, rel: "OUTREACH", dst: pax.id })[0];
    G.upsertEdge(predictionId, "OUTREACH", pax.id, { count: (oe?.count || 0) + 1, last: clock.nowIso() });
    sentN++;
  }
  G.setProps(predictionId, { offers_sent: sentN, offers_skipped: skipped, state: "OFFERS_OUT" });
  O.audit({ actor: "offer", action: "SEND_OFFERS", predictionId, rationale: `${sentN} sent, ${skipped} held back by consent/quiet/limits` });
  O.emit("prediction:state", { predictionId, from: "ACT", to: "OFFERS_OUT" });
  return { sent: sentN, skipped };
}

function decline(offerId) {
  const off = G.getNode(offerId); if (!off) return { ok: false };
  G.setProps(offerId, { state: "DECLINED" });
  G.upsertEdge(off.prediction, "DECLINED", off.passenger_ref);
  O.audit({ actor: "offer", action: "DECLINED", predictionId: off.prediction, rationale: `${off.passenger_ref} declined; no further outreach` });
  bridge.onDeclined({ off, pax: G.getNode(off.passenger_ref) });
  return { ok: true };
}

/* ---------------- Execution agent — compensating-transaction saga ---------------- */
function accept(offerId, optionId) {
  const t0 = Date.now();
  const off = G.getNode(offerId);
  if (!off) return { ok: false, error: "offer not found" };
  const paxId = off.passenger_ref; const predictionId = off.prediction;
  if (off.state === "ACCEPTED" && off.executed) return { ok: true, idempotent: true, refs: off.refs, ms: 0 };
  const opt = G.getNode(optionId || off.options[0]);
  const pax = G.getNode(paxId); const pnr = G.getNode(off.pnr);
  G.setProps(offerId, { state: "ACCEPTED", accepted_at: clock.nowIso() });

  const done = [];      // [{step, undo}]
  const refs = {};
  const fail = (step, why) => {
    for (const d of done.reverse()) { try { d.undo(); O.audit({ actor: "execution", action: `COMPENSATE:${d.step}`, predictionId, rationale: `rollback after ${step} failed` }); } catch {} }
    P.execute("ESCALATE_TO_HUMAN", { predictionId, perform: () => null }, { actor: "execution", predictionId, rationale: `saga failed at ${step}: ${why} — compensated, human has full context` });
    P.execute("PROCESS_REFUND", { predictionId, offerId, amount: 0 }, { actor: "execution", predictionId, rationale: `prepare fallback package for ${pnr.id} after ${step} failure` });
    G.setProps(offerId, { state: "ACCEPTED", executed: false, failed_step: step });
    return { ok: false, failed: step, compensated: true };
  };

  /* 1 · rebook */
  if (opt.type !== "REFUND") {
    const r = P.execute("REBOOK_SAME_CABIN", {
      predictionId, offerId, touched: [pnr.id],
      perform: () => {
        if (opt.type === "REROUTE") {
          const legs = (opt.components || []).filter((c) => c.flight);
          let pss = null;
          legs.forEach((l, i) => { const c = V.confirmSeats(`${opt.seat_hold_ref}:${i + 1}`); if (!c.ok) throw new Error("seat confirm failed"); pss = pss || c.pssRef; });
          G.setProps(pnr.id, { segments: legs.map((l) => ({ f: l.flight })), rebooked: true });
          for (const l of legs) {
            const [o, d] = String(l.route || "").split("-");
            const id = seededFlight(l.flight)?.id || `fi:${l.flight}:${l.date || ""}`;
            if (!G.getNode(id)) G.upsertNode(id, "FlightInstance", { flight_no: l.flight, date: l.date, origin: o, dest: d, sched_dep: l.dep ? `${l.date}T${l.dep}:00Z` : null, sched_arr: l.arr ? `${l.date}T${l.arr}:00Z` : null, recovery: true, status: "scheduled" });
            G.upsertEdge(id, "CARRIES", pnr.id);
          }
          return { pss };
        }
        const dv = (opt.components || []).find((c) => c.divert_to)?.divert_to || null;
        G.setProps(pnr.id, { diverted_to: dv, rebooked: true });
        return { pss: "DIV-" + pnr.record_locator };
      },
    }, { actor: "execution", predictionId, rationale: `rebook ${pnr.id} (${opt.type}) under weather waiver` });
    if (!r.ok) return fail("REBOOK", JSON.stringify(r));
    refs.rebook = r.result?.pss; done.push({ step: "REBOOK", undo: () => G.setProps(pnr.id, { segments: pnr.segments, rebooked: false, diverted_to: null }) });
  }

  /* 2 · hotel voucher */
  const hotelComp = (opt.components || []).find(c => c.hotel);
  if (hotelComp) {
    const hotel = G.getNode(hotelComp.hotel);
    const r = P.execute("ISSUE_HOTEL_VOUCHER", {
      predictionId, offerId, amount: hotel.rate, touched: [],
      perform: () => { const v = V.reserve("hotel", hotel.id, `idem:${offerId}:hotel`, { nights: 1, pax: pnr.party_size }); if (!v.ok) throw new Error(v.error); return v.ref; },
    }, { actor: "execution", predictionId, rationale: `hotel voucher ${hotel.name} EUR ${hotel.rate}` });
    if (!r.ok) return fail("HOTEL", JSON.stringify(r));
    refs.hotel = r.result; done.push({ step: "HOTEL", undo: () => V.cancel(`idem:${offerId}:hotel`) });
  }

  /* 3 · ground transport */
  const taxiComp = (opt.components || []).find(c => c.taxi);
  if (taxiComp) {
    const taxi = G.getNode(taxiComp.taxi);
    const r = P.execute("BOOK_GROUND_TRANSPORT", {
      predictionId, offerId, amount: taxi.rate, touched: [],
      perform: () => { const v = V.reserve("taxi", taxi.id, `idem:${offerId}:taxi`, { route: (opt.components || []).find((c) => c.transfer)?.transfer || "" }); if (!v.ok) throw new Error(v.error); return v.ref; },
    }, { actor: "execution", predictionId, rationale: `ground transfer EUR ${taxi.rate}` });
    if (!r.ok) return fail("TAXI", JSON.stringify(r));
    refs.taxi = r.result; done.push({ step: "TAXI", undo: () => V.cancel(`idem:${offerId}:taxi`) });
  }

  /* 4 · reissue */
  if (opt.type !== "REFUND") {
    const r = P.execute("REISSUE_TICKET", { predictionId, offerId, touched: [pnr.id], perform: () => "TKT-" + pnr.record_locator },
      { actor: "execution", predictionId, rationale: `reissue ticket for ${pnr.id}` });
    if (!r.ok) return fail("REISSUE", JSON.stringify(r));
    refs.ticket = r.result;
  } else {
    P.execute("PROCESS_REFUND", { predictionId, offerId, amount: 250 }, { actor: "execution", predictionId, rationale: "refund requested — packaged for approval" });
  }

  /* 5 · confirm (transactional message: quiet hours exempt by policy note) */
  const cityOf = (code) => { try { return require("../routes-data").AIRPORTS[code]?.city || code; } catch { return code; } };
  const legsC = (opt.components || []).filter((c) => c.flight); const via = opt.via || (legsC.length === 2 ? String(legsC[0].route || "").split("-")[1] : null); const dvC = (opt.components || []).find((c) => c.divert_to)?.divert_to; const xfer = (opt.components || []).find((c) => c.transfer)?.transfer || "";
  const facts = { name: pax.name.split(" ")[0], summary: opt.type === "REROUTE" ? (via ? `Rerouted via ${cityOf(via)}, arriving next morning` : "Rebooked on the next morning's direct flight") : opt.type === "DIVERT_PLUS_GROUND" ? `Landing ${dvC} with taxi, hotel tonight and a morning transfer to ${cityOf(xfer.split("-")[1] || "")}` : "Refund prepared", ref: refs.rebook || refs.hotel || "OK" };
  V.send("push", pax.id, V.render("confirm", pax.locale, facts), { predictionId });

  /* release sibling holds for this PNR's other options */
  for (const sib of ["A"]) {
    const other = G.getNode(`opt:${predictionId}:${off.pnr}:${sib}`);
    if (other && other.id !== opt.id && other.seat_hold_ref) { V.releaseSeats(other.seat_hold_ref + ":1"); V.releaseSeats(other.seat_hold_ref + ":2"); }
  }
  const ms = Date.now() - t0;
  G.setProps(offerId, { executed: true, refs, exec_ms: ms });
  G.setProps(predictionId, { state: "RESOLVING" });
  O.audit({ actor: "execution", action: "SAGA_COMPLETE", predictionId, rationale: `${opt.type} executed for ${off.pnr} in ${ms}ms`, inputs: refs });
  bridge.onAccepted({ offerId, off, pax, pnr, opt, refs });
  return { ok: true, refs, ms };
}

module.exports = { impact, recovery, offers, decline, accept };
